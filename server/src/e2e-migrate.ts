/**
 * 老库升级的断言（不需要 server、不连真库）：
 * 先造一个"旧版 schema"的库（usage 没有 user_id 列，就是盘上那个库的样子），
 * 再让真正的启动路径（`db.ts`）去升级它。
 *
 * 为什么要有这一条：临时库都是**新建**的，走 `CREATE TABLE` 那条路，
 * 所以"老库缺列"这个错在临时库上永远不会出现 —— 而它只会在真库上炸。
 * 真的炸过一次：`idx_usage_user` 建在补列之前，老库启动直接
 * `Error: no such column: user_id`。
 */
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 只认这一个临时路径：**绝不允许**外部用 SHUDONG_DB 把它指到真库上去（上面第一句就是 rm）。 */
const path = join(tmpdir(), 'shudong-migrate-check.db');
for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });

// 1. 造旧库：usage 没有 user_id，并且里面已经有一行老账
{
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE usage (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id           INTEGER,
    agent_slug        TEXT,
    kind              TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  )`);
  old.prepare(
    `INSERT INTO usage (post_id, agent_slug, kind, model, prompt_tokens, completion_tokens, created_at)
     VALUES (1, 'ahe', 'reply', 'm', 10, 20, 1)`,
  ).run();

  // 旧版的帖子和楼层：一帖、两层楼（一层已经说过，一层还没到点）——
  // 2026-10 那轮把 post_agents 换成了通用的 floors 表，这些行必须原样搬过去。
  // 这里**故意造最老的形状**（连 due_at / replied_at 都还没有，那是时钟功能才加的列）：
  // 盘上真有这种库，搬家的 SELECT 点了这两列的名，缺列就 `no such column` 把启动打挂。
  old.exec(`CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    handle        TEXT NOT NULL UNIQUE,
    pass_hash     TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )`);
  old.exec(`CREATE TABLE posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    content       TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )`);
  old.exec(`CREATE TABLE post_agents (
    post_id       INTEGER NOT NULL,
    agent_slug    TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending',
    reply         TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (post_id, agent_slug)
  )`);
  old.prepare(`INSERT INTO users (id, handle, pass_hash, created_at) VALUES (1, '老用户', 'x', 1)`).run();
  old.prepare(`INSERT INTO posts (id, user_id, content, created_at) VALUES (1, 1, '旧帖', 1)`).run();
  old.prepare(
    `INSERT INTO post_agents (post_id, agent_slug, state, reply, created_at)
     VALUES (1, 'ahe', 'done', '我先说', 1)`,
  ).run();
  old.prepare(
    `INSERT INTO post_agents (post_id, agent_slug, state, reply, created_at)
     VALUES (1, 'mianmian', 'pending', NULL, 2)`,
  ).run();
  old.close();
}

// 2. 走真正的启动路径。SHUDONG_DB 要在 import 之前设好（env.ts 在 import 时就读了）
process.env.SHUDONG_DB = path;
const { db } = await import('./db.ts');

let failed = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const cols = (db.prepare(`SELECT name FROM pragma_table_info('usage')`).all() as { name: string }[]).map((c) => c.name);
ok('老库补上了 usage.user_id 列', cols.includes('user_id'), cols);
ok(
  'idx_usage_user 建上了',
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_user'`).all() as unknown[]).length === 1,
);

const row = db.prepare(`SELECT user_id, prompt_tokens, completion_tokens FROM usage WHERE id = 1`).get() as
  | { user_id: number | null; prompt_tokens: number; completion_tokens: number }
  | undefined;
ok('老账还在，没被升级弄丢', row?.prompt_tokens === 10 && row?.completion_tokens === 20, row);
ok('老账的 user_id 是 NULL（那时候还没有这一列）', row?.user_id === null, row);

const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
ok('老的 post_agents 表已经没了（不然下次启动又建回来）', !tables.includes('post_agents'), tables);

type MovedFloor = {
  seq: number; author_kind: string; author_slug: string | null;
  state: string; content: string | null; due_at: number | null; replied_at: number | null; created_at: number;
};
const floors = db
  .prepare(`SELECT seq, author_kind, author_slug, state, content, due_at, replied_at, created_at FROM floors ORDER BY seq`)
  .all() as MovedFloor[];
ok('老库的两层楼都搬进了 floors（一层都没丢）', floors.length === 2, floors);
ok('搬过来还是吧友的楼层（author_kind / author_slug / 正文 / 说没说都在）',
  floors.every((f) => f.author_kind === 'agent' && !!f.author_slug) && floors[0]?.content === '我先说' &&
    floors[0]?.state === 'done' && floors[1]?.state === 'pending',
  floors);
ok('楼号按开口先后从 2 起编（1 楼永远是楼主）', floors[0]?.seq === 2 && floors[1]?.seq === 3, floors.map((f) => f.seq));
ok('时间也是原来的（没到点的还是没到点）',
  floors[0]?.created_at === 1 && floors[0]?.replied_at === null && floors[1]?.due_at === null && floors[1]?.created_at === 2,
  floors);
const postCols = (db.prepare(`SELECT name FROM pragma_table_info('posts')`).all() as { name: string }[]).map((c) => c.name);
ok('posts 补上了 author_slug（NULL = 楼主是用户）', postCols.includes('author_slug'), postCols);
const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_floors_post','idx_floors_due')`).all() as { name: string }[]).map((i) => i.name).sort();
ok('楼层的两个索引都建上了', idx.join(',') === 'idx_floors_due,idx_floors_post', idx);

db.close();
for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });

console.log(failed ? `\n${failed} 条失败。` : '\n全部通过。');
process.exit(failed ? 1 : 0);
