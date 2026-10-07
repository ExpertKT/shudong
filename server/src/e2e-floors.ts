/**
 * 「一帖 = 一栋楼」端到端：接话、被接话、还有吧友接着别人的话往下说。
 *
 * 为什么值得单独一个脚本：楼层是新的调度单位（`floors` 替掉了 `post_agents`），而"他接的是**前面谁**那句话"
 * 这件事坏掉时也是**静默**的 —— 楼层照样出现、账目照样对，只是每个人都像在自言自语。
 * 所以这里不只看数据库：**拿一个录音代理夹在 server 和本机模型之间**，直接查上游请求体。
 * 契约（task-3 轮 1 之后，Lead 2026-10 批）：prompt 里**只放一句抽象提醒**（"你前面已经有人
 * 说过话了。不要重复他们说过的话。"），**不再放前楼楼层原文** —— 所以这里正面查提醒在、
 * 反面查任何前楼原文都不在（来自 `personas.ts:916-931` 那块）。
 *
 * 跑法（server 的 LLM_BASE_URL 指向本脚本代理；代理上游必须显式设 FLOORS_UPSTREAM，且时钟必须关掉）：
 *   $env:PORT='8913'; $env:SHUDONG_DB='F:\tmp\floors-e2e.db'; $env:TICK_INTERVAL_SEC='0';
 *   $env:LLM_BASE_URL='http://127.0.0.1:8917/v1'; $env:FLOORS_UPSTREAM='http://127.0.0.1:11434/v1'; pnpm start
 *   $env:SHUDONG_BASE='http://127.0.0.1:8913'; node src/e2e-floors.ts
 *
 * TICK_INTERVAL_SEC=0 是硬要求：这条脚本自己在数"每次 tick 最多一层楼"，
 * 服务端时钟开着就会背着它生成，断言会飘（同 e2e.ts）。
 * 跑完清临时库、清进程。只调本机免费模型。
 */
import { createServer, request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const upstreamUrl = process.env.FLOORS_UPSTREAM;
if (!upstreamUrl) {
  console.error('未配置录音代理上游；请显式设置 FLOORS_UPSTREAM —— 禁止默认直连真实模型(11434)');
  process.exit(2);
}
const upstream = new URL(upstreamUrl);
const agentRootLeg = process.env.E2E_FLOOR_LEG === 'agent';
console.log(`测试上游：${upstream.origin}`);
const proxyPort = Number(process.env.FLOORS_PROXY_PORT ?? 8917);

let failed = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 录音代理：抄一份上游请求体，再把响应原样（含 SSE 流）转发回去
// ---------------------------------------------------------------------------
type Rec = { path: string; json: any };
const seen: Rec[] = [];

const proxy = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'POST') {
      let json: any = null;
      try { json = JSON.parse(raw); } catch { /* 不是 JSON 就只留路径 */ }
      seen.push({ path: req.url ?? '', json });
    }
    const up = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`上游不通：${String(e)}`);
    });
    up.end(raw);
  });
});

await new Promise<void>((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(proxyPort, '127.0.0.1', resolve);
});
console.log(`录音代理 http://127.0.0.1:${proxyPort}/v1 → ${upstream.origin}`);

/** 这一窗口里发给模型的所有消息正文（system + user + assistant）拼成一坨 —— 只用来找"有没有带某句话"。 */
function upstreamText(from = 0, to = seen.length): string {
  const out: string[] = [];
  for (const r of seen.slice(from, to)) {
    if (!r.path.includes('/chat/completions')) continue;
    for (const m of (r.json?.messages ?? []) as any[]) out.push(String(m?.content ?? ''));
  }
  return out.join('\n');
}
const upstreamHas = (needle: string, from = 0, to = seen.length) => upstreamText(from, to).includes(needle);

/**
 * 只取**回帖生成**那几次请求的正文 —— 同一窗口里还夹着"更新印象"的调用（`index.ts:719-725`），
 * 那个调用**按设计**就把楼主自己的话 + 用户自己接的每一层原文摆在提示里（`index.ts:194`、`:723`），
 * 也把几位吧友最新的台词原文列进去（`index.ts:197`、`:724`）—— 那是 QC-13 定下来的形状、有"不许当成
 * 这个人的事"那几行管着，不是本契约要防的"前楼原文泄漏"。所以反面那条必须按形状挑请求，不能整窗口一锅量：
 * 判据＝system 里有 `personas.ts:907` 那句「你是回帖的人之一」。认不出的形状就不算生成请求（宁可漏，不误判）。
 */
