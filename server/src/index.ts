import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, env } from './env.ts';
import { db, markMemoryTold, memoriesTold, now } from './db.ts';
import { PERSONAS, pickMemory, systemPrompt, type Persona } from './personas.ts';
import { COPY_RUN, MAX_REPLIERS, PACE_WEIGHT, batchRepeat, longestRun, metaNote, pickResponders, recitesMemory, templateRepeat, wholeRepeat } from './replies.ts';
import { DAY_MS, composePost, pickPoster } from './agent-post.ts';
import { chatOnce, pickModel, streamChat, target, type Usage } from './llm.ts';
import { gate, spent } from './budget.ts';
import { relationsRoutes } from './relations.ts';
import { boardRoutes } from './board.ts';
import { REGISTER_DAY_MS, clientKey, registerLimiter } from './ratelimit.ts';
import {
  COOKIE_NAME, clearLoginFailures, hashPassword, loginWaitMinutes, noteLoginFailure,
  parseCookies, readSession, sessionCookie, signSession, verifyPassword,
} from './auth.ts';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const rows = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as T[];
const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T | undefined;
const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));

const bySlug = new Map(PERSONAS.map((p) => [p.slug, p]));
const resequenceChars = (s: string) => [...String(s).replace(/[\s\p{P}]/gu, '')];
const resequenceBigrams = (s: string) => {
  const chars = resequenceChars(s);
  return new Set(chars.slice(0, -1).map((x, i) => x + chars[i + 1]));
};
const resequenceJaccard = (a: string, b: string) => {
  const A = resequenceBigrams(a);
  const B = resequenceBigrams(b);
  const intersection = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? intersection / union : 0;
};

type PostRow = {
  id: number; user_id: number; content: string; created_at: number;
  handle: string; author_slug: string | null;
};
/** 一层楼。`name/tagline/accent` 是 LEFT JOIN agents 来的（楼主是你那层没有作者）。 */
type FloorRow = {
  id: number; post_id: number; seq: number; author_kind: string; author_slug: string | null;
  state: string; content: string | null; note_id: number | null;
  due_at: number | null; replied_at: number | null; created_at: number;
  name: string | null; tagline: string | null; accent: string | null;
};
// 一层"到点了、该他说话了"的楼
type DueFloor = {
  floor_id: number;
  post_id: number;
  seq: number;
  author_slug: string;
  slug: string;
  content: string;
  handle: string;
  note_id: number | null;
  due_at: number | null;
  created_at: number;
  /** 帖子的作者：null = 楼主本人写的；非 null = 吧友自己起的帖（L-1）。 */
  post_author: string | null;
};
/** 前面谁说了什么 —— 交给 `systemPrompt` 的第 5 个参数（渲染在 personas.ts，这边只负责把话捞齐）。 */
type SaidLine = { name: string; text: string };

// ---------------------------------------------------------------------------
// 谁来回、什么时候来
// ---------------------------------------------------------------------------

/**
 * 吧友的"上网习惯" → 他大概多久之后会出现。**不进 prompt**（进了就是让他演"我很闲"）。
 *
 * 用户原话：「发一条帖子，下面就有三个头像开始转，回答出来了，这就不是贴吧的模式」。
 * 贴吧不是排队叫号：是一群人各自路过、各自说话，人数不定、时间不定。
 * 但**第一条永远是快的** —— 帖子发出去半小时没人吭声，那不叫慢，那叫坏了；
 * 用户也要求「最好是有经常冲浪的吧友秒回，要考虑一下及时的反馈」。
 */
const PACE_DELAY: Record<'surfer' | 'evening' | 'slow', [number, number]> = {
  surfer: [5_000, 25_000], // 经常冲浪：几秒到半分钟
  evening: [90_000, 900_000], // 下班/睡前才上来看一眼：一分半到十几分钟
  slow: [1_800_000, 7_200_000], // 日子过得慢的人：半小时到两小时
};

/** 二层接话的成本/深度闸：每帖每位吧友最多保留两层待回或已回。 */
const MAX_AGENT_FLOORS_PER_POST = 2;
/** 二层接话不保底，候选各自只有这一档概率进入；0 位是合法结果。 */
const FOLLOWUP_SPEAK_PROBABILITY = 0.25;

/**
 * 发帖那一刻把"谁来回、什么时候来"定死并写成 floors 里的 pending 楼层。
 * 之后每个 tick 只是照单执行 —— 刷新页面只会回放，不会重新烧一遍钱。
 *
 * "**谁来**"不在这里：在 `replies.ts` 的 `pickResponders`，每个人**自己**判断
 * 要不要接这个话茬（用户要的"有意思的帖人多、没意思的帖人少"）。
 * 这里只管"**什么时候来**"：各按自己的上网习惯到点，不硬加速。
 */
function planReplies(barSlugs: string[], text: string, at: number): { slug: string; dueAt: number }[] {
  const bar = barSlugs.map((s) => bySlug.get(s)).filter((p): p is Persona => !!p);
  // 一帖最多几个人开口只有这一个上限：`MAX_REPLIERS`（"有共鸣的帖人多"由概率表达，
  // 不要第二个天花板 —— 封顶两处 = 死配置）
  const picked = pickResponders(bar, text, Math.random).slice(0, MAX_REPLIERS);
  return picked.map((p) => {
    // 每个人按自己的上网习惯到点 —— 不硬加速：老陆秒回就不是老陆了
    const [lo, hi] = PACE_DELAY[p.pace];
    return { slug: p.slug, dueAt: at + lo + Math.floor(Math.random() * (hi - lo)) };
  });
}

/** 给同帖跟进/用户接楼复用：先排除达到上限者；有未开口者时只在这批里挑。 */
function underFloorCap(bar: Persona[], countOf: Map<string, number>, excludeSlug?: string): Persona[] {
  const eligible = bar.filter((p) => p.slug !== excludeSlug && (countOf.get(p.slug) ?? 0) < MAX_AGENT_FLOORS_PER_POST);
  const fresh = eligible.filter((p) => (countOf.get(p.slug) ?? 0) === 0);
  return (fresh.length ? fresh : eligible).sort((a, b) => PACE_WEIGHT[b.pace] - PACE_WEIGHT[a.pace]);
}

// ---------------------------------------------------------------------------
// 上游并发闸门：默认档是本地 Ollama，同时开太多会全部卡住
// ---------------------------------------------------------------------------
let inflight = 0;
const waiters: Array<() => void> = [];
async function acquire() {
  while (inflight >= env.maxInflight) await new Promise<void>((r) => waiters.push(r));
  inflight++;
}
function release() {
  inflight--;
  waiters.shift()?.();
}

/**
 * 同一条帖子的同一个 agent 正在这个进程里生成时，第二个连接不要重复生成。
 * 刷新页面 / 开两个标签页都会走到这里 —— 没有这道闸，就是重复烧钱。
 */
const generating = new Set<string>();

// ---------------------------------------------------------------------------
// 吧友：一个用户 + 一批 agent = 他的吧
//
// 现在是固定班子（谁进来都是这几位）。要改成"每个人分到不同的一批"，
// 只需要改 joinBar 往里塞什么，读的这边一行都不用动。
// ---------------------------------------------------------------------------
const readBar = db.prepare(
  `SELECT m.agent_slug AS slug FROM memberships m JOIN agents a ON a.slug = m.agent_slug
   WHERE m.user_id = ? ORDER BY a.sort, m.agent_slug`,
);
const addMember = db.prepare(
  'INSERT OR IGNORE INTO memberships (user_id, agent_slug, joined_at) VALUES (?, ?, ?)',
);

function joinBar(userId: number): void {
  for (const p of PERSONAS) addMember.run(userId, p.slug, now());
}

/** 我的吧友。没入过就现场入一次 —— 老账号（在这张表存在之前注册的）也能自愈。 */
function myBar(userId: number): string[] {
  const mine = (readBar.all(userId) as { slug: string }[]).map((r) => r.slug);
  if (mine.length) return mine;
  joinBar(userId);
  return (readBar.all(userId) as { slug: string }[]).map((r) => r.slug);
}

