/**
 * 人设评测。
 *
 * 为什么要有这个文件：人设是"活人感"的命门，而人设改坏了从 typecheck 里看不出来。
 * 之前那版的问题不是文笔，是**结构**：招牌道具（关东煮）被写进了人设正文，
 * 还被明确要求"偶尔提一句"。模型当然每条都提 —— 用户的原话是"0 人在意你关东煮"。
 *
 * 这个脚本能自动抓的，只有"演"的痕迹：
 *   - 招牌词刷屏：跟他的工作八竿子打不着的帖子，他还在提关东煮 / 修表 / 绿萝
 *   - 复述：把对方写的话换个说法念一遍（3-gram 重合）
 *   - 抄原话：把楼主的句子成串搬过来再挂个尾巴（去标点后最长逐字重合 ≥7 字）
 *   - 正确的废话：BANNED 词
 *   - 超长：树洞里没人读 300 字
 *   - 打比方：真人 60 条样本里一条都没有，却是模型撑长度装文艺的首选（"就像……似的"）
 *   - 编时间：说出帖子和往事里都没有的钟点（老陆："两点半出门的"）
 *   - 尺子自身的健全性：道具词如果本来就写在人设/往事里，那条检查只会误报，启动即失败
 * 抓不到的是"这句话像不像人说的"—— 那个只能人读，所以这里会把回复原文打出来。
 *
 * 第二块是**分布对照**：真人样本（豆瓣 4 个树洞/情感话题的 60 条非楼主回复，人工逐条编码）
 * 的长度、标点、自曝、建议、结尾方式，和我们这 24 条的分布摆在一起看。
 * 依据见下面 BASELINE 的注释。分布是软指标（n 只有 24，噪声大），只报警不计失败。
 * task-13 之后又并排了**当下**真人语料的形状（B站两批弹幕，`CORPUS` + `corpus/words-*.md`）——
 * 它体裁不同（边看边发的短反应），只作参考、不判偏差；语料只喂尺子，绝不进 prompt。
 *
 * 不经过 server、不写数据库，直接调模型。默认走本机 Ollama，免费。
 *   pnpm --filter @shudong/server eval:personas
 *   $env:ONLY='anhe,qisi'; $env:POSTS='2'; ...   # 只跑几个人 / 只跑前两帖
 */
import { pathToFileURL } from 'node:url';
import { PERSONAS, BANNED, personaText, pickMemory, systemPrompt } from './personas.ts';
import { metaNotes } from './meta-note.ts';
import { streamChat, target } from './llm.ts';

type Post = {
  id: number;
  /** 帖子里的事跟"你的工作/招牌道具"有没有关系 */
  propsAllowed: boolean;
  text: string;
};

/**
 * 测试帖要覆盖不同处境 —— 如果一个人只在"加班累"那帖里像人、别的帖全靠道具凑，
 * 那他不是在回帖，是在演自己。
 */
const POSTS: Post[] = [
  // 加班到半夜跟夜班真的有关，所以这条允许他提 —— 测的是"相关的帖子里他提不提得起、会不会只提一次"
  { id: 1, propsAllowed: true, text: '最近连着第三周加班到半夜，早上根本爬不起来，感觉身体在报警。' },
  { id: 2, propsAllowed: false, text: '分手一个月了，还是会习惯性点开他朋友圈，然后自己难受一晚上。' },
  { id: 3, propsAllowed: false, text: '我妈每次打电话都问我什么时候结婚，我说不想聊她还是说，我挂了又后悔。' },
  { id: 4, propsAllowed: false, text: '不知道该干什么，坐在椅子上刷了两个小时短视频，越刷越空。' },
  { id: 5, propsAllowed: false, text: '今天下班路上有只很小的橘猫蹲在电动车底下，我买了根火腿肠给它，它不吃，就盯着我看。' },
  // 这一帖跟便利店真的有关 —— 只有这种时候才允许他提道具，而且也只允许提一次
  { id: 6, propsAllowed: true, text: '半夜三点睡不着，下楼买了两瓶酒，坐在便利店门口喝完才上去。' },
];

const only = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const maxPosts = Number(process.env.POSTS ?? 0) || POSTS.length;
const personas = only.length ? PERSONAS.filter((p) => only.includes(p.slug)) : PERSONAS;
const posts = POSTS.slice(0, maxPosts);

// 这一把尺子的默认温度必须**等于线上的默认温度**（`server/src/llm.ts` 的 `opts.temperature ?? 0.9`），
// 否则量的就不是用户看到的东西。`EVAL_TEMP` 只有一个用途：量"把温度降下来会怎样"，
// 量出来的数字拿去跟 Lead 对齐之后才谈改 llm.ts（那个文件不在我的写作用域里）。
// 别用 `TEMP` 当变量名 —— 那是 Windows 自己的环境变量（临时目录）。
const TEMP = Number(process.env.EVAL_TEMP ?? 0) || 0.9;

const grams = (s: string): Set<string> => {
  const clean = s.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= clean.length; i++) out.add(clean.slice(i, i + 3));
  return out;
};

const sentences = (s: string) => s.split(/[。！？!?…，,；;\n]+/).map((x) => x.trim()).filter(Boolean);

/** 两条文本有多像（3-gram Jaccard）。用来抓"模板"和"抄例句"。 */
const alike = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared || 1);
};

/**
 * 真人回帖长什么样 —— 豆瓣 4 个树洞/情感话题 60 条非楼主回复的人工编码结果
 * （话题 302125627 / 267345277 / 285381453 / 210425920，逐条读过，见对话记录）。
 * 这不是"目标值"，是**用来照镜子的**：我们偏离越远，AI 味越重。
 *
 * 为什么要有这块：arXiv:2604.08479 实测 83–90% 的 LLM 回复命中同一个
 * "复述→验证→建议"模板，Self-Disclosure 使用率 LLM 是 0% 而 Reddit 真人是 68.2%。
 * 那个模板**人读起来舒服、评分还更高**（真人 M=3.71 vs GPT-4 Turbo M=4.18），
 * 所以"像活人"和"评分高"是两件事。要前者，就得对着真实分布校准。
 */
// ── 三条方法论：这是这个文件最该被读到的东西，比任何一个数字都值钱 ────────────────
//
// 1. **删掉"许可"句比加"禁令"有效。** 老陆的 voice 里原本写着"你爱问具体的数字和具体的
//    时间 —— 别人说'最近很累'，你想问的是'几点睡'"，于是他一连四轮编钟点（"十二点二十"
//    "两点半出门的"…）；后面那句"不许编"压不住前面这句**请他去吐钟点**。把那句删掉，
//    编时间立刻归零（迭代 9 验证）。**许可句是问题的产地，禁令只是事后围堵** ——
//    模型出毛病先回 prompt 里找"是谁请它这么干的"。
// 2. **往事的长度就是"照搬"能造成的伤害上界。** 35 字的往事被原样背出来就是 33 字的大段
//    （念简历，迭代 6 的阿禾）；压到 21 字以内，照搬也就 21 字，正落在真人中位数 11~30 里，
//    读起来就是一个人在提一句自己的事。所以治"背往事"要改往事，不是加检查 ——
//    我一度加过 12 字窗口的"抄往事"检查，它自己开始误报，删了。
// 3. **镜子错了两轮：凡是要照着一个数字调 prompt，先确认这个数字是量对了的。**
//    "讲到自己"那一项词表漏报（见下面的说明），我照着 4%/8% 这样的错数字调了两轮 prompt，
//    全是白调。度量本身也要被度量 —— 所以本文件里凡是"抓"的规则，都带一句它为什么这么定。