const GEN_TAG = '你是回帖的人之一'; // personas.ts:907
function genRequests(from = 0, to = seen.length): any[][] {
  const out: any[][] = [];
  for (const r of seen.slice(from, to)) {
    if (!r.path.includes('/chat/completions')) continue;
    const msgs = (r.json?.messages ?? []) as any[];
    const sys = String(msgs.find((m: any) => m?.role === 'system')?.content ?? '');
    if (!sys.includes(GEN_TAG)) continue;
    out.push(msgs);
  }
  return out;
}
/** 这几批生成请求里发给模型的全部正文（拼一坨，只用来找"有没有带某句话"）。 */
const genText = (reqs: any[][]): string => reqs.flat().map((m) => String(m?.content ?? '')).join('\n');
const requestUserTexts = (req: any[]): string[] => req.filter((m) => m?.role === 'user').map((m) => String(m.content ?? ''));
const countOccurrences = (body: string, text: string): number => {
  let count = 0;
  for (let at = body.indexOf(text); at >= 0; at = body.indexOf(text, at + 1)) count++;
  return count;
};
/** 从回帖请求本身取实际注入的父楼，避免用请求之后的 feed 快照反推。 */
const injectedParent = (req: any[]): string | null => {
  const system = String(req.find((m) => m?.role === 'system')?.content ?? '');
  const match = system.match(/前面是[^：:]+写的：([\s\S]*?)(?:\n只接他说到的那个点|$)/);
  return match?.[1] ?? null;
};
const positionRegression = () => {
  const candidate = '倒了吧，省得占肚子。';
  const parent = '我也说一句：我上周也是这样，走到楼下才发现钥匙没带。';
  const user = '今早豆浆卖光了，有人问那锅剩的汤咋办，我说倒了吧，省得占肚子。';
  const original = [{ role: 'system', content: parent }, { role: 'user', content: user }];
  const e1Prime = [...original, { role: 'user', content: `另一个合法输入：${candidate}` }];
  const legalCount = (req: any[], text: string, legal: string[]) => legal.reduce((n, s) => n + countOccurrences(s, text), 0);
  const requestCount = (req: any[], text: string) => req.reduce((n, m) => n + countOccurrences(String(m?.content ?? ''), text), 0);
  const originalGreen = requestCount(original, candidate) === legalCount(original, candidate, [user, parent]);
  const e1PrimeRed = requestCount(e1Prime, candidate) !== legalCount(e1Prime, candidate, [user, parent]);
  const appended = [{ role: 'system', content: parent }, { role: 'user', content: `${user}${candidate}` }];
  const appendedRed = requestCount(appended, candidate) !== legalCount(appended, candidate, [user, parent]);
  console.log(`  ${e1PrimeRed ? 'ok  ' : 'FAIL'} ⑦ E1′：候选串出现在另一条消息，必须判泄漏`);
  console.log(`  ${originalGreen ? 'ok  ' : 'FAIL'} ⑦ 原误报：候选串只在合法输入内，继续豁免`);
  console.log(`  ${appendedRed ? 'ok  ' : 'FAIL'} ⑦ 合法 user 消息末尾追加非父楼正文，必须判泄漏`);
  if (!e1PrimeRed || !originalGreen || !appendedRed) process.exit(1);
};
positionRegression();
const providedMemory = (req: any[]): string | null => {
  const system = String(req.find((m) => m?.role === 'system')?.content ?? '');
  return system.match(/〔([\s\S]*?)〕/)?.[1] ?? null;
};

// ---------------------------------------------------------------------------
// 小客户端
// ---------------------------------------------------------------------------
type Floor = {
  id: number; seq: number; kind: string;
  slug: string | null; name: string | null; content: string | null;
  state: string; dueAt: number | null; at: number | null; noteId: number | null;
};
type Post = {
  id: number; content: string; handle: string;
  author: { kind: string; handle?: string; slug?: string };
  pending: number; floors: Floor[];
};
type Tick = { replies: { postId: number; slug: string; name: string; text: string; at: number }[]; pending: number; error?: string };