// ---------------------------------------------------------------------------
// 成本账本
// ---------------------------------------------------------------------------
const insertUsage = db.prepare(
  `INSERT INTO usage (user_id, post_id, agent_slug, kind, model, prompt_tokens, completion_tokens, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const postOwner = db.prepare('SELECT user_id FROM posts WHERE id = ?');

/**
 * 往一栋楼里加一层。谁加的（user/agent）、第几楼、接的哪一楼，全由调用方算好 ——
 * 调度和落库分开，是为了让"排期"和"开口"两条路径都能用同一条 INSERT。
 */
const addFloor = db.prepare(
  `INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/**
 * `userId` 是第 6 个参数、可省 —— 走帖子的调用点不用改：postId 不为空又没传 userId 时，
 * 这里自己反查帖主补上。私聊 / 主动来消息没有 post_id，必须显式传，否则这笔记账掉出每用户额度那道闸。
 */
function recordUsage(
  postId: number | null,
  slug: string | null,
  kind: string,
  model: string,
  u: Usage,
  userId: number | null = null,
) {
  const owner =
    userId ?? (postId === null ? null : ((postOwner.get(postId) as { user_id: number } | undefined)?.user_id ?? null));
  insertUsage.run(owner, postId, slug, kind, model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, now());
}

// ---------------------------------------------------------------------------
// 印象更新：整条帖子只调一次，不是每个 agent 一次
// ---------------------------------------------------------------------------
type Finished = { slug: string; name: string; text: string };

/**
 * `postId` 为 null = 这次不是帖子里的回复，是私聊（relations.ts 也用这个函数）。
 * 账一律记在 `userId` 头上，不管有没有帖子。
 */
export async function updateImpressions(
  postId: number | null,
  userId: number,
  handle: string,
  post: string,
  said: Finished[],
) {
  if (!said.length) return;
  const shape: Record<string, string> = {};
  for (const s of said) shape[s.slug] = '';
  const raw = await chatOnce(
    [
      { role: 'system', content: '你在维护一个匿名树洞网站里几位网友的私人记忆。只输出 JSON，不要任何解释和代码块。' },
      {
        // 主语必须写死：这几行以前把"吧友自己的台词"直接摆在要求句前面，模型就把它记成了
        // "用户做过的事"（qc 的 QC-13：「他拍我肩膀，说屏幕关了再看…」——台词是起司的、动作是编的），
        // 再经 personas.ts 的「你以前跟他打过交道，你记得关于他的事」注回下一次回复。
        // 只有 `post` 是"这个人自己的话"；`said` 只是语气参考，明写不许当事实用。
        role: 'user',
        content: [
          `网名「${handle}」自己写下来的话（只有这些是这个人的事）：`,
          post,
          '',
          '下面是这几位网友自己说过的台词。它们只说明这些网友当时是什么口气，不是「这个人」说的话，也不是「这个人」做的事：',
          ...said.map((s) => `- ${s.slug}（${s.name}）说：${s.text}`),
          '',
          `请为每一位回复者各写一句他/她"下次再遇到「${handle}」这个人时会记住的、关于「${handle}」的事"。`,
          '要求：具体、有细节、不超过 30 字、不评价、不客套；句子的主语用「他 / 她」（别照抄网名，也别写"这个人"三个字），',
          '只能写上面「这个人自己写下来的话」里出现过的人和事。网友的台词只说明他们当时是什么口气：',
          '台词里说"我以前……"是那位网友自己的经历，绝不能记成「这个人」的经历；',
          '楼层里没出现过的动作（拍肩膀、递东西、看手机、关屏幕、擦桌子…）一律不写；',
          '也不许把网友自己的话、建议、心事写成「这个人」做过的事、说过的话或心里想的事。',
          '记的是这个人的样子（累、一个人扛、不知道在忙什么…），不是"他今天做了什么"的流水账；',
          '从他的话里实在看不出别的，就照着他的话写，不要拿网友的经历来填。',
          `输出格式（键必须是这些）：${JSON.stringify(shape)}`,
        ].join('\n'),
      },
    ],
    { tier: 'small', maxTokens: 400, onUsage: (u) => recordUsage(postId, null, 'impression', target('small').model, u, userId) },
  );

  const matched = raw.match(/\{[\s\S]*\}/);
  if (!matched) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(matched[0]) as Record<string, unknown>;
  } catch {
    return;
  }
  const up = db.prepare(
    `INSERT INTO impressions (user_id, agent_slug, text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, agent_slug) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
  );
  for (const s of said) {
    const t = obj[s.slug];
    if (typeof t === 'string' && t.trim()) up.run(userId, s.slug, t.trim().slice(0, 60), now());
  }
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------
type Vars = { userId: number | null };
const app = new Hono<{ Variables: Vars }>();

app.use('/api/*', async (c, next) => {
  const cookies = parseCookies(c.req.header('cookie'));
  c.set('userId', readSession(cookies[COOKIE_NAME]));
  await next();
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    llm: { baseURL: target('default').baseURL, model: target('default').model },
    agents: PERSONAS.length,
    // 服务端时钟的秒数（0=关）。跑 e2e 前先看一眼：开着的话，"恰好一条"的断言会飘。
    tick: env.tickIntervalSec,
    // 吧友自己起话头的密度（0=关）。同上：开着的话 e2e 的"恰好一条"也会飘。
    agentPostsPerDay: env.agentPostsPerDay,
    // 背往事枪（task-39）的开关（默认关，task-42）：阈值没拍之前不上线，重启后照这个字段核。
    memoryGun: env.memoryGun,
  }),
);

// ---- 账号 ----
const HANDLE_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/;

app.post('/api/auth/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { handle?: unknown; password?: unknown };
  const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!HANDLE_RE.test(handle)) return c.json({ error: '网名 2~16 位，只能是中英文、数字、下划线' }, 400);
  if (password.length < 8 || password.length > 200) return c.json({ error: '密码至少 8 位' }, 400);
  if (one('SELECT id FROM users WHERE handle = ? COLLATE NOCASE', handle)) {
    return c.json({ error: '这个网名有人用了' }, 409);
  }
  // ---- 节流：放在 scrypt 和入库**之前** ----
  // 不然刷注册就是在刷 CPU（一次 scrypt 几十毫秒）；上面两条 400/409 是免费的，不计数 ——
  // 否则正常用户填错一个字就先被自己罚一次。
  // 先看同来源那道（离他最近的），再看全站那道。
  const key = clientKey(c);
  const verdict = registerLimiter.take(key);
  if (!verdict.ok) {
    console.log(`[注册节流] 来源 ${key} 一小时内已经开过 ${env.registerPerIpHourly} 个号，还要等 ${verdict.waitMin} 分钟`);
    return c.json({ error: `这个网络开号开得太快了，过 ${verdict.waitMin} 分钟再来` }, 429);
  }
  if (env.registerPerDay > 0) {
    const today = one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', now() - REGISTER_DAY_MS)?.n ?? 0;
    if (today >= env.registerPerDay) {
      console.log(`[注册节流] 全站今天已经开了 ${today} 个号（上限 ${env.registerPerDay}），把来源 ${key} 挡在外面`);
      return c.json({ error: '今天洞里的新号满了，明天再来' }, 429);
    }
  }
  const id = Number(
    run('INSERT INTO users (handle, pass_hash, created_at) VALUES (?, ?, ?)', handle, hashPassword(password), now())
      .lastInsertRowid,
  );
  c.header('set-cookie', sessionCookie(signSession(id), 30 * 86_400));
  return c.json({ id, handle });
});

app.post('/api/auth/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { handle?: unknown; password?: unknown };
  const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const wait = loginWaitMinutes(handle);
  if (wait) return c.json({ error: `密码错太多次了，${wait} 分钟后再试` }, 429);
  const user = one<{ id: number; handle: string; pass_hash: string }>(
    'SELECT id, handle, pass_hash FROM users WHERE handle = ? COLLATE NOCASE', handle,
  );
  // 网名不存在和密码错误给同一个回答，别泄漏哪个网名存在
  if (!user || !verifyPassword(password, user.pass_hash)) {
    noteLoginFailure(handle);
    return c.json({ error: '网名或密码不对' }, 401);
  }
  clearLoginFailures(handle);
  c.header('set-cookie', sessionCookie(signSession(user.id), 30 * 86_400));
  return c.json({ id: user.id, handle: user.handle });
});

app.post('/api/auth/logout', (c) => {
  c.header('set-cookie', sessionCookie('', 0));
  return c.json({ ok: true });
});

app.get('/api/me', (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ user: null });
  const user = one<{ id: number; handle: string }>('SELECT id, handle FROM users WHERE id = ?', userId);
  return c.json({ user: user ?? null });
});

app.get('/api/usage', (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: '未登录' }, 401);
  return c.json(spent(userId));
});

// ---- 帖子 ----
app.get('/api/feed', (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: '未登录' }, 401);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 30) || 30, 1), 100);
  // 洞里没有别人 —— 这里只有你和吧友，别人的帖子不该出现
  const posts = rows<PostRow>(
    `SELECT p.id, p.user_id, p.content, p.created_at, p.author_slug, u.handle
     FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.user_id = ?
     ORDER BY p.id DESC LIMIT ?`,
    userId, limit,
  );
  if (!posts.length) return c.json({ posts: [] });

  const ids = posts.map((p) => p.id);
  const holes = ids.map(() => '?').join(',');
  // 楼层只给**已经说出口**的：还在等的人不出现在页面上（"贴吧不是排队叫号"）。
  // 谁在等、等几个，前端靠每帖一个 `pending` 数就够了 —— 具体是谁、几点到，是后台的事。
  const floors = rows<FloorRow>(
    `SELECT f.*, a.name, a.tagline, a.accent
     FROM floors f LEFT JOIN agents a ON a.slug = f.author_slug
     WHERE f.post_id IN (${holes}) AND f.state = 'done'
     ORDER BY f.seq`,
    ...ids,
  );
  const pendingRows = rows<{ post_id: number; n: number }>(
    `SELECT post_id, COUNT(*) AS n FROM floors WHERE post_id IN (${holes}) AND state = 'pending' GROUP BY post_id`,
    ...ids,
  );
  const floorsOf = new Map<number, FloorRow[]>();
  for (const f of floors) {
    const list = floorsOf.get(f.post_id) ?? [];
    list.push(f);
    floorsOf.set(f.post_id, list);
  }
  const pendingOf = new Map(pendingRows.map((r) => [r.post_id, Number(r.n)]));

  /** 楼主是这位吧友（吧友自己起的话头）还是一句话：`author_slug` 为 NULL = 你发的。 */
  const authorOf = (p: PostRow) => {
    if (!p.author_slug) return { kind: 'user' as const, handle: p.handle };
    const a = bySlug.get(p.author_slug);
    return {
      kind: 'agent' as const,
      slug: p.author_slug,
      name: a?.name ?? p.author_slug,
      tagline: a?.tagline ?? '',
      accent: a?.accent ?? '#888888',
    };
  };

  return c.json({
    posts: posts.map((p) => ({
      id: p.id,
      content: p.content,
      created_at: p.created_at,
      handle: p.handle,
      author: authorOf(p),
      pending: pendingOf.get(p.id) ?? 0,
      floors: (floorsOf.get(p.id) ?? []).map((f) => ({
        id: f.id, seq: f.seq,
        kind: f.author_kind,
        slug: f.author_slug, name: f.name, tagline: f.tagline, accent: f.accent,
        content: f.content, state: f.state,
        dueAt: f.due_at, at: f.replied_at, noteId: f.note_id,
      })),
    })),
  });
});

app.post('/api/posts', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: '未登录' }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { content?: unknown };
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return c.json({ error: '写点什么吧' }, 400);
  if (content.length > 2000) return c.json({ error: '最多 2000 字' }, 400);

  // 答不了的帖子，干脆不接下来 —— 别先收下再装作回了
  const blocked = gate(userId);
  if (blocked) return c.json({ error: blocked }, 429);

  const at = now();
  const id = Number(
    run('INSERT INTO posts (user_id, content, created_at) VALUES (?, ?, ?)', userId, content, at).lastInsertRowid,
  );

  // 谁来回这条、什么时候来，此刻定死 —— 之后每个 tick 只是照单执行，刷新页面不会重烧一遍钱。
  // 从"我的吧友"里挑，不是从全站人设里挑。楼号 2 起：1 楼是楼主（就是你，活在 posts 里）。
  const plan = planReplies(myBar(userId), content, at);
  plan.forEach((x, i) => {
    addFloor.run(id, 2 + i, 'agent', x.slug, 'pending', null, null, x.dueAt, null, at);
  });

  return c.json({
    id,
    agents: plan.map((x) => {
      const p = bySlug.get(x.slug);
      return {
        slug: x.slug, name: p?.name ?? x.slug, tagline: p?.tagline ?? '',
        accent: p?.accent ?? '#888888', dueAt: x.dueAt,
      };
    }),
  });
});

// ---- 你接一楼：留言板从"发帖 + 等回复"变成"一栋楼里几个人接着聊" ----
/**
 * 在任何一楼下面接话。**这句话本身不花钱**（你只是说了句话）—— 花钱的是"吧友回你"那一步，
 * 所以这里不拦成本闸门；排期那一步才过 `gate()`，撞额度就是没人回，不报错。
 *
 * 谁会来回你：**这帖里已经说过话的吧友**（他们更熟）。要是这帖里一位都还没开口
 * （比如刚发完帖就接一句），就没人回 —— 那不是坏了，是"还没人认识你"。
 */
app.post('/api/posts/:id/floors', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: '未登录' }, 401);
  const postId = Number(c.req.param('id'));
  const post = Number.isInteger(postId)
    ? one<{ id: number; user_id: number }>('SELECT id, user_id FROM posts WHERE id = ?', postId)
    : undefined;
  if (!post) return c.json({ error: '没有这帖' }, 404);
  if (post.user_id !== userId) return c.json({ error: '这不是你的帖子' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as { content?: unknown; noteId?: unknown };
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return c.json({ error: '写点什么吧' }, 400);
  if (content.length > 2000) return c.json({ error: '最多 2000 字' }, 400);
  const noteId = body.noteId === undefined || body.noteId === null ? null : Number(body.noteId);
  if (
    noteId !== null &&
    (!Number.isInteger(noteId) || !one('SELECT 1 AS x FROM floors WHERE id = ? AND post_id = ?', noteId, postId))
  ) {
    return c.json({ error: '接的那一楼不在这个帖子里' }, 400);
  }

  const at = now();
  // 楼号在一条 SQL 里算（MAX+1），不"先查再插" —— 两个请求同时接话不会抢同一个号
  const r = run(
    `INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
     SELECT ?, COALESCE(MAX(seq), 1) + 1, 'user', NULL, 'done', ?, ?, NULL, ?, ? FROM floors WHERE post_id = ?`,
    postId, content, noteId, at, at, postId,
  );
  const floorId = Number(r.lastInsertRowid);
  const mine = one<{ seq: number }>('SELECT seq FROM floors WHERE id = ?', floorId);
  const mySeq = mine?.seq ?? 0;

  const spoken = rows<{ slug: string }>(
    `SELECT DISTINCT author_slug AS slug FROM floors
     WHERE post_id = ? AND author_kind = 'agent' AND state = 'done' AND author_slug IS NOT NULL
     ORDER BY slug`,
    postId,
  );
  if (spoken.length && !gate(userId)) {
    const counts = rows<{ slug: string; n: number }>(
      `SELECT author_slug AS slug, COUNT(*) AS n FROM floors
       WHERE post_id = ? AND author_kind = 'agent' AND state IN ('pending', 'done') AND author_slug IS NOT NULL
       GROUP BY author_slug`,
      postId,
    );
    const countOf = new Map(counts.map((r) => [r.slug, Number(r.n)]));
    const bar = underFloorCap(
      spoken.flatMap((s) => {
        const p = bySlug.get(s.slug);
        return p ? [p] : [];
      }),
      countOf,
    );
    // 一到两位：多数时候一位，人多的帖里偶尔两位；谁开口同样由他自己判断（`replies.ts`）
    const want = bar.length >= 2 && Math.random() < 0.6 ? 2 : 1;
    let seq = mySeq;
    for (const p of pickResponders(bar, content, Math.random).slice(0, want)) {
      const [lo, hi] = PACE_DELAY[p.pace];
      seq++;
      addFloor.run(postId, seq, 'agent', p.slug, 'pending', null, floorId, at + lo + Math.floor(Math.random() * (hi - lo)), null, at);
    }
  }

  return c.json({ floor: { id: floorId, seq: mySeq, kind: 'user', content, at } });
});

// ---- 吧友名录 ----
/**
 * 这个用户洞里的**全体吧友**（前端右栏用）。
 * 必须来自"我的吧友"全表，不能只看"加过好友的"：**回帖人不限于好友** ——
 * 你没加他好友，他照样会来回你的帖。`unread` 是单聊里他说了、你还没看的条数。
 */
app.get('/api/agents/online', (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: '未登录' }, 401);
  const rawHour = c.req.query('hour');
  const parsedHour = rawHour === undefined ? new Date().getHours() : Number(rawHour);
  if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) {
    return c.json({ error: 'hour 必须是 0~23 的整数' }, 400);
  }
  const bar = myBar(userId);
  const slot = parsedHour < 11 ? 'morning' : parsedHour < 17 ? 'noon' : 'evening';
  const offset = slot === 'morning' ? 0 : slot === 'noon' ? 4 : 8;
  const selected = bar.slice(offset, offset + 4);
  const agents = (selected.length === 4 ? selected : bar.slice(0, 4)).flatMap((slug) => {
    const p = bySlug.get(slug);
    return p ? [{ slug: p.slug, name: p.name }] : [];
  });
  return c.json({ hour: parsedHour, slot, agents });
});

app.get('/api/agents', (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: '未登录' }, 401);
  const agents = myBar(userId).flatMap((slug) => {
    const p = bySlug.get(slug);
    if (!p) return [];
    const last = one<{ text: string | null; created_at: number }>(
      `SELECT text, created_at FROM dm_messages
       WHERE user_id = ? AND agent_slug = ? AND role = 'agent' AND state = 'done'
       ORDER BY id DESC LIMIT 1`,
      userId, slug,
    );
    return [
      {
        slug,
        name: p.name,
        tagline: p.tagline,
        accent: p.accent,
        friend: !!one('SELECT 1 AS x FROM friends WHERE user_id = ? AND agent_slug = ?', userId, slug),
        unread: Number(
          one<{ n: number }>(
            `SELECT COUNT(*) AS n FROM dm_messages
             WHERE user_id = ? AND agent_slug = ? AND role = 'agent' AND seen = 0 AND state = 'done'`,
            userId, slug,
          )?.n ?? 0,
        ),
        lastText: last?.text ?? null,
        lastAt: last?.created_at ?? null,
      },
    ];
  });
  return c.json({ agents });
});

// ---- 吧友的回帖：一条一条到，不是一起吐出来 ----
/**
 * 每次最多让**一位**到点的吧友说话。谁触发这件事有两个来源：
 *   1. 前端每几秒叫一次这个接口 —— 保证你开着页面时，回复一到就出现在眼前；
 *   2. 服务端自己的时钟（本文件末尾）—— 保证你**关掉页面**之后，
 *      吧友照着自己的作息继续说（产品决定："他们有自己的生活"，
 *      代价是不看也在花钱，这是明说的）。
 *
 * 为什么不是发帖时一次性吐出来（旧实现）：那正是"三个头像一起转"的聊天机器人观感。
 * 为什么不是"第 0 秒就全都到"：吧友有快有慢（PACE_DELAY），同一秒全冒出来就又变回机器人了。
 *
 * 只有**自己的**帖子能被 tick 到：别人的帖子连"存不存在"都不告诉他，
 * 也休想靠 tick 花掉别人的额度。
 */
type TickBody = {
  replies: { postId: number; slug: string; name: string; text: string; at: number }[];
  pending: number;
  error?: string;
};
type TickResult = { body: TickBody; blocked?: boolean };

/** 抄句兜底的小账（只进日志，不给前端）：命中几次 / 重说干净几次 / 直接判失败几层。 */
const copyStats = { hits: 0, cleaned: 0, dropped: 0, crossHits: 0, crossDropped: 0 };
/** 元叙述守门的小账（同上，`[元叙述]` 一档）：命中几次 / 重说干净几次 / 判失败几层。 */
const noteStats = { hits: 0, cleaned: 0, dropped: 0 };
/** 背往事守门的小账（同上，`[背往事]` 一档）：命中几次 / 重说干净几次 / 判失败几层。 */
const memoryStats = { hits: 0, cleaned: 0, dropped: 0 };

async function runFeedTick(userId: number): Promise<TickResult> {
  const pending = () =>
    Number(
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM floors f JOIN posts p ON p.id = f.post_id
         WHERE p.user_id = ? AND f.state = 'pending'`,
        userId,
      )?.n ?? 0,
    );

  const due = one<DueFloor>(
    `SELECT f.id AS floor_id, f.post_id, f.seq, f.author_slug, f.note_id, f.due_at, f.created_at, f.author_slug AS slug, p.content, p.author_slug AS post_author, u.handle
     FROM floors f
     JOIN posts p ON p.id = f.post_id
     JOIN users u ON u.id = p.user_id
     WHERE p.user_id = ? AND f.state = 'pending' AND f.author_kind = 'agent' AND COALESCE(f.due_at, 0) <= ?
     ORDER BY COALESCE(f.due_at, 0), f.id LIMIT 1`,
    userId, now(),
  );
  if (!due) return { body: { replies: [], pending: pending() } };

  // 帖子可能是之前发的，但钱可能是刚刚花完的 —— 这里拦一道，别打出去
  const blocked = gate(userId);
  if (blocked) return { body: { error: blocked, replies: [], pending: pending() }, blocked: true };

  const persona = due.slug ? bySlug.get(due.slug) : undefined;
  if (!persona) {
    run(`UPDATE floors SET state = 'failed' WHERE id = ?`, due.floor_id);
    return { body: { replies: [], pending: pending() } };
  }

  // 同一位吧友跨用户也只能同时生成一层：往事账本的读取、生成和记账必须串行，
  // 否则两个帖子会同时拿到同一个未讲过的 mem_index。
  const key = `persona:${persona.slug}`;
  if (generating.has(key)) return { body: { replies: [], pending: pending() } }; // 上一轮还没写完
  generating.add(key);
  try {
    const impression =
      one<{ text: string }>('SELECT text FROM impressions WHERE user_id = ? AND agent_slug = ?', userId, persona.slug)?.text ?? null;

    // 这栋楼里**已经说出口**的话，按楼号排。你自己那几层用你的网名当作者名 ——
    // 吧友读到的是"这个人又接了一句"，不是一串没有署名的话。
    const prior = rows<{ floor_id: number; author_kind: string; author_slug: string | null; name: string | null; content: string }>(
      `SELECT f.id AS floor_id, f.author_kind, f.author_slug, a.name, f.content
       FROM floors f LEFT JOIN agents a ON a.slug = f.author_slug
       WHERE f.post_id = ? AND f.state = 'done' AND f.content IS NOT NULL
       ORDER BY f.seq`,
      due.post_id,
    );
    const said: SaidLine[] = prior.map((r) => ({
      name: r.author_kind === 'agent' ? r.name ?? r.author_slug ?? '吧友' : due.handle,
      text: r.content,
    }));

    // 同一帖里**他自己**前面楼层已经说出口的话（task-20）：`pickMemory` 拿它把"讲过的往事"剔掉，
    // 免得同一位吧友在一栋楼里把同一件旧事讲第二遍。同一份 `prior`，不再查一次库。
    const mineSaid = prior
      .filter((r) => r.author_kind === 'agent' && r.author_slug === persona.slug)
      .map((r) => r.content);

    // 排期时写的是"接楼主"，可楼主之后又有人插了话 —— 那就接最新那一层，
    // 而不是接一个早就过时的靶子（feed 里的 noteId 前端要用的）。
    const lastFloor = prior.at(-1)?.floor_id ?? null;
    if (due.note_id === null && lastFloor !== null) {
      run('UPDATE floors SET note_id = ? WHERE id = ?', lastFloor, due.floor_id);
    }
    // `:642-644` 可能刚把数据库里的 note_id 改掉；due 是查询快照，不能拿它判断这次是不是接楼。
    // 只有数据库里确实挂了父楼，才把父楼原文交给模型；根楼的 prompt 必须逐字保持原样。
    const actualNoteId = one<{ note_id: number | null }>('SELECT note_id FROM floors WHERE id = ?', due.floor_id)?.note_id ?? null;
    const replyTo = actualNoteId === null
      ? null
      : one<{ name: string | null; content: string }>(
          `SELECT a.name, f.content FROM floors f LEFT JOIN agents a ON a.slug = f.author_slug WHERE f.id = ? AND f.content IS NOT NULL`,
          actualNoteId,
        );

    // 这一层 prompt 里**真的注进去的那一条往事**（没有再给就是 null）。往事由帖子话题决定讲不讲、
    // 同一帖里讲过的会剔掉（task-19/20）。接出来放变量里：`systemPrompt` 用它，第四把枪也拿它当尺子 ——
    // 判"背往事"只能比**这一条**，所以两边必须是同一个值，不许各算一次。
    const memory = pickMemory(persona, due.post_id, due.content, mineSaid, memoriesTold(persona.slug));

    const basePrompt = systemPrompt(persona, due.handle, impression, memory, said);
    const messages = [
      {
        role: 'system' as const,
        content: replyTo
          ? `${basePrompt}\n\n这一层是在接着前面那一层说。前面是${replyTo.name ?? '吧友'}写的：${replyTo.content}\n只接他说到的那个点，可以附和或不同意；不要争吵，不要写成长篇。`
          : basePrompt,
      },
      { role: 'user' as const, content: due.content },
    ];
    // 整条回复必须是**一行**。prompt 里写了"不换行、不空行"，但模型约每 30 条就有 1 条自己排起版来，
    // 所以在落库前折成空格：真人就是用空格断句的（42% 的真人树洞回复这么写），
    // "一行"由代码保证，不靠它听话。
    const fold = (s: string) => s.replace(/\s*\n+\s*/g, ' ').trim();
    // 模型"没什么可说"的时候会把一整句挤成一个字（实测回过一个"熬"）。那不叫回帖，那叫没说话。
    const slim = (s: string) => s.replace(/\s/g, '').length;
    // 35B 冷启动实测约 56–62 秒；同机实测可与 9B 共存且不互挤。闲置超过 5 分钟会卸载：本机未实测，勿视为结论。
    const selectedModel = pickModel({
      delayMs: (due.due_at ?? 0) - due.created_at,
      fast: env.model,
      slow: env.slowModel,
      afterSec: env.slowAfterSec,
    });
    const selectedTier = selectedModel === env.slowModel && env.slowModel ? 'slow' : 'default';
    const speak = async (extra: string | null): Promise<string> => {
      let a = '';
      await acquire();
      try {
        const msgs = extra ? [...messages, { role: 'user' as const, content: extra }] : messages;
        for await (const chunk of streamChat(msgs, {
          tier: selectedTier,
          maxTokens: persona.maxTokens,
          onUsage: (u) => recordUsage(due.post_id, persona.slug, 'reply', selectedModel, u),
        })) {
          a += chunk;
        }
      } finally {
        release();
      }
      return fold(a);
    };

    let text = await speak(null);
    if (slim(text) < 4) {
      // 宁可多花一次调用，也不让用户看见一个字的回帖。取更长的那次。
      const again = await speak('（你上面那句太短了，只挤出来一个字。对方还在等你的下半句。）');
      if (slim(again) > slim(text)) text = again;
    }
    // 抄句：模型会把同一帖里前几层的整句抄回来（baren 把 eval 改成线上同形后量到 r127 一处、
    // r128 三处，其中一条 100% 重合）。**给字的是引文本身，改措辞治不住** —— 所以在这一层不接受：
    // 重说一次；重说还抄就判失败、这层不上页面（不截断，也不改写后硬上）。
    // 两把枪缺一不可：`longestRun` 数字数的窗口（长句整段搬），`wholeRepeat` 数整句复读（只差尾标点/
    // 语气词的那种，字数会落在窗口下面 —— 帖7 那三层就是这么塌的）。日志标签分开，一份 log 里各数各的。
    const priorTexts = prior.map((r) => r.content);
    const checkCopy = (t: string) => {
      const run = longestRun(t, priorTexts);
      const same = wholeRepeat(t, priorTexts);
      const template = templateRepeat(t, priorTexts);
      const long = run.run >= COPY_RUN;
      const resequence = prior
         .filter((r) => r.author_kind === 'agent' && r.author_slug !== persona.slug && r.floor_id !== actualNoteId && r.content !== due.content)
         .find((r) => resequenceJaccard(t, r.content) >= 0.3)?.content ?? null;
       return { long, run: run.run, from: run.from, same, template, resequence };
    };
     const shadowResequence = prior
       .filter((r) => r.author_kind === 'agent' && r.author_slug !== persona.slug && r.floor_id !== actualNoteId && r.content !== due.content)
       .find((r) => resequenceJaccard(text, r.content) >= 0.2);
     if (shadowResequence) console.log(`[抄句·改字序·影子] post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} J=${resequenceJaccard(text, shadowResequence.content).toFixed(3)}`);
    const copy = checkCopy(text);
    if (copy.long || copy.same || copy.template || copy.resequence) {
      const tag = copy.resequence ? '[抄句·改字序]' : copy.long ? '[抄句]' : copy.same ? '[抄句·整句]' : '[抄句·模板]';
      const why = copy.resequence ? `与前面某层改字序二元组 J=${resequenceJaccard(text, copy.resequence).toFixed(3)}「${copy.resequence}」` : copy.long ? `与前面某层重合 ${copy.run} 字「${copy.from}」` : copy.same ? `整句跟前面某层一样「${copy.same}」` : `与前面某层共用${copy.template!.kind === 'prefix' ? '句首' : '句尾'}模板「${copy.template!.from}」`;
      copyStats.hits++;
      console.log(
        `${tag} 命中 ${copyStats.hits} 次（重说干净 ${copyStats.cleaned} / 丢弃 ${copyStats.dropped}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} ${why}`,
      );
      const again = await speak('（你上面那句几乎是在抄这帖里已经有人说过的话。用你自己的说法重说一遍，别重复别人的句子。）');
      const retry = checkCopy(again);
      if (retry.long || retry.same || retry.template || retry.resequence) {
        copyStats.dropped++;
        const tag1 = retry.resequence ? '[抄句·改字序]' : retry.long ? '[抄句]' : retry.same ? '[抄句·整句]' : '[抄句·模板]';
        const why1 = retry.resequence ? `重说后仍改字序复述 J=${resequenceJaccard(again, retry.resequence).toFixed(3)}「${retry.resequence}」` : retry.long ? `重说后仍重合 ${retry.run} 字「${retry.from}」` : retry.same ? `重说后还是同一句整句「${retry.same}」` : `重说后仍共用${retry.template!.kind === 'prefix' ? '句首' : '句尾'}模板「${retry.template!.from}」`;
        console.error(
          `${tag1} 丢弃 ${copyStats.dropped} 层（命中 ${copyStats.hits} / 重说干净 ${copyStats.cleaned}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} ${why1}`,
        );
        throw new Error(
          retry.long
            ? `重说了一遍还是在抄前面楼层的话（重合 ${retry.run} 字），这层不拿出来`
            : `重说了一遍还是一模一样的整句（「${retry.same}」），这层不拿出来`,
        );
      }
      copyStats.cleaned++;
      console.log(
        `${tag} 重说干净 ${copyStats.cleaned} 次（命中 ${copyStats.hits} / 丢弃 ${copyStats.dropped}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} 重合降到 ${retry.run} 字`,
      );
      text = again;
    }
    // 元叙述：模型偶尔把**给自己的自查备注**写进正文（r158 帖3 `随安SuiAan`：`(注：此回复严格遵循指令——
    // …长度约 38 字，无废话，无禁止词，无空行。)`），用户一眼看出这是"AI 交作业"。prompt 里没有这些字面串
    // （baren 192 条最终 prompt 逐字 grep 0 命中），所以**不许靠往 prompt 里加话去治** —— 纪律是 prompt 只许
    // 删除/还原/收窄。这里只做产品侧守门：重说一次（**不加任何提示语**，就是再采一次同一份 messages），
    // 还写自查的话就判失败、这层不上页面（不截断、不改写后硬上）。尺子只有 `replies.ts` 的 `metaNote` 一处。
    const note = metaNote(text);
    if (note) {
      noteStats.hits++;
      console.log(
        `[元叙述] 命中 ${noteStats.hits} 次（重说干净 ${noteStats.cleaned} / 丢弃 ${noteStats.dropped}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} 正文里出现了「${note}」`,
      );
      const again = await speak(null);
      const retryNote = metaNote(again);
      // 重说那次顺带再过一遍抄句那把枪：不然"元叙述重说"就成了绕开抄句兜底的后门。
      const retryCopy = checkCopy(again);
      if (retryNote || retryCopy.long || retryCopy.same) {
        noteStats.dropped++;
        const why = retryNote
          ? `重说后正文里还有自查的话「${retryNote}」`
          : `重说后改成抄前面楼层的话了（${retryCopy.long ? `重合 ${retryCopy.run} 字「${retryCopy.from}」` : `整句「${retryCopy.same}」`}）`;
        console.error(
          `[元叙述] 丢弃 ${noteStats.dropped} 层（命中 ${noteStats.hits} / 重说干净 ${noteStats.cleaned}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} ${why}`,
        );
        throw new Error(`${why}，这层不拿出来`);
      }
      noteStats.cleaned++;
      console.log(
        `[元叙述] 重说干净 ${noteStats.cleaned} 次（命中 ${noteStats.hits} / 丢弃 ${noteStats.dropped}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug}`,
      );
      text = again;
    }
    // 背往事（第四把枪，task-39）：往事是"要点不是台词"，可模型会把它整段背出来 —— task-45 的 21 条往事
    // 落盘后机器护栏全绿而人读判否（qc：「把履历念一遍」，逐字整条搬 13/96）。往事内容要留，枪负责把它
    // 从"照抄"逼成"改写"。判据只比**这一层真的注进去的那一条**（`memory`，窄口径；见 `replies.ts`）。
    // 形状与元叙述那把一样：同一份 messages 重说一次（**不加任何提示语**，纪律是 prompt 只许删除/还原/收窄），
    // 重说那趟**同样要过抄句枪与元叙述枪**（不然这条路径就成了那两把枪的后门）；还背就判失败、
    // 这层不上页面（不截断、不改写后硬上）。三个数分开记：命中 / 重说干净 / 丢弃。
    // **开关**（task-42，默认关）：阈值还没拍 —— Lead 的 r167 预登记按生产温度实测把 T=13 判否
    //（产品尺度预期丢弃率 15.6%~28.6%，>10% 生死线）⇒ 这一版默认不上线，`MEMORY_GUN=1` 才启用。
    // 关着时这一段整个不跑：不重说、不丢弃、三个计数恒为 0，正文照常渲染（与没装这把枪一样）。
    if (env.memoryGun) {
      const memo = recitesMemory(text, memory);
      if (memo.run) {
        memoryStats.hits++;
        console.log(
          `[背往事] 命中 ${memoryStats.hits} 次（重说干净 ${memoryStats.cleaned} / 丢弃 ${memoryStats.dropped}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} 跟这一层给的那条往事重合 ${memo.run} 字「${memo.from}」`,
        );
        const again = await speak(null);
        const retryMemo = recitesMemory(again, memory);
        const retryCopy = checkCopy(again);
        const retryNote = metaNote(again);
        if (retryMemo.run || retryCopy.long || retryCopy.same || retryNote) {
          memoryStats.dropped++;
          const why = retryMemo.run
            ? `重说了一遍还是把往事背了出来（跟那条往事重合 ${retryMemo.run} 字「${retryMemo.from}」）`
            : retryNote
              ? `重说后正文里还有自查的话「${retryNote}」`
              : `重说后改成抄前面楼层的话了（${retryCopy.long ? `重合 ${retryCopy.run} 字「${retryCopy.from}」` : `整句「${retryCopy.same}」`}）`;
          console.error(
            `[背往事] 丢弃 ${memoryStats.dropped} 层（命中 ${memoryStats.hits} / 重说干净 ${memoryStats.cleaned}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} ${why}`,
          );
          throw new Error(`${why}，这层不拿出来`);
        }
        memoryStats.cleaned++;
        console.log(
          `[背往事] 重说干净 ${memoryStats.cleaned} 次（命中 ${memoryStats.hits} / 丢弃 ${memoryStats.dropped}）：post=${due.post_id} floor=${due.floor_id} slug=${persona.slug} 重合降到 ${retryMemo.run} 字`,
        );
        text = again;
      }
    }
    if (!text) throw new Error('模型返回了空内容');
    if (slim(text) < 4) throw new Error('模型只挤出了一个字，没有说出完整的话');
    const at = now();
    run('UPDATE floors SET state = ?, content = ?, replied_at = ? WHERE id = ?', 'done', text, at, due.floor_id);
    const memoryIndex = memory === null ? -1 : persona.memories.findIndex((m) => m.text === memory);
    if (memoryIndex >= 0) {
      try {
        markMemoryTold(persona.slug, memoryIndex, at);
      } catch (e) {
        // 正文已经是 done；账本写失败只能告警，不能把已发出的回复改成 failed。
        console.error(`[往事账本] 写入失败但回复已保留：slug=${persona.slug} mem=${memoryIndex}`, e);
      }
    }

    // 根楼说完后，允许这栋楼再接 0–2 位；是否为根楼只看 DB 实际 note_id。
    // 接楼的 note_id 指向刚刚说完的这一层，后续 :642-644 会把它继续回指到最新楼。
    const rootNote = one<{ note_id: number | null }>('SELECT note_id FROM floors WHERE id = ?', due.floor_id)?.note_id ?? null;
    if (rootNote === null) {
      // 作者不能自己接自己；每位 agent 的 pending+done 由 floors 实算，failed 不计，达到上限就不再入池。
      const counts = rows<{ slug: string; n: number }>(
        `SELECT author_slug AS slug, COUNT(*) AS n FROM floors
         WHERE post_id = ? AND author_kind = 'agent' AND state IN ('pending', 'done') AND author_slug IS NOT NULL
         GROUP BY author_slug`,
        due.post_id,
      );
      const countOf = new Map(counts.map((r) => [r.slug, Number(r.n)]));
      const bar = underFloorCap(
        myBar(userId).map((slug) => bySlug.get(slug)).filter((p): p is Persona => !!p),
        countOf,
        persona.slug,
      );
      const next = bar
        .filter(() => Math.random() < FOLLOWUP_SPEAK_PROBABILITY)
        .slice(0, MAX_AGENT_FLOORS_PER_POST);
      const nextSeq = Number(one<{ seq: number }>('SELECT COALESCE(MAX(seq), 1) AS seq FROM floors WHERE post_id = ?', due.post_id)?.seq ?? 1);
      next.forEach((p, i) => {
        const [lo, hi] = PACE_DELAY[p.pace];
        addFloor.run(due.post_id, nextSeq + i + 1, 'agent', p.slug, 'pending', null, due.floor_id, at + lo + Math.floor(Math.random() * (hi - lo)), null, at);
      });
    }

    // 这栋楼的吧友都到齐了，才更新一次"他记得你"（一次调用，不是每人一次）
    const left = Number(
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM floors WHERE post_id = ? AND state = 'pending'`, due.post_id)?.n ?? 0,
    );
    // 印象只在**楼主自己的帖子**里更新：`impressions` 记的是"关于楼主这个人"的事。
    // 吧友自己起的帖（L-1）里，`p.content` 是那位吧友的生活，`u.handle` 却是楼主的网名 ——
    // 照旧跑就会把"他手全是狗毛""他后座箱饼馊了"记成楼主的经历（2026-10-05 线上实测：
    // 9 行印象全被吧友帖的正文污染、楼主自己那条被覆盖）。吧友之间的记忆是另一个功能，不在这个表里。
    if (!left && due.post_author === null) {
      try {
        // 同一位吧友可能在这帖里说了好几层 —— 取他最新那句，别让印象里出现两条一样的
        const bySlug = new Map<string, Finished>();
        for (const r of rows<Finished>(
          `SELECT f.author_slug AS slug, a.name, f.content AS text
           FROM floors f JOIN agents a ON a.slug = f.author_slug
           WHERE f.post_id = ? AND f.state = 'done' AND f.author_kind = 'agent' AND f.content IS NOT NULL
           ORDER BY f.seq`,
          due.post_id,
        )) {
          bySlug.set(r.slug, r);
        }
        // 楼主的话 + 你自己在这帖里接的每一层：他记住的是"这个人整场说了什么"，不只是开头那一句
        const mineText = rows<{ content: string }>(
          `SELECT content FROM floors
           WHERE post_id = ? AND author_kind = 'user' AND state = 'done' AND content IS NOT NULL
           ORDER BY seq`,
          due.post_id,
        );
        await updateImpressions(
          due.post_id,
          userId,
          due.handle,
          [due.content, ...mineText.map((m) => m.content)].join('\n'),
          [...bySlug.values()],
        );
      } catch {
        /* 印象失败不该影响"回复已经发出去了"这件事 */
      }
    }

    return { body: { replies: [{ postId: due.post_id, slug: persona.slug, name: persona.name, text, at }], pending: pending() } };
  } catch (e) {
    // 已经发布出去的正文不可撤回；catch 只负责把还没发出去的层标失败。
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[楼层生成失败] floor=${due.floor_id} post=${due.post_id} seq=${due.seq} author_slug=${due.author_slug} due_at=${due.due_at ?? 'null'} name=${err.name} message=${err.message} stack=${(err.stack ?? '').slice(0, 2000)}`);
    run(`UPDATE floors SET state = 'failed' WHERE id = ? AND state <> 'done'`, due.floor_id);
    return { body: { replies: [], pending: pending(), error: e instanceof Error ? e.message : String(e) } };
  } finally {
    generating.delete(key);
  }
}

