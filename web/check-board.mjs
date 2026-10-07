// 监工台走查：1440/1920/375 实时页 + file:// 单开快照 + 拍板四条路（真投 / 送不出去 / 重试 / 单开也要能投）
//          + 「要你定的事」专属一屏（L~Q：入口可见 / 三种卡真用 / 重开记得 / 快照也能用 / 四档不横滚可点可读 / 原有分区不丢）
//
// ── 怎么跑 ────────────────────────────────────────────────────────────────────
// 全程用 pwsh（别让命令经 cmd /d /s /c，会弹 Windows Terminal，见 TEAM.md §2）。三步：
//
//   1) 起临时服务（8901，绝不碰用户那个 8787）：
//        $env:PORT='8901'; $env:SHUDONG_DB='F:\tmp\ui-b2.db'; $env:SERVE_WEB='1'
//        $env:SHUDONG_BOARD_DECISIONS='F:\tmp\ui-board-decisions.jsonl'   # 票写临时文件，不写真票
//        Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'src/index.ts' -WorkingDirectory F:\shudong\server
//      注意 SERVE_WEB=1 吐的是 web/dist —— 改完 web/public/progress/index.html 必须先
//        Start-Process -WindowStyle Hidden -Wait -FilePath cmd -ArgumentList '/c','pnpm --filter @shudong/web build'
//      再 node F:\shudong\tools\board.mjs 重生成 board.html（单开快照），否则这份脚本看到的还是旧页。
//
//   2) 起 headless Edge（9333）：
//        Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList `
//          '--headless=new','--remote-debugging-port=9333','--user-data-dir=F:\tmp\ui-edge-b2','--no-first-run','--disable-gpu','--window-size=1440,900','about:blank'
//
//   3) node web/check-board.mjs     （跑完把服务、Edge、8901/9333 都收掉）
//
// 可用环境变量覆盖默认路径：BOARD_CDP / BOARD_PAGE / BOARD_API / BOARD_FILE / BOARD_SHOTS / BOARD_JSONL
//
// ── 两条别踩的坑 ──────────────────────────────────────────────────────────────
//   · 快照页的拍板必须打到临时口：本脚本用 Page.addScriptToEvaluateOnNewDocument 注入 window.__BOARD_API__，
//     注入后立刻断言 D_base === API，不等就 throw 停手 —— 绝不能让票落到活着的 8787 上。
//   · 判断界面状态用 querySelectorAll/属性，别拿 placeholder 文案去比 innerText（永远假）；
//     CDP WS 一断 Emulation.setDeviceMetricsOverride 就失效、视口回落 800×600（假象）。
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
const CDP = process.env.BOARD_CDP || "http://127.0.0.1:9333";
const SHOTS = process.env.BOARD_SHOTS || "F:\\tmp\\ui-board2-shots";
const PAGE = process.env.BOARD_PAGE || "http://127.0.0.1:8901/progress/index.html";
const FILE = process.env.BOARD_FILE || "file:///F:/shudong/board.html";
const API = process.env.BOARD_API || "http://127.0.0.1:8901";
const JSONL = process.env.BOARD_JSONL || "F:\\tmp\\ui-board-decisions.jsonl";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getDecisions = async () => { try { return await fetch(API + "/api/board/decisions").then((r) => r.json()); } catch (e) { return "ERR " + e.message; } };
const out = {};