async function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* 非 JSON 原样留着 */ }
  return { status: res.status, body };
}

/** 注册 + 拿 cookie（每个用户一份，脚本里就两三个人，不值得做 cookie jar）。 */
async function login(tag: string) {
  const handle = `${tag}${Date.now() % 100000}`;
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, password: 'shudong-test-123' }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  if (res.status >= 300 || !cookie) {
    console.log(`  FAIL 注册 ${tag} — ${res.status}`);
    process.exit(1);
  }
  return { handle, cookie };
}

const feedOf = async (cookie: string, postId: number): Promise<Post | null> => {
  const r = await req('GET', '/api/feed?limit=100', { cookie });
  return ((r.body?.posts ?? []) as Post[]).find((p) => p.id === postId) ?? null;
};
const tickOf = async (cookie: string) => {
  const r = await req('POST', '/api/feed/tick', { cookie });
  const t = (r.body ?? {}) as Tick;
  t.replies ??= [];
  return { ...t, status: r.status };
};
const usageOf = async (cookie: string) => {
  const r = await req('GET', '/api/usage', { cookie });
  return Number(r.body?.userToday ?? -1);
};

// ---------------------------------------------------------------------------
console.log('\n[1] 没登录：接话和看帖都不行');
{
  ok('未登录接话 → 401', (await req('POST', '/api/posts/1/floors', { body: { content: '喂' } })).status === 401);
  ok('未登录看 feed → 401', (await req('GET', '/api/feed')).status === 401);
}

console.log('\n[2] 发一帖：楼主是你（不是一层楼），回帖人在发帖那刻就排好了');
const POST_TEXT = '周三了，还是每天加班到十点。今天在地铁上突然想不起来自己为什么要这么拼。';
let postId = 0;
let userPostId = 0;
let plan: { slug: string; dueAt: number }[] = [];
const A = await login('楼主');
{
  const r = await req('POST', '/api/posts', { cookie: A.cookie, body: { content: POST_TEXT } });
  postId = Number(r.body?.id ?? 0);
  plan = (r.body?.agents ?? []) as { slug: string; dueAt: number }[];
  userPostId = postId;
  ok('发帖 200', r.status === 200 && postId > 0, `id=${postId}`);
  ok('发帖时就定下了谁什么时候来', plan.length > 0, plan.map((a) => `${a.slug}+${Math.round((a.dueAt - Date.now()) / 1000)}s`).join(' '));

  const f = await feedOf(A.cookie, postId);
  ok('楼主渲染成"你"（author_slug 为 NULL 的帖子也有作者）', f?.author.kind === 'user' && f?.author.handle === A.handle, f?.author);
  ok('楼主不是 floors 里的一层（1 楼永远在 posts 里）', !(f?.floors ?? []).some((fl) => fl.seq === 1));
  ok('刚发完：没人开口，pending 就是排期人数', (f?.floors.length ?? -1) === 0 && f?.pending === plan.length, `floors=${f?.floors.length} pending=${f?.pending}/${plan.length}`);

  const empty = await tickOf(A.cookie);
  ok('刚发完 tick：没人到点，一层楼都不出', empty.replies.length === 0 && empty.pending === plan.length, `pending=${empty.pending}`);
}

