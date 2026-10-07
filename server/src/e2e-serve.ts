/**
 * 起一台**自己的**测试 server，跑一个 e2e 客户端脚本，跑完自己收干净。
 *
 * 起因（真踩过，Lead 判的失败模式）：我自己起的实例 `EADDRINUSE` 当场死了，
 * 断言却打到了别人正在跑的服务上 —— "全绿"是假的。所以三件事做成机械的，不靠人记性：
 *   ① 端口被占 → 立刻中止，**一条 ok 都不落**（exit 2）；
 *   ② 健康检查过了还不算，还要 子进程活着（`child.exitCode === null`）＋ 监听这个端口的 pid
 *      就是这个子进程（`netstat -ano` 核）—— 否则 exit 3；
 *   ③ 跑前跑后给 `src/*.ts` 算 sha256，不一致就是"跑在一棵会动的树上"，判失败（exit 4）并点名谁变了。
 * server 的 stdout/stderr 落 `F:\tmp\<owner>-<id>.log`（不落管道、不落别人共享的 %TEMP%），
 * 起不来时直接打印这个 log 的尾巴，EADDRINUSE 之类一眼看见。
 *
 * 端口与临时库按人分（Lead 定的 team 约定）：
 *   bond 8920-8929 / qc 8930-8939 / ui 8940-8949；临时库 `F:\tmp\<owner>-<id>.db`。
 *
 * 用法：
 *   node src/e2e-serve.ts --script src/e2e.ts
 *   node src/e2e-serve.ts --script src/e2e-gate.ts --env USER_DAILY_TOKENS=1
 *   node src/e2e-serve.ts --script src/e2e-floors.ts --env LLM_BASE_URL=http://127.0.0.1:8917/v1
 *   node src/e2e-serve.ts --script src/e2e.ts --port 8925        # 指定自己号段内的口
 * 退出码：0 全绿 · 2 端口被占/起不来/脚本失败 · 3 应答的不是我的子进程 · 4 被测树跑动过
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BANDS: Record<string, [number, number]> = { bond: [8920, 8929], qc: [8930, 8939], ui: [8940, 8949] };

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}
const owner = arg('owner') ?? 'bond';
const band = BANDS[owner];
if (!band) {
  console.error(`✗ 不认识 owner=${owner}（端口号段只给了：${Object.keys(BANDS).join(' / ')}）`);
  process.exit(2);
}
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = arg('script') ?? 'src/e2e.ts';
const overrides: Record<string, string> = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--env') {
    const [k, ...rest] = (process.argv[i + 1] ?? '').split('=');
    if (!k || !rest.length) {
      console.error(`✗ --env 要写成 KEY=VALUE，收到 "${process.argv[i + 1]}"`);
      process.exit(2);
    }
    overrides[k] = rest.join('=');
  }
}

/** 监听 <port> 的 pid；没人听返回 null。netstat 认不出来就抛错（宁可炸，不要假绿）。 */
function listenerPid(port: number): number | null {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`netstat 跑不动：${r.error?.message ?? `exit ${r.status}`}`);
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const cols = line.trim().split(/\s+/);
    if (cols[1]?.endsWith(`:${port}`)) return Number(cols[cols.length - 1]);
  }
  return null;
}

function treeHashes(): Map<string, string> {
  const src = join(serverDir, 'src');
  const out = new Map<string, string>();
  for (const name of readdirSync(src).filter((f) => f.endsWith('.ts')).sort()) {
    out.set(name, createHash('sha256').update(readFileSync(join(src, name))).digest('hex'));
  }
  return out;
}

function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [name, hash] of before) {
    if (!after.has(name)) changed.push(`${name} 被删了`);
    else if (after.get(name) !== hash) changed.push(name);
  }
  for (const name of after.keys()) if (!before.has(name)) changed.push(`${name} 是新写的`);
  return changed;
}

// ① 端口：占了就中止，不落任何 ok。没指定就只在**我自己的号段**里挑第一个空的。
let port = 0;
const asked = arg('port');
if (asked) {
  port = Number(asked);
  if (port < band[0] || port > band[1]) {
    console.error(`✗ ${port} 不在 ${owner} 的号段 ${band[0]}-${band[1]} 里（别去踩别人的口）`);
    process.exit(2);
  }
  const busy = listenerPid(port);
  if (busy) {
    console.error(`✗ 端口 ${port} 已经被 pid ${busy} 占着，中止 —— 一条断言都不跑`);
    process.exit(2);
  }
} else {
  for (let p = band[0]; p <= band[1]; p++) {
    if (!listenerPid(p)) {
      port = p;
      break;
    }
  }
  if (!port) {
    console.error(`✗ ${owner} 的号段 ${band[0]}-${band[1]} 全被占了，中止`);
    process.exit(2);
  }
}