async function cdpUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(CDP + "/json/list").then((r) => r.json());
      const t = list.find((x) => x.type === "page");
      if (t) return t.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error("找不到 CDP 页面目标");
}
const ws = new WebSocket(await cdpUrl());
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
let seq = 0;
const waiters = new Map();
const pageErr = [];
let failAll = false, staleMode = false, staleBody = null;
ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.id && waiters.has(m.id)) {
    const w = waiters.get(m.id); waiters.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
    return;
  }
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") pageErr.push("log: " + m.params.entry.text);
  if (m.method === "Runtime.exceptionThrown") pageErr.push("exc: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Fetch.requestPaused") {
    // 只用来模拟"一个口子都送不出去"：一律掐掉（页面里的口子已经指到临时服务，掐它安全）
    if (staleMode && /board\.json/.test(m.params.request.url)) send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: staleBody }).catch(() => {});
    else if (failAll) send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" }).catch(() => {});
    else send("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {});
  }
});
function send(method, params) {
  return new Promise((res, rej) => { const i = ++seq; waiters.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("ev 出错: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const q = (sel, prop) => ev(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});return n?(${JSON.stringify(prop)}?n[${JSON.stringify(prop)}]:n.textContent):null})()`);
async function shot(name, fullPage) {
  const r = await send("Page.captureScreenshot", Object.assign({ format: "png" }, fullPage ? { captureBeyondViewport: true } : {}));
  writeFileSync(`${SHOTS}\\${name}.png`, Buffer.from(r.data, "base64"));
}
async function view(w, h) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(350); }
async function open(url, preScript) {
  if (preScript) await send("Page.addScriptToEvaluateOnNewDocument", { source: preScript });
  await send("Page.navigate", { url });
  await sleep(1400);
  for (let i = 0; i < 30; i++) { if (await ev("!!document.querySelector('#main .zone')")) break; await sleep(200); }
}
async function click(sel, nth = 0) {
  return ev(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(sel)})];const n=a[${nth}];if(!n)return 'missing';n.scrollIntoView({block:'center'});n.click();return 'ok'})()`);
}
const jsonlLines = () => (existsSync(JSONL) ? readFileSync(JSONL, "utf8").trim().split("\n").filter(Boolean) : []);

await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

// ── A. 1440 实时那页 ──────────────────────────────────────────
await view(1440, 900);
await open(PAGE);
out.A = await ev(`(()=>{
  const zs=[...document.querySelectorAll('#main .zone')];
  const first=document.querySelector('.first');
  const ask=first.querySelector('.zone'), now=first.querySelectorAll('.zone')[1];
  const r=(n)=>n?n.getBoundingClientRect():null;
  const g=(n,p)=>n?getComputedStyle(n)[p]:null;
  return {
    zones:zs.map(z=>z.id),
    zoneHeads:zs.map(z=>z.querySelector('h2').textContent),
    feels:{ask:document.getElementById('zb-ask')?.children.length, now:document.getElementById('zb-now')?.children.length,
      queued:document.getElementById('zb-queued')?.children.length, owed:document.getElementById('zb-owed')?.children.length,
      path:document.getElementById('zb-path')?.children.length, reports:document.getElementById('zb-reports')?.children.length,
      crew:document.getElementById('zb-crew')?.children.length},
    askQ:document.querySelector('.ask .q')?.textContent.slice(0,24),
    askQSize:g(document.querySelector('.ask .q'),'fontSize'),
    h2Size:g(document.querySelector('.zh h2'),'fontSize'),
    noteSize:g(document.querySelector('.card .note'),'fontSize'),
    noteFont:g(document.querySelector('.card .note'),'fontFamily'),
    bodyFont:g(document.body,'fontFamily'),
    freshText:document.querySelector('#freshText')?.textContent,
    updated:document.querySelector('#updated')?.textContent,
    foot:document.querySelector('#foot')?.textContent.slice(0,60),
    askColW:Math.round(r(ask).width), nowColW:Math.round(r(now).width),
    askTop:Math.round(r(ask).top), nowTop:Math.round(r(now).top),
    navLinks:[...document.querySelectorAll('#navInner a')].map(a=>a.textContent),
    wrapW:Math.round(r(document.querySelector('main')).width),
    autoCols:getComputedStyle(document.querySelector('#zb-queued')).gridTemplateColumns.split(' ').length,
    states:[...document.querySelectorAll('.state')].map(s=>s.textContent),
    pageH:document.documentElement.scrollHeight,
  };
})()`);
await shot("01-1440-fold");
await shot("01b-1440-full", true);

// 锚点能不能跳
out.A_anchor = await ev(`(()=>{const y0=scrollY;document.querySelector('#navInner a[href="#queued"]').click();const y1=scrollY;return {y0,y1,jumped:y1>y0+50}})()`);
await sleep(400);
out.A_geo = await ev("({sw:document.documentElement.scrollWidth,iw:window.innerWidth})");

// ── A1. 动效 / 微交互：入场动画、hover 抬升、reduced-motion 关掉 ──
out.A_motion = await ev(`(()=>{const z=document.querySelector('.zone'),c=document.querySelector('.card');
  const gz=getComputedStyle(z),gc=getComputedStyle(c);
  return {zoneAnim:gz.animationName+' '+gz.animationDuration+' delay '+gz.animationDelay,
    cardTransition:gc.transitionProperty+' '+gc.transitionDuration,
    focusRing:(()=>{const s=[...document.styleSheets].flatMap(x=>{try{return [...x.cssRules]}catch(e){return []}}).map(r=>r.cssText).find(t=>t.includes('focus-visible'));return s?s.slice(0,90):null})()}})()`);
await ev("window.scrollTo(0,0)");
await sleep(300);
const cardXY = await ev(`(()=>{const c=document.querySelector('.first .card');const r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+14)}})()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cardXY.x, y: cardXY.y });
await sleep(400);
out.A_hover = await ev(`(()=>{const c=document.querySelector('.first .card');return {at:${JSON.stringify(cardXY)},transform:getComputedStyle(c).transform,border:getComputedStyle(c).borderColor}})()`);
await ev("window.scrollTo(0,0)");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 400 });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await sleep(200);
out.A_reduced = await ev(`(()=>{const z=document.querySelector('.zone'),c=document.querySelector('.card');
  return {zoneAnim:getComputedStyle(z).animationDuration,cardTransition:getComputedStyle(c).transitionDuration}})()`);
await send("Emulation.setEmulatedMedia", { features: [] });

// ── A2. 真投一票（进临时票文件） ─────────────────────────────
const before = jsonlLines().length;
out.A_noteRows = await ev("document.querySelectorAll('.ask .note-in').length");
out.A_vote = await ev(`(()=>{const c=document.querySelectorAll('.ask')[1];const q=c.querySelector('.q').textContent.slice(0,18);
  const i=c.querySelector('.note-in'); i.value='走查留的备注'; i.dispatchEvent(new Event('input',{bubbles:true}));
  c.querySelector('.opt').click();return q})()`);