console.log('\n[3] 等第一位到点的人开口');
// 腿2不依赖 proactive：直接在用户帖子中由夹具预置已完成父楼 F。
let first: Floor | null = null;
if (agentRootLeg) {
  postId = userPostId;
  const dbPath = process.env.SHUDONG_DB;
  const tmpRoot = resolve('F:/tmp') + sep;
  const resolvedDb = dbPath ? resolve(dbPath) : '';
  if (!dbPath || !(resolvedDb + sep).startsWith(tmpRoot)) throw new Error('agent腿必须显式传入临时数据库 SHUDONG_DB');
  const db = new DatabaseSync(resolvedDb);
  const max = db.prepare('SELECT COALESCE(MAX(seq), 1) AS seq FROM floors WHERE post_id = ?').get(postId) as any;
  const nowMs = Date.now();
  const content = '夹具预置的agent父楼正文，专用于验证真实父楼注入。';
  const r = db.prepare("INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at) VALUES (?, ?, 'agent', ?, 'done', ?, NULL, ?, ?, ?)").run(postId, Number(max.seq) + 1, 'tutu', content, nowMs, nowMs, nowMs);
  first = { id: Number(r.lastInsertRowid), postId, seq: Number(max.seq) + 1, kind: 'agent', slug: 'tutu', name: 'tutu', state: 'done', content, noteId: null, at: nowMs, dueAt: nowMs } as Floor;
  const f2Content = '夹具预置的第二条agent正文，必须保持请求上下文隔离。';
  db.prepare("INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at) VALUES (?, ?, 'agent', ?, 'done', ?, NULL, ?, ?, ?)").run(postId, Number(max.seq) + 2, 'yushan', f2Content, nowMs, nowMs, nowMs);
  console.log(`       夹具预置已完成父楼 F=${first.id}；F2=${Number(first.id) + 1} 为非目标 agent 原文；G 排期由夹具，生成与父楼注入走产品tick`);
}
{
  const t0 = Date.now();
  let firstTicks = 0;
  while (Date.now() - t0 < (agentRootLeg ? 300_000 : 45_000) && !first) {
    firstTicks++;
    const tick = await tickOf(A.cookie);
    const f = await feedOf(A.cookie, postId);
    first = (f?.floors ?? []).find((fl) => fl.kind === 'agent' && fl.state === 'done') ?? null;
    if (agentRootLeg) console.log(`       根帖首层等待：第 ${firstTicks} 次 tick，${Math.round((Date.now() - t0) / 1000)} 秒，pending=${f?.pending ?? '?'}，${first ? `已完成 ${first.seq}楼` : '尚未完成'}${tick.error ? `，错误=${tick.error}` : ''}`);
    if (!first) await sleep(1000);
  }
  ok('到点的那位开口了，落在 floors 里', !!first, first ? `${first.slug} ${first.seq}楼` : '45 秒内没人说话');
  ok('他的 noteId 是 NULL（接的是楼主，不是别人的楼）', !!first && first.noteId === null, first?.noteId);
  ok('他带着正文和真实开口时刻', !!first?.content && !!first.at, first ? `"${first.content}"` : '');
}

