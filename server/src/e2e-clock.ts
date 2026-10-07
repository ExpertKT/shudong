/**
 * 端到端冒烟：**页面关掉、吧友照常说话** —— 服务端自己的时钟。
 *
 * 这条测的是产品决定（2026-10-05 用户选 A："吧友有自己的作息，你不在也照常说话"）：
 * 脚本**一次都不叫** `/api/feed/tick`（那是前端在你看着的时候叫的），发完帖就干等，
 * 回复必须自己落下来 —— 而且落下来的时刻不早于它"该到"的时刻。
 *
 * 用法（这个 server 的时钟必须是开着的，脚本会先查）：
 *   TICK_INTERVAL_SEC=2 PORT=8899 DB_PATH=<临时库> pnpm --filter @shudong/server dev
 *   PORT=8899 pnpm --filter @shudong/server e2e:clock
 *
 * 只等到**第一位**开口为止（最多 90 秒）：第一位永远是冲浪档（5~25 秒到），
 * 慢慢来的那几位（半小时起）不在这条的射程里 —— 那是"他有自己的作息"，不是"他坏了"。
 */
const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;

let cookie = '';
let failures = 0;

function ok(label: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  ok   ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0] ?? '').join('; ');
  return res;
}

type FeedFloor = {
  id: number; seq: number; kind: string;
  slug: string | null; name: string | null; content: string | null;
  state: string; dueAt: number | null; at: number | null;
};
type FeedPost = { id: number; pending: number; floors: FeedFloor[] };

const feedOf = async (postId: number): Promise<FeedPost | null> => {
  const res = await call('/api/feed?limit=100');
  const body = (await res.json()) as { posts: FeedPost[] };
  return body.posts.find((p) => p.id === postId) ?? null;
};

console.log(`\n[1] 这个 server 的时钟开着吗 ${base}/api/health`);
{
  const res = await call('/api/health');
  const body = (await res.json()) as { tick?: number };
  if (!body.tick) {
    console.log(`  FAIL 服务端时钟是关的（tick=${String(body.tick)}）—— 这条测的就是它，换个 server 再来`);
    process.exit(1);
  }
  ok('服务端时钟开着', true, `每 ${body.tick} 秒看一眼`);
}

console.log('\n[2] 注册 + 发帖，然后**一次 tick 都不叫**');
const handle = `干等${Date.now() % 100000}`;
let postId = 0;
let agents: { slug: string; dueAt: number }[] = [];
{
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ handle, password: 'shudong-test-123' }),
  });
  ok('注册成功', reg.status < 300, `status=${reg.status}`);

  const res = await call('/api/posts', {
    method: 'POST',
    body: JSON.stringify({ content: '今天没什么事，就是有点累。' }),
  });
  const body = (await res.json()) as { id: number; agents: { slug: string; dueAt: number }[] };
  postId = body.id;
  agents = body.agents;
  ok('发帖 200 且定下了谁什么时候来', res.status === 200 && agents.length > 0, `id=${postId} ${agents.map((a) => `${a.slug}+${Math.round((a.dueAt - Date.now()) / 1000)}s`).join(' ')}`);
}

console.log('\n[3] 干等：没有前端、没有 tick，回复该自己出现');
{
  const earliest = [...agents].sort((a, b) => a.dueAt - b.dueAt)[0];
  const t0 = Date.now();
  let landed: FeedFloor | null = null;
  while (Date.now() - t0 < 90_000 && !landed) {
    const feed = await feedOf(postId);
    landed = (feed?.floors ?? []).find((f) => f.kind === 'agent' && f.state === 'done') ?? null;
    if (!landed) await new Promise((r) => setTimeout(r, 2000));
  }

  ok('页面关着，吧友也自己开口了', !!landed, landed ? `${landed.slug} 在发帖后 ${Math.round((Date.now() - t0) / 1000)} 秒出现` : '90 秒内没人说话');
  ok('开口的是最早到点的那位', !!landed && landed.slug === earliest?.slug, `${landed?.slug} vs 最早 ${earliest?.slug}`);
  ok('落下来的是完整的话（不是挤出来的一个字）', !!landed?.content && landed.content.replace(/\s/g, '').length >= 4, landed?.content ? `"${landed.content}"` : '没有正文');
  ok('是一条消息，不是排过版的几段', !!landed?.content && !/[\r\n]/.test(landed.content));
  ok(
    '时间是真的：不早于它该到的时刻（不是发帖当场就编好等着）',
    !!landed && landed.at !== null && landed.dueAt !== null && landed.at >= landed.dueAt,
    landed ? `due=${new Date(landed.dueAt ?? 0).toISOString().slice(11, 19)} 实际=${new Date(landed.at ?? 0).toISOString().slice(11, 19)}` : '',
  );

  const why = await feedOf(postId);
  console.log(`       这一帖现在：${(why?.floors ?? []).map((f) => `${f.seq}楼${f.slug ?? '你'}:${f.state}`).join(' ')}（还等着 ${why?.pending ?? 0} 位）`);
}

console.log(failures ? `\n${failures} 处失败\n` : '\n全绿\n');
process.exit(failures ? 1 : 0);
