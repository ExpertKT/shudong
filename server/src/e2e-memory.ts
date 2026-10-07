/**
 * 「他会记得你」端到端：证明**积累下来的印象真的进了 prompt**，不是只躺在数据库里。
 *
 * 为什么值得单独一个脚本：这条链坏掉的时候是**静默**的 —— 账目全对、回复也照出，
 * 只是回复里再也没有"这个人上次说过什么"的味道。所以这里不看数据库，
 * 而是拿一个**录音代理**夹在 server 和本机模型之间，直接查上游请求体里的 system 段。
 *
 * 跑法（server 必须把 LLM_BASE_URL 指向本脚本起的那只代理）：
 *   $env:PORT='8913'; $env:SHUDONG_DB='F:\tmp\mem-e2e.db'; $env:DM_MEMORY='1';
 *   $env:LLM_BASE_URL='http://127.0.0.1:8916/v1'; pnpm start
 *   $env:SHUDONG_BASE='http://127.0.0.1:8913'; node src/e2e-memory.ts
 * 跑完清临时库、清进程。本脚本只调本机免费模型（qwen3.5:9b）。
 */
import { createServer, request as httpRequest } from 'node:http';

const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const upstreamUrl = process.env.MEM_UPSTREAM;
if (!upstreamUrl) {
  console.error('未配置记忆测试上游；请显式设置 MEM_UPSTREAM —— 禁止默认直连真实模型(11434)');
  process.exit(2);
}
const upstream = new URL(upstreamUrl);
console.log(`测试上游：${upstream.origin}`);
const proxyPort = Number(process.env.MEM_PROXY_PORT ?? 8916);

let failed = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

// ---------------------------------------------------------------------------
// 录音代理：把上游请求体抄一份，再把响应原样（含 SSE 流）转发回去。
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

/** 录到的所有 chat 请求（按发生顺序）里，system 段拼起来。 */
function systemTexts(from = 0, to = seen.length): string[] {
  const out: string[] = [];
  for (const r of seen.slice(from, to)) {
    if (!r.path.includes('/chat/completions')) continue;
    for (const m of (r.json?.messages ?? []) as any[]) {
      if (m?.role === 'system') out.push(String(m.content ?? ''));
    }
  }
  return out;
}
const chatCount = (from = 0, to = seen.length) =>
  seen.slice(from, to).filter((r) => r.path.includes('/chat/completions')).length;
const sysHas = (from: number, to: number, needle: string) =>
  systemTexts(from, to).some((s) => s.includes(needle));

// ---------------------------------------------------------------------------
// 一个极小的 HTTP 客户端（带 cookie）+ SSE 读取器
// ---------------------------------------------------------------------------
type Res = { status: number; body: any; cookie: string | null };

async function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* 非 JSON 就原样留着 */ }
  return { status: res.status, body, cookie: set ? set.split(';')[0]! : null };
}

/** 读一条 SSE 流到 complete。回复按 id（单聊）或 slug（帖子）归拢。 */
async function stream(path: string, cookie: string): Promise<{ status: number; events: any[]; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  try {
    const res = await fetch(base + path, { headers: { cookie }, signal: ctrl.signal });
    if (!res.ok || !res.body) return { status: res.status, events: [], text: '' };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const events: any[] = [];
    const texts = new Map<string, string>();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let ev: any;
        try { ev = JSON.parse(raw); } catch { continue; }
        events.push(ev);
        if (ev.type === 'delta') {
          const key = String(ev.id ?? ev.slug ?? '');
          texts.set(key, (texts.get(key) ?? '') + (ev.text ?? ''));
        }
        if (ev.type === 'complete') {
          await reader.cancel();
          return { status: res.status, events, text: [...texts.values()].join('') };
        }
      }
    }
    return { status: res.status, events, text: [...texts.values()].join('') };
  } finally {
    clearTimeout(timer);
  }
}