// ── 真人分布的基线：**这个文件是唯一来源**（lead 2026-10）────────────────────────
// 原来它漂在三处：这里 median 30、`personas.ts` 头部写"11~30"、报告里说过"约 20"。
// 三个数并存的话，下次谁都说不清改了没改。所以数字只留在下面这个对象里，别处一律只指向它。
//
// task-13 之后，这里的数字**分两类、来源不同**，别再混着用：
//   ① 形状类（句长 / 不写句末标点）—— 两份依据都列出来，**判分仍用豆瓣那 60 条**：
//      · 豆瓣 4 个树洞/情感话题的非楼主回复，n=60，人工逐条编码。**同体裁**（论坛回帖）。
//        来源：话题 302125627 / 267345277 / 285381453 / 210425920（见对话记录），2026-09。
//        **状态"暂借·未核"** —— 当初只落了编码结果，没有逐条落盘的原始文件，别人复核不了。
//      · B站两批弹幕（**当下**、机械可数、可重跑）—— 见下面的 `CORPUS`，体裁不同，只作参考。
//   ② 语义类（讲到自己 / 给建议 / 问句收尾）—— 只有豆瓣 n=60 一份：弹幕里数不出"讲到自己"
//      和"给建议"（要人读才能编码），所以这两项**没有被 task-13 重算**，状态照旧。
// 红线（lead 定的）：语料只喂尺子和对照表，**绝不进 personas 的 prompt**。
const BASELINE = {
  /** 长度中位数 11–30 字，≤10 字占 23%（豆瓣 n=60） */
  medianChars: 30,
  /** 42% 的回复连句末标点都没有（靠空格断句）（豆瓣 n=60）。**靶子就是这条 42%，不是弹幕的 78%** */
  noFinalPunct: 0.42,
  /** 28% 会讲到自己，且约 7 成放在承认对方之后（豆瓣 n=60 人工编码） */
  discloses: 0.28,
  /** 给建议的只有 10–13%（豆瓣 n=60 人工编码；弹幕里数不出这一项） */
  advice: 0.12,
  /** 以问句收尾的只 8%（断言收尾 58%）（豆瓣 n=60 人工编码） */
  askEnding: 0.08,
};

/**
 * 当下真人语料的**形状**基线（task-13，B站弹幕两批）—— 它只回答一件事：
 * "当下真人随手打出来的那一句，有多短、句末标点有多不齐"。
 * 依据（可重跑：`node F:\tmp\corpus-stats.mjs --replies F:\tmp\reply-24-r135.txt`；
 * 逐行读原文件、去掉空白后数码点，句末标点含"，、；："等所有标点）：
 *   · `F:\shudong\corpus\bili-danmaku-2026-10-05.txt`（第 1–2425 行，2026-10-05，n=2425）
 *       中位 9 字 / ≤8 字 47.3% / 不写句末标点 79.2% / 问号收尾 9.9%   sha256 `61C9FE28C804F239…`
 *   · `F:\shudong\corpus\bili-danmaku-2026-10-05-b.txt`（第 1–1191 行，2026-10-05，n=1191）
 *       中位 8 字 / ≤8 字 54.4% / 不写句末标点 74.9% / 问号收尾 4.5%   sha256 `2A3583151F311460…`
 *   · 合并 n=3616：中位 9 字 / ≤8 字 49.6% / ≤10 字 61.8% / 不写句末标点 77.8% / 问号收尾 8.1%
 *   · 标题两批（旁证，n=100 / n=287，中位 17 / 19 字）：只说明"标题比弹幕长"。
 * ⚠️ **体裁不同，别拿它当靶子**：弹幕是"边看边发的短反应"，一句 9 个字、多数不带标点是这类
 * 文本的天性；树洞回帖是"对着一个人说话"，句子长一倍（豆瓣 n=60 中位 11–30 字）。
 * 所以它**不参与判分**，只在下面的分布表里并排打出来，用来看"我们和当下口语的距离"。
 * 两批之间也稳（中位 9 / 8 字、不写句末标点 79% / 75%），单批对单批比总平均更值得看。
 * **方向（lead 2026-10-05 定）："不写句末标点"这个指标朝豆瓣的 42% 靠，绝不朝弹幕的 78% 靠。**
 * 拿弹幕当靶子会把回帖推成"每句 9 个字、句号全去掉" —— 那是把体裁差当缺陷。
 * `endingParticle`（末字是语气词）的依据：三份弹幕文件末字逐个数字，
 *   第 1 批 `…2026-10-05.txt` 第 1–2425 行 531/2425=21.9%，第 2 批 `…-b.txt` 第 1–1191 行 163/1191=13.7%，
 *   合并 640/3616=17.7%（弹幕末字 top：了、？、！、。、啊、的、吗、）、吧、呢）。
 * 它**只作参考不设线**：弹幕极短，一句一个语气词收尾本来就天然；回帖不该按 17.7% 追，看趋势。
 */
const CORPUS = {
  /** 两批弹幕合并（当下真人短句） */
  danmaku: { n: 3616, medianChars: 9, le8: 0.496, noFinalPunct: 0.778, askEnding: 0.081, endingParticle: 0.177 },
  /** 单批，用来看批次之间稳不稳 */
  batch1: { n: 2425, medianChars: 9, le8: 0.473, noFinalPunct: 0.792, askEnding: 0.099, endingParticle: 0.219 },
  batch2: { n: 1191, medianChars: 8, le8: 0.544, noFinalPunct: 0.749, askEnding: 0.045, endingParticle: 0.137 },
};

// ── 已知盲区：这些失败**故意不装机械判据**，由 qc 人读记单 ────────────────────────
// 写在这儿是为了下次别再试一遍 —— 每一条都已经有过"装上去会误伤"的证据：
//   · 同帖换说法说同一件事（QC-17 / QC-31）：r136 帖4 三个人各用一句话说"椅子凉"、
//     帖6 老陆与起司都说"钟摆"。同一帖里围着同一件事说本来就是正常的，逐字重合 < 10 字，
//     `longestRun` 与跨帖 Jaccard 都抓不到；机器抓会大面积误伤。
//   · 语义拧句 / 跑偏（QC-20）、改写事实（QC-23）：没有机械定义，人读才判得准。
//   · 对仗金句（QC-3/4 → QC-28）：是文采不是编事实，lead 只让记账。
//   · 跨轮同句自我复读（QC-33）：判据都在轮内，跨轮比要另建基线，先记账。

// 粗糙代理指标，只用来数分布，不当作判定依据
const FINAL_PUNCT = /[。！？!?…~～]$/;
const ASK_ENDING = /[？?]$/;
// ⚠️ 未校准（QC-29）：这是字面词表，换一句祈使句就全漏（"别硬撑""躺下吧"都不在里面）。
// 因此分布表里这一项**只显示不计分**，等 task-22 的逐条打标签尺子。
const ADVICE = ['试试', '要不', '建议', '你不如', '应该', '最好', '先去', '先把', '记得', '别忘'];
const DISCLOSE =
  /我也|我(以前|当时|那时候|那时|去年|上学|读书|做过|干过|见过|认识|朋友|同事|室友|妈|家)|(以前|当年|那会儿|那时候|当时|小时候)/;

