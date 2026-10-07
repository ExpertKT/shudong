import { pickModel } from './llm.ts';

let failed = 0;
function ok(label: string, value: boolean) {
  if (!value) failed++;
  console.log(`${value ? 'ok  ' : 'FAIL'} ${label}`);
}
const fast = 'qwen3.5:9b';
const slow = 'qwen3.6:35b-a3b-q4_k_m-gpu20';
ok('MODEL_SLOW 空：任何延迟都恒用 fast', pickModel({ delayMs: 999_999, fast, slow: '', afterSec: 30 }) === fast);
ok('延迟恰好 30 秒：边界仍用 fast', pickModel({ delayMs: 30_000, fast, slow, afterSec: 30 }) === fast);
ok('延迟 30 秒 + 1ms：切 slow', pickModel({ delayMs: 30_001, fast, slow, afterSec: 30 }) === slow);
ok('负延迟：仍用 fast', pickModel({ delayMs: -6_675, fast, slow, afterSec: 30 }) === fast);
if (failed) process.exit(1);
