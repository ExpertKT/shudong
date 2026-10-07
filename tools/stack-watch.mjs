/**
 * 述洞整栈看护 —— 只看「端口还答不答话」，**不看进程还在不在**。
 *
 * 为什么需要它：现有的 `llm-gate.vbs`（启动文件夹里那圈守夜）只会在
 * **进程退出** 时重起闸口；闸口要是卡住了（进程还在、但不再应答），
 * 它看不见。2026-10-06 18:02 就是这种：5173 / 8787 / 11499 三个口
 * 悄没声地全没了，用户看到的是一个死站，直到有人手工拉起。
 *
 * 每 30 秒做一次：
 *   1. 8787（后端）/ 5173（前端）任一不答话 → 跑一遍 `start-shudong.ps1 -NoOpen`
 *      （它本身是幂等的：只起「没人听」的那一半，不会碰别人的进程）。
 *   2. 11499（本地模型闸口）连两次不答话 → 收掉占着那个口的进程，
 *      等 10 秒；还不活就自己起一个。
 *
 * 日志：F:\tmp\stack-watch.log。手动跑：`node F:\shudong\tools\stack-watch.mjs`
 */
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const LOG = 'F:\\tmp\\stack-watch.log';
const PORT_TMP = 'F:\\tmp\\stack-watch.port.txt';
const INTERVAL = 30_000;
const GATE = 'http://127.0.0.1:11499/gate/health';
const START_PS1 = 'F:\\shudong\\tools\\start-shudong.ps1';
const GATE_MJS = 'F:\\shudong\\tools\\llm-gate.mjs';

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* 日志写不进去也不能让看护停摆 */ }
}

async function alive(url, ms = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** 跑一个命令并等它结束；输出直接丢掉（不接管道，绕开这台机器上 PowerShell 的 NO_PROXY 坑）。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, ...opts });
    p.on('exit', (code) => resolve(code));
    p.on('error', () => resolve(-1));
  });
}

/** 占着某个口的 pid（没有就 null）。输出走文件，不走管道。 */
async function portPid(port) {
  await run('cmd', ['/c', `netstat -ano > ${PORT_TMP}`]);
  try {
    for (const line of readFileSync(PORT_TMP, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
  } catch {
    /* 读不到就当没人占 */
  }
  return null;
}

async function ensureSite() {
  const [api, web] = await Promise.all([alive('http://127.0.0.1:8787/api/health'), alive('http://localhost:5173/')]);
  if (api && web) return;
  log(`站点掉了（8787=${api ? 'ok' : 'DOWN'} / 5173=${web ? 'ok' : 'DOWN'}）→ 拉起来`);
  const code = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', START_PS1, '-NoOpen']);
  const [api2, web2] = await Promise.all([alive('http://127.0.0.1:8787/api/health'), alive('http://localhost:5173/')]);
  log(`拉起结果 exit=${code} 8787=${api2 ? 'ok' : 'DOWN'} 5173=${web2 ? 'ok' : 'DOWN'}`);
}

async function ensureGate() {
  if (await alive(GATE)) return;
  log('闸口不答话，再等一次确认');
  await new Promise((r) => setTimeout(r, 5000));
  if (await alive(GATE)) return;

  const pid = await portPid(11499);
  if (pid) {
    log(`闸口卡住：11499 被 pid=${pid} 占着但不答话 → 收掉它`);
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    log('闸口没了：11499 空着');
  }

  // 先等 `llm-gate.vbs` 那圈守夜自己把它拉回来（它在的时候 5 秒一轮）
  await new Promise((r) => setTimeout(r, 10_000));
  if (await alive(GATE)) { log('闸口已被守夜拉回来'); return; }

  log('等不到守夜 → 自己起一个闸口');
  spawn('node', [GATE_MJS], { stdio: 'ignore', windowsHide: true, detached: true, cwd: 'F:\\shudong\\tools' }).unref();
  await new Promise((r) => setTimeout(r, 5000));
  log(`自己起的结果：11499 ${(await alive(GATE)) ? 'ok' : '仍然 DOWN'}`);
}

log(`看护启动（每 ${INTERVAL / 1000} 秒一轮）`);
for (;;) {
  try {
    await ensureSite();
    await ensureGate();
  } catch (e) {
    log(`这一轮出错（继续）：${e && e.message ? e.message : e}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