// "抄例句"。这不是假想出来的风险：迭代 3 里阿禾和绵绵在同一帖里同时说出了当时 prompt 里的
// 整句（"别给自己太多压力""你不用今晚就想明白"）。
// 做法（旧）：把例句去掉标点后切成 6 字窗口，回复（同样去标点）里命中任意一个就算抄。
// **r140 起这把窗口尺子随例句一起退役** —— `personas.ts` 里最后一条具体例句（真人语料
// "我前年也这样，一个人在出租屋里坐到天亮"）在 r139 被整句搬走（帖1 老陆、帖1 绵绵），
// 按事先定好的路：例句不加回来、改成给形状，于是 `COPIED_WINDOWS` 没有弹药了
// （**它的 0 是构造性的 0，不是"干净"** —— 别把它读成通过；这是 QC-29 那个病，先标出来）。
// 仍然生效的是下面 `promptExamples`：扫 system prompt 里**所有带引号的具体句子**（QC round 1 的补丁），
// 谁再往 prompt 里塞一句带引号的话，它照样报。
const stripPunct = (s: string): string =>
  [...s].filter((c) => !'，。！？、；：·…～ \n「」“”"\'()（）'.includes(c)).join('');

// "讲到自己"的兜底判据。为什么会需要它：
//   迭代 10 里绵绵写了"我就在图书馆坐了很久，书也没翻几页"—— 那正是一句自曝，
//   可 DISCLOSE 的词表里没有"我在……"，漏掉了；分布表因此报 4%，而同一轮的汇总
//   里她的自述占比是 22%。**镜子和镜子里的东西对不上，那是镜子错了。**
// 判据是确定的：这次如果发给了她往事，而回复与往事有 4 字以上连续重合，她就是讲了
// 自己那件事。它只覆盖"给了往事"的半边帖子，所以也只是补漏，不改变这项是软指标。
const MEMORY_RUN = 4;
const usedMemory = (text: string, memory: string | null): boolean => {
  if (!memory) return false;
  const m = stripPunct(memory);
  const t = stripPunct(text);
  for (let i = 0; i + MEMORY_RUN <= m.length; i++) {
    if (t.includes(m.slice(i, i + MEMORY_RUN))) return true;
  }
  return false;
};


// 【这把尺子的洞 · QC round 1】原来那条 6 字窗口尺子只比对 prompt 里的例句，**结构上永远抓不到
// 写在 voice / 公共段里的例句** —— qc 就是这么抓到起司逐字回了我们写在起司 voice 里的反例
// 「那挺难受的」（还有公共篇幅句里的「不太合适吧」），而 eval 当时是全绿的。
// 一句话总结："按你的尺子过了、读起来还是假"就是这么来的。
// Lead 2026-10 的修法：把 system prompt 里**所有用引号写出来的具体句子**都当例句，回复里逐字
// 出现任何一条 = 硬失败（逐字重合没有假阳性，是硬信号）。注意这条和 `RECITE_RUN = 10`、
// `RECITE_WORDS` 是**三件事**：那个抓的是长重合（≥10 字）和窄词表，都漏"5 个字整句搬走"这一型。
// 排除三样：往事（按设计允许照搬，且它不在引号里）、昵称（「小满」，2 字）、长度 <3 的引文
// （"回复：""@某某"这种说明文字，不是一个能当话说出去的句子）。
// r140 之后这一条成了**唯一**的"抄例句"口径（窗口那把已退役，见上面）。
const PROMPT_QUOTE = /["“]([^"”]{2,})["”]|「([^」]{2,})」/g;
const promptExamples = (spNoMem: string, text: string): string[] => {
  const s = stripPunct(text);
  const out = new Set<string>();
  for (const m of spNoMem.matchAll(PROMPT_QUOTE)) {
    const q = stripPunct(m[1] || m[2] || '');
    if (q.length >= 3 && s.includes(q)) out.add(q);
  }
  return [...out];
};

// "成串抄楼主的原话" —— Lead 2026-10 从真实现场带回来的失败模式（用户发的帖子不在下面 6 条里）：
// 用户发「今天有点累，随便说两句。」，阿禾回「今天有点累，随便说两句。我也没说啥，就累了。」
// —— 把楼主整句搬过来再挂个尾巴。`在复述对方` 抓的是"换个说法念一遍"（3-gram 比例 + 12 字门槛），
// 而**逐字搬**一条短句的回复反而可能落在门槛下面，所以单独立一条：去标点后的**最长公共子串**。
// 门槛 7 是拿现有 6 条帖量过的：帖3 里"什么时候结婚"正好 6 个字，而任何人说这件事都躲不开这个说法
// （冤一个真的代价比漏一个大 —— 判据总原则）；现场那条照抄有 10 个字，7 有富余。
const COPY_RUN = 7;

// 复读：回复里出现、且和这一轮 **system prompt** 一模一样的一长串 —— 模型把提示词当内容念出来。
// 第一条证据是 r101 帖6（老陆，半夜买酒那帖）：「好难受啊他没写屋里有灯没开你也没看见别瞎猜这事
// 具体怎么发生的他没说你别替他编」——38 个字，全是我写在 prompt 里的规矩，它照着念了。
// 这条**不是**在治老陆一个人：它证明的是"靠把话写得更小心来让模型守规矩有上限"（Lead 的结论），
// 所以跟 `分段` 同一条路 —— 产品层机械兜底（bond 在 `speak()` 里重说/拦），这里只负责**数**。
// 阈值 10 字是起点，先量后装：**先只出数，别为了好看动阈值，也别改任何 prompt 去躲它。**
// 它是观测项（进 `warns` 不进 `failures`）：假阳性率还不知道，等量出来再定拦不拦。
const RECITE_RUN = 10;

// 与 `RECITE_RUN` 并列的第二项，也是这条线上**唯一有信号**的那个：只在规矩里出现的词。
// 为什么需要它：连续重合抓不住真复读 —— r101 帖6 那条 38 字（"好难受啊他没写屋里有灯没开你也没看见
// 别瞎猜这事具体怎么发生的他没说你别替他编"）拿当时的 prompt 比，最长只有 9 字，卡在 10 字以下，
// 因为复读是**把好几条规矩各截 6~9 字串起来**，不是逐字抄一整段。
// 这五个词是量出来的：最近四轮 42 条里命中 1 条，就是那条真复读，假阳性 0。
// **不许放宽**：加 `没写`/`别管`/`别硬撑` 会变成 3 条，多出的两条（"身体报警你就别硬撑了。"、
// "坐着就是坐着，别管刷了多少。"）都是正常说话。以后要加词，先拿到 42 条上量一遍报数再提。
const RECITE_WORDS = ['瞎猜', '替他编', '不许', '你没看见', '都没说'];
const longestRun = (a: string, b: string): string => {
  let best = '';
  let prev: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if (cur[j]! > best.length) best = a.slice(i - cur[j]!, i);
      }
    }
    prev = cur;
  }
  return best;
};

// 一度在这里加过一个"抄往事"检查（往事切成 12 字窗口，回复命中就算整句搬运）。删掉的理由：
// 迭代 6 确实出现过阿禾把往事整段背下来（memory 35 字，回复 33 字近逐字），但迭代 9 里它开始
// 误报 —— 阿禾只写了"把耳机摘了听她讲完 一句没回"（14 字，这轮最自然的一句），照样命中。
// 病根不在"有没有照抄"，在**往事写得太长**：往事长度就是照搬能造成的伤害上界。往事压到 20 字
// 以内之后，照搬最多也就 20 字，正好落在真人中位数 11~30 里，读起来就是人在提一句自己的事。
// 所以去 personas.ts 把往事改短，而不是在这里加检查。

/** 同帖撞词窗口。见下方"跨人设撞车"处：7 是拿真实一轮的 24 条量出来的，8 漏、7 中。 */
const SAME_RUN = 7;

