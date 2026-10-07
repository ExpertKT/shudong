/**
 * 吧友自己起话头（L-1）—— 密度旋钮 + 起帖的提示词。
 *
 * 为什么单独一个文件：这一段的"谁该开口、多久开口一次"是**纯逻辑**（不碰 db、不起 server），
 * 可以被 `e2e-agentpost.ts` 直接 import 来验（`replies.ts` 当初分出去也是这个理由）；
 * 而"起帖的提示词"和回帖的 `systemPrompt` 是**两个语境**（那句写死了"你是回帖的人之一"），
 * 文案单放这里，将来改它不用动 index.ts。
 *
 * 密度为什么按整个吧、按上网习惯加权：
 *  - 按人头表达 = 人设池一扩容就翻倍（16 个人每人每天 1 帖 = 16 帖，用户没投这个）；
 *    按整吧表达 = `perDay` 就是这个洞里所有吧友加起来一天的新帖数。
 *  - 加权：常冲浪的那位本来就更容易开新话头（`replies.ts` 的 `PACE_WEIGHT`：
 *    surfer 3 / evening 2 / slow 1），所以 `interval_i = 一天 * Σw / (perDay * w_i)`
 *    —— 权重高的那位间隔短，谁也不会跟谁同一秒开火。
 *  - 没有历史帖的人按 slug 取一个固定**相位**，从"这个吧第一次被考虑"起算（错峰）：
 *    四个人不会同一秒集体开火，也不会先哑一整个间隔（`perDay = 2` 时那是一个人十几个小时）。
 *    基准由调用方给（`openingBase`）而不是这里自己取 now()：同一个基准要跨 tick 固定住，
 *    否则每轮重算一次相位，到点永远不会到来（这是落码时踩到的一个坑）。
 *
 * 账本就是 `posts` 表（`MAX(created_at) WHERE user_id = ? AND author_slug = ?`，见 index.ts）：
 * 不新增表、进程重启后自愈（下一轮 tick 自己会从库里重新算谁到点了）。
 */
import { BANNED, personaText, type Persona } from './personas.ts';
import { PACE_WEIGHT } from './replies.ts';
import { streamChat, type Msg, type Usage } from './llm.ts';

export const DAY_MS = 86_400_000;

/**
 * 开场窗口：从来没起过帖的吧友，第一次被考虑之后的这段时间里错峰开口。
 *
 * 为什么不是"每人先哑一个完整间隔"：间隔是按密度算出来的（`perDay = 2` 时一个人十几个小时），
 * 那样刚开这个旋钮的头一天，洞看着像死的 —— 用户投的恰恰是"热闹"。
 * 也不是"同一秒集体开火"：从没起过帖的人按 slug 的固定 rank 均匀摊在这个窗口里。
 *
 * 窗口是小时级的：池子 4→16 之后，`120_000` 会把十几位新人挤在两分钟里一起开口。
 * 摊开的方式必须"按 rank 铺满"、不能是"`slugHash % windowMs`" —— 取模在小时级窗口下
 * 第一位也要等几十分钟，`e2e-agentpost` 那条"15 秒内必须开出一条"会挂。
 */
export const OPEN_WINDOW_MS = 2 * 60 * 60 * 1000;

