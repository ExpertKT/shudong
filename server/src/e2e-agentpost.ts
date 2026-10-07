/**
 * 「吧友自己起话头」（L-1）的端到端：吧友自己发一条帖 → 别的吧友到楼里接话 → 楼主不是接话的人之一。
 *
 * 两条纪律决定了这个脚本的形状：
 *
 * 1. **不碰真模型**。脚本自己起一个**罐头** LLM（默认 `127.0.0.1:8918`），只认三种请求形状
 *    （起帖 / 回帖 / 更新印象，各自由提示词里独有的一句区分）。认不出的形状一律 500 并记账，
 *    最后 `unknown === 0` 是硬断言 —— prompt 改了形状必须是**红的**，不能变成"注入 0 次也算过"
 *    （`TEAM.md` §3 那条假绿教训）。
 * 2. **三种模式**（外层 `AGENTPOST_MODE`，因为 server 的额度是起 server 时定的）：
 *    - `ok`（默认）：`AGENT_POSTS_PER_DAY` 开高值 → 断言 tick 真产出一条吧友帖、它自带 pending
 *      楼层、楼主不在接话名单里、同一个吧友在自己的间隔内不重复起帖；
 *    - `off`：`AGENT_POSTS_PER_DAY=0`（默认值）→ 断言敲多少下 tick 都不出一条吧友帖、账一分不动、
 *      罐头 LLM **一次都没被请求**（这是线上的常态，旋钮默认就是关的）；
 *    - `broke`：`USER_DAILY_TOKENS=1` + `AGENTPOST_BIG_USAGE=1`（罐头把 token 报成天量，一次生成
 *      就把额度打穿）→ 先让这几轮正常起一条帖、把额度花光，**花光之后**再 tick：不许再起帖、
 *      不许再碰上游、账一分不涨。（开场要等：没有历史帖时第一个"到点"时刻是相位错峰出来的。）
 *
 * 起法（server 由 `e2e-serve.ts` 起，端口与临时库都归它管）：
 *   node src/e2e-serve.ts --script src/e2e-agentpost.ts --env AGENT_POSTS_PER_DAY=100000 \
 *     --env TICK_INTERVAL_SEC=0 --env LLM_BASE_URL=http://127.0.0.1:8918/v1 \
 *     --env USER_DAILY_TOKENS=200000 --env GLOBAL_DAILY_TOKENS=1000000
 *
 *   # 额度那条（这两个 env 是给**客户端**看的，所以在外层 shell 设）
 *   $env:AGENTPOST_MODE='broke'; $env:AGENTPOST_BIG_USAGE='1'
 *   node src/e2e-serve.ts --script src/e2e-agentpost.ts --env AGENT_POSTS_PER_DAY=100000 \
 *     --env TICK_INTERVAL_SEC=0 --env LLM_BASE_URL=http://127.0.0.1:8918/v1 --env USER_DAILY_TOKENS=1
 *
 *   # 旋钮关着那条（默认就是关的，不用给 AGENT_POSTS_PER_DAY）
 *   $env:AGENTPOST_MODE='off'
 *   node src/e2e-serve.ts --script src/e2e-agentpost.ts --env AGENT_POSTS_PER_DAY=0 \
 *     --env TICK_INTERVAL_SEC=0 --env LLM_BASE_URL=http://127.0.0.1:8918/v1
 */
import { createServer, type Server } from 'node:http';
import { OPEN_WINDOW_MS, postIntervalMs } from './agent-post.ts';
import { PERSONAS, type Persona } from './personas.ts';

const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const mode: 'ok' | 'off' | 'broke' =
  process.env.AGENTPOST_MODE === 'broke' ? 'broke' : process.env.AGENTPOST_MODE === 'off' ? 'off' : 'ok';
const STUB_PORT = Number(process.env.AGENTPOST_STUB_PORT ?? 8918);
/** 把罐头报的 token 数放大到天量：一次生成就能把 `USER_DAILY_TOKENS` 打穿（只有 broke 模式要）。 */
const BIG_USAGE = process.env.AGENTPOST_BIG_USAGE === '1';
/**
 * 抄旧帖的证据模式：桩把起帖 prompt 里那条"最近的帖子"（`recent[0]`）**原样吐回去**。
 * `once` = 只第一次这样（逼出"重说一遍，第二遍干净 ⇒ 帖落下来"）；`always` = 每次都这样
 * （逼出"重说还抄 ⇒ 这一轮根本不起帖"）。没有读 prompt 字面串当接口这回事：这里读的就是
 * `agent-post.ts` 自己拼进去的那一行，认不出标记就直接当"没抄到"（下面会因此红）。
 */
