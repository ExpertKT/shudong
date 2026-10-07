// 清掉真库里存量错误印象（task-18）。
//
// 背景：印象生成口 `server/src/index.ts:185-207` 已修（主语写死成「他/她」、明写吧友台词不是这个人的事），
// 但真库里那批用旧 prompt 生成的行还在，会被 personas.ts 注回下一次回复 ⇒ 用户看到的还是错的。
// 印象是派生数据，不是用户的内容，所以可以删；但这是用户的真库，纪律写在 task-18 卡里：
//   1) 先 VACUUM INTO 出一致快照（回滚点），2) 逐行判，3) 单条短事务按 rowid 删，4) 删完只读复查。
//
// 判断依据：`F:\shudong\qa\samples\db-impressions-2026-10-05.txt`（qc 的逐字快照）+
//           逐行把印象文本和「同一帖里那位吧友自己那层的原文」比出来的结论（见下面 reason）。
// 判错的标准（task-18 卡）：主语不是这个人（他/她）的、把吧友自己的动作/台词记成这个人的、
//           带评价的。@note rid=10 留着：那是修好以后生成的（只写这个人的话里出现过的事）。
//
// 用法：
//   node tools/fix-impressions.mjs            # 默认 dry-run：做快照 + 逐行列出打算删什么，不动库
//   node tools/fix-impressions.mjs --apply    # 真删（先快照；每个 rowid 的现文本必须与预期逐字相同，否则中止）

import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';

const DB = 'F:\\shudong\\data\\shudong.db';
const APPLY = process.argv.includes('--apply');

// 逐行裁定。expectText 逐字来自 2026-10-05 探库输出，是防"库又变了却照删"的护栏。
const JUDGED = [
  { rowid: 1, user: 1, slug: 'qisi', action: 'delete', expectText: '他拍我肩膀，说屏幕关了再看破事全是笑话，别矫情去睡。', reason: '记的是起司自己那层的话（「屏幕关了」「全是笑话」「别矫情」），动作「拍我肩膀」楼层里没有' },
  { rowid: 2, user: 1, slug: 'mianmian', action: 'delete', expectText: '她盯着绿萝发呆，说钥匙掉下水道那种空虚像不喜欢的专业。', reason: '绿萝发呆／钥匙掉下水道／不喜欢的专业 全是绵绵自己那层的话' },
  { rowid: 3, user: 1, slug: 'laolu', action: 'delete', expectText: '他看表针转不动，说晚饭后下楼走十分钟，先睡够八小时再说。', reason: '表针转不动／下楼走十分钟／睡够八小时 全是老陆自己那层的话' },
  { rowid: 4, user: 2, slug: 'qisi', action: 'delete', expectText: '他劝我别自我怀疑，说梦里啥都有比盯着屏幕强。', reason: '自我怀疑／梦里啥都有／比盯着屏幕强 全是起司的话；「他劝我」主客颠倒' },
  { rowid: 5, user: 2, slug: 'anhe', action: 'delete', expectText: '他说关东煮剩半锅时，店里仍有人进进出出买酱油。', reason: '关东煮剩半锅／进进出出买酱油 是阿禾自己那层的经历' },
  { rowid: 6, user: 2, slug: 'mianmian', action: 'delete', expectText: '她挖板结的绿萝土像没头苍蝇，觉得自己比草还离不开班。', reason: '挖板结的绿萝土／没头苍蝇／比草还离不开班 全是绵绵的话，且带比方' },
  { rowid: 7, user: 3, slug: 'qisi', action: 'delete', expectText: '递纸擦汗时那句‘别猝死’，比老板的滚蛋命令更烫手。', reason: '递纸擦汗／别猝死／老板让滚蛋 全是起司的话，且带评价（更烫手）' },
  { rowid: 8, user: 3, slug: 'anhe', action: 'delete', expectText: '凌晨四点便利店热气里，他买两串萝卜让心里踏实的样子。', reason: '凌晨四点／便利店热气／买两串萝卜 是阿禾自己那层的经历' },
  { rowid: 9, user: 3, slug: 'laolu', action: 'delete', expectText: '十点前把手机扔客厅，还要给脚泡热水，像头倔驴。', reason: '十点前睡／手机放客厅／泡脚 是老陆自己的建议，且带评价（像头倔驴）' },
  { rowid: 10, user: 4, slug: 'anhe', action: 'keep', expectText: '他是开发者，好累，自己扛着不知在忙什么', reason: '留住：「开发者」「好累」来自这个人自己写的话（post 9），没有吧友台词、没有编造动作、没有评价（修好后生成的）' },
  { rowid: 11, user: 4, slug: 'mianmian', action: 'delete', expectText: '她觉得开发者话难懂，直接选择放弃理解。', reason: '主语是绵绵自己（她对「开发者」的反应），不是这个人（exper7）的事；且带评价（话难懂／放弃理解）' },
  { rowid: 12, user: 4, slug: 'laolu', action: 'delete', expectText: '对方自称开发者，正等着听他讲述事情发生的经过。', reason: '主语「对方」，记的是那次对话的状态，不是这个人的样子' },
  { rowid: 13, user: 4, slug: 'qisi', action: 'delete', expectText: '对方发完测试消息后，没下文就不再多说。', reason: '主语「对方」，同上（对话流水账）' },
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshotPath = `F:\\tmp\\shudong-db-${stamp}.db`;
const q = (s) => `'${s.replace(/'/g, "''")}'`;

function counts(db) {
  const out = {};
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    out[t.name] = db.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get().c;
  }
  return out;
}

