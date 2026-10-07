import type { Pace, Persona } from './personas.ts';
import { metaNotes } from './meta-note.ts';

/**
 * "谁来接这个话茬" —— 从"按上网习惯抽签"改成"每个人自己判断"。
 *
 * 用户原话：「一个帖子（无论谁发的，ai 还是用户），每个吧友都应该结合自身性格评估要不要回……
 * 有些话题下面可以聊的热火朝天，有些话题可能没什么意思人就少」。
 * 改之前：`COUNT_WEIGHTS` 抽**人数**、`pickByPace` 按"谁爱上网"抽**是谁** ——
 * 人数已经不定，但抽签跟"这个话题他在不在意"毫无关系。这就是要改的地方。
 *
 * 为什么单独一个文件：这段是纯逻辑（不碰 db、不起 server），要能被 `src/test-replies.ts`
 * 直接 import。**放在 index.ts 里做不到** —— index.ts 末尾就是 `serve(...)`，
 * import 它的那一刻会把整个 server（和 env.dbPath 那个真库）一起带起来。
 *
 * 判断依据只有 `Persona.topics` + 一点运气：**不调模型**（发帖那一刻多打 4~20 次上游，
 * 成本和延迟都受不了）。
 */

/** 一帖最多几个人开口。人设池扩到 12~20 位之后要把上限往上提 —— 届时和 task-5 一起定。
 *
 * **底概率随人数摊薄**（`speakChance` 的 `SPEAK_BASE / n`）：`SPEAK_BASE = 0.6` 是从
 * 4 人时代实测的底概率反推的 —— `0.6 / 4 = 0.15`，所以 4 个人时行为**逐字不变**；
 * 16 个人时底概率自己降到 0.0375，冷帖才不会"来一屋子人"（"没意思的帖人少"是产品承诺）。 */
export const MAX_REPLIERS = 4;

/** 底概率的分子：`p0 = SPEAK_BASE / 人数`（4 人 → 0.15，与旧公式的常数一致）。 */
export const SPEAK_BASE = 0.6;
/** 每多命中一个词加多少概率。 */
export const SPEAK_SLOPE = 0.25;
/** 开口概率的天花板（命中再多也不会"必来"）。 */
export const SPEAK_CAP = 0.85;

/** 按"上网习惯"加权：只在**并列时**用来分先后（常冲浪的更可能排在前面）。 */
export const PACE_WEIGHT: Record<Pace, number> = { surfer: 3, evening: 2, slow: 1 };

/** 这个人在正文里命中几个"自己会主动接的话茬词"。 */
export function topicHits(p: Persona, text: string): number {
  return (p.topics ?? []).filter((t) => t && text.includes(t)).length;
}

/**
 * 他自己开口的概率：命中越多越可能开口，但**命中 0 不是闸门** ——
 * 0 命中的那位仍有 `SPEAK_BASE / 人数` 的底概率（起司对"加班/熬夜"这种帖子命中 0/6，
 * 可他也得有机会应一声，不然"人少"就变成了"永远没他"）。
 *
 * `n` 是这一帖的候选人数（`bar.length`）：人越多，每个路过的人开口的底概率越小
 * （`0.6 / n`），这样"冷帖大概来一个人"在任何池子大小下都成立。
 */
export function speakChance(hits: number, n: number): number {
  return Math.min(SPEAK_CAP, SPEAK_BASE / n + SPEAK_SLOPE * hits);
}

/**
 * 抽"这条帖子谁来"：每个人**各自**判断要不要接这个话茬。
 *
 * 三条不许破的规矩：
 *  - **至少一个人应一声**（"说给洞里听，总会有人回你"是承诺，"谁都不来"这一档不做）：
 *    命中最多的人保底必进，并列时按上网习惯、再按一次 rand。
 *  - **第一位仍然是快的**：他优先冲浪的（没有冲浪的就优先不慢的）—— 帖子发出去半小时
 *    没人吭声，那不叫慢，那叫坏了。
 *  - 人数上限 `MAX_REPLIERS`（成本闸门的一部分）。
 *
 * 纯函数：不碰模型、不碰时钟，随机源由调用方注入。
 */