const COPY_MODE = process.env.AGENTPOST_COPY === 'always' ? 'always' : process.env.AGENTPOST_COPY === 'once' ? 'once' : '';
/** 起帖 prompt 里"洞里最近有人写过这些…"那一行的标记与分隔符（`agent-post.ts:101`）。 */
const RECENT_MARK = '别接着它们说）：';
const RECENT_SEP = '\u3000';
/** 客户端种下的那一帖：**故意跟罐头台词没有任何重合**，所以它出现在吧友帖里只可能是抄的。 */
const SEED_TEXT = '我妈今天打电话问我最近怎么样，我说挺好的，然后就挂了。';

/** 从（JSON 化之后的）请求体里把 `recent` 清单抠出来。 */
function recentFrom(blob: string): string[] {
  const i = blob.indexOf(RECENT_MARK);
  if (i < 0) return [];
  const line = blob.slice(i + RECENT_MARK.length).split('\\n')[0] ?? '';
  return line.split(RECENT_SEP).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 罐头 LLM：只认"起帖"和"回帖"两种形状
// ---------------------------------------------------------------------------
/** 起帖提示词独有的一句（`agent-post.ts` 的 `postPrompt`）。 */
const POST_TAG = '不是回谁的话';
/** 回帖提示词独有的一句（`personas.ts` 的 `systemPrompt`）。 */
const REPLY_TAG = '你是回帖的人之一';
/** "更新印象"那个小调用独有的一句（`index.ts` 的 `updateImpressions`）—— 它也会走到默认档上。 */
const IMPRESSION_TAG = '只输出 JSON';

/**
 * 罐头帖子/回帖：短到两两之间不可能有 ≥10 字的连续重合（那会被抄句尺子拦下来，是本测试的噪声）。
 *
 * 帖子池给到 16 条，是**为了下面那条"同一位吧友开了不止一条帖"能被真的看见**：罐头按
 * `stubCalls.post` 轮着吐，池子小到会被轮完时，第二次起帖就会吐出同一条 → 抄句尺子拦下 →
 * `maybeAgentPost` 记 10 分钟失败冷却 ⇒ 这一轮里那个人再也不会起帖（3 条池子时实测就只有 3 条帖）。
 * 所以这里不是"多写几句"，是那条断言的**前置条件**，别缩回去。
 */
const POST_TEXTS = [
  '今天下班不想回家，在楼下坐了很久。',
  '阳台那盆花枯了，我好像也没觉得可惜。',
  '睡不着，把去年的照片翻了一遍。',
  '楼下修车摊今天没出摊，路口空了一块。',
  '中午的外卖凉了，还是吃完了。',
  '地铁上有人让座，我愣了一下才说谢谢。',
  '洗了三条床单，晾到一半下雨了。',
  '冰箱里剩半盒豆腐，明天再不吃就坏了。',
  '给家里打了个电话，聊了不到两分钟。',
  '路灯坏了一盏，回来的路特别黑。',
  '同事离职那天请我们吃了西瓜。',
  '钥匙找不到了，最后在鞋柜上看见。',
  '楼下小孩在学骑车，摔了两次还在笑。',
  '今天第一件外套没穿够，风从领口进来。',
  '热豆浆卖完了，只剩下冰的。',
  '想剪头发，理发店排队排到门外。',
];
const REPLY_TEXTS = ['嗯，我也是。', '早点睡吧。', '抱抱你。', '我懂这种感觉。', '别硬扛着。', '先歇一会儿。'];

let stub: Server | null = null;
let stubSeen = 0;
const stubCalls = { post: 0, reply: 0, impression: 0, unknown: 0 };

function startStub(): Promise<void> {
  return new Promise((resolve, reject) => {
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        stubSeen++;
        let messages: unknown = null;
        try {
          messages = (JSON.parse(raw) as { messages?: unknown }).messages ?? null;
        } catch {
          /* 下面按"认不出的形状"处理 */
        }
        const blob = JSON.stringify(messages);
        const kind = blob.includes(POST_TAG)
          ? 'post'
          : blob.includes(REPLY_TAG)
            ? 'reply'
            : blob.includes(IMPRESSION_TAG)
              ? 'impression'
              : 'unknown';
        stubCalls[kind]++;
        if (kind === 'unknown') {
          // 形状变了就必须炸：宁可这一轮红，也不要"没注入也算过"
          console.error(`  ✗ 罐头 LLM 收到认不出的请求形状，system 开头：${blob.slice(0, 160)}`);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: '不认识的请求形状' }));
          return;
        }
        // 印象那支要的是 JSON（`updateImpressions` 会自己解析）；给个空的等于"这轮没什么好记的"
        const pool = kind === 'post' ? POST_TEXTS : kind === 'reply' ? REPLY_TEXTS : ['{}'];
        let text = pool[(stubCalls[kind] - 1) % pool.length] as string;
        if (kind === 'post' && COPY_MODE) {
          const echo = recentFrom(blob)[0];
          if (echo && (COPY_MODE === 'always' || stubCalls.post === 1)) {
            text = echo;
            console.log(`  [桩] 把最近的帖子原样吐回去（copy=${COPY_MODE}，第 ${stubCalls.post} 次起帖请求）：${echo.slice(0, 18)}…`);
          }
        }
        const u = BIG_USAGE
          ? { prompt_tokens: 999_999, completion_tokens: 999_999, total_tokens: 1_999_998 }
          : { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: u })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    stub.on('error', reject);
    stub.listen(STUB_PORT, '127.0.0.1', () => resolve());
  });
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------
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