const uniq = Date.now().toString(36);
async function register(tag: string): Promise<{ cookie: string; handle: string }> {
  const handle = `mm${tag}${uniq}`.slice(0, 12);
  const r = await req('POST', '/api/auth/register', { body: { handle, password: 'pass12345' } });
  if (!r.cookie) throw new Error(`注册失败（${r.status}）: ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, handle };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等印象落库（单聊那条路是火忘式的，不会等回复）。 */
async function impressionOf(cookie: string, slug: string, waitMs = 0): Promise<string> {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await req('GET', `/api/dm/${slug}`, { cookie });
    const t = typeof r.body?.impression === 'string' ? r.body.impression.trim() : '';
    if (t || Date.now() >= until) return t;
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n[1] 没登录看不了单聊`);
{
  const r = await req('GET', '/api/dm/anhe');
  ok('未登录 → 401', r.status === 401, r);
}

// ---------------------------------------------------------------------------
// 帖子路径：发帖 → 回帖完 → 印象落库 → 再发一帖，那位的 system 段里必须带上这条印象
// ---------------------------------------------------------------------------
console.log(`\n[2] 帖子路径：第一次回帖攒下的印象，第二次回帖必须进 prompt`);
const A = await register('a');
console.log(`    注册 A：${A.handle}`);

let mem = '';           // 有印象的那位吧友
let memSlug = '';
let mark2 = 0;          // 第二帖开始时的录音位置
{
  const p1 = await req('POST', '/api/posts', { cookie: A.cookie, body: { content: '最近老觉得时间不够用，什么都想干又什么都没干成。' } });
  const agents1: string[] = (p1.body?.agents ?? []).map((a: any) => a.slug);
  ok('第一帖发出去了', p1.status === 200 && typeof p1.body?.id === 'number', p1.body);
  const s1 = await stream(`/api/posts/${p1.body?.id}/stream`, A.cookie);
  ok('第一帖的回复流跑完了', s1.events.some((e) => e.type === 'complete'), s1.events.map((e) => e.type));
  ok('第一帖真录到了上游请求', chatCount() > 0, chatCount());

  // updateImpressions 是在 complete 之前 await 的，所以这会儿库里已经有了。
  // **必须现在就把这几条抄下来**：第二帖跑完会拿第二帖的内容把印象覆盖一遍，
  // 那时候再去读就成了"第二帖自己的产物"，拿它去验第二帖的 prompt 是自欺欺人。
  for (const slug of agents1) await req('POST', '/api/friends', { cookie: A.cookie, body: { slug } });
  const memoBefore = new Map<string, string>();
  for (const slug of agents1) {
    const imp = await impressionOf(A.cookie, slug, 5_000);
    if (imp) { memoBefore.set(slug, imp); if (!mem) { mem = imp; memSlug = slug; } }
  }
  ok(`回帖的吧友记住了这个人（${memoBefore.size}/${agents1.length}）`, memoBefore.size > 0, { memSlug, mem });
  ok('那条印象不是空串', mem.trim().length >= 2, mem);

  // 反证：印象出现**之前**的那些生成，system 段里不该有它（不然这条断言是写死的）
  const before = seen.length;
  ok('印象出现之前的上游请求里没有它', !sysHas(0, before, mem));

  const p2 = await req('POST', '/api/posts', { cookie: A.cookie, body: { content: '今天本来想早点睡，结果又刷手机到两点。' } });
  const agents2: string[] = (p2.body?.agents ?? []).map((a: any) => a.slug);
  mark2 = before;
  const s2 = await stream(`/api/posts/${p2.body?.id}/stream`, A.cookie);
  ok('第二帖的回复流跑完了', s2.events.some((e) => e.type === 'complete'), s2.events.map((e) => e.type));
  ok('第二帖真的又调了上游', chatCount(mark2) >= agents2.length, chatCount(mark2));

  let checked = 0;
  let withMem = 0;
  for (const slug of agents2) {
    const imp = memoBefore.get(slug);   // 第一帖那份快照，不是现在的
    if (!imp) continue;
    checked++;
    const hit = sysHas(mark2, seen.length, imp);
    if (hit) withMem++;
    ok(`第二帖里 ${slug} 的 system 段带着第一帖攒下的印象`, hit, imp);
  }
  ok('第二帖里至少有一位是"已经记住他"的吧友（不然这一节是空转）', checked > 0, { checked, agents2 });
  ok('记着他的那几位，全都进了 prompt', checked > 0 && withMem === checked, { checked, withMem });
}

// ---------------------------------------------------------------------------
// 单聊路径：DM_MEMORY=1 时，聊完一轮会回头总结一次；下一句的 system 段里必须带上
// ---------------------------------------------------------------------------
console.log(`\n[3] 单聊路径：上一轮聊出来的印象，下一句必须进 prompt`);
const B = await register('b');
console.log(`    注册 B：${B.handle}`);
{
  await req('POST', '/api/friends', { cookie: B.cookie, body: { slug: 'anhe' } });
  const m1 = await req('POST', '/api/dm/anhe', { cookie: B.cookie, body: { text: '这几天总失眠，躺下就开始想工作上的事。' } });
  ok('第一句发出去了', m1.status === 200, m1.body);
  const d1 = await stream('/api/dm/anhe/stream?after=0', B.cookie);
  ok('第一句的回复流跑完了', d1.events.some((e) => e.type === 'complete'), d1.events.map((e) => e.type));

  const dmImp = await impressionOf(B.cookie, 'anhe', 120_000);
  ok('聊完一轮他记住了（DM_MEMORY=1）', dmImp.trim().length >= 2, dmImp);

  const mark = seen.length;
  const m2 = await req('POST', '/api/dm/anhe', { cookie: B.cookie, body: { text: '你说人为什么会这样，明明很困还是不肯睡。' } });
  ok('第二句发出去了', m2.status === 200, m2.body);
  const d2 = await stream('/api/dm/anhe/stream?after=0', B.cookie);
  ok('第二句的回复流跑完了', d2.events.some((e) => e.type === 'complete'), d2.events.map((e) => e.type));
  ok('第二句真的又调了上游', chatCount(mark) > 0, chatCount(mark));
  ok('第二句的 system 段里带着他对这个人的印象', sysHas(mark, seen.length, dmImp), dmImp);
}

// ---------------------------------------------------------------------------
proxy.close();
console.log(
  failed === 0
    ? `\n全部通过（共录到 ${chatCount()} 次上游调用）\n`
    : `\n${failed} 项失败（共录到 ${chatCount()} 次上游调用）\n`,
);
process.exit(failed === 0 ? 0 : 1);