// "打比方"。真人 60 条样本里没有一条这么写，但它是模型撑长度、装文艺最顺手的工具 ——
// 迭代 5 里绵绵 6 条里 4 条靠它（"就像我上次去图书馆……似的"）。prompt 里已明令禁止，这里跟着盯。
// 迭代 7 里阿禾写了"那猫看着你，**像**那天店里那只不听话的猫**一样**" —— 是打比方，
// 但"像那天"不在下面的词表里，漏了。迭代 10 又写"那猫挺倔 **像**我也学不惯美甲**那样**"，
// 所以"像……一样"和"像……那样"两个框都补上 —— 编的人总会换个尾巴。
//
// ⚠️ 但**裸的"好像/像是"不能收**，这是我改错又改回来的一处：迭代 11 我把裸"好像"
// 放进词表，结果迭代 12（r8）连报三处假阳性，全是"猜测"不是"打比方"：
//   "那猫**好像**也在想吃什么" / "**好像**也是没办法的事儿" / "那猫跟你**好像**"
// 中文里"好像"当"大概"讲的频率远高于当"像"讲。我们找的是**用比喻撑长度**
// （"就像……似的""像……一样"），这几种框是无歧义的；剩下的靠人读。
//
// 迭代 11 又漏了一处："那只猫不吃的样子，**像极了**以前我在美甲店学不下去…的时候" ——
// 尾巴是"的时候"不是"一样/那样"，两个框都没兜住。补 `极了`（无歧义，就是比喻）。
// 这条正则已经是第三次补了，说明"哪几个尾巴"这件事穷举不完；凡是补一次就记一次账，
// 别把"漏了"当成"没有了"。
const SIMILE = /就像|似的|仿佛|犹如|好比|像不像|像[^，。！？、\n]{0,14}(?:一样|那样|极了)/g;

// 【lead m03080 裁定 1：放宽，但不许进失败计数】上面那条严格正则当**硬线**（真 2 / 假 2，见
// `F:\tmp\simile-audit.mjs` 的审计：真 = r124 帖2「那个月亮似的」、r129 帖5「就像…钟摆停住那样」；
// 假 = r131 帖5「火腿肠没味道似的」、r135 帖2「像看见点什么似的」，都是"好像"式猜测、无喻体）。
// 它**结构上漏掉 `像 + 动词短语`** 那一型：r126 帖2 绵绵「像习惯性地关掉灯再走回黑屋子」、
// r128 帖3「像把没用的线缠在手上甩不掉」、r139 帖4「像谁在倒计时」（全是绵绵）。
// 这条宽口径只**显示、只计数、不计失败**：放宽能把真问题照出来，代价是把"好像式猜测"和纯抄句
// （r134 帖5 三人同句「看着你像在看个陌生人」）一起收进来 —— **让噪声显示出来，不许它驱动 prompt 改动**，
// 等 qc 人读分完类再决定要不要提成硬线（lead m03080）。
const LIKE_PENDING = /像[^，。！？、\n]{2,14}/g;

// "编时间"。老陆在迭代 5 里编了两次：帖4 "两小时就是十二点二十到两点二十吗"（帖里没写时间）、
// 帖6 "两点半出门的"（帖里只写了三点）。
//
// 判据刻意收窄：只认**明确是钟点**的写法（两位以上的数词+点 / X点整 / X点半 / X点N分 / 阿拉伯数字+点）。
// 因为"一点小事""有点空"里的"一点/有点"不是时间，放宽了这台机器就只会误报。
// 命中的词还必须**不出现在这一轮 prompt 的任何文本里**（帖子 + 往事 + 人设正文）——
// 引用自己往事里的时间不算编。
//
// ⚠️ 2026-10-05 补一个漏（同样的"报零"形状，见 QC-29）：上面那条{n,2}要求**两个**数词字，
// 于是**单个中文数词 + 点**的钟点（"四点""三点"）整类漏掉。证据：r137 帖6 阿禾
// 「**凌晨四点**打烊的时候，我把门口的瓶子抱起来扔进桶里了。」—— 她 life 写的是
// "晚上十点接班，早上六点交班"（`personas.ts:195`），"四点"不在这一轮 prompt 里，却没被判；
// r129 也有两处「熬到四点」。所以补第三支：单个中文数词 + 点。
// **但把"一点"排除**：r127「把闹钟定早一点」就是这个假阳性（已复核 11 轮原始文件，
// 裸钟点里只有 4 处真钟点 + 这 1 处假阳性，排除一之后零假阳性）。"两点"这类仍是风险，
// 历史 11 轮里没有出现被误报的例子，等它真出现再加白名单。
const CLOCK =
  /(?:[零一二两三四五六七八九十]{2,}|\d{1,2})点|[零一二两三四五六七八九十]点(?:半|整|\d{1,2}分)|[两三四五六七八九十]点/g;

// 但"给他安排将来"的钟点不是编。迭代 9 里老陆写"你试试今晚十一点前就睡"，被报了假阳性 ——
// 那不是替对方回忆，是给建议，真人天天这么说。我们拦的是**替他断言/回忆**
// （"两点半出门的"、"两点半买的还是三点的？"），所以那个钟点所在的那一句话里只要有
// 将来或建议的词，就放过去。分句是为了不让同一段里别的"先/最好"把一句断言也洗白。
// 迭代 32 里老陆写"哪怕只睡四小时也好过硬撑"又被 `编数字` 报了 —— 那也是在**给量**，不是在替他回忆；
// 跟上面同一个道理，把"哪怕/就算/至少/顶多/起码/不如"这类**提议句的框架词**一并算进来（还是宁漏不误）。
// 迭代 46：老陆写"越刷越空就不看手机了，出去走五分钟"又被 `编数字` 报了 —— 那句里的"了"
// 不是叙述过去，是**建议的口气**（"不看手机了"）；同一轮绵绵"我也这样两年了"也在这类边上。
// 所以把**指令/提议的口气词**一并算进这张表（就/吧/把/别/该/要/得/可以/出去/起来/一下/还是），
// 代价照旧写在明处：带这些字的句子从此不判编 —— 就是宁漏不误，这道检查宁可睡得着，不可乱咬。
const NEXT_HINT = /今晚|明晚|明天|后天|以后|接下来|这周|周末|先|试试|要不|应该|建议|最好|记得|别忘|哪怕|就算|至少|顶多|起码|不如|就|吧|把|别|该|要|得|可以|出去|起来|一下|还是/;