// ---------------------------------------------------------------------------
// 吧友自己起话头（L-1）：谁该开新帖、多久开一次、正文怎么写 —— 全在 agent-post.ts
//
// 这里只补**写入通路**：读那半边早就支持吧友当楼主（`/api/feed` 的 `authorOf`），
// 但在这之前，全库唯一写 posts 的地方（用户发帖）永远写 author_slug = NULL。
// ---------------------------------------------------------------------------

/** 起帖失败（上游抽风 / 模型没写出来）之后先晾一会儿：时钟 5 秒后就来，不能变成重试风暴。 */
const POST_RETRY_MS = 10 * 60_000;
/** 全吧速率闸：保留 PACE_WEIGHT 择人，但成功一帖后按 perDay 间隔再消费下一位 overdue。 */
const nextAgentPostAt = new Map<number, number>();

/** 正在起帖的人 + 刚失败过的人（键都是 `userId:slug`）。跟 `generating` 同一套理由：同一件事别重复烧钱。 */
const starting = new Set<string>();
const postFailedAt = new Map<string, number>();

/** 抄旧帖这把枪的账（跟回帖那两把枪分开记：一份 log 里 `[抄句]`/`[抄句·整句]`/`[抄旧帖]` 各数各的）。 */
const postCopyStats = { hits: 0, cleaned: 0, dropped: 0 };

