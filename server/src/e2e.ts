/**
 * 端到端冒烟：对**已经跑起来**的 server 走一遍 注册 → 发帖 → tick 到吧友开口 → feed 落库。
 * 用法：先 `pnpm --filter @shudong/server dev`，再 `pnpm --filter @shudong/server e2e`。
 *
 * 回帖是**异步**的：发帖只定"谁来回、什么时候来"（`due_at`），真正说话要等前端 tick
 * 到点那一位。所以这里的 [4] 是"轮询到第一位开口"，不是"读一条流"。
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

type Reply = { postId: number; slug: string; name: string; text: string; at: number };
type Tick = { replies: Reply[]; pending: number; error?: string };
/** 一层楼。`kind` 是作者：'agent' 是吧友说的，'user' 是楼主自己接的。 */
type FeedFloor = {
  id: number; seq: number; kind: string;
  slug: string | null; name: string | null; content: string | null;
  state: string; dueAt: number | null; at: number | null; noteId: number | null;
};
type FeedPost = {
  id: number; content: string; handle: string;
  author: { kind: string; handle?: string; slug?: string };
  pending: number; floors: FeedFloor[];
};

const tick = async (): Promise<Tick> => {
  const res = await call('/api/feed/tick', { method: 'POST' });
  const body = (await res.json()) as Tick;
  body.replies ??= [];
  return body;
};

const feedOf = async (postId: number): Promise<FeedPost | null> => {
  const res = await call('/api/feed?limit=100');
  const body = (await res.json()) as { posts: FeedPost[] };
  return body.posts.find((p) => p.id === postId) ?? null;
};

const handle = `小满${Date.now() % 100000}`;

// 单进程上线（SERVE_WEB=1）时才有这一步：server 该把 web/dist 一起吐出来
if (process.env.SERVE_WEB === '1') {
  console.log('\n[0] 前端由这个进程一起吐（SERVE_WEB=1）');
  const home = await call('/');
  const html = await home.text();
  ok('/ 返回 index.html', home.status === 200 && html.includes('<div id="root">'), `status=${home.status} / ${html.length} 字节`);

  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
  const codes = await Promise.all(refs.map(async (r) => (await call(r)).status));
  ok('页面引到的静态资源都拿得到', refs.length > 0 && codes.every((s) => s === 200), `${refs.join(' ')} → ${codes.join(',')}`);

  const deep = await call('/some/deep/link');
  ok('深链接回落给 index.html（前端自己路由）', deep.status === 200 && (await deep.text()).includes('<div id="root">'), `status=${deep.status}`);

  const nope = await call('/api/nope');
  ok('未知 /api 路径不回落成 HTML（接口写错要看得见）', nope.status === 404, `status=${nope.status}`);
}

console.log(`\n[1] 健康检查 ${base}/api/health`);
{
  const res = await call('/api/health');
  const body = (await res.json()) as Record<string, unknown>;
  ok('健康检查 200', res.status === 200);
  console.log(`       llm=${JSON.stringify(body.llm)} agents=${String(body.agents)}`);
  // 服务端时钟开着的话，它会和下面脚本自己的 tick 抢同一条帖子，断言就会莫名其妙地飘。
  // 早失败、说清楚，比让人对着飘绿的测试查半天强。
  const tickSec = Number(body.tick ?? 0);
  if (tickSec > 0) {
    console.log(`  FAIL 这个 server 的服务端时钟开着（TICK_INTERVAL_SEC=${tickSec}）—— 换个 TICK_INTERVAL_SEC=0 起的 server 再跑`);
    process.exit(1);
  }
  // 吧友自己起话头（L-1）同理、更甚：它会在你数"这一帖下面恰好几个人"的时候，
  // 背着脚本往洞里插一条**新帖**。开着就别跑这个脚本。
  const agentPosts = Number(body.agentPostsPerDay ?? 0);
  if (agentPosts > 0) {
    console.log(`  FAIL 这个 server 开着"吧友自己起话头"（AGENT_POSTS_PER_DAY=${agentPosts}）—— 换个 AGENT_POSTS_PER_DAY=0 起的 server 再跑`);
    process.exit(1);
  }
}

