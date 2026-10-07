import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from './env.ts';
import { PERSONAS, personaText } from './personas.ts';

mkdirSync(dirname(env.dbPath), { recursive: true });

export const db = new DatabaseSync(env.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    handle     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- author_slug 有值 = 楼主是这位吧友（他起的话头）；NULL = 楼主是这个用户。
  -- 老库上这一列由下面那段 ALTER 补（见 task-7 的 schema 契约）。
  CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    author_slug TEXT
  );

  CREATE TABLE IF NOT EXISTS agents (
    slug    TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    tagline TEXT NOT NULL,
    accent  TEXT NOT NULL,
    persona TEXT NOT NULL,
    sort    INTEGER NOT NULL
  );

  -- 一个帖子 = 一栋楼：1 楼永远是楼主（活在 posts 里），2 楼起每层一行。
  -- 原来是 post_agents（一人一条、PK 卡死在 (post_id, agent_slug)）—— 那个形状
  -- 让"同一个吧友在这帖里说第二次""你自己接一楼""吧友接吧友的话"都表达不出来。
  --   seq       楼号，从 2 起（1 楼 = posts.content）
  --   note_id   这一楼在接哪一楼的话（NULL = 接楼主）
  --   due_at    只有 agent+pending 有：到点才有资格开口（"贴吧不是排队叫号"）
  --   replied_at 真正开口的时刻（"几分钟前"用它，不用 created_at）
  CREATE TABLE IF NOT EXISTS floors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL REFERENCES posts(id),
    seq         INTEGER NOT NULL,
    author_kind TEXT NOT NULL,
    author_slug TEXT,
    state       TEXT NOT NULL,
    content     TEXT,
    note_id     INTEGER,
    due_at      INTEGER,
    replied_at  INTEGER,
    created_at  INTEGER NOT NULL
  );

  -- "我加入的这个吧里，有哪些吧友"。
  -- 现在每个用户塞进去的都是同一批固定班子；但这张表在，意味着以后要
  -- "每个人分到属于自己的一批"只需要改塞什么，查询一行都不用动。
  CREATE TABLE IF NOT EXISTS memberships (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    agent_slug TEXT NOT NULL REFERENCES agents(slug),
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_slug)
  );

  -- 每个 agent 对这个用户的私人印象，是"他记得你"的唯一来源
  CREATE TABLE IF NOT EXISTS impressions (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    agent_slug TEXT NOT NULL REFERENCES agents(slug),
    text       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_slug)
  );

  -- 成本账本：每次上游调用落一条
  -- user_id 必须落：私聊和 agent 主动来消息没有 post_id，只靠 post_id 反查的话
  -- 这部分开销就掉出"每用户额度"那道闸，只剩全站闸拦得住（一个用户能吃掉全站的额度）。
  CREATE TABLE IF NOT EXISTS usage (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER,
    post_id           INTEGER,
    agent_slug        TEXT,
    kind              TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS memories_told (
    slug     TEXT NOT NULL,
    mem_index INTEGER NOT NULL,
    told_at  INTEGER NOT NULL,
    PRIMARY KEY (slug, mem_index)
  );
`);

/**
 * 老库补列。`CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做，
 * 所以在盘上的库（包括用户正在用的那个）得 ALTER 一次。
 *
 * 顺序要紧：**索引必须在这个 ALTER 之后建**。放在上面那段 exec 里的话，
 * 老库上没有 user_id 列，`CREATE INDEX ... (user_id)` 会直接
 * `no such column: user_id` 把服务启动打挂 —— 而临时库是新建的，
 * 永远看不到这个错，只在真库上炸。
 */
{
  const colsOf = (table: string) =>
    (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  const add = (table: string, col: string, decl: string) => {
    if (!colsOf(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };

  add('usage', 'user_id', 'INTEGER');
  add('posts', 'author_slug', 'TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at)');
  // tick 每几秒问一次"谁到点了"，这两条是它的路（楼号那条给 feed 用）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_floors_post ON floors(post_id, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_floors_due ON floors(state, due_at)`);
}

/**
 * 老库搬家：`post_agents`（一人一条）→ `floors`（一帖一栋楼）。
 * 真库里有已经在用的楼，必须原样搬过去 —— 楼号按"谁先说"排出来（2 楼起，1 楼是楼主）。
 *
 * 三条纪律：
 *   - **一个事务**：搬一半崩了比不搬更糟；
 *   - 搬完 `DROP TABLE post_agents`，并且上面已经**删掉**它的 `CREATE` ——
 *     不删的话下次启动又建一张空表回来，这段以后每次都搬一次空表（不报错，但脏）；
 *   - 只在旧表真的存在时跑，所以只在老库上生效一次，之后是 no-op。
 */
{
  const hasOld =
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'post_agents'`).all() as unknown[])
      .length > 0;
  if (hasOld) {
    // 更老的库（时钟功能之前）post_agents 里还没有 due_at / replied_at。
    // 这两列马上要随表一起消失，但 SELECT 里点了名 —— 缺列就是
    // `no such column: replied_at` 把启动直接打挂（临时库新建表，永远看不到这个错）。
    // 补成 NULL 就够了：下面的 COALESCE 会退到 created_at。
    const oldCols = (db.prepare(`SELECT name FROM pragma_table_info('post_agents')`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const col of ['due_at', 'replied_at']) {
      if (!oldCols.includes(col)) db.exec(`ALTER TABLE post_agents ADD COLUMN ${col} INTEGER`);
    }
    db.exec('BEGIN');
    try {
      db.exec(`
        INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
        SELECT post_id,
               1 + ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY COALESCE(replied_at, due_at, created_at), agent_slug),
               'agent', agent_slug, state, reply, NULL, due_at, replied_at,
               COALESCE(replied_at, due_at, created_at)
        FROM post_agents
      `);
      db.exec('DROP TABLE post_agents');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}


/** 启动时把人设同步进库（只更新文案，不动主键 —— 楼层靠 slug 认人，主键动了就全断了）。 */
const upsertAgent = db.prepare(`
  INSERT INTO agents (slug, name, tagline, accent, persona, sort)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET
    name = excluded.name, tagline = excluded.tagline, accent = excluded.accent,
    persona = excluded.persona, sort = excluded.sort
`);
for (const p of PERSONAS) {
  upsertAgent.run(p.slug, p.name, p.tagline, p.accent, personaText(p), p.sort);
}

export const now = () => Date.now();

const memoriesToldSelect = db.prepare('SELECT mem_index FROM memories_told WHERE slug = ? ORDER BY mem_index');
const memoriesToldInsert = db.prepare('INSERT OR IGNORE INTO memories_told (slug, mem_index, told_at) VALUES (?, ?, ?)');

export function memoriesTold(slug: string): number[] {
  return (memoriesToldSelect.all(slug) as { mem_index: number }[]).map((row) => row.mem_index);
}

export function markMemoryTold(slug: string, memIndex: number, at: number): void {
  memoriesToldInsert.run(slug, memIndex, at);
}