// 这三个开关是"**没人开口就花钱**"的：本机 `server/.env`（演示/线上那份）把它们开着
// （`AGENT_POSTS_PER_DAY=10` / `PROACTIVE=1` / `DM_MEMORY=1`），测试结果就会跟着**本机的 .env 飘** ——
// 已经踩过：`e2e:gate` 第一次 tick 时 L-1 先给自己起了一条新帖（`index.ts:890` 的 `maybeAgentPost` 就在
// tick 路径上），额度花在起帖上、那条回复没生成，脚本报 `FAIL 回复真的生成了 — 0 字`（`userToday=775`）。
// harness 里一律钉死为 **0**；要验这些特性的脚本自己用 `--env AGENT_POSTS_PER_DAY=…` 显式打开
// （显式值在 `...overrides` 里、排在后面，压过这里）。
//
// `REGISTER_PER_*` 同理：它们是**注册节流**两道闸的额度，本机 `.env` 里也带着演示数字。
// 别的脚本会自己注册账号（`e2e-auth` / `e2e-floors` / `e2e-relations` …），一个临时库上跑几十次
// 就会撞上"同来源每小时 5 个" —— 那是**测试自己把测试绊倒**，不是产品的问题。所以默认关成 0；
// 专门验节流的 `e2e:register` 用 `--env REGISTER_PER_IP_HOURLY=…` 显式打开。
const PINNED = {
  AGENT_POSTS_PER_DAY: '0',
  PROACTIVE: '0',
  DM_MEMORY: '0',
  REGISTER_PER_IP_HOURLY: '0',
  REGISTER_PER_DAY: '0',
  // 来源判据也钉死：本机没有反代，XFF 是客户端自己写得出来的头。
  TRUST_PROXY: '0',
  // 背往事枪（task-42）默认关，但**测试不该跟着本机 `.env` 变**：线上哪天要开就把这个值写进
  // `server/.env`，真模型那几步（`e2e:floors` 等）会跟着丢楼层、变成假红。要验枪的脚本自己
  // 用 `--env MEMORY_GUN=1` 显式打开。
  MEMORY_GUN: '0',
};

const id = `${owner}-${port}-${Date.now().toString(36)}`;
const dbPath = join('F:\\tmp', `${id}.db`);
const logPath = join('F:\\tmp', `${id}.log`);
const logFd = openSync(logPath, 'a');
const before = treeHashes();
// 这行会把 `--env` 原样打出来，所以**密钥类只打长度** —— 别让测试日志里存在一把真密钥
// （跑 e2e 时可能顺手把线上那把 `SESSION_SECRET` 传进来，日志是会被人翻的）。
const sensitive = /SECRET|KEY|TOKEN|PASSWORD/i;
const shown = (k: string, v: string) => (sensitive.test(k) ? `${k}=<${v.length} 字符>` : `${k}=${v}`);
console.log(`▶ 起 server：port=${port} db=${dbPath} log=${logPath}`);
console.log(`  显式环境变量（压过 .env）：${Object.entries({ ...PINNED, ...overrides, PORT: String(port), SHUDONG_DB: dbPath }).map(([k, v]) => shown(k, v)).join(' ')}`);

const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.ts'], {
  cwd: serverDir,
  env: { ...process.env, ...PINNED, PORT: String(port), SHUDONG_DB: dbPath, ...overrides },
  stdio: ['ignore', logFd, logFd],
  // 别弹窗：用户为这个发过火（每起一次 server 就闪一个控制台）。
  windowsHide: true,
});

function die(code: number, why: string): never {
  console.error(`✗ ${why}`);
  console.error(`  server log 尾巴（${logPath}）：`);
  const tail = readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/).slice(-12).join('\n  ');
  if (tail) console.error(`  ${tail}`);
  try {
    child.kill();
  } catch {}
  closeSync(logFd);
  process.exit(code);
}

// ② 起：健康检查 + 子进程还活着 + 端口的主人就是这个子进程
let up = false;
for (let i = 0; i < 50; i++) {
  if (child.exitCode !== null) die(2, `我起的 server 已经死了（exit ${child.exitCode}）—— 断言一条都不能跑`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.status === 200) {
      up = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) die(2, `25 秒了 /api/health 还没起来`);
if (child.exitCode !== null) die(2, `health 通了但我的 server 已经死了（exit ${child.exitCode}）`);
const pid = listenerPid(port);
if (pid !== child.pid) die(3, `端口 ${port} 的主人是 pid ${pid}，不是我的子进程 pid ${child.pid} —— 应答我的不是这份代码`);

const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { tick?: number };
console.log(`  起好了：pid=${child.pid} tick=${health.tick}`);

// 跑客户端脚本（stdio 继承，输出原样给人看）
// 客户端拿到的是**和服务端同一份**环境：`PINNED` 打底、`--env` 压过。脚本要按"服务端实际拿到的
// 额度"写断言（比如 e2e-register 要数同来源第几次被拦），只给服务端不给客户端的话，脚本只能把
// 数字抄一遍 —— 抄错了就是假绿。
const run = spawn(process.execPath, [script], {
  cwd: serverDir,
  env: { ...process.env, ...PINNED, SHUDONG_BASE: `http://127.0.0.1:${port}`, SHUDONG_DB: dbPath, ...overrides },
  stdio: 'inherit',
  windowsHide: true,
});
const clientExit = await new Promise<number | null>((r) => run.on('exit', (code) => r(code)));

// ③ 树动过没有
const changed = diffTrees(before, treeHashes());
const files = [...before.keys()].map((n) => `${n}:${before.get(n)!.slice(0, 12)}`);

child.kill();
await new Promise((r) => setTimeout(r, 500));
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });
closeSync(logFd);
const stillThere = listenerPid(port);

console.log(`\n被测树 sha256（跑前）：${files.join(' ')}`);
console.log(`端口 ${port} 收尾后：${stillThere ? `还在被 pid ${stillThere} 听着 ✗` : '空了 ✓'}；临时库已删（log 留在 ${logPath}）`);

if (clientExit !== 0) {
  console.error(`✗ ${script} 自己报了失败（exit ${clientExit}）`);
  process.exit(2);
}
if (changed.length) {
  console.error(`✗ 跑动过的文件：${changed.join(' / ')} —— 这轮绿灯不算数，得在同一棵树上重跑`);
  process.exit(4);
}
if (stillThere) {
  console.error(`✗ 端口 ${port} 上还留着 pid ${stillThere}`);
  process.exit(2);
}
console.log(`✅ 全绿：${script} exit 0 · 端口 ${port} 是我的子进程 pid ${child.pid} · 树没动 · 收干净了`);