console.log(`\n[2] 注册 ${handle}`);
{
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ handle, password: 'shudong-test-123' }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  ok('注册成功', res.status < 300, `status=${res.status} ${JSON.stringify(body)}`);
  ok('拿到了签名 cookie', cookie.includes('sd_session='));

  const me = await call('/api/me');
  const meBody = (await me.json()) as Record<string, unknown>;
  ok('/api/me 认得出我', meBody.user !== null && meBody.user !== undefined);

  const list = (await (await call('/api/agents')).json()) as {
    agents: { slug: string; name: string; accent: string; friend: boolean; unread: number }[];
  };
  ok(
    '吧友名录列的是全体吧友（不是只有加过好友的 —— 没加好友的也会来回帖）',
    list.agents.length > 0 && list.agents.every((a) => !!a.name && !!a.accent),
    list.agents.map((a) => a.slug).join(', '),
  );
  ok(
    '名录带着"是不是好友 / 有没有未读"（右栏要用）',
    list.agents.every((a) => typeof a.friend === 'boolean' && typeof a.unread === 'number'),
  );
}

console.log('\n[3] 发帖');
const content = '连续加班第三周了，今天回家路上突然不知道自己在忙什么。';
let postId = 0;
let agentSlugs: string[] = [];
let plan: { slug: string; dueAt: number }[] = [];
{
  const res = await call('/api/posts', { method: 'POST', body: JSON.stringify({ content }) });
  const body = (await res.json()) as { id: number; agents: { slug: string; dueAt: number }[] };
  postId = body.id;
  agentSlugs = body.agents.map((a) => a.slug);
  plan = body.agents;
  ok('发帖 200', res.status === 200, `id=${body.id}`);
  ok('发帖时就定死了谁来回', agentSlugs.length > 0, `agents=[${agentSlugs.join(', ')}]`);
  ok(
    '每个人还定死了"什么时候来"（dueAt 是未来时刻）',
    body.agents.every((a) => Number.isFinite(a.dueAt) && a.dueAt > Date.now()),
    agentSlugs.map((s, i) => `${s}+${Math.round(((body.agents[i]?.dueAt ?? 0) - Date.now()) / 1000)}s`).join(' '),
  );
}

console.log('\n[4] tick：到点的那一位才说话，没到点的不会被提前生成');
let firstReply: Reply | null = null;
{
  // 刚发完，第一位也得几秒后才到点 —— 现在 tick 一定没人说话
  const early = await tick();
  ok('刚发完马上 tick：这一轮不该有人说话', early.replies.length === 0, `pending=${early.pending}`);
  ok('pending 还是全员（没人被提前生成）', early.pending === agentSlugs.length, `${early.pending}/${agentSlugs.length}`);

  const feed = await feedOf(postId);
  ok(
    'feed 里还没有人开口（排队的人不上页面），pending 是全员',
    !!feed && feed.floors.length === 0 && feed.pending === agentSlugs.length,
    feed ? `floors=${feed.floors.length} pending=${feed.pending}/${agentSlugs.length}` : 'feed 里没有这条帖子',
  );
  // 最早到点的人看**发帖那一刻的排期**，不是 feed —— 排期是"谁什么时候来"的唯一出处
  const earliest = [...plan].sort((a, b) => a.dueAt - b.dueAt)[0];

  const t0 = Date.now();
  const seen = new Set<string>();
  let perTickMax = 0;
  while (Date.now() - t0 < 40_000 && !firstReply) {
    const t = await tick();
    if (t.error) {
      ok(`tick 不该报错：${t.error}`, false);
      break;
    }
    perTickMax = Math.max(perTickMax, t.replies.length);
    for (const r of t.replies) {
      ok(`${r.slug} 只被生成一次（没有重复记账）`, !seen.has(r.slug));
      seen.add(r.slug);
      firstReply = r;
    }
    if (!firstReply) await new Promise((r) => setTimeout(r, 1000));
  }

  const ms = Date.now() - t0;
  ok('30 秒内有第一位吧友开口（"经常冲浪"那一档）', !!firstReply && ms < 30_000, `${ms}ms`);
  ok('每次 tick 最多一条', perTickMax <= 1, `最多 ${perTickMax} 条`);
  ok('开口的是最早到点的那位', !!earliest && firstReply?.slug === earliest.slug, `${firstReply?.slug} vs 最早 ${earliest?.slug}`);
  ok('回复有正文', !!firstReply?.text.trim(), firstReply ? `"${firstReply.text.trim().slice(0, 40)}…"` : '没有正文');
}

console.log('\n[5] tick 不重烧：落地的人不会再说一遍，空 tick 不花 token');
const firstSlug = firstReply?.slug ?? '';
{
  const before = (await (await call('/api/usage')).json()) as { userToday: number };
  const again = await tick();
  ok('刚刚说过的人不会被重新生成', !again.replies.some((r) => firstReply && r.slug === firstReply.slug), `replies=${again.replies.map((r) => r.slug).join(',') || '空'}`);

  // 第一位通常还在前 30 秒的窗口里，后面两位（一分半起）还没到点 —— 这一轮该是空的
  if (again.replies.length === 0) {
    const after = (await (await call('/api/usage')).json()) as { userToday: number };
    ok('空 tick 不花 token', after.userToday === before.userToday, `${before.userToday} → ${after.userToday}`);
  } else {
    console.log('       （还有别人到点了，跳过"空 tick"这条 —— 时间窗口里的事，不算错）');
  }
}