await sleep(1200);
out.A_mark = await q(".ask .opt[aria-pressed='true'] .mark");
out.A_note = { saved: await q(".ask .note-row .saved"), inCard2: await ev("document.querySelectorAll('.ask')[1].querySelector('.note-in').value") };
out.A_jsonl = { before, after: jsonlLines().length, last: jsonlLines().slice(-1)[0] };
out.A_server = await getDecisions();
await shot("02-1440-voted");

// ── B. 1920：吃掉宽屏 ─────────────────────────────────────────
await view(1920, 1080);
await ev("window.scrollTo(0,0)");
await sleep(400);
out.B = await ev(`(()=>{
  const main=document.querySelector('main'), r=main.getBoundingClientRect();
  const cols=getComputedStyle(document.querySelector('#zb-queued')).gridTemplateColumns.split(' ').length;
  const head=document.querySelector('.zh h2').getBoundingClientRect();
  return {mainL:Math.round(r.left),mainR:Math.round(r.right),mainW:Math.round(r.width),
    queuedCols:cols, scrollH:document.documentElement.scrollHeight, vh:innerHeight,
    sw:document.documentElement.scrollWidth, iw:innerWidth, h2Top:Math.round(head.top)};
})()`);
await shot("03-1920-fold");
await shot("03b-1920-full", true);

// ── C. 375 ───────────────────────────────────────────────────
await view(375, 812);
await ev("window.scrollTo(0,0)");
await sleep(400);
out.C = await ev(`(()=>{const a=document.querySelector('.ask');return {sw:document.documentElement.scrollWidth,iw:innerWidth,
  askVisible:!!a && a.getBoundingClientRect().width>200, askW:Math.round(a.getBoundingClientRect().width),
  navOverflow:getComputedStyle(document.querySelector('#navInner')).overflowX,
  cols:getComputedStyle(document.querySelector('#zb-queued')).gridTemplateColumns.split(' ').length}})()`);
await shot("04-375");

// ── G. 板子旧了不许装实时（拦 board.json，把时间戳换成 1 小时前）──
await view(1440, 900);
const boardReal = JSON.parse(readFileSync("F:\\shudong\\web\\public\\progress\\board.json", "utf8"));
const boardOld = Object.assign({}, boardReal, { updatedAt: "2026-10-05 01:00" });
staleBody = Buffer.from(JSON.stringify(boardOld)).toString("base64");
staleMode = true;
await send("Fetch.enable", { patterns: [{ urlPattern: "*board.json*" }] });
await send("Page.reload");
await sleep(2200);
out.G = await ev(`(()=>({fresh:document.querySelector('#freshText')?.textContent,
  stale:document.querySelector('#fresh')?.getAttribute('data-stale'),
  updated:document.querySelector('#updated')?.textContent}))()`);
await shot("09-1440-stale");
staleMode = false; await send("Fetch.disable");

// ── H. 设计标尺证据（排版/留白/层级/色彩/原创性）──
await send("Page.reload"); await sleep(2000);
out.H = await ev(`(()=>{const g=(s,p)=>{const n=document.querySelector(s);return n?getComputedStyle(n)[p]:null};
  const spine=getComputedStyle(document.querySelector('main'),'::before');
  const chisel=getComputedStyle(document.querySelector('.zh'),'::before');
  const mile=getComputedStyle(document.querySelector('.path'),'::before');
  return {wrapMax:g('main','maxWidth'), zonePadTop:g('#queued','paddingTop'), firstPadTop:g('#ask','paddingTop'),
    cardPad:g('.card','paddingTop'), cardGap:g('#zb-queued','gap'), zbCols:g('#zb-queued','gridTemplateColumns'),
    qSize:g('.ask .q','fontSize'), h2:g('.zh h2','fontSize'), cardH3:g('.card h3','fontSize'),
    meta:g('.card .meta','fontSize'), state:g('.state','fontSize'), hint:g('.zh .hint','fontSize'),
    tabular:g('.tid','fontVariantNumeric'), bodyLine:g('body','lineHeight'),
    spine:spine.width+' '+spine.backgroundImage.slice(0,34), chisel:chisel.width, mile:!!mile.width,
    accent:[...document.querySelectorAll('.who i')].slice(0,4).map(i=>getComputedStyle(i).backgroundColor),
    radiusCard:g('.card','borderRadius'), stateDoing:g(".state[data-s='doing']",'backgroundColor'), stateWait:g(".state[data-s='wait']",'color')}})()`);
// ── I. 重画不许再抖（手动 refresh(true) 后 60ms 内看有没有 opacity:0 的区）──
out.I = await ev(`(async()=>{ refresh(true); await new Promise(r=>setTimeout(r,60));
  const zs=[...document.querySelectorAll('.zone')];
  return {boot:document.querySelector('main').classList.contains('boot'),
    opacity:zs.map(z=>getComputedStyle(z).opacity), anim:zs.map(z=>getComputedStyle(z).animationName)}})()`);