/** 账本：这位吧友上一次起帖是什么时候（没发过 → 0）。账本就是 `posts` 表 —— 不新增表、重启自愈。 */
const lastPostAt = db.prepare(
  'SELECT COALESCE(MAX(created_at), 0) AS at FROM posts WHERE user_id = ? AND author_slug = ?',
);

/**
 * "这个吧第一次被考虑"的时刻（`userId` → 毫秒）。只在**旋钮开着**的时候记，而且记下就不再变。
 * 它只影响"从来没起过帖"的人的开场相位；起过帖的人走真实账本，跟这个无关。
 */
const openingBase = new Map<number, number>();

/**
 * 这一轮里，这个用户吧里有没有人该起新话了 —— 有就**当场写完发出去**，紧跟 `planReplies`
 * 让别的吧友到楼里接话。返回新帖 id，没发返回 null。
 *
 * 三道顺序是有讲究的：
 * 1. `gate` 在生成**之前**：没钱了就不开口（一次上游都不会发生）；
 * 2. 发帖要排在"排接话"之前：楼层得挂在新帖的 id 上；
 * 3. 起话头的人**必须从接话名单里剔掉** —— 他不是自己接自己的话。
 */
async function maybeAgentPost(userId: number): Promise<number | null> {
  if (!(env.agentPostsPerDay > 0)) return null;
  const bar = myBar(userId).map((s) => bySlug.get(s)).filter((p): p is Persona => !!p);
  if (!bar.length) return null;

  const at = now();
  const nextAt = nextAgentPostAt.get(userId) ?? 0;
  if (at < nextAt) return null;
  // 开场基准：**第一次真的考虑这个人**的时候定下来，之后不再动（每轮重算的话相位跟着漂，永远不到点）
  let base = openingBase.get(userId);
  if (base === undefined) {
    base = at;
    openingBase.set(userId, base);
  }
  const poster = pickPoster(bar, env.agentPostsPerDay, at, (slug) =>
    Number((lastPostAt.get(userId, slug) as { at: number } | undefined)?.at ?? 0),
    base,
  );
  if (!poster) return null;
  const persona = bySlug.get(poster.slug);
  if (!persona) return null;

  const key = `${userId}:${poster.slug}`;
  if (starting.has(key)) return null;
  const failedAt = postFailedAt.get(key);
  if (failedAt !== undefined && at - failedAt < POST_RETRY_MS) return null;
  if (gate(userId)) return null;

  starting.add(key);
  try {
    // 最近几帖正文只用来"换个话题"，但它确实摆在模型面前（`postPrompt` 整段拼进去）⇒ 下面那把枪量它
    const recent = rows<{ content: string }>(
      'SELECT content FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 5',
      userId,
    ).map((r) => r.content);
    const sameBatchPrior = rows<{ content: string }>(
      `SELECT content FROM posts
       WHERE user_id = ? AND author_slug IS NOT NULL AND author_slug != ?
         AND created_at >= ?
       ORDER BY id DESC LIMIT 20`,
      userId, persona.slug, at - 20 * 60_000,
    ).map((r) => r.content);

    let text = await composePost(persona, recent, (u) =>
      recordUsage(null, persona.slug, 'post', target('default').model, u, userId),
    );

    // 抄旧帖：`recent` 是**摆在 prompt 里**的那几条原文（`postPrompt` 整段拼进去），所以它既是最可能的
    // 话题来源、也是最可能被照搬的句子。跟回帖那条守同一份纪律：量一遍，命中就重说，重说还抄就这轮
    // 不起帖（不截断、不改写后硬上）。三把尺子：长句、整句，以及不同整句共用的首/尾模板。
    const checkCopy = (t: string) => {
      const run = longestRun(t, recent);
      const same = wholeRepeat(t, recent);
      const template = templateRepeat(t, recent);
      const batch = batchRepeat(t, sameBatchPrior);
      return { long: run.run >= COPY_RUN, run: run.run, from: run.from, same, template, batch };
    };
    const copy = checkCopy(text);
    if (copy.long || copy.same || copy.template || copy.batch) {
      const tag = copy.batch ? '[抄旧帖·同拨]' : copy.long ? '[抄旧帖]' : copy.same ? '[抄旧帖·整句]' : '[抄旧帖·模板]';
      const why = copy.batch ? `与同拨帖子重合 ${copy.batch.run} 字「${copy.batch.from}」` : copy.long ? `与最近的帖子重合 ${copy.run} 字「${copy.from}」` : copy.same ? `整句跟最近的帖子一样「${copy.same}」` : `与最近帖子共用${copy.template!.kind === 'prefix' ? '句首' : '句尾'}模板「${copy.template!.from}」`;
      postCopyStats.hits++;
      console.log(
        `${tag} 命中 ${postCopyStats.hits} 次（重说干净 ${postCopyStats.cleaned} / 丢弃 ${postCopyStats.dropped}）：user=${userId} slug=${persona.slug} ${why}`,
      );
      const again = await composePost(
        persona,
        recent,
        (u) => recordUsage(null, persona.slug, 'post', target('default').model, u, userId),
        '（你上面那句几乎是在抄洞里最近别人写过的帖子。换一件你自己的事重说一遍，别重复别人的句子。）',
      );
      const retry = checkCopy(again);
      if (retry.long || retry.same || retry.template || retry.batch) {
        postCopyStats.dropped++;
        const tag1 = retry.batch ? '[抄旧帖·同拨]' : retry.long ? '[抄旧帖]' : retry.same ? '[抄旧帖·整句]' : '[抄旧帖·模板]';
        const why1 = retry.batch ? `重说后仍与同拨帖子重合 ${retry.batch.run} 字「${retry.batch.from}」` : retry.long ? `重说后仍与最近的帖子重合 ${retry.run} 字「${retry.from}」` : retry.same ? `重说后还是同一句整句「${retry.same}」` : `重说后仍共用${retry.template!.kind === 'prefix' ? '句首' : '句尾'}模板「${retry.template!.from}」`;
        console.error(
          `${tag1} 丢弃 ${postCopyStats.dropped} 条（命中 ${postCopyStats.hits} / 重说干净 ${postCopyStats.cleaned}）：user=${userId} slug=${persona.slug} ${why1}`,
        );
        // 这一轮不起帖：**不 INSERT**。挂上冷却，免得 tick 5 秒一次接着重试。
        postFailedAt.set(key, now());
        return null;
      }
      postCopyStats.cleaned++;
      console.log(
        `${tag} 重说干净 ${postCopyStats.cleaned} 次（命中 ${postCopyStats.hits} / 丢弃 ${postCopyStats.dropped}）：user=${userId} slug=${persona.slug} 重合降到 ${retry.run} 字`,
      );
      text = again;
    }

    const createdAt = now();
    const id = Number(
      run(
        'INSERT INTO posts (user_id, content, created_at, author_slug) VALUES (?, ?, ?, ?)',
        userId, text, createdAt, persona.slug,
      ).lastInsertRowid,
    );

    // 别的吧友路过这栋楼：跟用户发帖走同一条排期（`planReplies`），楼号也从 2 起（1 楼是楼主）
    const others = bar.map((p) => p.slug).filter((s) => s !== persona.slug);
    planReplies(others, text, createdAt).forEach((x, i) => {
      addFloor.run(id, 2 + i, 'agent', x.slug, 'pending', null, null, x.dueAt, null, createdAt);
    });

    postFailedAt.delete(key);
    nextAgentPostAt.set(userId, createdAt + DAY_MS / env.agentPostsPerDay);
    console.log(`[起帖] user=${userId} slug=${persona.slug} post=${id} 字数=${text.replace(/\s/g, '').length}`);
    return id;
  } catch (e) {
    // 这一轮没成：不是"他还没到点"，下一轮 tick 会立刻再选到他 —— 所以得记下失败时间晾一会儿
    postFailedAt.set(key, now());
    console.error('起帖出错：', e);
    return null;
  } finally {
    starting.delete(key);
  }
}