console.log('\n[4] 你接一楼 + 吧友接着往下说');
const myId: number[] = [];
const mark0 = seen.length;
let perTickMax = 0;
const tickErrors: string[] = [];
{
  const myText = '我也说一句：我上周也是这样，走到楼下才发现钥匙没带。';
  const before = await feedOf(A.cookie, postId);
  const maxSeq = Math.max(...(before?.floors ?? []).map((f) => f.seq), 1);
  const r = await req('POST', `/api/posts/${postId}/floors`, { cookie: A.cookie, body: { content: myText, noteId: first?.id ?? null } });
  ok('接一楼 200', r.status === 200, JSON.stringify(r.body));
  const mine = Number(r.body?.floor?.id ?? 0);
  myId.push(mine);
  ok('楼号接得上（比前面所有楼层都大）', Number(r.body?.floor?.seq ?? 0) > maxSeq, `${r.body?.floor?.seq} > ${maxSeq}`);

  const after = await feedOf(A.cookie, postId);
  const seenMine = (after?.floors ?? []).find((f) => f.id === mine);
  ok('**不用等 tick**，feed 里立刻看得见你这层', !!seenMine);
  ok('它是 user 层，正文就是你写的', seenMine?.kind === 'user' && seenMine?.content === myText, seenMine?.content);
  ok('它接的是你点的那层（noteId 原样带着）', seenMine?.noteId === (first?.id ?? null), seenMine?.noteId);
  ok('你一接话 pending 就涨了（有人被排上来回你）', (after?.pending ?? 0) > (before?.pending ?? 0), `${before?.pending} → ${after?.pending}`);

  ok('空话 → 400', (await req('POST', `/api/posts/${postId}/floors`, { cookie: A.cookie, body: { content: '   ' } })).status === 400);
  ok('超过 2000 字 → 400', (await req('POST', `/api/posts/${postId}/floors`, { cookie: A.cookie, body: { content: 'x'.repeat(2001) } })).status === 400);
  ok('noteId 不是这帖的楼层 → 400', (await req('POST', `/api/posts/${postId}/floors`, { cookie: A.cookie, body: { content: '喂', noteId: 999999 } })).status === 400);

  // 一边 tick 一边等：等到（a）有人接了你这层、（b）同一位吧友说了不止一次。
  // 每 15 秒没进展就再插一句 —— 插话会把新的排期推上来（排期的人从"已经说过话的吧友"里挑）。
  let seededAgentFloorId: number | null = null;
  if (agentRootLeg) {
    const dbPath = process.env.SHUDONG_DB;
    if (!dbPath || !dbPath.replaceAll('\\', '/').startsWith('F:/tmp/')) throw new Error('agent腿必须显式传入临时数据库 SHUDONG_DB');
    const db = new DatabaseSync(dbPath);
    const f = db.prepare("SELECT id, post_id, seq, author_slug, content FROM floors WHERE post_id = ? AND author_kind = 'agent' AND state = 'done' AND content IS NOT NULL ORDER BY id DESC LIMIT 1").get(postId) as any;
    if (!f) throw new Error('agent腿找不到可用已完成父楼');
    const slug = f.author_slug === 'tutu' ? 'yushan' : 'tutu';
    const max = db.prepare('SELECT COALESCE(MAX(seq), 1) AS seq FROM floors WHERE post_id = ?').get(postId) as any;
    const nowMs = Date.now();
    const r = db.prepare("INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at) VALUES (?, ?, 'agent', ?, 'pending', NULL, ?, ?, NULL, ?)").run(postId, Number(max.seq) + 1, slug, f.id, nowMs, nowMs);
    seededAgentFloorId = Number(r.lastInsertRowid);
    console.log(`       夹具排入 agent→agent 层 G=${seededAgentFloorId}，父楼 F=${f.id}(${f.author_slug})，产品tick负责生成与注入`);
  }
  const t0 = Date.now();
  const done = new Map<number, Floor>();
  let agentAgentFloor = false;
  let lastFloorSummary = '';
  let nextInterject = Date.now() + 15_000;
  let round = 1;
  const enough = () => {
    if (agentRootLeg && seededAgentFloorId !== null) return done.get(seededAgentFloorId)?.state === 'done';
    const all = [...done.values()];
    const slugs = new Map<string, number>();
    for (const f of all) if (f.slug) slugs.set(f.slug, (slugs.get(f.slug) ?? 0) + 1);
    return all.some((f) => f.noteId !== null && myId.includes(f.noteId)) && [...slugs.values()].some((n) => n >= 2);
  };
  while (Date.now() - t0 < 180_000 && !enough()) {
    const t = await tickOf(A.cookie);
    if (t.error) tickErrors.push(t.error);
    perTickMax = Math.max(perTickMax, t.replies.length);
    const f = await feedOf(A.cookie, postId);
    for (const fl of f?.floors ?? []) done.set(fl.id, fl);
    agentAgentFloor = [...done.values()].some((fl) =>
      fl.kind === 'agent' && fl.noteId !== null && !myId.includes(fl.noteId) && done.get(fl.noteId)?.kind === 'agent' && done.get(fl.noteId)?.state === 'done');
    lastFloorSummary = `${(f?.floors ?? []).map((fl) => `${fl.seq}楼${fl.slug ?? '你'}:kind=${fl.kind},note=${fl.noteId},state=${fl.state}`).join(' ')}（还等着 ${f?.pending ?? 0} 位）`;
    console.log(`       排期观察：${lastFloorSummary}`);
    if (!enough() && (f?.pending ?? 0) === 0 && Date.now() > nextInterject && round <= 4) {
      round++;
      const words = `再说一句（第 ${round} 次）：今天也在加班，路上买了碗面。`;
      const r2 = await req('POST', `/api/posts/${postId}/floors`, { cookie: A.cookie, body: { content: words, noteId: [...done.values()].at(-1)?.id ?? null } });
      if (r2.status === 200) myId.push(Number(r2.body?.floor?.id ?? 0));
      nextInterject = Date.now() + 15_000;
    }
    if (!enough()) await sleep(1000);
  }
  const all = [...done.values()];

  if (agentRootLeg) {
    console.log(`       夹具排入的 agent→agent 层：${agentAgentFloor ? '拿到' : '未拿到'}，已等 ${Math.round((Date.now() - t0) / 1000)} 秒`);
    ok('夹具排入的 agent→agent 层已完成', seededAgentFloorId !== null && done.get(seededAgentFloorId)?.state === 'done', `G=${seededAgentFloorId}；最后排期：${lastFloorSummary}`);
  }
  ok('每次 tick 最多一层楼', perTickMax <= 1, `最多 ${perTickMax} 层`);
  ok('tick 一路没报错', tickErrors.length === 0, tickErrors);
  if (agentRootLeg) console.log('       （腿2跳过吧友回帖判据：目标楼层三条归腿1）');
  else ok('吧友回了你这层（新楼层的 noteId 指着你接的那一楼）',
    all.some((f) => f.noteId !== null && myId.includes(f.noteId)),
    all.map((f) => `${f.seq}楼${f.slug}:note=${f.noteId}`).join(' '));

  const slugs = new Map<string, number>();
  for (const f of all) if (f.kind === 'agent' && f.slug) slugs.set(f.slug, (slugs.get(f.slug) ?? 0) + 1);
  const twice = [...slugs.entries()].filter(([, n]) => n >= 2);
  if (agentRootLeg) console.log('       （腿2跳过同一吧友多次发言判据：目标楼层三条归腿1）');
  else ok('同一位吧友能在这帖里说多次', twice.length > 0, twice.map(([s, n]) => `${s}×${n}`).join(' '));

  const ordered = (await feedOf(A.cookie, postId))?.floors ?? [];
  ok('feed 里的楼层按楼号升序、没有重复楼号',
    ordered.every((f, i, a) => i === 0 || f.seq > (a[i - 1]?.seq ?? 0)),
    ordered.map((f) => `${f.seq}`).join(','));

  // 关键的一条：接话时必须看见**目标楼层**；其余非目标 agent 楼层全文不得塞进生成请求。
  // “目标楼层”＝帖子里有楼层把 noteId 指向它的那些层；这些父楼原文按 index.ts:652-658 的设计会注入。
  // 两面都只看 `genText` 挑出来的回帖生成请求（同窗口里"更新印象"那个按设计就带原文，见函数上的注释）。
  const SAID_REMINDER = '这一帖里，你前面已经有人说过话了。不要重复他们说过的话。'; // personas.ts:919，改文案就要同步这里
  const gen = genRequests(mark0, seen.length);
  const body = genText(gen);
  ok('窗口内确实发生回帖生成请求', gen.length > 0, `窗口 ${mark0} → ${seen.length} 次请求，其中回帖生成 ${gen.length} 次；无证据不得判绿`);
  ok('生成时发给模型的请求体里带着"前面有人说过话"的提醒', body.includes(SAID_REMINDER),
    `窗口 ${mark0} → ${seen.length} 次请求，其中回帖生成 ${gen.length} 次`);
  // 目标楼层断言只看实际录音请求，不看请求之后的 feed 快照：排期未轮到目标层时跳过，避免把随机调度当成失败。
  const targetProduced = all.some((f) => f.kind === 'agent' && f.noteId !== null && myId.includes(f.noteId));
  const targetReqs = gen.filter((req) => genText([req]).includes(myText));
  if (!targetProduced) {
    console.log(`       （跳过目标楼层请求断言：本窗口没有吧友实际接 ${myText}）`);
  } else {
    ok('生成时发给模型的请求体里逐字包含本次目标楼层原文', targetReqs.length > 0 && targetReqs.every((req) => {
      const system = String(req.find((m: any) => m?.role === 'system')?.content ?? '');
      return system.includes(myText);
    }), `目标楼层已落库，匹配生成请求 ${targetReqs.length} 次`);
    ok('目标楼层生成请求来自独立落库楼层证据', targetReqs.length > 0,
      `agent noteId→user floor: ${all.filter((f) => f.kind === 'agent' && f.noteId !== null && myId.includes(f.noteId)).length}`);
    const expectedParents = all
      .filter((f) => f.kind === 'agent' && f.noteId !== null && myId.includes(f.noteId))
      .map((f) => all.find((parent) => parent.id === f.noteId)?.content)
      .filter((t): t is string => !!t);
    ok('非根楼生成请求逐字包含独立来源父楼原文', expectedParents.length > 0 && targetReqs.some((req) => expectedParents.some((t) => genText([req]).includes(t))),
      `独立父楼 ${expectedParents.length} 条，目标请求 ${targetReqs.length} 次`);
  }
  // 反面：允许注入的父楼文本来自 feed 的 noteId 关系，而不是从同一个请求反推，避免自指放行。
  // 太短的（<6 字）不参与，避免撞上固定文案。
  const agentTexts = all
    .filter((f) => f.kind === 'agent' && f.content && f.content !== myText && f.content !== POST_TEXT)
    .map((f) => f.content as string)
    .filter((t) => t.replace(/\s/g, '').length >= 6);
  const leaks = gen.flatMap((req) => {
    const legalInputs = [...new Set([POST_TEXT, myText, injectedParent(req), providedMemory(req)].filter((t): t is string => !!t))];
    return agentTexts.filter((t) => {
      const requestCount = req.reduce((n, m) => n + countOccurrences(String(m?.content ?? ''), t), 0);
      const legalCount = legalInputs.reduce((n, input) => n + countOccurrences(input, t), 0);
      return requestCount !== legalCount && genText([req]).includes(t);
    }).map((t) => ({ t, req }));
  });
  const leakPairs = gen.filter((req) => {
    const p = injectedParent(req);
    return !!p && agentTexts.includes(p);
  });
  if (agentRootLeg) {
    console.log(`       真实父楼证据 ${leakPairs.length} 个；生成请求 ${gen.length} 个`);
    ok('反面断言有真实证据：窗口里至少有一个请求注入了非目标 agent 父楼原文', leakPairs.length > 0,
      `真实父楼证据 ${leakPairs.length} 个；生成请求 ${gen.length} 个`);
  }
  ok('生成时发给模型的请求体里**没有**非目标 agent 楼层原文', leaks.length === 0,
    leaks.length ? leaks.map(({ t, req }) => ({ text: t.length > 40 ? `${t.slice(0, 40)}…` : t, parent: injectedParent(req), users: requestUserTexts(req) })) : `逐请求检查 ${agentTexts.length} 条 agent 原话，父楼只按实际注入放行`);
  console.log(`       这一帖现在：${ordered.map((f) => `${f.seq}楼${f.slug ?? '你'}`).join(' ')}（还等着 ${(await feedOf(A.cookie, postId))?.pending ?? 0} 位）`);
}

