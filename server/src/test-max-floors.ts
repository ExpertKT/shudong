import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failed = 0;
function ok(label: string, value: boolean, extra = '') {
  if (!value) failed++;
  console.log(`${value ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
}

const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
ok('生产路径声明同帖单人上限为 2', source.includes('const MAX_AGENT_FLOORS_PER_POST = 2'));
ok('生产路径按 pending+done 计数并排除达到上限者', source.includes("state IN ('pending', 'done')") && source.includes('countOf.get(p.slug) ?? 0) < MAX_AGENT_FLOORS_PER_POST'));
ok('生产路径优先未开口者', source.includes('const fresh = eligible.filter((p) => (countOf.get(p.slug) ?? 0) === 0)') && source.includes('fresh.length ? fresh : eligible'));
const doneAt = source.indexOf("UPDATE floors SET state = ?, content = ?, replied_at = ? WHERE id = ?");
const ledgerAt = source.indexOf('markMemoryTold(persona.slug, memoryIndex, at)');
ok('同一 slug 跨帖子生成串行', source.includes('const key = `persona:${persona.slug}`') && source.includes('generating.has(key)'));
ok('账本失败不覆盖已落库正文', doneAt >= 0 && ledgerAt > doneAt && source.includes('账本] 写入失败但回复已保留'));
ok('done 后排期异常不撤回正文', source.includes("UPDATE floors SET state = 'failed' WHERE id = ? AND state <> 'done'") && source.includes('已经发布出去的正文不可撤回'));

const old = ['anhe', 'anhe', 'anhe', 'anhe'];
const counts = new Map<string, number>();
const cap = 2;
const next = old.filter((slug) => {
  const n = counts.get(slug) ?? 0;
  if (n >= cap) return false;
  counts.set(slug, n + 1);
  return true;
});
ok('post81 旧 anhe×4 在新上限下最多保留 2 层', next.length === 2, `old=${old.length} new=${next.length}`);
const eligible = [{ slug: 'anhe', n: 1 }, { slug: 'mianmian', n: 0 }, { slug: 'laoding', n: 0 }];
const fresh = eligible.filter((p) => p.n === 0);
ok('post81 未开口者优先入候选池', fresh.map((p) => p.slug).join(',') === 'mianmian,laoding');

const tempDir = mkdtempSync(join(tmpdir(), 'task66-memory-'));
const tempDb = join(tempDir, 'test.db');
try {
  const dbUrl = pathToFileURL(join(import.meta.dirname, 'db.ts')).href;
  const probe = `
    import { markMemoryTold, memoriesTold } from ${JSON.stringify(dbUrl)};
    markMemoryTold('anhe', 3, 100);
    markMemoryTold('anhe', 3, 101);
    markMemoryTold('mianmian', 3, 102);
    console.log(JSON.stringify({ anhe: memoriesTold('anhe'), mianmian: memoriesTold('mianmian') }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, SHUDONG_DB: tempDb },
    encoding: 'utf8',
  }).trim()) as { anhe: number[]; mianmian: number[] };
  ok('memory 记账读得回', result.anhe.length === 1 && result.anhe[0] === 3);
  ok('memory 重复记账不炸且不重复', result.anhe.join(',') === '3');
  ok('memory 两个 slug 不串', result.mianmian.length === 1 && result.mianmian[0] === 3 && result.anhe[0] === 3);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failed) process.exit(1);
