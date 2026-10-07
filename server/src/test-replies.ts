/**
 * "谁来接这个话茬"的断言 —— **不起 server、不连库**（直接 import `replies.ts` 这个纯模块）。
 *
 * 跑法：`pnpm --filter @shudong/server test:replies`
 *
 * 为什么这里不统计飘：随机源是注入的，`seeded()` 是固定种子的 mulberry32 ——
 * 同一支脚本跑一万遍结果一模一样（验收第 4 条）。人数是**分布**，所以断言用中位数/最小值，
 * 不用均值（均值会被个别 4 人的长尾拉走）。
 */
import { PERSONAS, pickMemory } from './personas.ts';
import { COPY_RUN, MAX_REPLIERS, MEMORY_RUN, SPEAK_CAP, TEMPLATE_RUN, batchRepeat, longestRun, memoryRunFrom, metaNote, pickResponders, recitesMemory, speakChance, templateRepeat, topicHits } from './replies.ts';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failed = 0;
function ok(label: string, cond: boolean, extra = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
}

const COLD = '今天天气挺好的';
const HOT = '加班到半夜，一个人在家，睡不着，不知道以后干什么';
const EXAMPLE = '又加班到半夜，不敢跟人说'; // 任务描述里举的那句
const EVERYTHING = PERSONAS.flatMap((p) => p.topics).join('，'); // 人人命中