app.post('/api/feed/tick', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: '未登录' }, 401);
  const r = await runFeedTick(userId);
  // 起新话头跟在回帖后面、**同一次请求里做完**（e2e 要能确定地断言"这一下发出了一条新帖"）。
  // 顺序反了会白花一轮：先起帖的话，它自己那批 pending 楼层要等下一 tick 才轮到。
  await maybeAgentPost(userId);
  return r.blocked ? c.json(r.body, 429) : c.json(r.body);
});

// ---- 吧友的作息：服务端自己的时钟 ----
// ---------------------------------------------------------------------------
// 记忆与关系：加好友 / 单聊 / 主动来找你 —— 全在 relations.ts 里。
// 挂在时钟**之前**：时钟那一轮要调它的 `tickProactive`，页面一次都没叫也叫得动。
// ---------------------------------------------------------------------------
const relations = relationsRoutes({ recordUsage, gate, acquire, release, remember: updateImpressions });
app.route('/api', relations.app);

/**
 * 前端那份 tick 只保证"你开着页面时回复立刻刷出来"；页面关掉之后，靠这里让吧友照常说话
 * （产品决定：他们有自己的生活，代价是不看也在花钱 —— 用户 2026-10-05 拍板选这个）。
 *
 * 开销：每 tickIntervalSec 秒查一次库（一次 SELECT，没有到点的人就不花钱）；
 * 真正的钱花在"确实有人到点了"的时候，那本来就该花。
 *
 * TICK_INTERVAL_SEC=0 关掉它。**跑 e2e 必须关**：断言在数"恰好一条"，让它背着测试
 * 自己生成回复，断言就会飘（`server/src/e2e.ts` 默认打 8787，起 server 的人别忘了）。
 */
