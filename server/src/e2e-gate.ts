/**
 * 只验证成本闸门真的会拦人。
 * 前置：拿一个**小额度**启动 server，例如
 *   $env:USER_DAILY_TOKENS='1'; node src/index.ts
 * 然后跑 `node src/e2e-gate.ts`。
 *
 * 为什么单独一个文件：它要求 server 跑在小额度下，和 e2e.ts 的前置条件冲突。
 */
const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;

let cookie = '';
let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  ok   ${label}${extra ? ` — ${extra}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const sc = res.headers.getSetCookie();
  if (sc.length) cookie = sc.map((c) => c.split(';')[0] ?? '').join('; ');
  return res;
}

/** 反复 tick 到第一位吧友开口（这样才会真的花掉 token）。返回吐出来的字数。 */
async function drain(postId: number): Promise<number> {
  const t0 = Date.now();
  let chars = 0;
  while (Date.now() - t0 < 40_000) {
    const res = await call('/api/feed/tick', { method: 'POST' });
    const body = (await res.json()) as { replies?: { postId: number; text: string }[]; error?: string };
    for (const r of body.replies ?? []) if (r.postId === postId) chars += r.text.trim().length;
    if (chars > 0) return chars;
    if (body.error) return 0;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return chars;
}

const handle = `闸门${Date.now() % 100000}`;
console.log(`\n成本闸门（${base}，新用户 ${handle}）`);

{
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ handle, password: 'shudong-test-123' }),
  });
  ok('注册', res.status < 300, `status=${res.status}`);
  const l = (await (await call('/api/usage')).json()) as { userToday: number; userLimit: number };
  ok('新用户今天还没花过', l.userToday === 0, `userToday=${l.userToday} userLimit=${l.userLimit}`);
}

let firstId = 0;
{
  const res = await call('/api/posts', { method: 'POST', body: JSON.stringify({ content: '第一句，额度应该够。' }) });
  const body = (await res.json()) as { id?: number };
  firstId = body.id ?? 0;
  ok('额度够时放行', res.status === 200, `status=${res.status} id=${firstId}`);
}

{
  const chars = await drain(firstId);
  ok('回复真的生成了（token 花出去了）', chars > 0, `${chars} 字`);
  const l = (await (await call('/api/usage')).json()) as { userToday: number };
  ok('花费记在这个用户头上（usage→posts 的连接对）', l.userToday > 0, `userToday=${l.userToday}`);
}

{
  const res = await call('/api/posts', { method: 'POST', body: JSON.stringify({ content: '第二句，额度已经超了。' }) });
  const body = (await res.json()) as { error?: string };
  ok('额度用完时拦住', res.status === 429, `status=${res.status} error="${body.error ?? ''}"`);

  const feed = (await (await call('/api/feed?limit=10')).json()) as { posts: { content: string }[] };
  ok('被拦的帖子根本没落库', !feed.posts.some((p) => p.content.includes('第二句')));
}

console.log(failures === 0 ? '\n闸门正常。\n' : `\n有 ${failures} 项没过。\n`);
process.exitCode = failures === 0 ? 0 : 1;
