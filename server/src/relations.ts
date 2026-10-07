/**
 * 记忆与关系：加好友 → 单独聊天 →（下一步）agent 自己来找你说话。
 *
 * 为什么单独一个文件：index.ts 已经四百行，而且这里的表是"关系"自己的，
 * 跟帖子那套互不相干。父 app 只往 index.ts 里加一行挂载，两边不互相踩。
 *
 * 复用（不新建第二套）：
 * - 会话/鉴权：父 app 的 `/api/*` 中间件已经解好 `userId`，这里只管取。
 * - 人格：`systemPrompt(p, handle, impression, pickMemory(p, id, text))` —— 同一个口子，
 *   第 4 个参数是"这次给不给他往事"（`null` = 这次一句都不提自己）。
 * - 上游：`streamChat` + `target()`。
 * - 传输：单聊用自己的 SSE 事件形状（多带一个 `id`）—— 回帖那边已经不是流了，
 *   是前端轮询 `POST /api/feed/tick`；**聊天才需要打字机**，论坛里一句一句往外蹦是错的。
 * - 成本：每次上游调用都 `recordUsage`，生成前都过 `gate(userId)`。
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db, now } from './db.ts';
import { PERSONAS, pickMemory, systemPrompt, type Persona } from './personas.ts';
import { streamChat, target, type Msg, type Usage } from './llm.ts';
import { env } from './env.ts';

// ---------------------------------------------------------------------------
// 表：只建自己的。db.ts 一个字都不动（它是 Lead 的）
// ---------------------------------------------------------------------------
db.exec(`
  -- "我加了谁"。加了好友才进得去单聊 —— 好友关系不是装饰，是权限。
  CREATE TABLE IF NOT EXISTS friends (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    agent_slug TEXT NOT NULL REFERENCES agents(slug),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_slug)
  );

  -- 单聊消息。agent 那条回复在"用户按下发送"那一刻就以 state='pending' 落库，
  -- 刷新只回放、不重新生成 —— 跟 post_agents 是同一个思路（见 db.ts 的注释）。
  CREATE TABLE IF NOT EXISTS dm_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    agent_slug TEXT NOT NULL REFERENCES agents(slug),
    role       TEXT NOT NULL,               -- 'user' | 'agent'
    text       TEXT,                        -- agent 还没生成完时是 NULL
    state      TEXT NOT NULL,               -- 'pending' | 'done' | 'failed'
    seen       INTEGER NOT NULL DEFAULT 0,  -- agent 的话有没有被看过（未读小红点）
    created_at INTEGER NOT NULL,
    origin     TEXT NOT NULL DEFAULT 'reply' -- 'reply' 回他一句 | 'proactive' 他自己来找你
  );

  CREATE INDEX IF NOT EXISTS idx_dm_thread ON dm_messages(user_id, agent_slug, id);

  -- 每个人自己的"主动来消息"开关和频率账：把 agent 关掉、上次谁来找过你、今天来过几条。
  CREATE TABLE IF NOT EXISTS dm_settings (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id),
    proactive INTEGER NOT NULL DEFAULT 1,
    last_at   INTEGER NOT NULL DEFAULT 0,
    day_key   TEXT    NOT NULL DEFAULT '',
    day_count INTEGER NOT NULL DEFAULT 0
  );
`);

/** dm_messages 是后加的表、origin 是后加的列：盘上真跑起来过的库得补一次。 */
{
  const cols = db.prepare(`SELECT name FROM pragma_table_info('dm_messages')`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'origin')) {
    db.exec(`ALTER TABLE dm_messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'reply'`);
  }
}

// ---------------------------------------------------------------------------
// 小工具（跟 index.ts 里那三行同名同义；它们没被导出，所以这里各留一份）
// ---------------------------------------------------------------------------
const rows = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as T[];
const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T | undefined;
const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bySlug = new Map(PERSONAS.map((p) => [p.slug, p]));
const MODEL = target('default').model;

