/**
 * relay-watch —— 盯着中转站，它一旦没钱 / 停了 / 被限流，弹一个 Windows 气泡提醒你。
 *
 * 为什么要有它（用户 m04546 的原话）："中转站可能干一半没钱了，停了，你要提醒我的，可以弹windows气泡"。
 * 切到中转之后，那边的余额和可用性不归我们管；真出事时你正在忙别的，只会看到"队友忽然不动了"，
 * 看不到原因。这个脚本替你看着，出问题用气泡拍你一下 —— 不靠你盯着日志。
 *
 * 代价：每轮一次最小请求（`deepseek-flash`，1 个 token）。默认 5 分钟一轮。
 * 判据：HTTP 200 = 好；401/402/403/429 或正文里出现余额/额度/欠费/充值字样 = 没钱或被限流；
 *       连不上 = 网络层失败（要连续两次才算数，避免一次抖动就吵你）。
 * 纪律：只在"状态变化"时弹，或者一直坏着每 30 分钟再拍一次 —— 不刷屏。
 * 闸口（用户 m07752 要的"本地模型闸口"，`llm-gate.mjs`，Lead 维护）：每轮顺手 GET 一下它的 /gate/health，
 *       不通就在日志里记一行 `gate DOWN`，通了记一行 `gate 恢复`。**只记不重起** —— 重起是 Startup 里
 *       `llm-gate.vbs` 守护的活，这里再起一个就会两个人抢 11499 端口。
 * 停它：建一个空文件 F:\tmp\relay-watch.stop，下一轮自己退。
 * 日志：F:\tmp\relay-watch.log（只追加）。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const KEYFILE = process.env.RELAY_KEYFILE ?? 'C:/Users/Maverick/.dsh/.credentials.yaml';
const BASE = process.env.RELAY_BASE ?? 'https://momoapi.asia/v1';
const INTERVAL = Number(process.env.RELAY_WATCH_SEC ?? 300);
const LOG = process.env.RELAY_WATCH_LOG ?? 'F:/tmp/relay-watch.log';
const STOP = process.env.RELAY_WATCH_STOP ?? 'F:/tmp/relay-watch.stop';
const REPEAT_MS = Number(process.env.RELAY_WATCH_REPEAT_MIN ?? 30) * 60_000;
const GATE_HEALTH = process.env.RELAY_WATCH_GATE_URL ?? 'http://127.0.0.1:11499/gate/health';
/** 自检时给标题加前缀 —— 免得测试气泡被你当成真事故。 */
const TEST = process.env.RELAY_WATCH_TEST ? '（自检）' : '';
const PS = 'F:/tmp/relay-balloon.ps1';

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
const log = (line) => {
  const l = `[${stamp()}] ${line}`;
  appendFileSync(LOG, l + '\n');
  console.log(l);
};

/** 弹一个 Windows 气泡。写一个临时 .ps1（带 BOM，老 powershell 才读得对中文）再隐藏着跑。 */
function balloon(title, body) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const script = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Warning
$ni.BalloonTipTitle = ${q(title)}
$ni.BalloonTipText = ${q(body)}
$ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
$ni.Visible = $true
$ni.ShowBalloonTip(20000)
Start-Sleep -Seconds 10
$ni.Dispose()
`;
  writeFileSync(PS, '\uFEFF' + script, 'utf8');
  try {
    spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS], {
      detached: true,
      stdio: 'ignore', // 不能用 pipe：沙箱里 node 开管道会 EPERM
      windowsHide: true,
    }).unref();
    log(`已弹气泡 :: ${title} :: ${body}`);
  } catch (e) {
    log(`弹气泡失败（${e.message}）—— 消息是：${title} :: ${body}`);
  }
}

function apiKey() {
  if (process.env.DS_API_KEY) return process.env.DS_API_KEY;
  const m = readFileSync(KEYFILE, 'utf8').match(/^\s*DS_API_KEY:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`在 ${KEYFILE} 里找不到 DS_API_KEY`);
  return m[1];
}

function reasonOf(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.error ?? j?.message;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 200);
  } catch {
    // 不是 JSON 就退回去看正文
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function probe(key) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: '1' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(25000),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (r.status === 200) return { ok: true, ms };
    const broke = [401, 402, 403, 429].includes(r.status) || /balance|quota|insufficient|欠费|余额|额度|充值|过期|expired/i.test(text);
    return { ok: false, kind: broke ? 'broke' : 'http', reason: `HTTP ${r.status} · ${reasonOf(text)}`, ms };
  } catch (e) {
    return { ok: false, kind: 'net', reason: `${e.name}: ${e.message}`, ms: Date.now() - t0 };
  }
}

/**
 * 本地模型闸口活着吗？`/gate/health` 不管在哪个档位都答 200 + `{ok:true,mode,…}`（它只是报当前档位，
 * 闸口自己关着也照答），所以"连不上 / 不是这个形状"就等于闸口进程没了。只读，不碰上游。
 */
async function gateUp() {
  try {
    const r = await fetch(GATE_HEALTH, { signal: AbortSignal.timeout(8000) });
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

const key = apiKey();
log(`开跑 · base=${BASE} · 每 ${INTERVAL}s 一轮 · key 从 ${KEYFILE} 读到（长度 ${key.length}）`);

let state = 'ok';
let gateState = 'ok';
let fails = 0;
let lastAlert = 0;
let ticks = 0;

for (;;) {
  if (existsSync(STOP)) {
    log('看到停止文件，退出');
    break;
  }
  const p = await probe(key);
  ticks += 1;

  if (p.ok) {
    if (state !== 'ok') {
      log(`恢复 · 这一轮 ${p.ms}ms`);
      balloon('述洞 · 中转站又能通了', `刚才不行的那阵已经过去（这一轮 ${p.ms}ms）。`);
    } else if (ticks === 1 || ticks % 12 === 0) {
      log(`心跳 ok · ${p.ms}ms`);
    }
    state = 'ok';
    fails = 0;
  } else {
    fails += 1;
    const hint = p.kind === 'broke' ? '（像没钱/被限流）' : p.kind === 'net' ? '（连不上）' : '';
    log(`失败 #${fails} ${hint} · ${p.reason}`);
    const enough = p.kind === 'net' ? fails >= 2 : fails >= 1;
    if (enough && (state === 'ok' || Date.now() - lastAlert > REPEAT_MS)) {
      const title = (p.kind === 'broke' ? '述洞 · 中转站可能没钱了' : p.kind === 'net' ? '述洞 · 中转站连不上了' : '述洞 · 中转站报错');
      balloon(TEST + title, `${p.reason}（${stamp()}，第 ${fails} 次）`);
      lastAlert = Date.now();
    }
    state = 'fail';
  }

  // 闸口体检：只记不重起（重起是 Startup 里 llm-gate.vbs 守护的活，这里再起就抢端口了）
  const gUp = await gateUp();
  if (!gUp && gateState === 'ok') {
    gateState = 'down';
    log(`gate DOWN · ${GATE_HEALTH} 不通 —— 本地模型请求全卡在闸口，吧友这阵子不会说话（不自动重起）`);
  } else if (gUp && gateState === 'down') {
    gateState = 'ok';
    log(`gate 恢复 · ${GATE_HEALTH}`);
  }

  const until = Date.now() + INTERVAL * 1000;
  while (Date.now() < until) {
    if (existsSync(STOP)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (existsSync(STOP)) {
    log('看到停止文件，退出');
    break;
  }
}