/** 同一个 slug 每次都得到同一个相位（错峰用；不要求密码学强度）。 */
export function slugHash(slug: string): number {
  let h = 2166136261;
  for (const ch of slug) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 这位吧友起话头的间隔（毫秒）。`perDay` 是整个吧一天的新帖数。 */
export function postIntervalMs(bar: Persona[], perDay: number, p: Persona): number {
  const total = bar.reduce((n, x) => n + PACE_WEIGHT[x.pace], 0);
  return (DAY_MS * Math.max(1, total)) / Math.max(1, perDay * PACE_WEIGHT[p.pace]);
}

export type Poster = { slug: string; intervalMs: number; waitedMs: number };

/**
 * 谁该起话头了。`lastAt(slug)` 是账本里那个人上一次起帖的时间（没发过返回 0）；
 * `openingBase` 是"这个吧第一次被考虑"的时刻（调用方给，且**只看一次就固定下来**）。
 * 纯函数：不碰 db、不碰时钟 —— `at`、账本、开场基准都由调用方给，所以 e2e 不用等真实的一天。
 */
export function pickPoster(
  bar: Persona[],
  perDay: number,
  at: number,
  lastAt: (slug: string) => number,
  openingBase: number,
): Poster | null {
  if (!(perDay > 0) || !bar.length) return null;
  // 开场错峰的铺位：按 slugHash 升序 rank（同 hash 用 slug 兜底），与 `bar` 的传入顺序无关。
  const opening = [...bar].sort(
    (a, b) => slugHash(a.slug) - slugHash(b.slug) || (a.slug < b.slug ? -1 : 1),
  );
  let best: Poster | null = null;
  let bestOverdue = 0; // 正好到点(0)也算到点；严格小于 0 才是还没到
  for (const p of bar) {
    const intervalMs = postIntervalMs(bar, perDay, p);
    const last = lastAt(p.slug);
    // 没有历史帖：从开场基准起算，按 rank 摊在 `OPEN_WINDOW_MS` 里 —— 谁先开口每次都一样，
    // rank0 就在 0ms（这个窗口不能跟着间隔一起变长，见上面的说明）。
    const windowMs = Math.max(1, Math.min(intervalMs, OPEN_WINDOW_MS));
    const startedAt =
      last > 0
        ? last + intervalMs
        : openingBase + Math.floor((opening.indexOf(p) * windowMs) / opening.length);
    const overdue = at - startedAt;
    if (overdue < 0) continue;
    if (best === null || overdue > bestOverdue) {
      bestOverdue = overdue;
      best = { slug: p.slug, intervalMs, waitedMs: at - startedAt + intervalMs };
    }
  }
  return best;
}

/**
 * 起帖的提示词。和回帖那条守同一份纪律：**不举例、不给词表、不写格言/金句**
 * —— prompt 里每个具体字符串都是锚点，会被原样念出来（这个项目上已经验过 7 次以上）。
 * `recent` 是洞里最近几条帖子正文，只用来"换个话题"，不是给它可以抄的句子。**但它确实摆在
 * 模型面前** —— 所以 index.ts 的 `maybeAgentPost` 在 INSERT 之前拿这两把已有的抄句尺子
 * （`longestRun` + `COPY_RUN`、`wholeRepeat` + `RECITE_RUN`）量一遍，命中就重说、重说还抄就
 * 这轮不起帖（`[抄旧帖]` 单独记账）。这里只负责拼词，兜底不在这一层。
 */
export function postPrompt(p: Persona, recent: string[]): string {
  return [
    `你是${p.name}。`,
    personaText(p),
    '',
    '你在一个匿名树洞里，这次是你**自己**想写点什么 —— 不是回谁的话。',
    // 不把最近帖原文喂给模型：具体句子（尤其收尾）会被跨人设照搬成同一模板。
    // 话题切换由 persona 自己的 life/voice/cares 提供；输出抄旧帖的事后枪仍保留作旧库兜底。
    ...(recent.length ? ['', '洞里刚有人说过话，这次只写你自己的事，不接着复述他们。'] : []),
    '',
    '怎么写这条：',
    '- 一句想说的话就够了：今天碰上的事、心里过不去的那个点、随口的一个念头。',
    `- 篇幅跟别人发的帖子一个量级，十几到几十个字，最多两句。上限 ${p.maxChars} 字。`,
    '- 说你自己的事，就说上面那一段里的事；不要现编一件更大的事，也不要写你不知道的细节。',
    '- 不要打比方，不要写格言或者金句，不要劝人，也不要写成问题清单。',
    `- 不要出现这些词：${BANNED.join('、')}。`,
    '- 不要列表、不要 Markdown、不要 emoji、不要空行分段，也不要用"/"把句子排成一列。',
    '',
    '直接开始写。整条帖子是**一行**：不换行、不空行，也不写"帖子：""标题："之类的标记。',
  ].join('\n');
}

/** 生成一条起帖正文要发出去的消息（system + user）。`note` 只在"重说一遍"时用（跟回帖那把枪同一形状）。 */
export function postMessages(p: Persona, recent: string[], note = ''): Msg[] {
  return [
    { role: 'system', content: postPrompt(p, recent) },
    { role: 'user', content: '（写一条你自己的。）' },
    ...(note ? [{ role: 'user' as const, content: note }] : []),
  ];
}

/**
 * 生成一条起帖的正文。**折成一行**（不靠模型听话：回帖那边已经量到每 30 条有 1 条自己排起版来），
 * 空的/太短的直接抛 —— 宁可这一轮不发，也不能往洞里塞一条"熬"。
 * usage **不在这里记**：那一笔归谁的账是 index.ts 的事（`recordUsage(..., userId)`）。
 */
export async function composePost(p: Persona, recent: string[], onUsage: (u: Usage) => void, note = ''): Promise<string> {
  let out = '';
  for await (const chunk of streamChat(postMessages(p, recent, note), { maxTokens: p.maxTokens, onUsage })) {
    out += chunk;
  }
  const text = out.replace(/\s*\n+\s*/g, ' ').trim();
  if (text.replace(/\s/g, '').length < 4) throw new Error('模型没写出一条像样的帖子');
  return text;
}