// "编数字" —— 拦住"替对方编事实"的第二道（Lead 点名要的）。现场记录：迭代 18/19 里
// 绵绵帖4 写"那两个半小时"（帖里写的是**两个小时**）、还写"上周三"（帖里没写星期几）；
// 老陆写"那酒是不是没开盖就买的"、起司写"好像也没吃晚饭吧" —— 同一个病：拿没人写过的事实填空。
// 数字不一定是钟点（钟点归 `CLOCK`），所以另开一条。
//
// 判据只认**数字 + 量词**的组合，并且放过一批不成句的惯用搭配（一个、一天、一次…）：
// 那些在汉语里是虚词不是事实，不放过它们这道检查会把所有人每条都毙掉。
// **一条会误报的规则比没有规则更坏**（BANNED 删"醒醒"就是这个教训），宁可漏，不可误报。
// 命中的词还必须在**这一轮 prompt 出现过的文字**里能找到 —— 引用自己往事/人设里的数字不算编。
// 代价写在明处：人设正文里的钟点数字也在这份 hay 里，所以"他拿人设里的数字去说对方"这一窄类抓不到；
// 换来的是不会误报（判据收紧的方向永远选"宁漏不误"）。
// 最后：像"你试试先睡二十分钟"这种**给他安排将来**的建议不是编，同 `CLOCK` 免 `NEXT_HINT`。
// 被判的两次假阳性（r32"哪怕只睡四小时"、r43"把手机扣桌上一分钟"）都是"给量/给建议"，
// 真阳性（r18/r36 绵绵"两个半小时"，帖子写的是两个小时）才是"替他回忆过去"。
// 所以判据反过来写：**只有当这个数字出现在一句"讲过去"的话里，才判它编**（宁漏不误）——
// 句子里有"了/过/那/当时/之前"这类叙述标记，且没有将来/建议/提议的框架词，才算。
const NARRATIVE = /了|过|已经|那|当时|之前|原来|那天|那次/;
// 序数词不算"量"：r120 帖2 绵绵写"第二天早上醒来第一件事又是什么"，
// 匹配到的 `二天` 被报了 `编数字:二天` —— 假阳性（"第二天"是顺序，不是数量）。
// 镜子照错了就修镜子（方法论第 3 条），加个负向后顾 `(?<!第)` 而不是去改 prompt。
const QUANTITY = /(?<!第)(?:[零一二两三四五六七八九十百千]{1,3}|\d{1,3})(?:个半?小时|小时|分钟|天|晚上|个月|月|年|礼拜|星期|周|次|瓶|根|只|杯|块|岁|遍|趟|口|句)/g;
const IDIOM = new Set(['一个', '一下', '一天', '一次', '一句', '一口', '一年', '一瓶', '一杯', '一块', '一只', '一碗']);
// "三点"和"3点"得认成同一个数（Lead 点名的容忍项）：把阿拉伯数字统一写成汉字再比。
const NUM_CHARS: Record<string, string> = { '0': '零', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '7': '七', '8': '八', '9': '九' };
const asHan = (s: string): string => s.replace(/\d/g, (d) => NUM_CHARS[d]!);
// 判"这个数字是不是编的"时，**量词里的"个"不算数**：帖子里写"刷了两个小时"、回复写"坐两小时…"，
// 说的是同一件事，而字面 substring 会判它编出来的 —— 迭代 26/27/28 **连着三轮**都栽在同一个
// 假阳性上（`帖4 起司: 编数字:两小时`）。镜子照错了就修镜子，不是去改 prompt（方法论第 3 条）。
const looseNum = (s: string): string => asHan(s).replace(/个/g, '');

type Row = {
  slug: string;
  name: string;
  post: number;
  text: string;
  chars: number;
  props: string[];
  selfRatio: number;
  echo: number;
  banned: string[];
  maxChars: number;
  ms: number;
  finalPunct: boolean;
  askEnding: boolean;
  advice: boolean;
  discloses: boolean;
  copied: string[];
  /** 与帖子正文的最长逐字重合（去标点，≥ `COPY_RUN` 才算抄）。见 `longestRun` 上的注释。 */
  copy: string;
  /** 回复与 system prompt（**已把那一段往事抠掉**）的最长逐字重合（≥ RECITE_RUN 才有值） */
  recite: string;
  /** 只在规矩里出现的词出现在回复里 —— 复读的第二种信号（见 RECITE_WORDS） */
  jargon: string[];
  simile: string[];
  /** 宽口径"像字开头"命中（`LIKE_PENDING`）：只显示、不计失败。 */
  likePending: string[];
  fakeTime: string[];
  fakeNum: string[];
  /** 正文里的元叙述/自查备注（QC-42）。判据与来源见 `meta-note.ts`。 */
  meta: string[];
  /** 同帖撞词判据：这条回复里所有 8 字窗口（去标点）。 */
  sameRuns: Set<string>;
  grams: Set<string>;
};

async function ask(
  p: (typeof PERSONAS)[number],
  post: Post,
  // 这一帖里**在他之前已经说过的楼层**，与线上同形（见下面主循环与 `personas.ts:588`）。
  said: { name: string; text: string }[] = [],
): Promise<Row> {
  // 往事在这一轮 prompt 里到底给没给、给的是哪一条，判定"编时间/编数字"时要用到，所以先取出来。
  // 现在要把帖子正文一起传进去 —— 往事得由帖子的话题决定讲不讲（见 personas.ts 的 `pickMemory`）。
  const memory = pickMemory(p, post.id, post.text);
  // system prompt 单独存一份：模型可能把它当内容念出来（复读检测要拿它比对）。
  // `said` 也要传：线上 `F:\shudong\server\src\index.ts:584-599` 就是这么调的，尺子量错场景最费时间。
  const sysPrompt = systemPrompt(p, '小满', null, memory, said);
  const t0 = Date.now();
  let acc = '';
  for await (const chunk of streamChat(
    [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: post.text },
    ],
    { maxTokens: p.maxTokens, temperature: TEMP },
  )) {
    acc += chunk;
  }
  const text = acc.trim();
  const ms = Date.now() - t0;

  return measureReply({ text, p, post, memory, sysPrompt, ms });
}

/**
 * 模型调用**之后**那段度量（原样从 `ask()` 里搬出来，口径一行未改）。
 *
 * 为什么要 export：三臂的机器列（跑器/对账脚本）必须用**这一份**判据，不许再写第二套 ——
 * 同一条规则各写一份的下场已经量到过（`replies.ts:99-104` 那笔账）。被 import 时不会跑整轮评测
 * （文件下方的 `isMain` 守卫）；`judgeFlags` 是同一段控制流里的另一半。
 */
export function measureReply({
  text,
  p,
  post,
  memory,
  sysPrompt,
  ms,
}: {
  text: string;
  p: (typeof PERSONAS)[number];
  post: Post;
  memory: string | null;
  sysPrompt: string;
  ms: number;
}): Row {
  const hit = p.props.filter((w) => text.includes(w));
  const ss = sentences(text);
  const selfRatio = ss.length ? ss.filter((s) => /我|咱|自个/.test(s)).length / ss.length : 0;
  const g = grams(text);
  const gp = grams(post.text);
  let shared = 0;
  for (const x of g) if (gp.has(x)) shared++;
  const echo = g.size ? shared / g.size : 0;

  // "这一轮 prompt 里出现过的所有文字" —— 帖子 + 往事 + 人设正文。
  // 他说出的钟点只要在这里面，就是引用，不是编。
  const promptHay = `${post.text}\n${memory ?? ''}\n${personaText(p)}`;
  const fakeTime = [...new Set(text.match(CLOCK) ?? [])].filter(
    (t) => !promptHay.includes(t) && !ss.some((s) => s.includes(t) && NEXT_HINT.test(s)),
  );
  const fakeNum = [...new Set(text.match(QUANTITY) ?? [])].filter(
    (t) =>
      !IDIOM.has(t) &&
      !looseNum(promptHay).includes(looseNum(t)) &&
      ss.some((s) => s.includes(t) && NARRATIVE.test(s) && !NEXT_HINT.test(s)),
  );

  // 同帖里两条回复之间"连着 7 个字一样"用的窗口（见下面 跨人设撞车 的注释）
  const SP = stripPunct(text);
  const sameRuns = new Set<string>();
  for (let i = 0; i + SAME_RUN <= SP.length; i++) sameRuns.add(SP.slice(i, i + SAME_RUN));
  // 抄原话：与帖子正文的最长逐字重合。
  const run = longestRun(SP, stripPunct(post.text));
  const copy = run.length >= COPY_RUN ? run : '';
  // 复读：去标点后与 system prompt 的最长公共子串（阈值见 RECITE_RUN 的注释）。
  // 口径（Lead m01801 定的）：**把往事从 prompt 里抠掉再比** —— 往事按设计就写在 prompt 里，
  // 照搬它不算复读。含往事时 42 条里报的第一条正是 r102 帖4 绵绵「在图书馆待到闭馆，书一页没翻」
  // （就是往事原文），把一条读着没问题的回复标成复读是坏账；抠掉之后 42 条报 0 条。
  const spNoMem = memory
    ? stripPunct(sysPrompt).split(stripPunct(memory)).join('')
    : stripPunct(sysPrompt);
  const reciteRun = longestRun(SP, spNoMem);
  const recite = reciteRun.length >= RECITE_RUN ? reciteRun : '';
  const jargon = RECITE_WORDS.filter((w) => text.includes(w));

  return {
    slug: p.slug, name: p.name, post: post.id, text,
    chars: [...text].length,
    props: hit,
    selfRatio,
    echo,
    banned: BANNED.filter((w) => text.includes(w)),
    maxChars: p.maxChars,
    ms,
    finalPunct: FINAL_PUNCT.test(text),
    askEnding: ASK_ENDING.test(text),
    advice: ADVICE.some((w) => text.includes(w)),
    discloses: DISCLOSE.test(text) || usedMemory(text, memory),
    copied: [...new Set(promptExamples(spNoMem, text))],
    copy,
    recite,
    jargon,
    simile: [...new Set(text.match(SIMILE) ?? [])],
    likePending: [...new Set(text.match(LIKE_PENDING) ?? [])],
    fakeTime,
    fakeNum,
    meta: metaNotes(text),
    sameRuns,
    grams: g,
  };
}