if (env.tickIntervalSec > 0) {
  let ticking = false;
  setInterval(() => {
    if (ticking) return; // 上一轮还没跑完，跳过这一次，别堆起来
    ticking = true;
    void (async () => {
      try {
        const users = rows<{ user_id: number }>(
          `SELECT DISTINCT p.user_id AS user_id
           FROM floors f JOIN posts p ON p.id = f.post_id
           WHERE f.state = 'pending' AND f.author_kind = 'agent' AND COALESCE(f.due_at, 0) <= ?
           ORDER BY p.user_id LIMIT 20`,
          now(),
        );
        for (const u of users) await runFeedTick(u.user_id);
        // 起新话头：跟回帖同一个钟，但**名单不是同一拨** —— 上面那条 SELECT 只找"有到点楼层的人"，
        // 而吧友起帖时用户可能一层 pending 都没有（新用户、冷清的吧）。所以这里按"有吧的人"取，
        // 到没到点由 `agent-post.ts` 按整个吧的密度 + 各人的上网习惯算；每人每轮最多一帖。
        const bars = rows<{ user_id: number }>(
          `SELECT DISTINCT user_id FROM memberships ORDER BY user_id LIMIT 20`,
        );
        for (const u of bars) void maybeAgentPost(u.user_id);
        // 主动来找你：跟回帖同一个钟（"他有自己的作息"）。关系那边自己先过三道闸
        // （总闸 / 安静间隔 / 当日上限），没好友、没聊过的人在这里一次上游都不会发生。
        await relations.tickProactive();
      } catch (e) {
        console.error('回帖时钟出错：', e);
      } finally {
        ticking = false;
      }
    })();
  }, env.tickIntervalSec * 1000).unref();
}