/** 跑 N 次，返回每次"来了几个人" */
function counts(text: string, times: number, seed: number, bar = PERSONAS): number[] {
  const rand = seeded(seed);
  return Array.from({ length: times }, () => pickResponders(bar, text, rand).length);
}
function runs(text: string, times: number, seed: number, bar = PERSONAS): string[][] {
  const rand = seeded(seed);
  return Array.from({ length: times }, () => pickResponders(bar, text, rand).map((p) => p.slug));
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const slugOf = (name: string) => PERSONAS.find((p) => p.name === name)?.slug ?? '';

const N = 200;
/** 4 人的**旧池子**（task-28 里"4 人那档走字面值"指的就是这四位：anhe/laolu/mianmian/qisi）。
 *  钉死它、不拿"`PERSONAS` 当前有几位"当 4 人档 —— 人设池扩容时这条才不会跟着漂。 */
const legacy = PERSONAS.slice(0, 4);
/** 16 人那档就是**现在的真池子**（task-5 之后 `PERSONAS` 已是 16 位）；
 *  若哪天回落到不足 16 位，就补副本凑到 16（口径不变，脚本照样跑）。 */
const sixteen = Array.from({ length: 16 }, (_, i) => {
  const p = PERSONAS[i % PERSONAS.length]!;
  return i < PERSONAS.length ? p : { ...p, slug: `${p.slug}-${i}` };
});
const cold = counts(COLD, N, 1, legacy);
const hot = counts(HOT, N, 2, legacy);
const example = counts(EXAMPLE, N, 3, legacy);
const cold16 = counts(COLD, N, 1, sixteen);
const hot16 = counts(HOT, N, 2, sixteen);

console.log(`人设池 ${PERSONAS.length} 位：${PERSONAS.map((p) => `${p.name}(${p.pace}/${topicHits(p, HOT)}命中)`).join(' ')}`);
console.log(`冷帖「${COLD}」中位数 ${median(cold)} 均值 ${mean(cold).toFixed(2)} 最少 ${Math.min(...cold)} 最多 ${Math.max(...cold)}`);
console.log(`热帖「${HOT}」中位数 ${median(hot)} 均值 ${mean(hot).toFixed(2)} 最少 ${Math.min(...hot)} 最多 ${Math.max(...hot)}`);
console.log(`原话「${EXAMPLE}」中位数 ${median(example)} 均值 ${mean(example).toFixed(2)}`);

// 1. 冷帖：没人有反应，但"总有人应一声" —— 永远 1 个人（保底那位）
ok('冷帖中位数 = 1', median(cold) === 1, `median=${median(cold)}`);
// 2. 热帖：聊得起来的人更多 —— 中位数 ≥ 2，且明显多于冷帖
ok('热帖中位数 ≥ 2', median(hot) >= 2, `median=${median(hot)}`);
ok('热帖比冷帖人多', median(hot) > median(cold) && mean(hot) >= mean(cold) + 0.3,
  `中位数 ${median(cold)}→${median(hot)}，均值 ${mean(cold).toFixed(2)}→${mean(hot).toFixed(2)}`);
// 2b. 冷热差是**命中数**决定的，不是阈值写软 —— 任务描述里举的那句原话只有阿禾一位命中
//     （命中 2 个词），他就不该引来一屋子人。task-28 把这条**绝对数**换成性质断言：
//     "热文本确实比冷帖多来人"，两个规模（4 人与 16 人）下都要求成立；4 人那档的
//     字面值（原话中位数 = 1）另外单独锁住 —— 新公式不许改变 4 人的行为。
ok('热文本确实比冷帖多来人（4 人 / 16 人两档，中位数严大于）',
  median(hot) > median(cold) && median(hot16) > median(cold16),
  `中位 冷→热：4 人 ${median(cold)}→${median(hot)}，16 人 ${median(cold16)}→${median(hot16)}`);
ok('4 人那档的字面值锁住：只有一位命中时中位数仍是 1',
  median(example) === 1 && median(hot) > median(example),
  `原话中位数 ${median(example)}，热帖 ${median(hot)}`);
// 3. 任何时候都不为 0（"说给洞里听，总会有人回你"）
const allRuns = [...cold, ...hot, ...example, ...counts(EVERYTHING, N, 5)];
ok('从来没有 0 个人的时候', Math.min(...allRuns) === 1, `min=${Math.min(...allRuns)}`);
// 4. 纯函数 + 注入 rand：同一个种子跑两遍，连顺序都一模一样
const a = runs(HOT, N, 42).map((r) => r.join(','));
const b = runs(HOT, N, 42).map((r) => r.join(','));
ok('同一种子两遍结果完全一样', a.join('|') === b.join('|'));
ok('换个种子结果不一样（不是写死的常量）', runs(HOT, N, 43).map((r) => r.join(',')).join('|') !== a.join('|'));
// 5. 上限：拿一个 8 人的池子（4 位人设各复制一份）人人命中，人数也不许超
const wide = [...PERSONAS, ...PERSONAS.map((p) => ({ ...p, slug: `${p.slug}-b` }))];
const wideCounts = counts(EVERYTHING, N, 7, wide);
ok(`人数上限生效（≤ ${MAX_REPLIERS}）`, Math.max(...wideCounts) <= MAX_REPLIERS, `max=${Math.max(...wideCounts)}`);
ok('上限真的会顶到（不是永远没到）', Math.max(...wideCounts) === MAX_REPLIERS);
// 6. 第一位仍然是快的：有冲浪的在场，他一定排第一；一个冲浪的都没有才退让给不慢的
const picksOf = (text: string, times: number, seed: number) => {
  const rand = seeded(seed);
  return Array.from({ length: times }, () => pickResponders(PERSONAS, text, rand));
};
const firstBad = [...picksOf(HOT, N, 11), ...picksOf(COLD, N, 12)].filter((r) => {
  const fast = r.find((p) => p.pace === 'surfer');
  return fast ? r[0] !== fast : r[0]?.pace === 'slow';
});
ok('第一位优先冲浪的吧友（没有才退让）', firstBad.length === 0, `违例 ${firstBad.length} 次`);
// 7. 底概率 = 0.6 / 人数（task-28）：4 人时正好是旧公式那个常数，人多时自己摊薄
ok('底概率 = 0.6/人数（4 人时正好是旧公式那个 0.15）', speakChance(0, 4) === 0.15, `speakChance(0,4)=${speakChance(0, 4)}`);
ok('人数越多底概率越小（16 人 = 0.0375）', Math.abs(speakChance(0, 16) - 0.0375) < 1e-12, `speakChance(0,16)=${speakChance(0, 16)}`);
ok('命中越多概率越高、到上限为止（0.85 仍是天花板）',
  speakChance(1, 16) > speakChance(0, 16) && speakChance(9, 16) === 0.85 && speakChance(30, 16) === SPEAK_CAP,
  `0/1/9/30 命中：${speakChance(0, 16)}/${speakChance(1, 16)}/${speakChance(9, 16)}/${speakChance(30, 16)}`);

/** 冷帖"来了几个人"的形状 + 三项性质（0 人 / 只来 1 人 / 顶到上限）。 */
const shapeOf = (bar: typeof PERSONAS, seed: number) => {
  const cs = counts(COLD, 2000, seed, bar);
  const at = (f: (n: number) => boolean) => cs.filter(f).length / cs.length;
  return { median: median(cs), mean: mean(cs), zero: at((n) => n === 0), one: at((n) => n === 1), three: at((n) => n >= 3), cap: at((n) => n === MAX_REPLIERS) };
};
const s4 = shapeOf(legacy, 21);
const s16 = shapeOf(sixteen, 22);
// 7b. 4 人那档照旧走字面值：新公式若改到它，说明动的是别的地方 —— 不许拿"性质断言"掩盖过去
ok('n=4 冷帖形状与旧公式逐字相同（均 ≈1.456 / 中位 1 / 只来 1 人 ≈61% / ≥3 人 ≈6%）',
  s4.median === 1 && s4.mean > 1.4 && s4.mean < 1.51 && s4.one > 0.56 && s4.one < 0.66 && s4.three > 0.03 && s4.three < 0.1,
  `均 ${s4.mean.toFixed(3)} 中位 ${s4.median} 只来1人 ${(s4.one * 100).toFixed(1)}% ≥3人 ${(s4.three * 100).toFixed(1)}%`);
// 7c. 16 人那档守性质：冷帖没被摊坏、顶不到上限、从无 0 人
ok('n=16 冷帖仍是"只来一两个"：只来 1 人 ≥ 40% 且 ≥3 人 ≤ 20%',
  s16.median === 1 && s16.one >= 0.4 && s16.three <= 0.2,
  `均 ${s16.mean.toFixed(3)} 中位 ${s16.median} 只来1人 ${(s16.one * 100).toFixed(1)}% ≥3人 ${(s16.three * 100).toFixed(1)}%`);
ok(`n=16 顶到人数上限（${MAX_REPLIERS} 人）的比例 < 10%（与 task-5 体检的 1.6~3.6% 同源）`,
  s16.cap < 0.1, `顶到 ${MAX_REPLIERS} 人 ${(s16.cap * 100).toFixed(1)}%`);
// 7d. 那位"一句话都命中不上"的吧友：底不是 0，但他不占前排（原来是一条绝对数 `poorIn >= 100`）
const poor = slugOf('阿七哥');
const top = slugOf('阿舟');
const poorHits = topicHits(PERSONAS.find((p) => p.slug === poor)!, HOT);
const poorAt = (bar: typeof PERSONAS) => {
  const rand = seeded(99);
  let poorIn = 0;
  let topIn = 0;
  let zero = 0;
  for (let i = 0; i < 2000; i++) {
    const r = pickResponders(bar, HOT, rand);
    if (!r.length) zero++;
    if (r.some((p) => p.slug === poor)) poorIn++;
    if (r.some((p) => p.slug === top)) topIn++;
  }
  return { poorIn, topIn, zero };
};
const p4 = poorAt(legacy);
const p16 = poorAt(sixteen);
ok(`0 命中的吧友也有机会开口，但不占前排（他命中 ${poorHits}，底概率 ${speakChance(0, 4)}）`,
  p4.poorIn > 0 && p16.poorIn > 0 && p4.poorIn < p4.topIn && p16.poorIn < p16.topIn,
  `2000 次里来了：4 人 ${p4.poorIn} 次（命中最多那位 ${p4.topIn}），16 人 ${p16.poorIn} 次（${p16.topIn}）`);
ok('任何时候都不为 0（4 人 / 16 人两档）', p4.zero === 0 && p16.zero === 0, `0 人次数 ${p4.zero} / ${p16.zero}`);
// 8. 任务里举的原话：命中 2 个词的阿禾一定在
const ah = slugOf('阿舟');
ok('命中最多的人保底必进', runs(EXAMPLE, N, 3).every((r) => r.includes(ah)),
  `阿禾命中 ${topicHits(PERSONAS.find((p) => p.slug === ah)!, EXAMPLE)}`);

// 9. "抄句"的尺子（index.ts 拿它决定：重说一次 / 这层楼不拿出来）
//    为什么要有这段：尺子本身错了，线上要么放过抄句、要么把好话也判成抄的。
//    归一化（去空白 + 标点）住在 longestRun 里面，所以下面两条"只差标点"的必须命中。
const PRIOR = [
  '以前在奶茶店凌晨三点擦桌子的时候也哭过，后来就那样过来了。',
  '我也加班到半夜过，那时候就靠一碗热汤撑着。',
];
ok('整句抄回来：超过阈值（标点被归一化，run 不等于原句长度）', longestRun(PRIOR[0]!, PRIOR).run >= COPY_RUN,
  `run=${longestRun(PRIOR[0]!, PRIOR).run}（原句 ${PRIOR[0]!.length} 字含标点）`);
ok('无标点的整句：量出来就是它的字数', longestRun('就靠一碗热汤撑着', ['就靠一碗热汤撑着']).run === 8,
  `run=${longestRun('就靠一碗热汤撑着', ['就靠一碗热汤撑着']).run}`);
ok('只差一个标点/空格的复读照样命中（r133 帖3 那一型）',
  longestRun('点进去删掉吧，删完就睡去。', ['点进去删掉吧 删完就睡去']).run >= COPY_RUN
  && longestRun('点进去删掉吧，删完就睡去。', ['点进去删掉吧 删完就睡去']).run
     === longestRun('点进去删掉吧删完就睡去', ['点进去删掉吧删完就睡去']).run,
  `run=${longestRun('点进去删掉吧，删完就睡去。', ['点进去删掉吧 删完就睡去']).run}`);
ok('换个说法（只零星几个字碰巧一样）不算抄', longestRun('我懂，那阵子我也熬过来了。', PRIOR).run < COPY_RUN,
  `run=${longestRun('我懂，那阵子我也熬过来了。', PRIOR).run}`);
ok('恰好 COPY_RUN 个字才算命中，少一个字不算（阈值就这一处）',
  COPY_RUN === 10
  && longestRun('啊'.repeat(COPY_RUN), ['啊'.repeat(COPY_RUN)]).run === COPY_RUN
  && longestRun('啊'.repeat(COPY_RUN - 1), ['啊'.repeat(COPY_RUN - 1)]).run === COPY_RUN - 1);
ok('from 给的是被抄的那串话（日志里人眼一核就知道抄了谁）',
  longestRun('今天也是这样，就靠一碗热汤撑着。', ['就靠一碗热汤撑着']).from === '就靠一碗热汤撑着',
  `from=「${longestRun('今天也是这样，就靠一碗热汤撑着。', ['就靠一碗热汤撑着']).from}」`);
ok('两侧的标点/空白都归掉才比（乱撒标点也照样认出来）',
  longestRun('就靠一碗热汤撑着', ['就，靠 一碗热汤。撑着']).from === '就靠一碗热汤撑着',
  `from=「${longestRun('就靠一碗热汤撑着', ['就，靠 一碗热汤。撑着']).from}」`);
ok('前面没人说过话时不误伤（第一层楼）', longestRun('随便说点什么', []).run === 0);
ok('碰巧共用一个字不算抄', longestRun('随便说点什么', ['完全不同的一句话内容']).run < COPY_RUN,
  `run=${longestRun('随便说点什么', ['完全不同的一句话内容']).run}`);
const TEMPLATE_PRIOR = ['算了，还是先顾着这店里那点事吧', '今天别急，还是先顾着这安静那点事吧'];
const templateHit = templateRepeat('算了，还是先顾着这安静那点事吧', TEMPLATE_PRIOR);
ok('不同整句共用六字句尾模板会命中，且不降低 COPY_RUN',
  TEMPLATE_RUN === 6 && templateHit?.kind === 'prefix' && templateHit.from === '算了还是先顾',
  `hit=${templateHit ? `${templateHit.kind}:${templateHit.from}` : 'none'} COPY_RUN=${COPY_RUN}`);
ok('句首模板也按同一把归一化尺子命中',
  templateRepeat('想先把这一页删了再说', ['想先把这一页改了再说'])?.kind === 'prefix');
ok('没有共同首尾模板不命中', templateRepeat('完全不同的一句话', TEMPLATE_PRIOR) === null);

// 同拨起帖真实正样本（posts 75–78）：套话在句中，首/尾模板尺子抓不到，longestRun≥6 才拦。
const SAME_BATCH = {
  zhebie: '后腰又硬得像块铁，不敢直挺挺坐副驾，系安全带时得把身子往门框上侧着挤两下，算了，还是先顾着这车里那点事吧。',
  qiezi: '刚在店里又被问了几次婚没结，我说快了，转身把车钥匙插进点火孔，算了，先顾着这车那点事吧。',
  daju: '刚给那只乱叫的金毛洗完澡，满手都是毛，算了，还是先顾着这店里那点事吧。',
  danhuang: '回家把书包扔在玄关，嗓子哑得说不出话，算了，还是先顾着这安静那点事吧。',
};
const batchPairs = (a: string, b: string) => batchRepeat(a, [b]);
ok('同拨 75×77：中段公共串 ≥6 命中', (batchPairs(SAME_BATCH.zhebie!, SAME_BATCH.daju!)?.run ?? 0) >= 6);
ok('同拨 75×78：中段公共串 ≥6 命中', (batchPairs(SAME_BATCH.zhebie!, SAME_BATCH.danhuang!)?.run ?? 0) >= 6);
ok('同拨 77×78：中段公共串 ≥6 命中', (batchPairs(SAME_BATCH.daju!, SAME_BATCH.danhuang!)?.run ?? 0) >= 6);
ok('同拨 75×76：最长仅 5，不误拦', (batchPairs(SAME_BATCH.zhebie!, SAME_BATCH.qiezi!)?.run ?? 0) < 6);
ok('同拨 76×77：最长 <6，不误拦', (batchPairs(SAME_BATCH.qiezi!, SAME_BATCH.daju!)?.run ?? 0) < 6);
ok('同拨 76×78：最长 <6，不误拦', (batchPairs(SAME_BATCH.qiezi!, SAME_BATCH.danhuang!)?.run ?? 0) < 6);

// 10. "元叙述"的尺子（index.ts 拿它决定：这层重说一次 / 不拿出来）
//     为什么要有这段：r158 帖3 有一位吧友把**给自己的自查备注**写进了正文，用户一眼看出是"AI 交作业"。
//     判据只有一份（`meta-note.ts`，同一份语料里这套串**只出现 1 次**，就是下面那条）。尺子只认固定形状，
//     宽泛的「注」「备注」不算 —— 那条误伤线也钉在下面。
const R158 = `只是话不该说死。

(注：此回复严格遵循指令——驳前句（她催的动机），给后见（你在乎她），长度约 38 字，无废话，无禁止词，无空行。)`;
const SHAPES = ['(注：', '（注：', '严格遵循', '长度约 38 字', '长度约38字', '无废话', '无禁止词', '无空行'];
ok('r158 那条自查备注被认出来（返回命中的那截字，日志里能打给人看）', metaNote(R158) === '(注：',
  `命中「${metaNote(R158)}」`);
ok('四种形状各自单独出现都算（半角/全角括号都认）',
  SHAPES.every((s) => metaNote(`前面还有半句。${s}后面也还有。`) !== ''),
  SHAPES.map((s) => `${s}→${metaNote(`前面还有半句。${s}后面也还有。`) || '空'}`).join(' '));
ok('「长度约」后面必须是数字才认（不许把"长度约很多字"当自查）',
  metaNote('长度约很多字，我写短点。') === '' && metaNote('长度约 12 字，不空行。') === '长度约 12 字');
ok('带「注」字的正常句子不误伤（用户原话式的那条误伤线）', metaNote('我注了下水，锅里的水刚好没过面。') === ''
  && metaNote('备注一下，周三交房租。') === '' && metaNote('我自己检查了一遍，门锁了。') === '',
  `三条都没命中`);
ok('正常回帖里那些"检查/话"的字面不会撞上（抽一条真的 r154 回帖）',
  metaNote('身体报警了，是不是最近也没顾上吃早饭？') === ''
  && metaNote('把电话挂了就别再听那声音。') === '');

// 11. "背往事"的尺子（index.ts 拿它决定：这层重说一次 / 不拿出来）
//     为什么要有这段：task-45 的往事落盘后机器护栏全绿、人读判否（qc 读出来是"把履历念一遍"：
//     逐字整条搬 13/96）。往事要留（那是"他有生活"），但"引用往事必须改写"得由枪兑现。
//     口径**只比这一层真的注进去的那一条往事**（`pickMemory` 的返回值）—— 比宽了会把正常句误杀。
//     下面那句往事取真实的长度（≤21 字），阈值 10 就是它的大半：照搬一眼就能看出来。
// task-64：每条往事的 when 至少有一个不在本人 topics 的收窄词；总池固定为 16×91。
const memoryTotal = PERSONAS.reduce((n, p) => n + p.memories.length, 0);
const whenTopicCollisions = PERSONAS.flatMap((p) => p.memories.map((m) => ({ p, m })))
  .filter(({ p, m }) => !m.when.some((w) => !p.topics.includes(w)));
ok('task-64 往事池固定为 16 人 / 91 条，且每条 when 有本人 topics 外的词',
  PERSONAS.length === 16 && memoryTotal === 91 && whenTopicCollisions.length === 0,
  `人数=${PERSONAS.length} 往事=${memoryTotal} 冲突=${whenTopicCollisions.length}`);
const anhe = PERSONAS.find((p) => p.slug === 'anhe')!;
const uniqueAnhe = anhe.memories[0]!;
const replayText = uniqueAnhe.when.find((w) => !anhe.topics.includes(w))!;
const replay: (string | null)[] = [];
const said: string[] = [];
for (let i = 0; i < 7; i++) {
  const picked = pickMemory(anhe, 900 + i, replayText, said);
  replay.push(picked);
  if (picked) said.push(picked);
}
ok('task-64 阿舟 7 次唯一候选：首层可讲，后续 6 层不再连讲同一条',
  replay[0] === uniqueAnhe.text && replay.slice(1).every((x) => x === null),
  replay.map((x) => x ? 'hit' : 'null').join('→'));
const stillCallable = anhe.memories[1]!;
ok('task-64 原有可讲人设仍可命中',
  pickMemory(anhe, 901, stillCallable.when[0]!, []) === stillCallable.text,
  `候选=${stillCallable.text}`);

const resequenceChars = (s: string) => [...String(s).replace(/[\s\p{P}]/gu, '')];
const resequenceJaccard = (a: string, b: string) => {
  const grams = (s: string) => {
    const chars = resequenceChars(s);
    return new Set(chars.slice(0, -1).map((x, i) => x + chars[i + 1]));
  };
  const A = grams(a), B = grams(b);
  const intersection = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? intersection / union : 0;
};
const RESEQ_A = '头一年过年没人陪，我一个人炒到打烊。';
const RESEQ_B = '没人陪你过年头一年炒到打烊';
ok('改字序复述真例 J≥0.30 必抓', resequenceJaccard(RESEQ_A, RESEQ_B) >= 0.30, `J=${resequenceJaccard(RESEQ_A, RESEQ_B).toFixed(3)}`);
ok('改字序反例 J<0.20 不抓', resequenceJaccard('今天下班回家买菜做饭。', '昨天在店里修车喝茶。') < 0.20, `J=${resequenceJaccard('今天下班回家买菜做饭。', '昨天在店里修车喝茶。').toFixed(3)}`);
ok('改字序只改标点/空白不影响 J', resequenceJaccard('头一年过年没人陪，我一个人炒到打烊。', '头一年，过年没人陪我一个人炒到打烊') === resequenceJaccard('头一年过年没人陪我一个人炒到打烊', '头一年过年没人陪我一个人炒到打烊'), `J=${resequenceJaccard('头一年过年没人陪，我一个人炒到打烊。', '头一年，过年没人陪我一个人炒到打烊').toFixed(3)}`);
const MEMORY = '去年冬天我妈在电话里催我回家相亲'; // 16 字，与 personas.ts 里那些往事同一量级
ok('整条往事被原样背出来 ⇒ 命中', recitesMemory(`我懂。${MEMORY}，所以我不催你。`, MEMORY).run === MEMORY.length,
  `重合 ${recitesMemory(`我懂。${MEMORY}，所以我不催你。`, MEMORY).run} 字（往事 ${MEMORY.length} 字）`);
ok(`恰好 ${MEMORY_RUN} 字才算命中（边界：少一个字就不算）`,
  MEMORY_RUN === 10
  && recitesMemory(MEMORY.slice(0, MEMORY_RUN), MEMORY).run === MEMORY_RUN
  && recitesMemory(MEMORY.slice(0, MEMORY_RUN - 1), MEMORY).run === 0,
  `${MEMORY_RUN} 字→${recitesMemory(MEMORY.slice(0, MEMORY_RUN), MEMORY).run}，${MEMORY_RUN - 1} 字→${recitesMemory(MEMORY.slice(0, MEMORY_RUN - 1), MEMORY).run}`);

ok('MEMORY_RUN 环境变量解析窄断言',
  memoryRunFrom(undefined) === 10
  && memoryRunFrom('10') === 10
  && memoryRunFrom('96') === 96
  && memoryRunFrom('97') === 10
  && memoryRunFrom('0') === 10
  && memoryRunFrom('abc') === 10
  && memoryRunFrom(' 12 ') === 12);
ok('只差标点/空格的背照样命中（归一化还是 longestRun 那一份 bare）',
  recitesMemory('去年冬天，我妈在电话里，催我回家相亲。', MEMORY).run === MEMORY.length,
  `重合 ${recitesMemory('去年冬天，我妈在电话里，催我回家相亲。', MEMORY).run} 字`);
ok('正常句不误伤（只零星几个字碰巧一样，比如"我妈""电话"）',
  recitesMemory('我妈昨天也给我打电话了，说家里一切都好。', MEMORY).run === 0,
  `最长重合 ${longestRun('我妈昨天也给我打电话了，说家里一切都好。', [MEMORY]).run} 字`);
ok('没给往事的那一层不误伤（memory=null ⇒ 这把枪不参与）', recitesMemory('去年冬天我妈在电话里催我回家相亲', null).run === 0);
ok('from 给的是被背下来的那串字（日志里人眼一核就知道背的是哪条往事）',
  recitesMemory(`别提了，${MEMORY}。`, MEMORY).from === MEMORY,
  `from=「${recitesMemory(`别提了，${MEMORY}。`, MEMORY).from}」`);
// 局限（如实报，不算通过）：**改写成半句**时这枪够不到 —— 语义上是同一个往事，逐字却接不上。
const HALF = '去年冬天我妈打电话让我回家看看';
ok('（局限，不算通过）改写一半的往事：逐字重合 < 阈值，这枪拦不住',
  recitesMemory(HALF, MEMORY).run === 0,
  `最长重合 ${longestRun(HALF, [MEMORY]).run} 字（「${longestRun(HALF, [MEMORY]).from}」）< ${MEMORY_RUN} ⇒ 放过`);

console.log(failed ? `\n${failed} 条失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
