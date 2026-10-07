/**
 * 监工台的"拍板"：你在板子上选一个，这一票要真的送到 Lead 手里。
 *
 * 为什么需要一个后端口子：那块板子是一个静态页（`web/public/progress/`，也能单开成
 * `board.html`），静态页写不了文件。要让"点了就算数"，只能有一个能落盘的小接口。
 * 落的是**只追加的流水**（`data/board-decisions.jsonl`，一行一票），不是覆盖写：
 * 同一个问题再选一次就再追加一行，读的时候取最后一行 —— 你改主意不算"改历史"。
 *
 * 安全（这里的信任边界是"谁能让我的板子变样"）有两道门，缺一不可：
 * 1) **只认回环地址**（服务端默认监听所有网卡，局域网里别人碰不到），也不需要你输密码。
 * 2) **只认本机的页面**（`Origin` 白名单：`null`＝`file://` 单开的那版，`127.0.0.1`/`localhost`＝5173 或 8787 那版）。
 *    第 2 道门是必需的：光看回环地址挡不住"你在浏览器里打开的一个陌生网页"——
 *    它发起的请求源地址同样是 127.0.0.1。`file://` 单开时页面要跨源读回执，所以顺手把 CORS
 *    头也发好（只发给白名单里的源），OPTIONS 预检在这儿收掉。
 * 校验照做：id/choice 必须是截断长度的非空串，落盘前不允许塞进换行（JSONL 会被搞坏）。
 */
import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env.ts';

// 测试用可以指到别处（e2e 不许碰真板子的票）
const DECISIONS = process.env.SHUDONG_BOARD_DECISIONS ?? join(ROOT, 'data', 'board-decisions.jsonl');

type Decision = { id: string; choice: string; at: number; note?: string };

/** 允许跨源的那几个源：`null`＝file:// 单开的板子，其余是本机 dev/prod 页面。 */
const OK_ORIGIN = /^(null|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?)$/;

function isLocal(c: Context): boolean {
  try {
    const a = getConnInfo(c).remote.address ?? '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  } catch {
    return false; // 拿不到来源地址就当不是本机
  }
}

/** 最后一行算数：改主意是再投一票，不是擦掉上一票。 */
function decisions(): Decision[] {
  if (!existsSync(DECISIONS)) return [];
  const out = new Map<string, Decision>();
  for (const line of readFileSync(DECISIONS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Decision;
      if (d && typeof d.id === 'string' && typeof d.choice === 'string') out.set(d.id, d);
    } catch {
      // 半行/坏行就跳过 —— 一张坏票不能让整块板子读不出来
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

const clean = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max && !v.includes('\n') && !v.includes('\r') ? v.trim() : null;

export function boardRoutes() {
  const app = new Hono();

  // 第 2 道门：带 Origin 的请求（＝浏览器发起的跨源/跨站请求）只放本机页面过。
  // 不带 Origin 的（curl、走 vite 代理的服务端调用）交给 isLocal 判 —— 见文件头的说明。
  app.use('/board/*', async (c, next) => {
    const o = c.req.header('origin');
    if (o === undefined) return next();
    if (!OK_ORIGIN.test(o)) return c.json({ error: '这块板子只认本机的浏览器' }, 403);
    c.header('Access-Control-Allow-Origin', o);
    c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type');
    c.header('Vary', 'Origin');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  });

  app.get('/board/decisions', (c) => c.json({ decisions: decisions() }));

  app.post('/board/decision', async (c) => {
    if (!isLocal(c)) return c.json({ error: '这块板子只认本机的浏览器' }, 403);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '这不是一段 JSON' }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const id = clean(b.id, 64);
    const choice = clean(b.choice, 200);
    const note = b.note == null ? undefined : clean(b.note, 500);
    if (!id) return c.json({ error: '缺 id（这颗选项属于哪个问题）' }, 400);
    if (!choice) return c.json({ error: '缺 choice（你选了什么）' }, 400);
    if (b.note != null && note == null) return c.json({ error: 'note 太长或带了换行' }, 400);

    const d: Decision = { id, choice, at: Date.now(), ...(note ? { note } : {}) };
    appendFileSync(DECISIONS, JSON.stringify(d) + '\n');
    return c.json({ ok: true, decision: d });
  });

  return app;
}
