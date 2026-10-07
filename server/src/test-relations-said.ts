/**
 * relations.ts 的 said 接线离线断言：纯函数、无 server、无库、无模型请求。
 */
import { PERSONAS, pickMemory, type Persona } from './personas.ts';

type HistoryRow = { role: string; text: unknown };

function assistantSaid(history: HistoryRow[]): string[] {
  return history
    .filter((h) => h.role === 'assistant')
    .map((h) => (typeof h.text === 'string' ? h.text : ''))
    .filter(Boolean);
}

function fixture(): { persona: Persona; postId: number; postText: string; first: string } {
  for (const persona of PERSONAS) {
    const postText = persona.memories.flatMap((m) => m.when).join(' ');
    const first = pickMemory(persona, 2, postText);
    const candidates = persona.memories.filter((m) => m.when.some((w) => postText.includes(w)));
    if (persona.tells && candidates.length > 1 && first) return { persona, postId: 2, postText, first };
  }
  throw new Error('没有找到至少两条候选往事的确定性测试夹具');
}

let failed = 0;
function ok(label: string, condition: boolean, detail = '') {
  if (!condition) failed++;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const { persona, postId, postText, first } = fixture();
const next = pickMemory(persona, postId, postText, [first]);
ok('命中 ⇒ 换一条', next !== first, `首次「${first}」→ 再次「${next ?? '不讲自己'}」`);

const unrelated = '完全不相干的话，不包含任何往事原文。';
const unchanged = pickMemory(persona, postId, postText, []);
const withUnrelated = pickMemory(persona, postId, postText, [unrelated]);
ok('未命中 ⇒ 逐字节不变', unchanged === withUnrelated, `空 said「${unchanged}」→ 无关 said「${withUnrelated}」`);

const history: HistoryRow[] = [
  { role: 'user', text: first },
  { role: 'assistant', text: first },
  { role: 'assistant', text: '' },
  { role: 'assistant', text: 123 },
  { role: 'user', text: '不应进入 said' },
];
const said = assistantSaid(history);
ok('只认 assistant 的非空字符串', said.length === 1 && said[0] === first, `said=${JSON.stringify(said)}`);

process.exit(failed ? 1 : 0);