// ---------------------------------------------------------------------------
// 监工台：你在板子上拍板，这一票落进 data/board-decisions.jsonl —— 全在 board.ts 里
// （板子本身是静态页，写不了文件，所以它得有个口子；只认回环地址）
// ---------------------------------------------------------------------------
app.route('/api', boardRoutes());

// ---------------------------------------------------------------------------
// 生产：server 顺便把前端吐出去，上线只有一个进程、一个端口
// （开发时走 vite，这段不生效）
// ---------------------------------------------------------------------------
const dist = join(ROOT, 'web', 'dist');
const serveWeb = env.serveWeb && existsSync(join(dist, 'index.html'));
if (serveWeb) {
  app.use('*', serveStatic({ root: dist }));
  // 前端是单页应用，深链接（/x/y）没有对应文件，回落给 index.html 让前端自己路由。
  // /api/ 下面的未知路径不许回落 —— 否则"接口写错了"会返回一页 HTML，前端只看到解析失败。
  app.get('*', async (c, next) => (c.req.path.startsWith('/api/') ? c.notFound() : next()),
    serveStatic({ root: dist, path: 'index.html' }));
}

serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`述洞 server → http://127.0.0.1:${info.port}`);
  console.log(`  LLM: ${target('default').baseURL}  ${target('default').model}`);
  console.log(`  DB : ${env.dbPath}`);
  console.log(`  前端: ${serveWeb ? `${dist}（这个进程一起吐）` : '不在这里，web/ 用 vite 单独跑'}`);
  console.log(`  cookie Secure: ${env.cookieSecure ? '开（只走 https）' : '关'}`);
  // 会话密钥用的是哪一把：**没设 SESSION_SECRET 时就是那串公开的开发密钥**，
  // 谁都能拿它签一个 `1.9999999999999.<mac>` 冒充任何人 —— 这件事必须在启动时喊出来，
  // 不能像现在这样一声不响（`env.ts` 只在 NODE_ENV=production 时才拒绝启动）。
  if (env.sessionSecretIsDev) {
    console.log('  ⚠️  会话密钥：**正在用公开的开发密钥**（SESSION_SECRET 没设）—— 谁都能自己签 cookie 冒充别人。');
    console.log('      上线前必须在 server/.env 里设一把随机串，比如：');
    console.log('      node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"');
  } else {
    console.log(`  ✅ 会话密钥：SESSION_SECRET 已设（${env.sessionSecret.length} 字符）${env.sessionSecretOld ? '；另外认着 SESSION_SECRET_OLD（旧 cookie 还没过期）' : ''}`);
  }
  console.log(`  注册节流: 同来源 ${env.registerPerIpHourly || '不限'}/小时 · 全站 ${env.registerPerDay || '不限'}/天 · 来源判据 ${env.trustProxy ? '信任 X-Forwarded-For 最后一段' : 'socket 地址（不读 XFF）'}`);
});