type FeedFloor = { seq: number; kind: string; slug: string | null; content: string | null; state: string };
type FeedPost = {
  id: number; content: string; created_at: number;
  author: { kind: string; slug?: string; name?: string };
  pending: number; floors: FeedFloor[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function allPosts(): Promise<FeedPost[]> {
  const res = await call('/api/feed?limit=100');
  if (res.status !== 200) throw new Error(`/api/feed 返回 ${res.status}`);
  return ((await res.json()) as { posts: FeedPost[] }).posts;
}

const usage = async (): Promise<{ userToday: number; allToday: number }> => {
  const res = await call('/api/usage');
  return (await res.json()) as { userToday: number; allToday: number };
};

/** 这位吧友的起帖间隔（毫秒）。跟 server 算的是同一份函数、同一个吧；密度从 `/api/health` 拿。 */
const intervalOf = (slug: string): number => {
  const p = PERSONAS.find((x) => x.slug === slug) as Persona;
  return postIntervalMs(PERSONAS, perDay, p);
};
/** 服务端报的密度（`--env` 只给 server，客户端只有从 `/api/health` 读才是同一份）。 */
let perDay = 0;

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------
const handle = `小满${Date.now() % 100000}`;
console.log(`\n▶ 模式 ${mode} · ${base} · 罐头 LLM 127.0.0.1:${STUB_PORT}`);

try {
  await startStub();
} catch (e) {
  console.log(`  FAIL 罐头 LLM 起不来（${STUB_PORT} 被占？）— ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

{
  const health = (await (await call('/api/health')).json()) as { tick?: number; agentPostsPerDay?: number };
  perDay = Number(health.agentPostsPerDay ?? 0);
  ok('这个 server 的时钟是关的（TICK_INTERVAL_SEC=0）', Number(health.tick ?? 0) === 0, `tick=${health.tick}`);
  if (mode === 'off') {
    ok('这个 server 关着"吧友自己起话头"（0 是默认值）', perDay === 0, `AGENT_POSTS_PER_DAY=${health.agentPostsPerDay}`);
  } else {
    ok('这个 server 开着"吧友自己起话头"', perDay > 0, `AGENT_POSTS_PER_DAY=${health.agentPostsPerDay}`);
  }
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ handle, password: 'shudong-test-123' }),
  });
  ok('注册成功', res.status < 300, `status=${res.status}`);
}

if (mode === 'broke') {
  console.log('\n[broke] 额度只剩一点点：先让它花光，花光之后 tick 不许再起帖、也不许再碰上游');
  // 阶段一：额度还没花完 —— 这几轮该正常起一条帖，并顺手把额度打穿（罐头报的是天量 token）。
  // 注意开场要等：没有历史帖时每位吧友的第一个"到点"时刻是 `openingBase + 相位`（见 agent-post.ts
  // 的 `pickPoster`），所以第一轮 tick 不一定会起帖，得按 400ms 轮询到它开口。
  const stub0 = stubSeen;
  const openDeadline = Date.now() + 15_000;
  let opened: FeedPost[] = [];
  let firstStatus = 0;
  while (Date.now() < openDeadline) {
    const r = await call('/api/feed/tick', { method: 'POST' });
    if (!firstStatus) firstStatus = r.status;
    opened = (await allPosts()).filter((p) => p.author.kind === 'agent');
    if (opened.length >= 1) break;
    await sleep(400);
  }
  ok('额度还没花完时 tick 没被拦（先开口再谈拦住）', firstStatus === 200, `第一次 tick status=${firstStatus}`);
  ok('这一轮真的落了一条吧友帖', opened.length === 1, `吧友帖 ${opened.length} 条`);
  ok('起帖那次上游调用确实发生了', stubSeen > stub0, `stubSeen ${stub0} → ${stubSeen}`);
  const drained = (await usage()) as { userToday: number; allToday: number; userLimit?: number };
  ok('这一条就把额度花完了（后面 gate 该拦住）',
    Number(drained.userLimit ?? 0) > 0 && drained.userToday >= Number(drained.userLimit),
    `userToday=${drained.userToday} userLimit=${drained.userLimit}`);

  // 阶段二：额度过线之后再 tick —— 一条新帖都不许起，一次上游都不许发生
  const mark = { posts: opened.length, usage: drained, stub: stubSeen };
  let blocked = 0;
  for (let i = 0; i < 10; i++) {
    const r = await call('/api/feed/tick', { method: 'POST' });
    if (r.status === 429) blocked++;
    await sleep(300);
  }
  const after = (await usage()) as { userToday: number; allToday: number };
  const later = (await allPosts()).filter((p) => p.author.kind === 'agent');
  ok('额度花完之后一条新帖都不起', later.length === mark.posts, `吧友帖 ${mark.posts} → ${later.length}`);
  ok('被拦的这几轮账一分没涨（没花 token）',
    after.userToday === mark.usage.userToday && after.allToday === mark.usage.allToday,
    `before=${JSON.stringify(mark.usage)} after=${JSON.stringify(after)}`);
  ok('罐头 LLM 一次都没被再请求', stubSeen === mark.stub, `stubSeen ${mark.stub} → ${stubSeen}`);
  console.log(`  （顺带：到点的楼层撞 gate 时 tick 会回 429，这几轮碰上了 ${blocked} 次 —— 这条不当作断言，` +
    `回帖那条闸门由 e2e-gate.ts 负责）`);
  ok('没有认不出的请求形状', stubCalls.unknown === 0, `unknown=${stubCalls.unknown}`);
} else if (COPY_MODE) {
  // 起帖那条路上有没有抄旧帖的兜底：桩把 `recent[0]` 原样吐回来（`recent` 就是用户自己最近那几帖，
  // 摆在起帖 prompt 里）。**没有兜底的话，这句话会被直接 INSERT 进 posts** —— 那正是要被治的病。
  console.log(`\n[copy] 起帖会不会把"最近的帖子"抄进来（桩把 recent[0] 原样吐回；copy=${COPY_MODE}）`);
  const seed = await call('/api/posts', { method: 'POST', body: JSON.stringify({ content: SEED_TEXT }) });
  ok('先种一帖当"最近的帖子"（它的正文就摆在起帖 prompt 里）', seed.status < 300, `status=${seed.status}`);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await call('/api/feed/tick', { method: 'POST' });
    const now = (await allPosts()).filter((p) => p.author.kind === 'agent');
    if (stubCalls.post >= 2 && (COPY_MODE === 'always' || now.length >= 1)) break;
    await sleep(300);
  }
  const mine = (await allPosts()).filter((p) => p.author.kind === 'agent');
  const copied = mine.filter((p) => p.content.includes(SEED_TEXT) || SEED_TEXT.includes(p.content));
  ok('吧友帖里没有"最近那条帖子的原文"', copied.length === 0,
    copied.length ? `帖 ${copied.map((p) => p.id).join(',')} 正文=${copied[0]?.content}` : `吧友帖 ${mine.length} 条`);
  ok('桩收到过第二次起帖请求（"重说一遍"真的发生了）', stubCalls.post >= 2, `起帖请求 ${stubCalls.post} 次`);
  if (COPY_MODE === 'always') {
    ok('重说之后还在抄 ⇒ 这一轮根本不起帖', mine.length === 0, `吧友帖 ${mine.length} 条`);
  } else {
    ok('重说干净之后帖才落下来，正文是干净的那句',
      mine.length >= 1 && mine.every((p) => POST_TEXTS.includes(p.content)),
      mine.map((p) => p.content.slice(0, 14)).join(' | '));
  }
  ok('没有认不出的请求形状', stubCalls.unknown === 0, `unknown=${stubCalls.unknown}`);
} else if (mode === 'off') {
  // 线上的常态：旋钮默认就是关的。关着的时候敲多少下 tick 都不许有吧友帖、不许花 token、不许碰上游。
  console.log('\n[off] 旋钮关着：tick 敲再多下也不许起帖、不许花 token、不许碰上游');
  const before = (await usage()) as { userToday: number; allToday: number };
  for (let i = 0; i < 12; i++) {
    await call('/api/feed/tick', { method: 'POST' });
    await sleep(300);
  }
  const after = (await usage()) as { userToday: number; allToday: number };
  const mine = (await allPosts()).filter((p) => p.author.kind === 'agent');
  ok('关了以后一条吧友帖都不起', mine.length === 0, `吧友帖 ${mine.length} 条`);
  ok('关了以后账一分不动（压根没生成）',
    after.userToday === 0 && after.allToday === 0 && after.allToday === before.allToday,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  ok('关了以后一次上游都没发生', stubSeen === 0, `stubSeen=${stubSeen}`);
  ok('没有认不出的请求形状', stubCalls.unknown === 0, `unknown=${stubCalls.unknown}`);
} else {
  console.log('\n[ok] tick 该让吧友自己起一条帖，别的吧友到楼里接话');
  const seen = new Map<number, FeedPost>();
  // 30 秒：起帖是由"每个人自己的间隔 + slug 哈希错开的开场相位"算出来的，最慢那位能到 120 秒，
  // 所以窗口短了就是**看没看见**的问题（12 秒那次在慢机器上真的什么都没等到）。
  // 这不是"等结果"，是守着下面那条"tick 真的让吧友自己起了一条帖"的前置条件，别改成跳过。
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await call('/api/feed/tick', { method: 'POST' });
    for (const p of await allPosts()) if (p.author.kind === 'agent') seen.set(p.id, p);
    await sleep(400);
  }
  const posts = [...seen.values()].sort((a, b) => a.created_at - b.created_at);
  ok('tick 真的让吧友自己起了一条帖', posts.length >= 1, `吧友帖 ${posts.length} 条`);
  ok(
    '楼主是吧友本人，正文走的是起帖那条提示词',
    posts.length >= 1 && posts.every((p) => !!p.author.slug && POST_TEXTS.includes(p.content)),
    posts.map((p) => `${p.author.slug}:${p.content.slice(0, 8)}`).join(' | '),
  );

  const first = posts[0];
  if (first) {
    // 它自带的那批 pending 楼层：谁在等、等几个，页面靠 `pending` 数；断言"至少有一个人会来"
    ok('新帖自带"会有人来"的 pending 楼层', first.pending >= 1, `pending=${first.pending}`);
  }

  // 轮到谁接话是按 `due_at` 全局排序的（不是按帖），而且"日子过得慢"的人要半小时后才到 ——
  // 所以这里不盯第一条帖，找**已经有人说出口的那栋吧友楼**当样本。样本是扫描出来的，不是猜的。
  // 窗口 45 秒：下面"同一位吧友不在自己间隔内重复起帖"要真的看见重复，而最快那一档的间隔是
  // 9.2s、中间档 27.6s（`perDay=100000`）—— 所以这段时间里顺手把新起的帖也收进 `seen`
  // （以前只收第一段的，第二段起的帖对下面那两条断言是隐形的，于是"确实开了不止一条"会假红）。
  const due = Date.now() + 45_000;
  let spoken: FeedPost | undefined;
  while (Date.now() < due) {
    await call('/api/feed/tick', { method: 'POST' });
    const now = await allPosts();
    for (const p of now) if (p.author.kind === 'agent') seen.set(p.id, p);
    if (!spoken) {
      spoken = now
        .filter((p) => p.author.kind === 'agent' && p.floors.length >= 1)
        .sort((a, b) => a.id - b.id)[0];
    }
    await sleep(400);
  }
  ok('别的吧友到吧友起的楼里接话了', !!spoken, spoken ? `post=${spoken.id} 楼主=${spoken.author.slug} 楼层 ${spoken.floors.length}` : '25 秒里没有一层说出口');
  ok(
    '楼主不在自己那栋楼的接话名单里',
    !!spoken && spoken.floors.every((f) => f.slug !== spoken?.author.slug),
    spoken ? `楼主=${spoken.author.slug} 接话=${spoken.floors.map((f) => f.slug).join(',')}` : '',
  );
  ok(
    '接话的都是别的吧友（不是楼主自己接自己）',
    !!spoken && spoken.floors.every((f) => f.kind === 'agent' && !!f.slug),
    spoken ? spoken.floors.map((f) => `${f.kind}/${f.slug}`).join(' ') : '',
  );

  // 同一个吧友在自己的间隔内不重复起帖：把每位吧友的相邻两条帖拎出来比。
  // 用两段窗口合起来的快照 —— 重复多半发生在后面那段，只看第一段会漏。
  const postsAll = [...seen.values()].sort((a, b) => a.created_at - b.created_at);
  const bySlug = new Map<string, FeedPost[]>();
  for (const p of postsAll) {
    const slug = p.author.slug as string;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), p]);
  }
  const repeated = [...bySlug.values()].filter((g) => g.length >= 2);
  ok('这一轮里确实有吧友开了不止一条帖（否则下面那条断言是空的）', repeated.length >= 1,
    `两段窗口共 ${postsAll.length} 条 · ` + [...bySlug].map(([s, g]) => `${s}×${g.length}`).join(' '));
  const tooSoon = repeated.flatMap((g) =>
    g.slice(1).map((p, i) => ({ p, prev: g[i] as FeedPost })).filter(({ p, prev }) => p.created_at - prev.created_at < intervalOf(p.author.slug as string) - 1),
  );
  ok(
    '同一个吧友不在自己的间隔内重复起帖',
    tooSoon.length === 0,
    tooSoon.length
      ? tooSoon.map(({ p, prev }) => `${p.author.slug} 隔了 ${p.created_at - prev.created_at}ms（间隔 ${Math.round(intervalOf(p.author.slug as string))}ms）`).join(' | ')
      : `间隔 ${[...bySlug.keys()].map((s) => `${s}=${Math.round(intervalOf(s))}ms`).join(' ')}`,
  );

  // 形状那条：起帖 / 回帖两种请求都该见到过，且没有认不出的
  ok('罐头 LLM 见过"起帖"和"回帖"两种请求', stubCalls.post >= 1 && stubCalls.reply >= 1,
    `起帖=${stubCalls.post} 回帖=${stubCalls.reply} 印象=${stubCalls.impression}（开场窗口 ${Math.round(OPEN_WINDOW_MS / 1000)}s）`);
  ok('没有认不出的请求形状（prompt 形状变了就必须是红的）', stubCalls.unknown === 0, `unknown=${stubCalls.unknown}`);

  // 印象只记"楼主自己写下来的话"。吧友自发帖（L-1）的正文是那位吧友的生活，被当成楼主的经历记下来
  // 就会变成"他手全是狗毛"这种假记忆（2026-10-05 真库实测 9 行，见 index.ts 那个守卫的注释）。
  // 楼主自己发帖那条路必须照旧写印象，由 src/e2e-memory.ts 守着。
  const drained = posts.filter((p) => p.pending === 0 && p.floors.length >= 1);
  ok(
    '吧友自发帖一次印象都不许写（印象只记楼主自己写的话）',
    stubCalls.impression === 0,
    `印象=${stubCalls.impression} · 已经全部说完的吧友帖 ${drained.length} 条`,
  );
}

(stub as Server | null)?.close();
console.log(`\n${failures ? `✗ ${failures} 条不过` : '✅ 全过'}`);
process.exit(failures ? 1 : 0);
