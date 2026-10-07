// 本地模型闸口 —— 用户用软件开关控制团队能否使用本机 Ollama（127.0.0.1:11434）。
//
// 三种状态（state 文件 F:\shudong\data\llm-gate.json）：
//   off      关闭      —— 任何推理请求都拒绝（连产品也不行）
//   product  只准产品  —— 只放行 allow 列表里的模型（默认 qwen3.5:9b，即线上吧友用的那个）
//   on       开放给团队 —— 全部放行（用户点开后才允许跑实验：35B、eval、A/B 等）
//
// 换状态：浏览器打开 http://127.0.0.1:11499/gate 点按钮（也可以 GET /gate/set?mode=off）。
// 只读接口（/api/tags、/api/ps、/api/version、/v1/models）任何时候都放行。
// 识别不出用途的路径一律按"可能推理"处理 —— 只有 on 才放行（fail-closed）。
//
// 起：node F:\shudong\tools\llm-gate.mjs   （日志 F:\tmp\llm-gate.log，每条请求一行 JSON）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.GATE_PORT ?? 11499);
const UP_HOST = process.env.GATE_UPSTREAM_HOST ?? '127.0.0.1';
const UP_PORT = Number(process.env.GATE_UPSTREAM_PORT ?? 11434);
const STATE_FILE = process.env.GATE_STATE ?? 'F:\\shudong\\data\\llm-gate.json';
const LOG_FILE = process.env.GATE_LOG ?? 'F:\\tmp\\llm-gate.log';
const MAX_BODY = 64 * 1024 * 1024;

const DEFAULT_STATE = {
  mode: 'product',
  allow: ['qwen3.5:9b'],
  note: '',
  updatedAt: null,
  updatedBy: 'default',
};

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const allow = Array.isArray(s.allow) && s.allow.length ? s.allow.map(String) : DEFAULT_STATE.allow;
    const mode = ['off', 'product', 'on'].includes(s.mode) ? s.mode : DEFAULT_STATE.mode;
    return { ...DEFAULT_STATE, ...s, mode, allow };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(s, who = 'gate') {
  const next = { ...s, updatedAt: new Date().toISOString(), updatedBy: who };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function logLine(obj) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    /* 日志失败不影响放行判断 */
  }
}

const INFER = [
  /^\/v1\/chat\/completions/,
  /^\/v1\/completions/,
  /^\/v1\/embeddings/,
  /^\/v1\/responses/,
  /^\/api\/chat/,
  /^\/api\/generate/,
  /^\/api\/embed/,
  /^\/api\/embeddings/,
];
const READONLY = [/^\/api\/tags/, /^\/api\/ps/, /^\/api\/version/, /^\/api\/show/, /^\/v1\/models/];

function modelAllowed(model, allow) {
  if (!model) return false;
  const base = String(model).split(':')[0];
  return allow.some((a) => a === model || a === base || a.split(':')[0] === base);
}