/**
 * 一行的 ❌/⚠ 装配（原样从主循环里搬出来，口径一行未改）。
 *
 * `flags` 判失败、`warns` 只显示 —— 哪些在 warn 里、为什么，见各行的注释。
 * export 的理由同 `measureReply`：三臂的 ❌ 列必须 import 这一份。
 */
export function judgeFlags(r: Row, post: Post, batch: Row[]): { flags: string[]; warns: string[] } {
  const flags: string[] = [];
  // 观测项：只打印 ⚠，**不判失败**。目前只有 `分段`（理由见那一行）。
  const warns: string[] = [];
  if (r.banned.length) flags.push(`BANNED:${r.banned.join('/')}`);
  if (r.props.length && !post.propsAllowed) flags.push(`跑题道具:${r.props.join('/')}`);
  if (r.props.length > 1) flags.push(`道具刷屏:${r.props.join('/')}`);
  // 在复述对方：短回复要豁免。迭代 11 阿禾帖4 只回了四个字"越刷越空"（就是帖子里那个词），
  // 复述率必然 1.00 —— 可那不是"复述→验证→建议"的模板，那是人在接话。
  // 一条回复短到十几字以内，就没有"复述"这回事，只有"接住他的词"。
  if (r.echo > 0.5 && r.chars >= 12) flags.push(`在复述对方:${r.echo.toFixed(2)}`);
  if (r.chars > r.maxChars) flags.push(`超长:${r.chars}>${r.maxChars}`);
  if (r.copied.length) flags.push(`抄例句:${r.copied.join('/')}`);
  if (r.copy) flags.push(`抄原话:${r.copy}`);
  if (r.simile.length) flags.push(`打比方:${r.simile.join('/')}`);
  // `像字开头(待判)`：宽口径，**只显示、不判失败**（lead m03080 裁定 1）。
  if (r.likePending.length) warns.push(`像字开头(待判):${r.likePending.join('/')}`);
  if (r.fakeTime.length) flags.push(`编时间:${r.fakeTime.join('/')}`);
  if (r.fakeNum.length) flags.push(`编数字:${r.fakeNum.join('/')}`);
  // 元叙述（QC-42）：模型把"我在按指令写"写进了正文 —— 用户看得见脏东西，所以是硬线。
  // 判据很窄（`meta-note.ts`：词表来自实测、不许扩大），只有"自查备注"的固定说法会命中。
  if (r.meta.length) flags.push(`元叙述:${r.meta.join('/')}`);
  // 分段（**观测项，不判失败** —— Lead 2026-10 拍板）：
  // 真人 60 条里没有一条在回复里换行（他们靠空格断句），模型换行就是在模仿我们 prompt 的排法
  // （迭代 9/10 老陆把三四句排成一列，52 字，读起来像清单）。所以还是量它 —— 但它**不再是用户的可见行为**：
  // `index.ts` 的 tick 在落库前把换行折成空格（`acc.replace(/\s*\n+\s*/g, ' ')`），
  // `e2e.ts` 的 [6] 段也有断言"回复是一行"，所以"整条一行"由代码保证，不在提示词里求模型。
  // 留在 ⚠ 里当**提示词服从度**的观测数字（近 5 轮 4/120 ≈ 3.3%，集中在老陆/绵绵"短句连着说"的形状上）。
  if (/\n/.test(r.text)) warns.push('分段');
  // 复读：只计数（见 RECITE_RUN / RECITE_WORDS 注释）—— 先量假阳性，再决定 bond 那边拦不拦。
  if (r.recite) warns.push(`复读:${r.recite}`);
  if (r.jargon.length) warns.push(`复读词:${r.jargon.join('/')}`);
  // 两个人对同一帖说出同一句话 —— 真人不会这样，这是最硬的破绽
  for (const other of batch) {
    if (other.slug <= r.slug) continue;
    const jac = alike(r.grams, other.grams);
    if (jac > 0.4) flags.push(`和${other.name}说的一样:${(jac * 100).toFixed(0)}%`);
    // 迭代 8 里绵绵和起司在同一帖里都写了"便利店…灯太亮了吧…喝完"（帖子里根本没写灯 ——
    // 两个人一起编了同一个细节），而 3-gram Jaccard 只有 0.15，上面那条没报。
    // 再补一条硬判据：两条回复之间有 7 个字连着一样就算撞 —— 两个人各自独立地回同一个帖子，
    // 不该同时写出同一串七个字。
    //
    // 窗口是**量出来的**，不是猜的：拿迭代 8 的 24 条原文，把 6 帖 × 6 对两两求交集，
    // 窗口 8 一处都不命中（"便利店的灯太亮了吧"vs"便利店那灯太亮了吧"只同 5 字 ——
    // 看着像同一句，其实第 4 个字就不一样），窗口 7 命中"灯太亮了吧喝完"，且全轮仅此一处。
    const overlap = [...r.sameRuns].find((w) => other.sameRuns.has(w));
    if (overlap) flags.push(`和${other.name}撞词:${overlap}`);
  }
  return { flags, warns };
}

// ---- 只有"直接运行"才跑整轮评测 -------------------------------------------------
// `measureReply` / `judgeFlags` 要 export 给三臂的机器列 import，所以被 import 时**绝不能**顺带跑掉
// 96 次模型调用。判定用 `process.argv[1]`（`import.meta.main` 要更新的 Node）。
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
console.log(`模型: ${target('default').model}   人设 ${personas.length} 位 × 帖子 ${posts.length} 条\n`);

const failures: string[] = [];
const rows: Row[] = [];

// ---- 先验尺子自己：道具词不能出现在这一轮 prompt 里 -------------------------
// 道具检查的含义是"跟他的工作八竿子打不着的帖子，他还在提招牌词"。可如果那个词本来就写在
// life / voice / cares / 往事里，模型提它是**我们让它提的**，不是它在演人设 —— 尺子这时是在误报。
// 迭代 5 就被这个咬过一次：绵绵帖3 报了 `跑题道具:专业`，而"专业"就写在她自己的 life 和往事里。
// 与其逐条复查，不如把这条不变式变成断言：只要有人往 props 里塞了 prompt 里已有的词，立刻失败。
for (const p of PERSONAS) {
  const hay = [personaText(p), ...p.memories.map((m) => m.text)].join('\n');
  const bad = p.props.filter((w) => hay.includes(w));
  if (bad.length) {
    failures.push(`尺子坏了 · ${p.name} 的 props 里这些词就写在他的人设/往事里，一提就误报：${bad.join('/')}`);
  }
}