console.log('\n[5] 空 tick 不花 token');
{
  const beforeGen = genRequests(mark0, seen.length).length;
  const t = await tickOf(A.cookie);
  if (t.replies.length === 0) {
    const afterGen = genRequests(mark0, seen.length).length;
    ok('没有人到点时 tick 不发生成请求', afterGen === beforeGen, `${beforeGen} → ${afterGen} 个回帖生成请求`);
  } else {
    console.log('       （刚好有人到点了，这一条跳过 —— 时间窗口里的事，不算错）');
  }
}

console.log('\n[6] 别人的帖子：看不见、接不了、tick 也动不了');
{
  const B = await login('路人');
  const f = await feedOf(B.cookie, postId);
  ok('他的 feed 里没有我的帖子', f === null);
  const r = await req('POST', `/api/posts/${postId}/floors`, { cookie: B.cookie, body: { content: '我来插一句' } });
  ok('他接我的帖子 → 403', r.status === 403, `status=${r.status}`);
  const t = await tickOf(B.cookie);
  ok('他 tick 不到我的帖子（他自己的洞里没东西）', t.replies.length === 0 && t.pending === 0, `replies=${t.replies.length} pending=${t.pending}`);
  if (agentRootLeg) {
    console.log('       本腿不适用：knob 让帖主自己承担自起帖费用');
  } else {
    ok('他这一轮一分钱都没花', (await usageOf(B.cookie)) === 0, await usageOf(B.cookie));
  }
  const mine = await feedOf(A.cookie, postId);
  ok('我的帖子没被他动过', !!mine && mine.floors.length > 0);
}

proxy.close();
console.log(failed ? `\n${failed} 项没过。\n` : '\n全部通过。\n');
process.exit(failed ? 1 : 0);