// ── D. file:// 真身快照（注入 __BOARD_API__ 指到临时口，绝不碰 8787）──
await view(1440, 900);
await open(FILE, `window.__BOARD_API__=${JSON.stringify(API)};window.__NET=0;if(!window.__NETW){window.__NETW=1;var _f=window.fetch;window.fetch=function(){window.__NET++;return _f.apply(this,arguments)}};`);
// 硬保险：注入没生效就立刻停手 —— 绝不能让这一页的拍板打到活着的 8787
out.D_base = await ev("String(window.__BOARD_API__)");
if (out.D_base !== API) throw new Error("注入没生效（__BOARD_API__=" + out.D_base + "），停手，免得票打到真服务上");
out.D = await ev(`(()=>{const r=(n)=>n?n.getBoundingClientRect():null;return {
  asks:document.querySelectorAll('.ask').length,
  q:document.querySelector('.ask .q')?.textContent.slice(0,24),
  chosen:[...document.querySelectorAll('.opt[aria-pressed="true"]')].map(b=>b.querySelector('.mark')?.textContent),
  foot:document.querySelector('#foot')?.textContent.slice(0,120),
  updated:document.querySelector('#updated')?.textContent,
  fresh:document.querySelector('#freshText')?.textContent,
  net:window.__NET||0,
  sw:document.documentElement.scrollWidth,iw:innerWidth,
  mainW:Math.round(r(document.querySelector('main')).width),
  zones:document.querySelectorAll('#main .zone').length}})()`);
await shot("05-snap-1440");
await view(375, 812);
await ev("window.scrollTo(0,0)");
await shot("06-snap-375");
out.D_geo375 = await ev("({sw:document.documentElement.scrollWidth,iw:innerWidth})");

// ── E. 快照里真投一票（file:// 跨源，服务端已开 CORS + Origin 白名单 ⇒ 要有真回执）──
await view(1440, 900);
const eBefore = jsonlLines().length;
out.E_click = await click(".ask .opt", 0);
await sleep(5200);   // 失败的话要等它把 3 次重试走完（400+900+2000ms）
out.E = { mark: await q(".opt[aria-pressed='true'] .mark"), failBox: await q(".vote-fail .msg"),
  jsonl: { before: eBefore, after: jsonlLines().length, last: jsonlLines().slice(-1)[0] } };
out.E_server = await getDecisions();
await shot("07-snap-voted");

// ── F1. 服务端"没起来"时点拍板：重试 3 次后必须诚实说 + 给「再送一次」──
failAll = true;
await send("Fetch.enable", { patterns: [{ urlPattern: "*board/decision*" }] });
const fBefore = jsonlLines().length;
out.F_click = await click(".ask .opt", 1);
await sleep(5600);
out.F = await ev(`(()=>{const f=document.querySelector('.vote-fail');const t=document.body.innerText;
  return {msg:f?.querySelector('.msg')?.textContent, rawFailedFetch:/Failed to fetch|NetworkError/i.test(t),
    buttons:f?[...f.querySelectorAll('button')].map(b=>b.textContent):[],
    code:f?.querySelector('code')?.textContent, jsonlBefore:${fBefore}}})()`);

// ── F2. 服务端回来了，点「再送一次」：票必须真落地 ──
failAll = false;
await send("Fetch.disable");
out.F_retry_click = await click(".vote-fail button", 0);
await sleep(2000);
out.F_after = { mark: await q(".opt[aria-pressed='true'] .mark"), failBox: await q(".vote-fail .msg"),
  jsonl: { before: out.F.jsonlBefore, after: jsonlLines().length, last: jsonlLines().slice(-1)[0] } };
await shot("10-1440-retry-ok");
await send("Fetch.disable"); failAll = false;
await shot("08-snap-fail");

// ── J. P0：快照页刷新一次，「已拍板」不许丢（refresh 的 snap 分支要问一次真票）──
await view(1440, 900);
await open(FILE);                      // 重开 = 刷新（注入脚本还在）
out.J_base = await ev("String(window.__BOARD_API__)");
out.J = await ev(`(()=>{const b=document.querySelector('.ask .opt[aria-pressed="true"]');
  return {marks:document.querySelectorAll('.ask .opt .mark').length,
    chosen:[...document.querySelectorAll('.ask .opt[aria-pressed="true"] .mark')].map(m=>m.textContent),
    noteRows:document.querySelectorAll('.ask .note-in').length,
    saved:[...document.querySelectorAll('.ask .note-row .saved')].map(s=>s.textContent)}})()`);
await shot("11-snap-reload");

// ── K. 收尾三条：①「谁在干」任何宽度都不许一行只剩一张窄卡 ②右栏竖脊只在真两栏（≥1024）时生 ──
async function crewProbe(w, h) {
  await view(w, h || 900);
  await open(PAGE);
  return await ev(`(()=>{const body=document.querySelector('.crew-body');
    const cards=body?[...body.querySelectorAll(':scope > .card')]:[];
    const cards2=[...document.querySelectorAll('.first > .zone')[1]?.querySelectorAll('.card')||[]];
    const groups={};cards.forEach(c=>{const t=Math.round(c.getBoundingClientRect().top);(groups[t]=groups[t]||[]).push(c)});
    const rows=Object.values(groups).map(g=>g.length);
    const bodyW=Math.round(body.getBoundingClientRect().width);
    const loneNarrow=Object.values(groups).filter(g=>g.length===1).filter(g=>Math.round(g[0].getBoundingClientRect().width)<bodyW-2).length;
    const z2=document.querySelectorAll('.first > .zone')[1];
    return {w:innerWidth,display:getComputedStyle(body).display,cards:cards.length,rows:rows,
      loneNarrow:loneNarrow,bodyW:bodyW,firstCardW:cards.length?Math.round(cards[0].getBoundingClientRect().width):null,
      rightZoneCards:cards2.length,
      spineMain:getComputedStyle(document.querySelector('#main'),'::before').content,
      spineRight:z2?getComputedStyle(z2,'::before').content:null,
      zone2PadLeft:z2?getComputedStyle(z2).paddingLeft:null,
      sw:document.documentElement.scrollWidth,iw:innerWidth}})()`);
}
out.K = [];
for (const w of [1920, 1440, 1200, 1024, 768, 640, 375]) out.K.push(await crewProbe(w));
await view(1440, 900); await open(PAGE); await shot("12-1440-crew");
await view(1920, 1080); await open(PAGE); await shot("13-1920-crew");
await view(375, 812); await open(PAGE); await shot("14-375-crew");
await shot("14b-375-crew-full", true);