// ---- 第三条先验：往事不许和"人设正文"说同一件事 ---------------------------------
// 往事有 `pickMemory` 当闸门（帖子对得上才给，而且一次只给一条）；`personaText` 里的 life/voice/cares
// **没有任何闸门** —— 它每次都进 prompt，模型想端就能端。所以 `life` 里只要有一句具体到能当素材复述的话，
// 它就等于一条"没有闸门的往事"。
// 这不是理论：r78 里绵绵 6 条有 4 条讲"半夜刷手机到天亮"，其中帖2、帖5 `pickMemory` 返回的是 null
// （帖里没有 '睡不着' 这类词），那两句就是从她的 life 里抄出来的 —— 用户投诉的"你的整个人生都只剩下
// 关东煮了吗"在 life 上重演了一次。这四条 life 已经改成只写条件；这条断言留着防下一次（12~20 人的
// 池子由 task-5 的 loader 写 JSON，更需要它兜着）。
// 阈值 5 字：'了三十年'（老陆 life 的"修了三十年" vs 往事"来了三十年"）是 4 字，属于无害巧合，放过。
for (const p of PERSONAS) {
  const hay = stripPunct(personaText(p));
  const dup = p.memories
    .map((m) => longestRun(stripPunct(m.text), hay))
    .filter((run) => run.length >= 5)
    .map((run) => run.trim());
  if (dup.length) {
    failures.push(`尺子坏了 · ${p.name} 的往事和 life/voice/cares 说了同一件事（${dup.join('/')}），它在 prompt 里没有闸门`);
  }
}

// ---- 再先验一次 `topics`：它是排期数据、不进 prompt，但要防"对什么都命中" -------------
// `topics` 只喂服务端"这一帖他到底要不要接话"的抽签（task-9），`systemPrompt` 里**没有读它的
// 代码路径**，所以"会不会漏进 prompt"不用查。这里查的是另一件事：**词的区分度**。
// 泛词（"累""难受"）的两种坏法前面都写过：一是把冷帖也弄成热帖，二是让某个人对什么都命中
// （`when` 的 '空'/'半夜'/'妈' 三次返工都是这个病）。所以要人看一眼这张表：
// 冷帖应当只有保底那位（sort 最小的阿禾），热帖应当有 2 位以上。
console.log('━'.repeat(72));
console.log('话题词自检（topics：只喂排期抽签，绝不进 prompt）');
for (const p of PERSONAS) {
  const hit = posts.filter((post) => p.topics.some((t) => post.text.includes(t))).map((post) => post.id);
  console.log(
    `  ${p.name}  ${hit.length}/${posts.length} 帖${hit.join(',') || '—'}` +
      `${hit.length >= 4 && hit.length > posts.length / 2 ? '  ⚠ 词太泛' : ''}   ${p.topics.join('/')}`,
  );
}
const hot = posts.filter((post) => PERSONAS.filter((p) => p.topics.some((t) => post.text.includes(t))).length >= 2);
console.log(`  热帖（≥2 位会接）：${hot.map((post) => post.id).join(',') || '—'}；其余只靠保底那一位（阿禾）`);
console.log('');

for (const post of posts) {
  console.log('━'.repeat(72));
  console.log(`[帖 ${post.id}] ${post.text}`);
  console.log(`  道具${post.propsAllowed ? '允许' : '禁止'}出现\n`);
  // 一帖里**一次只让一个人说话**，后面的人看得见前面说过的楼层 —— 复刻线上那条路
  // （`F:\shudong\server\src\index.ts:584-599`：每个 tick 只放一位吧友，`said` = 这帖在他之前已经说过的）。
  // 2026-10 之前这里是 `Promise.all`，四个人全成了"第一个说话"、谁也没看见谁：r126 帖5 阿禾
  // 「那猫没吃火腿肠，就盯着你看了。」和老陆「那只小猫没吃火腿肠，就盯着你。」判成 `和…说的一样:53%`。
  // 判据本身没错（两条几乎同句），**错的是场景** —— 线上老陆看得见阿禾那句，prompt 明写"接意思，不接字"。
  // 所以这里改成串行；`sameRuns` 的撞词判据保留，它现在量的是"给了别人那句话，他会不会还抄"。
  const batch: Row[] = [];
  for (const p of personas) {
    batch.push(await ask(p, post, batch.map((r) => ({ name: r.name, text: r.text }))));
  }
  for (const r of batch) rows.push(r);

  for (const r of batch) {
    // flags 的装配（原样搬到 `judgeFlags` 里，口径一行未改）：三臂的 ❌ 列要 import 同一份。
    const { flags, warns } = judgeFlags(r, post, batch);
    if (flags.length) failures.push(`帖${post.id} ${r.name}: ${flags.join(' ')}`);

    console.log(`  ${r.name}  ${String(r.chars).padStart(3)}字 自述${(r.selfRatio * 100).toFixed(0)}% 复述${(r.echo * 100).toFixed(0)}%  ${(r.ms / 1000).toFixed(1)}s  ${flags.concat(warns).length ? '⚠ ' + flags.concat(warns).join(' ') : ''}`);
    console.log(`    ${r.text.replace(/\n/g, ' / ')}`);
  }
  console.log('');
}

// ---- 汇总：一个人设是不是"只会演自己" --------------------------------------
// 跨帖看：如果 6 条回复全是同一个开头套路，那是模板不是人。
console.log('━'.repeat(72));
console.log('汇总\n');
for (const p of personas) {
  const mine = rows.filter((r) => r.slug === p.slug);
  if (!mine.length) continue;
  const avgChars = mine.reduce((a, r) => a + r.chars, 0) / mine.length;
  const avgSelf = mine.reduce((a, r) => a + r.selfRatio, 0) / mine.length;
  const propPosts = new Set(mine.filter((r) => r.props.length).map((r) => r.post));
  const openings = mine.map((r) => [...r.text].slice(0, 3).join(''));
  const dupOpen = openings.length - new Set(openings).size;
  // 跨帖雷同：同一个人的两条回复（回的是不同的帖子）有多像。像 = 他有一套万能模板。
  let worst = 0;
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const jac = alike(mine[i]!.grams, mine[j]!.grams);
      if (jac > worst) worst = jac;
    }
  }
  const like = `跨帖最像 ${(worst * 100).toFixed(0)}%`;
  const hits = [
    worst > 0.15 ? `⚠ ${like}` : like,
    dupOpen ? `⚠ ${dupOpen} 条开头撞车` : '',
  ].filter(Boolean).join('  ');
  console.log(`${p.name.padEnd(4)} 均${avgChars.toFixed(0)}字  自述占比均${(avgSelf * 100).toFixed(0)}%  提到道具的帖:${propPosts.size}/${mine.length}  ${hits}`);
}