export function pickResponders(bar: Persona[], text: string, rand: () => number): Persona[] {
  if (!bar.length) return [];

  // 先把"并列时用来分先后"的那次 rand 抽掉：rand 的调用顺序必须是定的，
  // 更不能在 sort 的比较函数里调 rand（比较函数跑几次、按什么顺序跑都不保证）。
  const scored = bar.map((p) => ({ p, hits: topicHits(p, text), tie: rand() }));
  const rank = (a: { p: Persona; hits: number; tie: number }, b: { p: Persona; hits: number; tie: number }) =>
    b.hits - a.hits || PACE_WEIGHT[b.p.pace] - PACE_WEIGHT[a.p.pace] || a.tie - b.tie;

  // 1. 各自独立抽一次
  const spoke = scored.filter((s) => rand() < speakChance(s.hits, bar.length));

  // 2. 保底：最在意这个话题的那位必进
  const most = scored.slice().sort(rank)[0];
  if (most && !spoke.includes(most)) spoke.push(most);

  // 3. 排序：第一位优先快的，其余按命中数降序、再按上网习惯
  const picked = spoke.slice().sort(rank);
  const surfer = picked.findIndex((s) => s.p.pace === 'surfer');
  const fallback = picked.findIndex((s) => s.p.pace !== 'slow');
  const idx = surfer >= 0 ? surfer : fallback;
  if (idx > 0) picked.unshift(...picked.splice(idx, 1));

  return picked.slice(0, MAX_REPLIERS).map((s) => s.p);
}

/**
 * "抄句"的尺子：跟同一帖里**已经说出口的**话比，最长能连着重合多少个字。
 *
 * 为什么要治：模型会把前面几层的整句抄回来（baren 把 eval 改成线上同形后量到 r127 一处、
 * r128 三处，其中一条 100% 重合）。**给字的是引文本身，改措辞治不住** —— 所以这一步不是
 * 让它"换个说法"，而是产品层不接受抄句（`index.ts` 里那道"重说一次，还抄就这层不渲染"）。
 *
 * 归一化只在这里一份（`bare`，已 export 出去给别的尺子 import）：比较前两侧都去掉空白 +
 * 标点/符号，所以只差一个标点的复读照样命中。同一条规则各写一份的下场已经量到过：同一个
 * r127~r131 语料，qc 得 12/120、baren 得 10/120，差的正是标点/空白口径。
 *
 * **`eval.ts:189` 的 `stripPunct` 不是这一份、也没换成 import**：它只去一张手写字符表
 * （不含 ASCII 标点、不含符号/emoji），换过来会改它的数（≈改语义）—— 要合的话得先重量一轮。
 *
 * `from` 是那段被判为抄的连着的话（归一化之后的形态），`run` 是它的长度；谁都没重合就是
 * `{ run: 0, from: '' }`。阈值 `COPY_RUN` **也只在这个文件里定义一处**。
 */
export const COPY_RUN = 10;

export const bare = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, ''); // 空白 + 标点/符号：尺子两边同一把

/**
 * "整句复读"的尺子（第二把枪）：同一帖里，规范化之后**整句**一样（≥ `RECITE_RUN` 字）就算抄。
 *
 * 为什么要单独立一条：上面那把是**字数窗口**，够不到"只差尾标点/语气词的整句复读" —— 线上量到过：
 * 帖7 三层「那家店现在卖什么糖」/「那家店现在卖什么糖……」/「那家店现在卖什么糖？」规范化后是同一句，
 * 最长逐字重合只有 9 字，落在 `COPY_RUN` 下面，于是整栋楼都在说同一句话还一路绿灯。
 * 阈值/流程/日志都不新造：命中就走 `index.ts` 里已有的"重说一次，还抄这层不拿出来"。
 *
 * 规范化只比 `longestRun` 多一步：同一个 `bare`（去空白 + 标点/符号）之后，再反复剥**尾部语气词**；
 * **不剥 `了`/`的`** —— 剥了会把「别等了」和「别等」并成一句，那是另一回事。
 * 返回重复的那句（规范化之后），没重复就是空串。
 */
export const RECITE_RUN = 6;

/**
 * 第三把“抄句”尺子：不同整句也可能共享同一个句首/句尾模板。
 * 只比较归一化后的首、尾 k 字；不降低 COPY_RUN，避免把正常短语误判成整句复读。
 */
export const TEMPLATE_RUN = 6;
/** 同拨起帖尺子：同一用户近窗口内，其他吧友自起帖的最长连续重合。 */
export function batchRepeat(a: string, texts: string[], k = TEMPLATE_RUN): { run: number; from: string } | null {
  const hit = longestRun(a, texts);
  return hit.run >= k ? hit : null;
}

export function templateRepeat(a: string, texts: string[], k = TEMPLATE_RUN): { kind: 'prefix' | 'suffix'; from: string } | null {
  const x = bare(a);
  if (k < 1 || x.length < k) return null;
  const parts: Array<{ kind: 'prefix' | 'suffix'; value: string }> = [
    { kind: 'prefix', value: x.slice(0, k) },
    { kind: 'suffix', value: x.slice(-k) },
  ];
  for (const raw of texts) {
    const t = bare(raw);
    if (t.length < k) continue;
    if (t.slice(0, k) === parts[0]!.value) return { kind: 'prefix', from: parts[0]!.value };
    if (t.slice(-k) === parts[1]!.value) return { kind: 'suffix', from: parts[1]!.value };
  }
  return null;
}