console.log('\n[6] feed 里这条帖子是落库的');
{
  const feed = await feedOf(postId);
  const done = (feed?.floors ?? []).filter((f) => f.kind === 'agent' && f.state === 'done' && (f.content ?? '').trim().length > 0);
  ok('feed 里有它', !!feed);
  ok('已经说过话的人落了库（刷新页面不会重烧）', done.length === 1, `done=${done.length}`);
  ok('回复是一行（换行/空行在落库前就被折成空格了）', done.every((f) => !/[\r\n]/.test(f.content ?? '')), done.map((f) => JSON.stringify((f.content ?? '').slice(0, 30))).join(' '));
  ok('回复不是"一个字"（模型挤出一个字会被打回去重说）', done.every((f) => (f.content ?? '').replace(/\s/g, '').length >= 4), done.map((f) => `${f.slug}:${(f.content ?? '').replace(/\s/g, '').length}字`).join(' '));
  ok('说过话的人带着真实开口时刻（#楼层 · 几分钟前 要用）', done.every((f) => f.at !== null && f.at > 0), `at=${done.map((f) => f.at).join(',')}`);
  ok('每层楼都带楼号，且按楼号升序（一帖 = 一栋楼）', (feed?.floors ?? []).every((f, i, a) => f.seq >= 2 && (i === 0 || f.seq > (a[i - 1]?.seq ?? 0))), (feed?.floors ?? []).map((f) => `${f.seq}楼`).join(' '));
  // "还没到点的" = 计划里的人数 − 已经开口的人数。**不能用 > 0 断**：task-9 之后
  // 一帖可能只抽到一个人，那位一开口 pending 就合法地变成 0（原来那样写会假红）。
  const waiting = plan.length - done.length;
  ok('还没到点的人没上页面，只用 pending 数告诉你', (feed?.pending ?? -1) === waiting,
    `pending=${feed?.pending} 计划=${plan.length} 已开口=${done.length}`);
}

console.log('\n[7] 成本账本读得出来');
{
  const res = await call('/api/usage');
  const l = (await res.json()) as { userToday: number; allToday: number; userLimit: number; globalLimit: number };
  ok('/api/usage 200', res.status === 200, JSON.stringify(l));
  ok('今天花的 token 记上了', l.userToday > 0 && l.allToday >= l.userToday);
  ok('限额不是 0（闸门是开着的）', l.userLimit > 0 && l.globalLimit > 0);
}

console.log('\n[8] 洞里没有别人：另一个人看不见我的帖子，tick 也动不了我的帖子');
{
  const mineCookie = cookie;
  cookie = ''; // 换成另一个人
  const other = `小李${Date.now() % 100000}`;
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ handle: other, password: 'shudong-test-123' }),
  });
  ok('另一个人也注册上了', reg.status < 300, `status=${reg.status}`);

  const feedRes = await call('/api/feed?limit=100');
  const feed = (await feedRes.json()) as { posts: { id: number; handle: string }[] };
  ok('他的 feed 里看不到我的帖子', !feed.posts.some((p) => p.id === postId), `他看见 ${feed.posts.length} 条，含我的=${feed.posts.some((p) => p.id === postId)}`);

  // 他没有帖子，tick 应该什么都生成不出来 —— 更不该替我生成（花我的额度）
  const theirTick = await tick();
  ok('他 tick 不到我的帖子（他自己的洞里没东西）', theirTick.replies.length === 0 && theirTick.pending === 0, `replies=${theirTick.replies.length} pending=${theirTick.pending}`);

  cookie = mineCookie;
  const mineFeed = await feedOf(postId);
  const myDone = (mineFeed?.floors ?? []).filter((f) => f.kind === 'agent' && f.state === 'done').length;
  ok('我的帖子状态没被他动过（还是 1 条 done）', myDone === 1, `${myDone} 条 done`);
  const mine = await call('/api/feed?limit=100');
  const mineBody = (await mine.json()) as { posts: { id: number }[] };
  ok('我自己还看得见', mineBody.posts.some((p) => p.id === postId), `我看见 ${mineBody.posts.length} 条`);
}

console.log(failures === 0 ? '\n全部通过。\n' : `\n有 ${failures} 项没过。\n`);
process.exitCode = failures === 0 ? 0 : 1;