/** 带进 prompt 的历史条数。再多也没用，单聊的重心是"最近这几句"。 */
const CONTEXT_MESSAGES = 12;

/**
 * 单聊不是公开回帖。systemPrompt 是按"树洞里回帖"写的，所以这里只在**末尾补一句场合**，
 * 人格本身、印象、往事全都还是走 systemPrompt —— 不另造一套人设机制。
 */
const PRIVATE_CHAT =
  '\n\n你俩已经加了好友，现在是单独聊天：只有你和他，没有别人在看。你不用回帖，就当是给他发消息。';

/**
 * 主动来消息：这次不是你回他，是你先开口。人设还是同一套，只换场合。
 */
const PROACTIVE_OPEN =
  '\n\n你俩已经加了好友，是单独聊天。这次不是他先开口 —— 是你隔了好一阵子忽然想起他，主动给他发一条。' +
  '就一两句，像随手甩过来的一句话，别写长，别提问卷，也别重复你上一条说过的话。';

/**
 * 主动消息的对话必须以**别人说的话**结尾，不能以他自己上一句结尾：模型看到最后一条是
 * assistant 就当自己说完了，直接收尾。实测（本机 qwen3.5:9b，各 12 次，12/12 vs 0/12 退化）：
 *   以他自己的话结尾 → 12/12 只吐一两个字或者干脆空；末尾补一句旁白 → 0/12。
 * 所以这句不是"提醒他"，是给模型一个非答不可的位置，内容本身会被 PROACTIVE_OPEN 压住。
 */
const PROACTIVE_NUDGE = '（你们有一阵子没说话了。你忽然想起他。）';

/**
 * 两次主动消息之间至少隔这么久，也是"这条线要安静够久才可能想起你"的那条线：
 * 刚说完话的人不会马上又来找你。一个旋钮管两头。
 */
const PROACTIVE_GAP_MS = env.proactiveMinGapMin * 60_000;

/** 聊完之后回去更新"他对你的印象"的最小间隔 —— 不是每句话都值得总结一遍。 */
const MEMORY_GAP_MS = 30 * 60_000;

type DmRow = {
  id: number; user_id: number; agent_slug: string; role: string;
  text: string | null; state: string; seen: number; created_at: number; origin: string;
};

type DmSettings = { user_id: number; proactive: number; last_at: number; day_key: string; day_count: number };

const DEFAULT_SETTINGS: DmSettings = { user_id: 0, proactive: 1, last_at: 0, day_key: '', day_count: 0 };

const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** user_id = 0 是"这行还不存在"的哨兵（自增主键从 1 开始）。 */
const readSettings = (userId: number): DmSettings =>
  one<DmSettings>('SELECT * FROM dm_settings WHERE user_id = ?', userId) ?? { ...DEFAULT_SETTINGS };

function settingsFor(userId: number): DmSettings {
  if (!readSettings(userId).user_id) run('INSERT OR IGNORE INTO dm_settings (user_id) VALUES (?)', userId);
  return readSettings(userId);
}

/**
 * 谁该主动来找你：只在他**聊过**的吧友里挑（线程里有生成好的消息），
 * 而且这条线得安静够久；最熟的优先（来回条数最多），其次最近的。
 */
function pickProactive(userId: number): Persona | null {
  const row = one<{ slug: string }>(
    `SELECT f.agent_slug AS slug
       FROM friends f
       JOIN dm_messages m ON m.user_id = f.user_id AND m.agent_slug = f.agent_slug
      WHERE f.user_id = ? AND m.state = 'done' AND m.text IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM dm_messages x
           WHERE x.user_id = f.user_id AND x.agent_slug = f.agent_slug
             AND x.role = 'agent' AND x.state = 'pending'
        )
      GROUP BY f.agent_slug
     HAVING MAX(m.created_at) <= ?
      ORDER BY COUNT(*) DESC, MAX(m.created_at) DESC
      LIMIT 1`,
    userId, now() - PROACTIVE_GAP_MS,
  );
  return row ? (bySlug.get(row.slug) ?? null) : null;
}