const TAIL_TONE = /[啊呀吧呢哦噢唉哎嘛啦咯喽嘞哈呵嗯呗喔哟]+$/;

const whole = (s: string): string => {
  let t = bare(s);
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(TAIL_TONE, '');
  }
  return t;
};

export function wholeRepeat(a: string, texts: string[]): string {
  const x = whole(a);
  if (x.length < RECITE_RUN) return '';
  for (const t of texts) if (whole(t) === x) return x;
  return '';
}

/**
 * "元叙述"的尺子（第三把枪）：模型把**给自己的自查备注**写进了回复正文。
 *
 * 现场（r158 帖3 `随安SuiAan`）：`…只是话不该说死。\n\n(注：此回复严格遵循指令——驳前句（她催的动机），
 * 给后见（你在乎她），长度约 38 字，无废话，无禁止词，无空行。)` —— 用户一眼看出这是"AI 交作业"。
 * （括号是**半角**的；全角那份也认，判据在 `meta-note.ts` 里，这里不重复。）
 * baren 的来源诊断（192 条最终 prompt 逐字 grep）**0 命中**：不是字面串被念出来，是模型把共享规则区的
 * **自检口吻**反着复述（`personas.ts:934/1033/1036/1050`）。
 *
 * **判据只有一份：`meta-note.ts`（QC-42，b1 落的那份）** —— 这里不抄正则、也不扩词表，只把"命中的第一截字"
 * 取出来给 `index.ts` 打日志（`metaNotes` 是去重保序的数组，与 qc/baren 的尺子同源）。宽泛的 `注`/`备注`/
 * `自检` 都不算（「我注了下水」必须穿过）。没命中返回空串（与 `wholeRepeat` 同形）。
 */
export function metaNote(s: string): string {
  return metaNotes(s)[0] ?? '';
}

/**
 * "背往事"的尺子（第四把枪）：回复跟**这一层 prompt 里真的注进去的那一条往事**逐字重合 ≥ `MEMORY_RUN` 字。
 *
 * 为什么要治：往事是"要点不是台词"（`personas.ts:985` 逐字写着），可模型会把它整段背出来 ——
 * task-45 的 21 条往事落盘后机器护栏全绿而**人读判否**（qc 读出来是"把履历念一遍"：逐字整条搬 13/96）。
 * 往事内容要留（那是"他有生活"），但"引用往事必须改写"得由产品路径的枪来兑现。
 *
 * **为什么叫 `MEMORY_RUN` 而不是 `RECITE_RUN`**：`RECITE_RUN`（=6）已经被上面那把"整句复读"的枪占了，
 * 那是**另一条口径**（整句一样，比谁跟谁）。这里是"跟往事重合多少字"，判据、阈值、比的对象都不同 ——
 * 共用一个名字只会让后来人把两把枪改串。
 *
 * 阈值默认取 10：人读发现两条 11 字整段照搬在 13 下仍被放行，升高只会继续漏；降到 10 是已做重放后可接受的实验档位。
 * `MEMORY_RUN` 是实验旋钮，允许用环境变量覆盖（1..96）；`MEMORY_GUN` 默认仍关。
 *
 * 口径**窄到只有这一条**：只比这一格 `pickMemory(...)` 的返回值。
 * 不比他的别的往事、不比别人的往事、更不比 `personaText` —— 往事和 life 本来就共用词汇
 * （`eval.ts` 专门有断言查"往事和正文说了同一件事"），宽口径会把正常句一片误杀。
 * 归一化还是 `longestRun` 里那一份 `bare`（去空白 + 标点/符号），所以只差标点的背照样命中。
 */
const MEMORY_RUN_DEFAULT = 10;

export function memoryRunFrom(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return MEMORY_RUN_DEFAULT;
  const i = Math.trunc(n);
  return i >= 1 && i <= 96 ? i : MEMORY_RUN_DEFAULT;
}

export const MEMORY_RUN = memoryRunFrom(process.env.MEMORY_RUN);

export function recitesMemory(text: string, memory: string | null): { run: number; from: string } {
  if (!memory) return { run: 0, from: '' };
  const r = longestRun(text, [memory]);
  return r.run >= MEMORY_RUN ? r : { run: 0, from: '' };
}

export function longestRun(a: string, texts: string[]): { run: number; from: string } {
  const x = bare(a);
  let best = { run: 0, from: '' };
  for (const t of texts) {
    const y = bare(t);
    if (!y) continue;
    for (let i = 0; i < x.length; i++) {
      for (let j = 0; j < y.length; j++) {
        let k = 0;
        while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
        if (k > best.run) best = { run: k, from: x.slice(i, i + k) };
      }
    }
  }
  return best;
}