/* ══ L~Q. task-24：「要你定的事」专属一屏（hash #asks）═════════════════════════════
   板子上必须一眼看到入口；进去只有要他拍板/动手的事，返回也一眼能回；
   三种卡（vote / checklist / text）都要真能用；提交走同一个 POST /api/board/decision（不新开后端）；
   重开页面要记得他投过什么；file:// 单开快照那版也要能用（不许新开 HTML 页面）。 */
const SNAP_PRE = `window.__BOARD_API__=${JSON.stringify(API)};window.__NET=0;if(!window.__NETW){window.__NETW=1;var _f=window.fetch;window.fetch=function(){window.__NET++;return _f.apply(this,arguments)}};`;
const ASKS_MEASURE = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d');
  const rgb = (css) => { cx.clearRect(0,0,1,1); cx.fillStyle = css; cx.fillRect(0,0,1,1);
    const d = cx.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255]; };
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
  const ratio = (a,b) => { const x = L(a), y = L(b); const hi = Math.max(x,y), lo = Math.min(x,y);
    return Math.round(((hi+0.05)/(lo+0.05))*100)/100; };
  const hex = (c) => '#' + [c[0]||0,c[1]||0,c[2]||0].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
  const bgOf = (el) => { let n = el; while (n) { const c = rgb(getComputedStyle(n).backgroundColor); if (c[3] > 0.9) return c; n = n.parentElement; } return [14,16,20,1]; };
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
  const txtOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.tagName).trim().replace(/\\s+/g,' ').slice(0,18);
  const all = [...document.querySelectorAll('body *')].filter(e => e.offsetParent !== null);
  const sizes = {};
  for (const el of all) { if (!el.innerText || !el.innerText.trim() || el.children.length) continue;
    const s = getComputedStyle(el).fontSize; sizes[s] = (sizes[s]||0)+1; }
  const pairs = new Map();
  for (const el of all) {
    const hidden = el.closest('[aria-hidden="true"]') !== null;
    const txt = el.children.length ? '' : (el.innerText||'').trim();
    const ph = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.placeholder||'') : '';
    if (!txt && !ph) continue;
    const color = ph && !txt ? getComputedStyle(el,'::placeholder').color : getComputedStyle(el).color;
    const c0 = rgb(color); if (c0[3] < 0.05) continue;   // 全透明的勾号：颜色来自状态，不算文字
    const bg = bgOf(el), c = rgb(color), r = ratio(c,bg);
    const key = hex(c) + ' on ' + hex(bg);
    const p = pairs.get(key) || { key, ratio: r, n: 0, decorative: hidden, font: getComputedStyle(el).fontSize, sample: (txt||ph).slice(0,16) };
    p.n++; p.decorative = p.decorative && hidden; pairs.set(key,p);
  }
  const contrast = [...pairs.values()].sort((a,b)=>a.ratio-b.ratio);
  const areas = [];
  for (const el of all) {
    if (!el.matches('button, a[href], input, textarea, select, [role="button"], label')) continue;
    if (el.classList.contains('sr-only')) continue;
    const b = box(el); if (b.w < 1 || b.h < 1) continue;
    areas.push({ label: txtOf(el), ...b, ok: b.w >= 24 && b.h >= 24, cls: (typeof el.className === 'string' ? el.className : '').slice(0,40) });
  }
  const gate = document.getElementById('gate'); const gb = gate ? box(gate) : null;
  return { sizes, contrast, areas, smallTargets: areas.filter(a=>!a.ok).map(a=>a.label+' '+a.w+'x'+a.h),
    gate: gate ? { text: document.getElementById('gateText')?.textContent, n: document.getElementById('gateN')?.textContent, w: gb.w, h: gb.h, ok: gb.w >= 24 && gb.h >= 24 } : null,
    askN: document.querySelector('#asks .n')?.textContent,
    cards: document.querySelectorAll('#asks .ask').length,
    chosen: [...document.querySelectorAll('.item[aria-pressed="true"] .by')].map(x=>x.textContent),
    sent: [...document.querySelectorAll('.sent')].map(x=>x.textContent).filter(Boolean),
    sw: document.documentElement.scrollWidth, iw: innerWidth, docH: document.documentElement.scrollHeight };
})()`;

// ── L. 入口一眼能看到；点它进专属屏 ──
await view(1440, 900);
await open(PAGE);
out.L_board = await ev(`(()=>{const g=document.getElementById('gate');const b=g?g.getBoundingClientRect():null;
  return {hidden:!!(g&&g.hidden),text:document.getElementById('gateText')?.textContent,n:document.getElementById('gateN')?.textContent,
    w:b?Math.round(b.width):0,h:b?Math.round(b.height):0,navShown:!document.getElementById('nav')?.hidden,
    zones:document.querySelectorAll('#main .zone').length,
    askCards:document.querySelectorAll('#zb-ask .ask').length,pointerRows:document.querySelectorAll('#zb-ask .more-asks').length,
    askN:document.querySelector('#ask .n')?.textContent,navAsk:document.querySelector('#navInner a[href="#ask"]')?.textContent,
    hint:document.querySelector('#ask .zh .hint')?.textContent}})()`);
await shot("20-1440-board-gate");
out.L_click = await click("#gate", 0);
await sleep(700);
out.L_asks = await ev(`(()=>({hash:location.hash,navHidden:!!document.getElementById('nav')?.hidden,
  bodyCls:document.body.className,gateText:document.getElementById('gateText')?.textContent,
  askZone:!!document.getElementById('asks'),zoneCount:document.querySelectorAll('#main .zone').length,
  n:document.querySelector('#asks .n')?.textContent,cards:document.querySelectorAll('#asks .ask').length,
  voteCards:document.querySelectorAll('#asks .ask[data-ask="d1"],#asks .ask[data-ask="d3"],#asks .ask[data-ask="d4"],#asks .ask[data-ask="d5"]').length,
  groups:document.querySelectorAll('#asks .grp').length,items:document.querySelectorAll('#asks .item').length,
  texts:document.querySelectorAll('#asks textarea').length,
  qs:[...document.querySelectorAll('#asks .ask .q')].map(q=>q.textContent.slice(0,16)),
  sw:document.documentElement.scrollWidth,iw:innerWidth}))()`);
await shot("21-1440-asks-fold");
await shot("21b-1440-asks-full", true);

// ── L2. 票面可选字段 image：选项上方那张图真渲染出来了（四档不横滚算在 P 里，file:// 算在 O 里）──
out.L_wantFigs = await ev(`(()=>{const d=(window.__BOARD__||lastPayload||{});const a=Array.isArray(d.asks)?d.asks:(d.waitingOnYou||[]);
  return a.filter(x=>x&&x.image).length})()`);
out.L_askFigs = await ev("document.querySelectorAll('#asks .ask-fig').length");
out.L_img = await ev(`(()=>{const i=document.querySelector('#asks .ask-fig img');if(!i)return{present:false};
  const r=i.getBoundingClientRect();
  return {present:true,ask:i.closest('.ask')?.dataset.ask,srcHead:String(i.getAttribute('src')).slice(0,20),
    isData:String(i.getAttribute('src')).startsWith('data:'),alt:i.getAttribute('alt'),
    natW:i.naturalWidth,natH:i.naturalHeight,w:Math.round(r.width),h:Math.round(r.height),
    maxH:getComputedStyle(i).maxHeight,fits:r.width<=innerWidth+1,sw:document.documentElement.scrollWidth,iw:innerWidth}})()`);
await shot("30-1440-ask-image");

// ── M. checklist 卡真用：勾 2 条 + 一句话，必须落盘 ──
const mBefore = jsonlLines().length;
out.M_pick = await ev(`(()=>{const c=document.querySelector('#asks .ask[data-ask="review-24"]');
  const it=[...c.querySelectorAll('.item')];
  it.find(x=>x.dataset.i==='3')?.click(); it.find(x=>x.dataset.i==='7')?.click();
  c.querySelector('.note-in').value='这两条读起来像模板话（第 3、第 7 条）';
  return {items:it.length,groups:c.querySelectorAll('.grp').length,pressed:c.querySelectorAll('.item[aria-pressed="true"]').length,
    picked:c.querySelector('.picked')?.textContent,sendText:c.querySelector('.send')?.textContent}})()`);
out.M_send = await click('#asks .ask[data-ask="review-24"] .send', 0);
await sleep(5400);
out.M = await ev(`(()=>{const c=document.querySelector('#asks .ask[data-ask="review-24"]');
  return {sent:c?.querySelector('.sent')?.textContent||null,fail:c?.querySelector('.vote-fail .msg')?.textContent||null,
    pressed:c?.querySelectorAll('.item[aria-pressed="true"]').length,
    by:[...c.querySelectorAll('.item[aria-pressed="true"] .by')].map(x=>x.textContent),
    meta:c?.querySelector('.meta .done')?.textContent||null,note:c?.querySelector('.note-in')?.value}})()`);
out.M_jsonl = { before: mBefore, after: jsonlLines().length, last: jsonlLines().slice(-1)[0] };
await shot("22-1440-checklist-sent");

// ── T. text 卡真用：写一段，必须落盘 ──
const tBefore = jsonlLines().length;
out.T_type = await ev(`(()=>{const c=document.querySelector('#asks .ask[data-ask="say-free"]');
  const ta=c.querySelector('textarea'); ta.value='先别排第二轮：把窄屏那两处母题补上再说';
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  return {count:c.querySelector('.picked')?.textContent,sendDisabled:!!c.querySelector('.send')?.disabled}})()`);
out.T_send = await click('#asks .ask[data-ask="say-free"] .send', 0);
await sleep(5400);
out.T = await ev(`(()=>{const c=document.querySelector('#asks .ask[data-ask="say-free"]');
  return {sent:c?.querySelector('.sent')?.textContent||null,fail:c?.querySelector('.vote-fail .msg')?.textContent||null,
    ta:c?.querySelector('textarea')?.value,meta:c?.querySelector('.meta .done')?.textContent||null}})()`);
out.T_jsonl = { before: tBefore, after: jsonlLines().length, last: jsonlLines().slice(-1)[0] };
await shot("23-1440-text-sent");

// ── U. 专属屏上送不出去时：也要说人话 + 给复制行（页面内不许出现裸的 "Failed to fetch"）──
failAll = true;
await send("Fetch.enable", { patterns: [{ urlPattern: "*board/decision*" }] });
out.U_click = await click('#asks .ask[data-ask="say-free"] .send', 0);
await sleep(5600);
out.U = await ev(`(()=>{const f=document.querySelector('#asks .ask[data-ask="say-free"] .vote-fail');
  const t=document.body.innerText;
  return {msg:f?.querySelector('.msg')?.textContent||null, rawFailedFetch:/Failed to fetch|NetworkError/i.test(t),
    copy:f?.querySelector('code')?.textContent||null,
    buttons:f?[...f.querySelectorAll('button')].map(b=>b.textContent):[], jsonlBefore:${jsonlLines().length}}})()`);
await shot("23b-1440-asks-sendfail");
failAll = false;
await send("Fetch.disable");
out.U_jsonl = { before: out.U.jsonlBefore, after: jsonlLines().length };

// ── N. 重开页面：他投过的必须还在（读 GET /api/board/decisions + 板子自己那一行）──
await open(PAGE + "#asks");
out.N = await ev(`(()=>{const c=document.querySelector('#asks .ask[data-ask="review-24"]');
  const t=document.querySelector('#asks .ask[data-ask="say-free"]');
  return {hash:location.hash,cards:document.querySelectorAll('#asks .ask').length,
    pressed:c?c.querySelectorAll('.item[aria-pressed="true"]').length:null,
    by:c?[...c.querySelectorAll('.item[aria-pressed="true"] .by')].map(x=>x.textContent):null,
    sent:[...document.querySelectorAll('.sent')].map(x=>x.textContent).filter(Boolean),
    meta:[...document.querySelectorAll('#asks .meta .done')].map(x=>x.textContent).slice(0,2),
    note:(c&&c.querySelector('.note-in').value)||null,ta:(t&&t.querySelector('textarea').value)||null,
    gateN:document.getElementById('gateN')?.textContent,gateText:document.getElementById('gateText')?.textContent,
    navHidden:!!document.getElementById('nav')?.hidden}})()`);
out.N_decisions = await getDecisions();
await shot("24-1440-asks-reload");

// ── O. file:// 单开快照那一版：入口 + 专属屏都得能用（且只能打到临时口）──
await view(1440, 900);
await open(FILE + "#asks", SNAP_PRE);
out.O_base = await ev("String(window.__BOARD_API__)");
out.O_img = await ev(`(()=>{const i=document.querySelector('.ask-fig img');if(!i)return{present:false};
  const s=String(i.getAttribute('src')),r=i.getBoundingClientRect();
  i.scrollIntoView({block:'center'});
  return {present:true,isData:s.startsWith('data:'),mime:s.slice(5,16),natW:i.naturalWidth,natH:i.naturalHeight,
    w:Math.round(r.width),h:Math.round(r.height),fits:r.width<=innerWidth+1,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
await shot("31-file-ask-image");
if (out.O_base !== API) throw new Error("注入没生效（__BOARD_API__=" + out.O_base + "），停手，免得票打到真服务上");
out.O = await ev(`(()=>({hash:location.hash,cards:document.querySelectorAll('.ask').length,
  navHidden:!!document.getElementById('nav')?.hidden,gateText:document.getElementById('gateText')?.textContent,
  gateN:document.getElementById('gateN')?.textContent,askN:document.querySelector('#asks .n')?.textContent,
  items:document.querySelectorAll('.item').length,texts:document.querySelectorAll('textarea').length,
  fresh:document.getElementById('freshText')?.textContent,net:window.__NET||0,
  sw:document.documentElement.scrollWidth,iw:innerWidth}))()`);
await shot("25-snap-asks");
const oBefore = jsonlLines().length;
out.O_click = await click('.ask[data-ask="d3"] .opt', 0);
await sleep(5400);
out.O_after = await ev(`(()=>{const c=document.querySelector('.ask[data-ask="d3"]');
  return {mark:c?.querySelector('.opt[aria-pressed="true"] .mark')?.textContent||null,
    fail:c?.querySelector('.vote-fail .msg')?.textContent||null,
    sent:c?.querySelector('.sent')?.textContent||null}})()`);
out.O_jsonl = { before: oBefore, after: jsonlLines().length, last: jsonlLines().slice(-1)[0] };
await shot("25b-snap-asks-voted");

// ── P. 四档宽度：不横滚、可点 ≥24×24、文字 ≥4.5:1 ──
out.P = [];
for (const [w, h] of [[1440, 900], [1024, 768], [768, 900], [375, 812]]) {
  await view(w, h);
  await open(PAGE + "#asks");
  await sleep(1300);   // 等 5 秒轮询那一帧画稳，别量到切换中的中间态
  const m = await ev(ASKS_MEASURE);
  out.P.push({ w, sw: m.sw, iw: m.iw, docH: m.docH, cards: m.cards, gate: m.gate,
    smallTargets: m.smallTargets, sizes: m.sizes,
    worstContrast: m.contrast.filter((c) => !c.decorative).slice(0, 6) });
}
await view(375, 812); await open(PAGE + "#asks");
await shot("26-375-asks-fold");
await shot("26b-375-asks-full", true);

// ── Q. 不许回退：板子上原来能看的一条都不能少 ──
await view(1440, 900);
await open(PAGE);
out.Q = await ev(`(()=>{const n=(s)=>document.querySelectorAll(s).length;const t=(s)=>document.querySelector(s)?.textContent;
  return {zones:[...document.querySelectorAll('#main .zone')].map(z=>z.id).join(','),
    zoneN:[...document.querySelectorAll('#main .zone')].map(z=>z.querySelector('.n')?.textContent).join(','),
    askCards:n('#zb-ask .ask'),pointerRows:n('#zb-ask .more-asks'),
    now:n('#zb-now > *'),queued:n('#zb-queued > *'),owed:n('#zb-owed > *'),
    path:n('#zb-path > *'),reports:n('#zb-reports > *'),crew:n('#zb-crew > *'),
    navShown:!document.getElementById('nav')?.hidden,
    nav:[...document.querySelectorAll('#navInner a')].map(a=>a.textContent).join('|'),
    gateN:t('#gateN'),updated:t('#updated'),fresh:t('#freshText')}})()`);
out.Q_geo = await ev("({sw:document.documentElement.scrollWidth,iw:innerWidth})");
await shot("27-1440-board-after");

out.pageErr = pageErr;

// ── 判定层：照验收口径过一遍（violations 空数组 = 全过；BOARD_STRICT=1 时非空则退出码 1）──
const violations = [];
const errs = (pageErr || []).filter((e) => !String(e).endsWith("net::ERR_FAILED"));
if (errs.length) violations.push("控制台报错: " + errs.join(" | "));
for (const p of out.P || []) {
  if (p.sw > p.iw) violations.push(`宽度 ${p.w} 横滚: sw=${p.sw} > iw=${p.iw}`);
  if (p.smallTargets && p.smallTargets.length) violations.push(`宽度 ${p.w} 有可点元件 <24×24: ` + JSON.stringify(p.smallTargets));
  for (const c of p.worstContrast || []) {
    if (!c.decorative && c.ratio < 4.5) violations.push(`宽度 ${p.w} 文字对比度 ${c.ratio}:1（${c.key}）`);
  }
}
if (!out.L_asks || !out.L_asks.askZone || out.L_asks.navHidden !== true || out.L_asks.hash !== "#asks") {
  violations.push("没进「要你定的事」专属屏（该有 #asks、该藏 nav、hash 该是 #asks）: " + JSON.stringify(out.L_asks));
}
for (const [k, v] of [["勾选卡落盘", out.M_jsonl], ["写字卡落盘", out.T_jsonl], ["快照投票落盘", out.O_jsonl]]) {
  if (!v || !(v.after > v.before) || !String(v.last || "").includes('"at"')) violations.push(k + " 没落地: " + JSON.stringify(v));
}
if (!out.M || !out.M.sent) violations.push("勾选卡提交后没给「已送到」回执");
if (!out.U || out.U.rawFailedFetch !== false) violations.push("送不出去时露出了裸的 Failed to fetch");
const wantFigs = out.L_wantFigs || 0;
if ((out.L_askFigs || 0) !== wantFigs) violations.push(`票面里带 image 的 ${wantFigs} 个，却渲染了 ${out.L_askFigs} 块图`);
if (wantFigs > 0) {
  const img = out.L_img || {};
  if (!img.present) violations.push("票面里的 image 没渲染出图（选项上方那块）");
  else {
    if (!(img.natW > 0)) violations.push("图没加载出来（naturalWidth=0）: " + img.srcHead);
    if (img.isData) violations.push("http 那版的图不该是 data URI: " + img.srcHead);
    if (!img.fits || img.sw > img.iw) violations.push(`图把页面撑横滚了: w=${img.w} iw=${img.iw} sw=${img.sw}`);
    if (!/px$/.test(String(img.maxH))) violations.push("图没吃到 max-height（长图会把选项挤没）: " + img.maxH);
  }
  const oi = out.O_img || {};
  if (!oi.present) violations.push("file:// 单文件版没显示 image");
  else if (!oi.isData) violations.push("file:// 单文件版的图不是内联 data URI（双击打开会裂）");
  else if (!(oi.natW > 0)) violations.push("file:// 单文件版的图没加载出来");
}
if (out.O_base !== API) violations.push(`快照页打到的不是临时口: ${out.O_base} ≠ ${API}`);
out.violations = violations;
console.log(JSON.stringify(out, null, 2));
console.log(violations.length ? `violations: ${violations.length} 条` : "violations: []（全过）");
for (const v of violations) console.log("  - " + v);
ws.close();
if (process.env.BOARD_STRICT === "1" && violations.length) process.exit(1);