// 1) 快照（只读连接也能 VACUUM INTO；WAL 下这是一致的）
const ro = new DatabaseSync(DB, { readOnly: true });
if (existsSync(snapshotPath)) throw new Error(`快照路径已存在：${snapshotPath}`);
ro.exec(`VACUUM INTO ${q(snapshotPath)}`);
if (!existsSync(snapshotPath) || statSync(snapshotPath).size < 4096) throw new Error('快照没落下来或大小不合理');
const snap = new DatabaseSync(snapshotPath, { readOnly: true });
const before = counts(ro);
const snapCounts = counts(snap);
const same = JSON.stringify(before) === JSON.stringify(snapCounts);
console.log(`快照: ${snapshotPath}  ${statSync(snapshotPath).size} 字节  各表行数与源一致=${same}`);
if (!same) throw new Error('快照行数与源不一致，停手');

// 2) 逐行核对现文本
const rows = new Map(ro.prepare('SELECT rowid AS rid, user_id, agent_slug, text FROM impressions').all().map((r) => [r.rid, r]));
console.log(`\nimpressions 现有 ${rows.size} 行；裁定：删 ${JUDGED.filter((j) => j.action === 'delete').length} 行 / 留 ${JUDGED.filter((j) => j.action === 'keep').length} 行`);
const toDelete = [];
let mismatch = 0;
let skipped = 0;
for (const j of JUDGED) {
  const r = rows.get(j.rowid);
  if (!r && j.action === 'delete') {
    skipped++;
    console.log(`·  rid=${j.rowid} 已不存在（上次删过了，跳过）`);
    continue;
  }
  if (!r && j.action === 'keep') {
    console.log(`⚠ rid=${j.rowid} 该留的行不见了（不是我删的）：${j.expectText}`);
    continue;
  }
  const ok = r && r.user_id === j.user && r.agent_slug === j.slug && r.text === j.expectText;
  if (!ok) {
    mismatch++;
    console.log(`✗ rid=${j.rowid} 现文本与预期不符，停止：\n   库里: ${r ? `${r.user_id}/${r.agent_slug} ${r.text}` : '(不存在)'}\n   预期: ${j.user}/${j.slug} ${j.expectText}`);
    continue;
  }
  if (j.action === 'delete') toDelete.push(j.rowid);
  console.log(`${j.action === 'delete' ? '删' : '留'} rid=${j.rowid} user=${j.user}/${j.slug} — ${j.reason}\n    ${r.text}`);
}
const extra = [...rows.keys()].filter((rid) => !JUDGED.some((j) => j.rowid === rid));
if (extra.length) console.log(`\n注意：库里有 ${extra.length} 行不在裁定表里（没动）：${extra.join(',')}`);
if (mismatch) throw new Error(`${mismatch} 行与预期不符，未做任何删除`);
if (!toDelete.length) {
  console.log(`\n已经清干净了（跳过 ${skipped} 行），不用动库。`);
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n[dry-run] 没有动库。真要删就加 --apply（将 DELETE ${toDelete.length} 行：${toDelete.join(',')}）`);
  process.exit(0);
}

// 3) 单条短事务删除（只碰 impressions，只按 rowid）
ro.close();
const rw = new DatabaseSync(DB);
rw.exec('PRAGMA busy_timeout = 5000');
rw.exec('BEGIN IMMEDIATE');
try {
  const n = rw.prepare(`DELETE FROM impressions WHERE rowid IN (${toDelete.join(',')})`).run().changes;
  rw.exec('COMMIT');
  console.log(`\n已删 ${n} 行（预期 ${toDelete.length}）`);
} catch (e) {
  rw.exec('ROLLBACK');
  throw e;
}
rw.close();

// 4) 只读复查
const after = new DatabaseSync(DB, { readOnly: true });
const afterCounts = counts(after);
console.log('\n各表行数 删前 → 删后：');
for (const t of Object.keys(before)) {
  const b = before[t];
  const a = afterCounts[t];
  console.log(`  ${t}: ${b} → ${a}${t === 'impressions' ? '' : b === a ? ' ✓未变' : ' ✗变了！'}`);
}
console.log('\n剩下的印象（逐字）：');
for (const r of after.prepare('SELECT rowid AS rid, user_id, agent_slug, text FROM impressions ORDER BY user_id, agent_slug').all()) {
  console.log(`  rid=${r.rid} user=${r.user_id} agent=${r.agent_slug}\n    ${r.text}`);
}
console.log(`\n回滚点: ${snapshotPath}`);