const brief = (p: Persona) => ({ slug: p.slug, name: p.name, tagline: p.tagline, accent: p.accent });

const isFriend = (userId: number, slug: string): boolean =>
  !!one('SELECT 1 AS x FROM friends WHERE user_id = ? AND agent_slug = ?', userId, slug);

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** 父 app 借给这里的东西（成本账本、上游并发闸门、印象更新）。 */
export type RelationsDeps = {
  recordUsage: (
    postId: number | null,
    slug: string | null,
    kind: string,
    model: string,
    u: Usage,
    userId: number | null,
  ) => void;
  gate: (userId: number) => string | null;
  acquire: () => Promise<void>;
  release: () => void;
  /** index.ts 的 updateImpressions：`postId` 传 null 就是"这不是帖子里的事"。 */
  remember: (
    postId: number | null,
    userId: number,
    handle: string,
    post: string,
    said: { slug: string; name: string; text: string }[],
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
// 路由。父 app 用 `app.route('/api', relationsRoutes(...).app)` 挂上去，
// 时钟那一轮用同一个返回里的 `tickProactive`（**生成逻辑只有一份**）。
// ---------------------------------------------------------------------------
export type RelationsApi = {
  app: Hono<{ Variables: { userId: number | null } }>;
  /**
   * 服务端时钟每一轮调一次：把"该被叫一句"的用户挑出来（便宜的闸门先过一遍），
   * 再逐个真正生成。返回这一轮真发出去几条。
   */
  tickProactive: () => Promise<number>;
};

export function relationsRoutes(deps: RelationsDeps): RelationsApi {
  const app = new Hono<{ Variables: { userId: number | null } }>();

  // 同一个"用户 × 吧友 × 那条 pending"正在生成时，第二个连接不重复生成（两个标签页/刷新）。
  const generating = new Set<string>();

  /**
   * "他会记得你"：聊完之后回头更新一次印象。**火忘式** —— 不能拖慢回复，失败了就算了。
   * 而且隔 `MEMORY_GAP_MS` 才总结一次：每句话都总结一遍是纯烧钱。开关是 env.dmMemory。
   */
  function remember(userId: number, p: Persona, handle: string, said: string, reply: string): void {
    if (!env.dmMemory || !said.trim()) return;
    const last = one<{ updated_at: number }>(
      'SELECT updated_at FROM impressions WHERE user_id = ? AND agent_slug = ?', userId, p.slug,
    )?.updated_at ?? 0;
    if (last > now() - MEMORY_GAP_MS) return;
    void deps.remember(null, userId, handle, said, [{ slug: p.slug, name: p.name, text: reply }]).catch(() => {});
  }

  /**
   * 生成一条 agent 消息。**SSE 流和"主动来消息"共用这一条路径** —— 拼 prompt 的逻辑只有一份，
   * 区别只在 `origin` 决定末尾补哪一句（回他 / 我先开口）。
   * 已经有人在生成同一条时返回 null；失败时把那条标成 failed 并把异常抛给调用方。
   */
  async function generateReply(
    userId: number,
    p: Persona,
    m: DmRow,
    on: { start: () => void; delta: (text: string) => void },
    delayMs = 0,
  ): Promise<string | null> {
    const key = `${userId}:${p.slug}:${m.id}`;
    if (generating.has(key)) return null;
    generating.add(key);
    try {
      const handle = one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', userId)?.handle ?? '';
      const impression = one<{ text: string }>(
        'SELECT text FROM impressions WHERE user_id = ? AND agent_slug = ?', userId, p.slug,
      )?.text ?? null;

      const history = rows<{ role: string; text: string | null }>(
        `SELECT role, text FROM dm_messages
          WHERE user_id = ? AND agent_slug = ? AND id < ? AND state = 'done' AND text IS NOT NULL
          ORDER BY id DESC LIMIT ?`,
        userId, p.slug, m.id, CONTEXT_MESSAGES,
      ).reverse();

      await sleep(delayMs + p.thinkMs * (0.8 + Math.random() * 0.5));
      on.start();

      await deps.acquire();
      try {
        const said = history
          .filter((h) => h.role === 'assistant')
          .map((h) => h.text ?? '')
          .filter(Boolean);
        const messages: Msg[] = [
          {
            role: 'system',
            content:
              systemPrompt(p, handle, impression, pickMemory(p, m.id, m.text ?? '', said)) +
              (m.origin === 'proactive' ? PROACTIVE_OPEN : PRIVATE_CHAT),
          },
          ...history.map((h): Msg => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text ?? '' })),
        ];
        // 主动来消息时 history 的最后一条是他自己上次说的话，模型会当成"说完了"直接收尾 —— 补一句旁白
        if (m.origin === 'proactive') messages.push({ role: 'user', content: PROACTIVE_NUDGE });
        let acc = '';
        for await (const chunk of streamChat(messages, {
          maxTokens: p.maxTokens,
          onUsage: (u) =>
            deps.recordUsage(null, p.slug, m.origin === 'proactive' ? 'proactive' : 'dm', MODEL, u, userId),
        })) {
          acc += chunk;
          on.delta(chunk);
          await sleep(Math.min(500, (chunk.length / p.cps) * 1000));
        }
        const text = acc.trim();
        if (!text) throw new Error('模型返回了空内容');
        run(`UPDATE dm_messages SET state = 'done', text = ? WHERE id = ? AND user_id = ?`, text, m.id, userId);
        remember(userId, p, handle, history.filter((h) => h.role === 'user').at(-1)?.text ?? '', text);
        return text;
      } finally {
        deps.release();
      }
    } catch (e) {
      run(`UPDATE dm_messages SET state = 'failed' WHERE id = ? AND user_id = ?`, m.id, userId);
      throw e;
    } finally {
      generating.delete(key);
    }
  }

  // ---- 加好友 ----
  app.post('/friends', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { slug?: unknown };
    const slug = typeof body.slug === 'string' ? body.slug : '';
    const p = bySlug.get(slug);
    if (!p) return c.json({ error: '没有这个吧友' }, 400);
    run('INSERT OR IGNORE INTO friends (user_id, agent_slug, created_at) VALUES (?, ?, ?)', userId, slug, now());
    return c.json({ ok: true, friend: brief(p) });
  });

  app.delete('/friends/:slug', (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const slug = c.req.param('slug');
    if (!bySlug.has(slug)) return c.json({ error: '没有这个吧友' }, 404);
    run('DELETE FROM friends WHERE user_id = ? AND agent_slug = ?', userId, slug);
    return c.json({ ok: true });
  });

  app.get('/friends', (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const list = rows<{ slug: string; created_at: number; last_text: string | null; last_at: number | null; unread: number }>(
      `SELECT f.agent_slug AS slug, f.created_at,
              (SELECT m.text FROM dm_messages m
                WHERE m.user_id = f.user_id AND m.agent_slug = f.agent_slug AND m.text IS NOT NULL
                ORDER BY m.id DESC LIMIT 1) AS last_text,
              (SELECT m.created_at FROM dm_messages m
                WHERE m.user_id = f.user_id AND m.agent_slug = f.agent_slug AND m.text IS NOT NULL
                ORDER BY m.id DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*) FROM dm_messages m
                WHERE m.user_id = f.user_id AND m.agent_slug = f.agent_slug
                  AND m.role = 'agent' AND m.seen = 0 AND m.state = 'done') AS unread
         FROM friends f WHERE f.user_id = ?
        ORDER BY f.created_at DESC, f.agent_slug`,
      userId,
    );
    return c.json({
      friends: list.flatMap((r) => {
        const p = bySlug.get(r.slug);
        return p ? [{ ...brief(p), since: r.created_at, lastText: r.last_text, lastAt: r.last_at, unread: r.unread }] : [];
      }),
    });
  });

  // ---- 单聊 ----
  app.get('/dm/:slug', (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const p = bySlug.get(c.req.param('slug'));
    if (!p) return c.json({ error: '没有这个吧友' }, 404);
    if (!isFriend(userId, p.slug)) return c.json({ error: '你们还不是好友' }, 403);

    const limit = clamp(Math.trunc(Number(c.req.query('limit') ?? 50) || 50), 1, 200);
    const messages = rows<DmRow>(
      `SELECT id, role, text, state, seen, created_at, origin FROM dm_messages
        WHERE user_id = ? AND agent_slug = ? ORDER BY id DESC LIMIT ?`,
      userId, p.slug, limit,
    ).reverse();
    const impression = one<{ text: string }>(
      'SELECT text FROM impressions WHERE user_id = ? AND agent_slug = ?', userId, p.slug,
    )?.text ?? null;

    return c.json({
      agent: brief(p),
      friend: true,
      impression,
      messages: messages.map((m) => ({
        id: m.id, role: m.role, text: m.text, state: m.state, seen: !!m.seen, origin: m.origin,
        createdAt: m.created_at,
      })),
    });
  });

  /** 发一句。回复**不在这里生成** —— 只登记一条 pending，真正的生成在 SSE 流里（跟发帖一样）。 */
  app.post('/dm/:slug', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const p = bySlug.get(c.req.param('slug'));
    if (!p) return c.json({ error: '没有这个吧友' }, 404);
    if (!isFriend(userId, p.slug)) return c.json({ error: '你们还不是好友' }, 403);

    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: '说点什么吧' }, 400);
    if (text.length > 2000) return c.json({ error: '最多 2000 字' }, 400);

    // 答不了就别先收下
    const blocked = deps.gate(userId);
    if (blocked) return c.json({ error: blocked }, 429);

    const userMessageId = Number(
      run(
        `INSERT INTO dm_messages (user_id, agent_slug, role, text, state, seen, created_at)
         VALUES (?, ?, 'user', ?, 'done', 1, ?)`,
        userId, p.slug, text, now(),
      ).lastInsertRowid,
    );

    // 连发好几条时不要排一队回复：末尾那条还没生成的，直接复用
    const pending = one<{ id: number }>(
      `SELECT id FROM dm_messages WHERE user_id = ? AND agent_slug = ? AND role = 'agent' AND state = 'pending'
        ORDER BY id DESC LIMIT 1`,
      userId, p.slug,
    );
    const agentMessageId = pending?.id ?? Number(
      run(
        `INSERT INTO dm_messages (user_id, agent_slug, role, text, state, seen, created_at)
         VALUES (?, ?, 'agent', NULL, 'pending', 0, ?)`,
        userId, p.slug, now(),
      ).lastInsertRowid,
    );

    return c.json({ ok: true, userMessageId, agentMessageId });
  });

  /** 进过这个单聊、看完了 —— 未读清零。 */
  app.post('/dm/:slug/seen', (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const slug = c.req.param('slug');
    if (!bySlug.has(slug)) return c.json({ error: '没有这个吧友' }, 404);
    if (!isFriend(userId, slug)) return c.json({ error: '你们还不是好友' }, 403);
    run(`UPDATE dm_messages SET seen = 1 WHERE user_id = ? AND agent_slug = ? AND role = 'agent' AND seen = 0`, userId, slug);
    return c.json({ ok: true });
  });

  /**
   * 流式回复。`after` 是客户端已经拿到的那条 id（发完消息把 userMessageId 传进来）。
   * 事件：ping / agent_start / delta / done / error / complete，都带那条消息的 `id`。
   */
  app.get('/dm/:slug/stream', (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const p = bySlug.get(c.req.param('slug'));
    if (!p) return c.json({ error: '没有这个吧友' }, 404);
    if (!isFriend(userId, p.slug)) return c.json({ error: '你们还不是好友' }, 403);

    const after = Math.max(0, Math.trunc(Number(c.req.query('after') ?? 0) || 0));
    const msgs = rows<DmRow>(
      `SELECT id, role, text, state, seen, created_at, origin FROM dm_messages
        WHERE user_id = ? AND agent_slug = ? AND role = 'agent' AND id > ? ORDER BY id`,
      userId, p.slug, after,
    );
    const handle = one<{ handle: string }>('SELECT handle FROM users WHERE id = ?', userId)?.handle ?? '';

    return streamSSE(c, async (stream) => {
      // ping / 多条回复可能并发写同一个流，串行化
      let chain: Promise<void> = Promise.resolve();
      const send = (evt: unknown) => {
        const data = JSON.stringify(evt);
        chain = chain.then(() => stream.writeSSE({ data })).catch(() => {});
      };
      const ping = setInterval(() => send({ type: 'ping' }), 15_000);

      try {
        // 1) 已经生成过的直接回放
        for (const m of msgs) {
          if (m.state === 'done' && m.text) {
            send({ type: 'agent_start', slug: p.slug, id: m.id });
            send({ type: 'delta', slug: p.slug, id: m.id, text: m.text });
            send({ type: 'done', slug: p.slug, id: m.id, text: m.text });
          } else if (m.state === 'failed') {
            send({ type: 'error', slug: p.slug, id: m.id, message: '上次生成失败了' });
          }
        }

        // 2) 还没生成的现场生成
        const pending = msgs.filter((m) => m.state === 'pending');
        const blocked = pending.length ? deps.gate(userId) : null;
        if (blocked) for (const m of pending) send({ type: 'error', slug: p.slug, id: m.id, message: blocked });

        const todo = blocked ? [] : pending;
        for (const [i, m] of todo.entries()) {
          try {
            const text = await generateReply(
              userId,
              p,
              m,
              {
                start: () => send({ type: 'agent_start', slug: p.slug, id: m.id }),
                delta: (t) => send({ type: 'delta', slug: p.slug, id: m.id, text: t }),
              },
              i * 300,
            );
            if (text !== null) send({ type: 'done', slug: p.slug, id: m.id, text });
          } catch (e) {
            send({ type: 'error', slug: p.slug, id: m.id, message: e instanceof Error ? e.message : String(e) });
          }
        }

        send({ type: 'complete' });
        await chain;
      } finally {
        clearInterval(ping);
      }
    });
  });

  // ---- 他主动来找你 ----
  /**
   * `on` 是全局总闸（env.proactive，部署时定死），`enabled` 是这个用户自己的开关：
   * 两个都开着他才可能主动来找你。
   */
  const stateOf = (s: DmSettings) => {
    const today = dayKey();
    return {
      on: env.proactive,
      enabled: !!s.proactive,
      sentToday: s.day_key === today ? s.day_count : 0,
      dailyMax: env.proactiveDailyMax,
      minGapMin: env.proactiveMinGapMin,
    };
  };

  type TickResult = {
    state: ReturnType<typeof stateOf>;
    messages: { slug: string; id: number; text: string }[];
    /** 撞上成本闸门（路由回 429） */
    blocked?: string;
    /** 生成失败（路由回 502；账已经记过了） */
    error?: string;
  };

  /**
   * 真正动手的那一步。**页面在轮询的路由和页面根本没开的服务端时钟共用这一份** ——
   * 两份逻辑各写一遍迟早会漂（一边修了另一边忘了）。
   * 返回的是"给前端的形状"而不是 Hono 响应：200/429/502 由调用方自己决定。
   */
  async function proactiveTick(userId: number): Promise<TickResult> {
    const state = stateOf(settingsFor(userId));
    const empty: TickResult = { state, messages: [] };
    // 三道闸，顺序从便宜到贵：总闸 → 他自己的开关 → 今天够了 → 这条线还没安静够
    if (!state.on || !state.enabled) return empty;
    if (state.sentToday >= state.dailyMax) return empty;
    if (readSettings(userId).last_at > now() - PROACTIVE_GAP_MS) return empty;

    const p = pickProactive(userId);
    if (!p) return empty;

    const blocked = deps.gate(userId);
    if (blocked) return { state, messages: [], blocked };

    // 先记下"我来过了"再张嘴：生成失败也不能变成每分钟重试一次的刷屏
    const t = now();
    const day = dayKey();
    run(
      'UPDATE dm_settings SET last_at = ?, day_key = ?, day_count = ? WHERE user_id = ?',
      t, day, state.sentToday + 1, userId,
    );
    const id = Number(
      run(
        `INSERT INTO dm_messages (user_id, agent_slug, role, text, state, seen, created_at, origin)
         VALUES (?, ?, 'agent', NULL, 'pending', 0, ?, 'proactive')`,
        userId, p.slug, t,
      ).lastInsertRowid,
    );

    try {
      const text = await generateReply(userId, p, {
        id, user_id: userId, agent_slug: p.slug, role: 'agent',
        text: null, state: 'pending', seen: 0, created_at: t, origin: 'proactive',
      }, { start: () => {}, delta: () => {} });
      return { state: stateOf(settingsFor(userId)), messages: text ? [{ slug: p.slug, id, text }] : [] };
    } catch (e) {
      // 这条已经记进"今天来过了"，所以回的是**记完之后**的状态，别让前端以为还有额度
      return { state: stateOf(settingsFor(userId)), messages: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 该被叫一句的用户。**便宜的闸门在这里先过一遍**：总闸、他自己的开关、当日上限、
   * 安静间隔、真有好友 —— 一条不合格的都不进这个名单。
   * （每 5 秒给每个用户打一次模型是不可接受的；`dm_settings` 没行的按默认值算，
   * 跟 `stateOf`/`proactiveTick` 的口径一致，不然"没打开过设置页的人永远收不到"。）
   */
  function proactiveCandidates(): number[] {
    if (!env.proactive) return [];
    return rows<{ user_id: number }>(
      `SELECT u.id AS user_id
         FROM users u
         LEFT JOIN dm_settings s ON s.user_id = u.id
        WHERE COALESCE(s.proactive, 1) = 1
          AND NOT (COALESCE(s.day_key, '') = ? AND COALESCE(s.day_count, 0) >= ?)
          AND COALESCE(s.last_at, 0) <= ?
          AND EXISTS (SELECT 1 FROM friends f WHERE f.user_id = u.id)
        ORDER BY COALESCE(s.last_at, 0)
        LIMIT 5`,
      dayKey(), env.proactiveDailyMax, now() - PROACTIVE_GAP_MS,
    ).map((r) => r.user_id);
  }

  /** 时钟那一轮。一个一个来（生成本身有并发闸门），返回这一轮真发出去几条。 */
  async function tickProactive(): Promise<number> {
    let sent = 0;
    for (const userId of proactiveCandidates()) sent += (await proactiveTick(userId)).messages.length;
    return sent;
  }

  app.get('/proactive', (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    return c.json(stateOf(settingsFor(userId)));
  });

  /** 一键关（也想能重新打开）。 */
  app.put('/proactive', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 得是 true/false' }, 400);
    const s = settingsFor(userId);
    run('UPDATE dm_settings SET proactive = ? WHERE user_id = ?', body.enabled ? 1 : 0, userId);
    return c.json(stateOf({ ...s, proactive: body.enabled ? 1 : 0 }));
  });

  /**
   * 前端每分钟敲一下这里。页面没开的时候由服务端时钟敲（`tickProactive`）——
   * **两条路走的是同一个 `proactiveTick`**，只有一份逻辑。
   * 至多一条，而且当场生成完再返回：前端拿到 text 直接显示，不用再开一个流。
   * 关着的时候一次上游调用都不会发生，直接返回空。
   */
  app.post('/proactive/tick', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: '未登录' }, 401);
    const r = await proactiveTick(userId);
    if (r.blocked) return c.json({ error: r.blocked }, 429);
    if (r.error) return c.json({ ...r.state, messages: [], error: r.error }, 502);
    return c.json({ ...r.state, messages: r.messages });
  });

  return { app, tickProactive };
}
