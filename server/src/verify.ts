/**
 * 上台前的"窄套"：typecheck + test:replies + test:hardening + test:relations-said + e2e:register + e2e:floors + e2e:gate，
 * 一条命令跑完。
 *
 * 为什么要有它：这几步改完一次要手敲一遍，还得靠记性记住给 `e2e-floors` 指 8917 那个录音代理、
 * 给 `e2e-gate` 把额度压到 1 字、给 `e2e:register` 显式打开节流（harness 默认把两道闸钉成 0）、
 * 两边都别开钟（`TICK_INTERVAL_SEC=0`）。手敲的顺序与环境只要漏一项，"以为验过了"就成立 ——
 * 所以把它落成机械的，末尾再把被测文件（`src/*.ts`）的 sha256 + mtime 打出来，让"跑的是哪一棵树"
 * 落成文字（与 `e2e-serve.ts` 的跑前=跑后校验互补）。
 *
 * **不在这个套里**：`e2e:clock`（它按真实时钟等分钟数，要开钟）、`e2e`（真模型全流程，更慢，
 * 单独跑）、`e2e:migrate` / `e2e:auth` / `e2e:relations` / `e2e:proactive`（M1/M2 的回归，改到那边才跑）。
 *
 * 用法：`pnpm --filter @shudong/server verify`（或 `node src/verify.ts`，cwd 在 `server/`）。
 * 退出码：0 全都过 · 否则＝第一步没过的退出码（后面的步骤不跑）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const verifyOwner = process.env.VERIFY_OWNER ?? 'bond';
const floorsProxyPort = Number(process.env.VERIFY_FLOORS_PROXY_PORT ?? 8917);
const floorsPortArgs = ['--owner', verifyOwner];

// server 的环境变量由 e2e-serve.ts 起子进程时注入（含下面的 --env），这里不再套一层 .env。
const steps: [string, string[]][] = [
  // 用 node 跑本地 tsc 的入口，不靠 shell 找 tsc.cmd（Windows 下 spawnSync 不带 shell 找不到 .cmd）。
  ['typecheck', [join(serverDir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']],
  ['test:replies', ['src/test-replies.ts']],
  ['test:hardening', ['src/test-hardening.ts']],
  ['test:model-routing', ['src/test-model-routing.ts']],
  ['test:max-floors', ['src/test-max-floors.ts']],
  ['test:relations-said', ['src/test-relations-said.ts']],
  // 注册节流跑**两遍**：一遍认 XFF（两道闸各自的 429 原句都能看到），一遍不认 XFF（换多少
  // 个 XFF 也是同一个桶）。两遍都不用模型，秒过。
  [
    'e2e:register（认 XFF）',
    [
      'src/e2e-serve.ts', ...floorsPortArgs, '--script', 'src/e2e-register.ts',
      '--env', 'TICK_INTERVAL_SEC=0',
      '--env', 'TRUST_PROXY=1',
      '--env', 'REGISTER_PER_IP_HOURLY=3',
      '--env', 'REGISTER_PER_DAY=4',
    ],
  ],
  [
    'e2e:register（不认 XFF）',
    [
      'src/e2e-serve.ts', ...floorsPortArgs, '--script', 'src/e2e-register.ts',
      '--env', 'TICK_INTERVAL_SEC=0',
      '--env', 'REGISTER_PER_IP_HOURLY=2',
      '--env', 'REGISTER_PER_DAY=0',
    ],
  ],
  [
    'e2e:floors（腿1：用户根帖）',
    [
      'src/e2e-serve.ts', ...floorsPortArgs, '--script', 'src/e2e-floors.ts',
      '--env', 'TICK_INTERVAL_SEC=0', // 别让服务端时钟在断言期间插进来说话
      '--env', `FLOORS_PROXY_PORT=${floorsProxyPort}`,
      '--env', `LLM_BASE_URL=http://127.0.0.1:${floorsProxyPort}/v1`, // 指向 e2e-floors.ts 自带的录音代理
      '--env', 'FLOORS_UPSTREAM=http://127.0.0.1:11499/v1', // 录音代理的真实上游，禁止绕过 11499
      '--env', 'USER_DAILY_TOKENS=200000',
      '--env', 'GLOBAL_DAILY_TOKENS=1000000',
    ],
  ],
  [
    'e2e:floors（腿2：吧友根帖）',
    [
      'src/e2e-serve.ts', ...floorsPortArgs, '--script', 'src/e2e-floors.ts',
      '--env', 'TICK_INTERVAL_SEC=0',
      '--env', 'E2E_FLOOR_LEG=agent',
      '--env', 'AGENT_POSTS_PER_DAY=0',
      '--env', 'PROACTIVE=0',
      '--env', 'FLOORS_PROXY_PORT=8919',
      '--env', 'LLM_BASE_URL=http://127.0.0.1:8919/v1',
      '--env', 'FLOORS_UPSTREAM=http://127.0.0.1:11499/v1',
      '--env', 'USER_DAILY_TOKENS=200000',
      '--env', 'GLOBAL_DAILY_TOKENS=1000000',
    ],
  ],
  [
    'e2e:gate',
    ['src/e2e-serve.ts', ...floorsPortArgs, '--script', 'src/e2e-gate.ts', '--env', 'TICK_INTERVAL_SEC=0', '--env', 'USER_DAILY_TOKENS=1', '--env', 'LLM_BASE_URL=http://127.0.0.1:11499/v1'],
  ],
];

for (const [label, args] of steps) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, args, { cwd: serverDir, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    const why = r.status === null ? `被信号 ${r.signal} 打断` : `exit ${r.status}`;
    console.error(`\n✗ ${label} 没过（${why}）—— 后面的步骤不跑了`);
    process.exit(r.status ?? 1);
  }
}

console.log('\n被测文件（sha256 · mtime · 名字）：');
const src = join(serverDir, 'src');
for (const name of readdirSync(src).filter((f) => f.endsWith('.ts')).sort()) {
  const p = join(src, name);
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
  console.log(`  ${sha}  ${statSync(p).mtime.toISOString()}  ${name}`);
}
console.log('\n✅ 窄套全绿：typecheck · test:replies · test:hardening · e2e:register（认/不认 XFF）· e2e:floors · e2e:gate');