// ---- 分布对照：我们 vs 真人样本 -------------------------------------------
console.log('');
console.log('━'.repeat(72));
console.log(`分布对照  我们 ${rows.length} 条  vs  真人样本 60 条（软指标，n 小，只报警不计失败）\n`);
{
  const n = rows.length;
  const rate = (k: number) => k / n;
  const lens = rows.map((r) => r.chars).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)] ?? 0;
  const noPunct = rate(rows.filter((r) => !r.finalPunct).length);
  const discloses = rate(rows.filter((r) => r.discloses).length);
  const advice = rate(rows.filter((r) => r.advice).length);
  const askEnding = rate(rows.filter((r) => r.askEnding).length);

  const line = (label: string, human: string, us: string, okFlag: boolean, note = '') =>
    console.log(
      `  ${label.padEnd(14)}真人 ${human.padEnd(10)}我们 ${us.padEnd(10)}${note || (okFlag ? '✓' : '⚠ 偏差大')}`,
    );

  line('长度中位数', '11–30 字', `${median} 字`, median <= BASELINE.medianChars);
  line('不写句末标点', '42%', `${(noPunct * 100).toFixed(0)}%`, noPunct >= 0.3);
  line('讲到自己', '28%', `${(discloses * 100).toFixed(0)}%`, discloses >= 0.12 && discloses <= 0.5);
  // ⚠️ 这一项是**代理指标**：用词表 + "往事有没有被用上"两条凑出来的，漏报多于误报，
  // 只能看趋势。它曾经整整错了两轮 —— 词表里没有"我在……"，绵绵写"我就在图书馆坐了很久"
  // 被算成没自曝（报 4%，而同轮汇总里她的自述占比是 22%）。我照着一个错数字调了两轮 prompt。
  // **凡是要照着一个数字调 prompt，先确认这个数字是量对了的。** 现在这条有兜底判据了
  // （见上面的 usedMemory），但它仍然是软的 —— 不判失败，只报警。
  //
  // 而且它**不该被聚合数字抹平**：老陆和起司是刻意封闭的人设（往事只半句带过），
  // 他们本来就该低于 28%。28% 是"真人平均"，不是"每个人都要到的线" ——
  // 24 条里 28% = 6.7 条，25% = 6.0 条，差不到一条消息。按人设分开列出来，看得见就好。
  for (const p of personas) {
    const mine = rows.filter((r) => r.slug === p.slug);
    if (!mine.length) continue;
    const mineD = mine.filter((r) => r.discloses).length;
    console.log(`    ${p.name}  ${mineD}/${mine.length}`);
  }
  // ⚠️ **判据未校准，勿据此打勾**（qc QC-29 + lead 2026-10-05）：`ADVICE` 只是 `eval.ts` 上面那张
  // 字面词表，换个祈使句就全漏 —— r136 判出"给建议 0% ✓"，qc 人读是 24 条里 13 条在下指令
  // （最干净一例：帖1 起司「爬不起来就在家躺着，别硬撑。」一个词都不含）。
  // 所以这一项**只看数字、不计分**，等 task-22 的新尺子（`tools/judge.mjs`，本机模型逐条打标签、
  // 用 qc 的人读单当标尺报一致率）落地再恢复判分。在那之前别拿这个数下结论。
  line(
    '给建议',
    '10–13%',
    `${(advice * 100).toFixed(0)}%`,
    false,
    '⚠ 判据未校准（字面词表漏祈使句），勿据此打勾；等 task-22',
  );
  line('问句收尾', '8%', `${(askEnding * 100).toFixed(0)}%`, askEnding <= 0.25);
  // `像字开头(待判)`：宽口径的**计数**（只显示，不判失败 —— lead m03080 裁定 1）。
  // 严格那条 `打比方` 才算硬线；这一行存在的意义是"别让放宽后的噪声悄悄驱动 prompt 改动"。
  {
    const n = rows.filter((r) => r.likePending.length).length;
    console.log(`  ${'像字开头(待判)'.padEnd(14)}${n} / ${rows.length} 条  ${'⚠ 只显示、不计失败；等 qc 人读分完类（@ eval.ts LIKE_PENDING）'}`);
  }

  // 末字分布（task-13 后的新旋钮，软指标）。为什么单列这一项：语料两批 3616 条弹幕里，
  // **17.7% 收在语气词上**（末字 top：了×406、啊×97、吗×57、吧×47、呢×33），
  // 而我们 24 条里语气词收尾是 0 —— 长度、标点都对得上时，"尾巴的形状"是最后露馅的地方。
  // ⚠️ 只是参考：弹幕极短（中位 9 字），一句一个语气词收尾本来就天然；回帖中位 20 字，
  // 不该按 17.7% 追。**看趋势，不设线**。
  {
    const lastChar = (s: string) => [...s.replace(/\s+/g, '')].slice(-1)[0] ?? '';
    const tailCount = new Map<string, number>();
    for (const r of rows) {
      const c = lastChar(r.text);
      if (c) tailCount.set(c, (tailCount.get(c) ?? 0) + 1);
    }
    const top = [...tailCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c, k]) => `${c}×${k}`)
      .join(' ');
    const particle = /[了呀吧呢吗嘛啊哦噢唉嗯哈]/;
    const pCount = rows.filter((r) => particle.test(lastChar(r.text))).length;
    console.log(
      `\n  末字分布          我们 ${top}`.padEnd(60) +
        `\n                    语气词收尾 ${pCount}/${n}（真人弹幕 ${(CORPUS.danmaku.endingParticle * 100).toFixed(1)}%，${CORPUS.danmaku.n} 条）`,
    );
  }

  console.log('\n  真实样本在这几项上是**分散**的（同一个人有时回 4 个字、有时写 150 字）。');
  console.log('  如果我们每一项都压成一个平均值、人人都一样，那比偏差大更假。');

  // ── 当下真人语料并排（task-13）────────────────────────────────────────────
  // 这一块**不判偏差**：弹幕是"边看边发的短反应"，不是"对着一个人说话的回帖"，
  // 体裁不同，只有"一句有多短、标点有多不齐"两样能拿来照。数字与依据见上面 `CORPUS` 的注释。
  console.log('');
  console.log(`  当下真人语料并排（B站弹幕两批，n=${CORPUS.danmaku.n}，2026-10-05，只喂尺子）:`);
  console.log(
    `    ${'真人（弹幕）'.padEnd(14)}中位 ${CORPUS.danmaku.medianChars} 字`.padEnd(30) +
      `≤8 字 ${(CORPUS.danmaku.le8 * 100).toFixed(0)}%`.padEnd(14) +
      `不写句末标点 ${(CORPUS.danmaku.noFinalPunct * 100).toFixed(0)}%`.padEnd(20) +
      `问号收尾 ${(CORPUS.danmaku.askEnding * 100).toFixed(0)}%`,
  );
  console.log(
    `    ${'我们（同口径）'.padEnd(14)}中位 ${median} 字`.padEnd(30) +
      `≤8 字 ${(rate(rows.filter((r) => r.chars <= 8).length) * 100).toFixed(0)}%`.padEnd(14) +
      `不写句末标点 ${(noPunct * 100).toFixed(0)}%`.padEnd(20) +
      `问号收尾 ${(askEnding * 100).toFixed(0)}%`,
  );
  console.log(
    `    单批稳定性: 第一批 n=${CORPUS.batch1.n} 中位 ${CORPUS.batch1.medianChars} 字 / 不写标点 ${(CORPUS.batch1.noFinalPunct * 100).toFixed(0)}%` +
      `  ·  第二批 n=${CORPUS.batch2.n} 中位 ${CORPUS.batch2.medianChars} 字 / 不写标点 ${(CORPUS.batch2.noFinalPunct * 100).toFixed(0)}%`,
  );
  console.log('    （体裁不同：弹幕是短反应，我们写的是回帖 —— 只作参考，不判偏差）');
}

console.log('');
if (failures.length) {
  console.log(`❌ ${failures.length} 处:`);
  for (const f of failures) console.log('   ' + f);
  process.exitCode = 1;
} else {
  console.log('✅ 自动能抓的那几样都过了（像不像人说的，请自己读上面的原文）');
}
} // end of isMain