function denyMessage(state, model) {
  const url = `http://127.0.0.1:${PORT}/gate`;
  if (state.mode === 'off') {
    return `本地模型闸口当前是【休息】：本机模型谁也不跑，线上吧友的回复也一起停（模型「${model || '未指明'}」被拒）。要恢复，请用户打开 ${url} 或 DSH 的「智能体团队」面板，点「只准产品」或「开工」。`;
  }
  return `本地模型闸口当前是【只准产品】：只放行 ${state.allow.join('、')}（线上吧友用的那个）。请求的模型「${model || '未指明'}」属于实验用途，被拒绝 —— 实验会占满显存、让用户的电脑卡死。要跑实验必须由用户打开 ${url} 点「开放给团队」。`;
}

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function classify(pathname) {
  if (READONLY.some((re) => re.test(pathname))) return 'readonly';
  if (INFER.some((re) => re.test(pathname))) return 'infer';
  return 'unknown';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function tailRows(limit = 30) {
  let raw = '';
  try {
    const st = fs.statSync(LOG_FILE);
    const start = Math.max(0, st.size - 512 * 1024);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch {
    return { rows: [], usage: {}, denied: [] };
  }
  const lines = raw.split('\n').filter(Boolean);
  const rows = [];
  for (const l of lines) {
    try {
      rows.push(JSON.parse(l));
    } catch {
      /* 半行 */
    }
  }
  const day = today();
  const todays = rows.filter((r) => String(r.t || '').slice(0, 10) === day);
  const usage = {};
  for (const r of todays) {
    if (r.verdict !== 'allow') continue;
    const k = `${r.model || '?'}`;
    usage[k] = (usage[k] || 0) + 1;
  }
  const denied = todays.filter((r) => r.verdict === 'deny').slice(-10).reverse();
  return { rows, usage, denied, last: todays.slice(-limit).reverse() };
}

function gatePage() {
  const s = readState();
  const { usage, denied, last } = tailRows();
  const modeLabel = { off: '关闭', product: '只准产品', on: '开放给团队' }[s.mode] || s.mode;
  const usageRows = Object.entries(usage)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `<tr><td>${esc(m)}</td><td class="n">${n}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="dim">今天还没有推理请求</td></tr>';
  const deniedRows = denied
    .map((r) => `<tr><td>${esc(String(r.t).slice(11, 19))}</td><td>${esc(r.model || '?')}</td><td>${esc(r.path || '')}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="dim">没有被拒的请求</td></tr>';
  const lastRows = (last || [])
    .map(
      (r) =>
        `<tr class="${r.verdict === 'allow' ? '' : 'bad'}"><td>${esc(String(r.t).slice(11, 19))}</td><td>${esc(r.verdict)}</td><td>${esc(
          r.model || '-',
        )}</td><td>${esc(r.path || '')}</td></tr>`,
    )
    .join('') || '<tr><td colspan="4" class="dim">暂无</td></tr>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>本地模型闸口</title><style>
body{font:14px/1.6 -apple-system,"Microsoft YaHei",sans-serif;margin:24px auto;max-width:860px;padding:0 16px;color:#222}
h1{font-size:20px;margin:0 0 4px} .sub{color:#777;margin-bottom:16px}
.mode{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:600}
.mode.off{background:#ffe3e3;color:#a1181c}.mode.product{background:#e6f0ff;color:#1b4f9c}.mode.on{background:#e3f7e8;color:#1a6b34}
a.btn,button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer;text-decoration:none;color:#222;margin-right:8px}
button.sel{border-color:#1b4f9c;background:#eef4ff;font-weight:600}
table{border-collapse:collapse;margin:6px 0 18px;width:100%}td,th{border-bottom:1px solid #eee;padding:4px 8px;text-align:left}
th{color:#777;font-weight:500}.n{text-align:right;font-variant-numeric:tabular-nums}
tr.bad td{color:#a1181c}.dim{color:#999}
.card{border:1px solid #eee;border-radius:10px;padding:12px 16px;margin-bottom:16px}
</style></head><body>
<h1>本地模型闸口</h1>
<div class="sub">本机 Ollama（127.0.0.1:11434）的前置开关 · 只放行走 <b>http://127.0.0.1:${PORT}</b> 的请求 · 改完立刻生效，不用重启任何东西</div>
<div class="card">
  当前状态：<span class="mode ${esc(s.mode)}">${esc(modeLabel)}</span>
  <span class="dim">（只准产品时放行：${esc(s.allow.join('、'))}）</span><br>
  <div style="margin-top:10px">
    <form method="POST" action="/gate/mode" style="display:inline"><input type="hidden" name="mode" value="off"><button ${s.mode === 'off' ? 'class="sel"' : ''}>关闭</button></form>
    <form method="POST" action="/gate/mode" style="display:inline"><input type="hidden" name="mode" value="product"><button ${s.mode === 'product' ? 'class="sel"' : ''}>只准产品</button></form>
    <form method="POST" action="/gate/mode" style="display:inline"><input type="hidden" name="mode" value="on"><button ${s.mode === 'on' ? 'class="sel"' : ''}>开放给团队</button></form>
  </div>
  <div class="dim" style="margin-top:8px">最后改动：${esc(s.updatedAt || '—')}（${esc(s.updatedBy || '—')}）${s.note ? ' · ' + esc(s.note) : ''}</div>
  <form method="POST" action="/gate/allow" style="margin-top:12px">
    只准产品时额外放行的模型（逗号分隔）：
    <input name="allow" value="${esc(s.allow.join(','))}" style="font:inherit;padding:6px 8px;width:52%">
    <button>保存</button>
  </form>
</div>
<div class="card"><b>今天谁在用（按请求数）</b><table>${usageRows}</table>
<b>被拒的实验请求</b><table><tr><th>时间</th><th>模型</th><th>路径</th></tr>${deniedRows}</table></div>
<div class="card"><b>最近 30 条请求</b><table><tr><th>时间</th><th>结果</th><th>模型</th><th>路径</th></tr>${lastRows}</table></div>
</body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function readFormFields(req) {
  return readBody(req).then((b) => Object.fromEntries(new URLSearchParams(b.toString())));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // ---- 跨源：DSH 的「智能体团队」面板里也放了这个开关，那边是 http://127.0.0.1:43120 ----
  // 只服务 /gate* 这组自己的路由，代理路径一个头都不加（模型请求是服务端发的，不需要 CORS）。
  if (p.startsWith('/gate')) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // ---- 开关自己的界面 ----
  if (p === '/gate' || p === '/gate/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(gatePage());
    return;
  }
  if (p === '/gate/state') {
    sendJson(res, 200, readState());
    return;
  }
  if (p === '/gate/health') {
    sendJson(res, 200, { ok: true, mode: readState().mode, port: PORT, upstream: `${UP_HOST}:${UP_PORT}` });
    return;
  }
  if (p === '/gate/mode' || p === '/gate/set') {
    const fields = req.method === 'POST' ? await readFormFields(req) : Object.fromEntries(url.searchParams);
    const mode = String(fields.mode || '');
    if (!['off', 'product', 'on'].includes(mode)) {
      sendJson(res, 400, { error: { message: 'mode 只能是 off / product / on' } });
      return;
    }
    const next = writeState({ ...readState(), mode }, 'user@gate-ui');
    logLine({ verdict: 'mode', mode, path: p, from: req.socket.remoteAddress });
    if (req.method === 'POST') {
      res.writeHead(303, { location: '/gate' });
      res.end();
    } else {
      sendJson(res, 200, { ok: true, ...next });
    }
    return;
  }
  if (p === '/gate/allow') {
    const fields = req.method === 'POST' ? await readFormFields(req) : Object.fromEntries(url.searchParams);
    const allow = String(fields.allow || '')
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const next = writeState({ ...readState(), allow: allow.length ? allow : DEFAULT_STATE.allow }, 'user@gate-ui');
    if (req.method === 'POST') {
      res.writeHead(303, { location: '/gate' });
      res.end();
    } else {
      sendJson(res, 200, { ok: true, ...next });
    }
    return;
  }

  // ---- 代理 ----
  const kind = classify(p);
  const method = (req.method || 'GET').toUpperCase();
  let body = Buffer.alloc(0);
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 413, { error: { message: '请求体过大' } });
      return;
    }
  }
  let model = null;
  if (body.length) {
    try {
      // 去掉 BOM / 空白再解析：有的客户端（和 Windows 上随手 Set-Content 的脚本）会带 BOM，
      // 解析失败就会把模型名读成 null，进而把产品的 9B 也误拒。
      const j = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, '').trim());
      model = j.model || j.model_name || null;
    } catch {
      /* 真的不是 JSON：交给 upstream 自己报错，闸口按"未指明模型"处理（product 模式下拒） */
    }
  }

  const state = readState();
  // 三态语义（别把 off 和 product 合成一档：off 是"休息"，连线上吧友那个模型也不跑）：
  //   off      → 只放行只读查询，任何推理都拒（真的停下来，风扇不转）
  //   product  → 只放行 allow 列表里的模型（线上吧友用的那个），实验模型一律拒
  //   on       → 都放行
  const verdict =
    kind === 'readonly'
      ? 'allow'
      : state.mode === 'on'
        ? 'allow'
        : state.mode === 'product' && kind === 'infer' && modelAllowed(model, state.allow)
          ? 'allow'
          : 'deny';

  logLine({
    verdict,
    mode: state.mode,
    model,
    kind,
    method,
    path: p,
    port: req.socket.remotePort,
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
  });

  if (verdict === 'deny') {
    const msg = denyMessage(state, model);
    sendJson(res, 503, { error: { message: msg, type: 'local_model_gate', code: 'gate_denied', mode: state.mode } }, { 'x-local-model-gate': 'deny' });
    return;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  headers.host = `${UP_HOST}:${UP_PORT}`;
  const up = http.request({ host: UP_HOST, port: UP_PORT, method, path: req.url, headers }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, { ...upRes.headers, 'x-local-model-gate': `allow;mode=${state.mode}` });
    upRes.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `闸口连不上本机 Ollama（${UP_HOST}:${UP_PORT}）：${e.message}` } });
    } else {
      res.destroy();
    }
  });
  res.on('close', () => up.destroy());
  if (body.length) up.write(body);
  up.end();
});

if (!fs.existsSync(STATE_FILE)) writeState({ ...DEFAULT_STATE }, 'gate-first-run');
server.listen(PORT, '127.0.0.1', () => {
  const s = readState();
  console.log(`[llm-gate] http://127.0.0.1:${PORT}  mode=${s.mode}  allow=${s.allow.join(',')}  upstream=${UP_HOST}:${UP_PORT}`);
  console.log(`[llm-gate] 界面 http://127.0.0.1:${PORT}/gate   日志 ${LOG_FILE}`);
});
