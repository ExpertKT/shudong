// 取一批「当下真人」的语料：B站热榜标题 + 1~4 个视频的弹幕。一次性、低频，**不是爬虫**（单次运行 ≤20 次导航、每次间隔 ≥2.5 秒）。
//
// ── 为什么必须走真浏览器会话（踩过的坑，别再试）────────────────────────────────
//   · node 内置 fetch 打 B站 api 直接被风控：{"code":-352}；
//   · 裸 curl 只有「第一次」能过，同一 URL 连打立刻 -352；
//   · 带 buvid3 也没用 —— 风控看的是 TLS/JS 指纹 + 浏览器攒下的 cookie，所以借真浏览器的网络栈。
//   做法：headless Edge + CDP，**直接导航到接口地址**读浏览器渲染出来的正文：
//     JSON 接口 → Chrome 把正文放进 <body><pre>，读 document.body.innerText；
//     弹幕 XML  → XML 文档没有 body，读 document.documentElement 里的 <d> 节点。
//   这样不碰 CORS（不用在页面里发 fetch），也天然带着浏览器自己的 cookie。
//
// ── 怎么跑 ───────────────────────────────────────────────────────────────────
//   1) 起 headless Edge（9334，别用别的 profile，跑完关掉）：
//        Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList `
//          '--headless=new','--remote-debugging-port=9334','--user-data-dir=F:\tmp\corpus-edge','--no-first-run','--disable-gpu','about:blank'
//   2) node F:\shudong\tools\fetch-corpus.mjs        # 环境变量可覆盖：CDP / OUT / DATE / TAG / RIDS
//   3) 关掉 Edge 与 9334；把 stdout 的 JSON 摘要抄进 corpus\README.txt（条数、失败、删了什么）
//
//   第一批（全站热榜 + 前 2 个视频）：不设 RIDS。
//   第二批（换 tname、加广度）：RIDS=<分区 id 逗号分隔> TAG=-b
//     例：$env:RIDS='4,138,160,211'; $env:TAG='-b'; node F:\shudong\tools\fetch-corpus.mjs
//     分区 id：4=游戏 138=搞笑 160=生活 211=美食 217=动物圈 119=鬼畜 36=科技 188=数码
//     给了 RIDS 就每个分区各取一份榜单、每个分区挑**第一名**当视频 ⇒ tname 天然不同，文件也带 TAG 后缀（不覆盖上一批）。
//
// 纪律：被风控（-352 / 空响应 / 验证码）立即停手并把失败写进 README；宁可少取，不许编。
import { writeFileSync, mkdirSync } from "node:fs";

const CDP = process.env.CDP || "http://127.0.0.1:9334";
const OUT = process.env.OUT || "F:\\shudong\\corpus";
// 用「本地日期」命名（第一次踩过：toISOString() 是 UTC，本地凌晨 04:5x 会写成前一天）
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DATE = process.env.DATE || localDay();
const TAG = process.env.TAG || "";     // 同一天再跑一批时给文件名加后缀，别覆盖上一批
const RIDS = (process.env.RIDS || "").split(",").map((s) => s.trim()).filter(Boolean);  // 只取这些分区的榜（用来换 tname）
const MIN_GAP_MS = 2500;   // 每次导航之间的最小间隔
const MAX_NAV = 20;        // 单次运行的总导航上限
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const note = (s) => { log.push(s); console.error("[corpus] " + s); };

// ── CDP ─────────────────────────────────────────────────────────────────────
async function cdpUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(CDP + "/json/list").then((r) => r.json());
      const t = list.find((x) => x.type === "page");
      if (t) return t.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error("找不到 CDP 页面目标（Edge 起来了吗？端口 " + CDP + "）");
}
const ws = new WebSocket(await cdpUrl());
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
let seq = 0;
const waiters = new Map();
ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.id && waiters.has(m.id)) {
    const w = waiters.get(m.id); waiters.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
  }
});
const send = (method, params) => new Promise((res, rej) => { const i = ++seq; waiters.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面里出错: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

// ── 低频导航（唯一的上网动作）───────────────────────────────────────────────
let navCount = 0, lastNav = 0;
const steps = [];
async function visit(url, { kind = "text", label = "" } = {}) {
  if (navCount >= MAX_NAV) { note(`已到上限 ${MAX_NAV} 次导航，停手`); return { ok: false, why: "到达导航上限" }; }
  const wait = MIN_GAP_MS - (Date.now() - lastNav);
  if (wait > 0) await sleep(wait);
  navCount++; lastNav = Date.now();
  const t0 = new Date().toISOString();
  await send("Page.navigate", { url });
  let body = null;
  for (let i = 0; i < 40; i++) {          // 最多等 ~8 秒
    await sleep(200);
    body = await ev(kind === "xml"
      ? "document.documentElement && document.documentElement.tagName==='parsererror' ? '' : (document.querySelectorAll('d').length ? 'XML' : '')"
      : "(document.body && document.body.innerText) || ''");
    if (body) break;
  }
  const rec = { label: label || url, url, at: t0, ok: !!body };
  steps.push(rec);
  if (!body) note(`空响应：${url}`);
  return { ok: !!body, url, kind };
}

// ── 1. 先正经访问一次站，让它自己发 cookie ──────────────────────────────────
await visit("https://www.bilibili.com/", { label: "warmup 首页" });
const dom = await ev("document.title + ' | ' + document.body.innerText.slice(0,60).replace(/\\s+/g,' ')");
note("首页标题：" + dom);

// ── 2. 榜单：RIDS 给了就按分区各取一份（换 tname），否则取全站热榜 ──────────
async function apiJson(url, label) {
  const r = await visit(url, { label });
  if (!r.ok) return null;
  const txt = await ev("document.body.innerText");
  try { return JSON.parse(txt); } catch (e) { note(`${label} 不是 JSON（前 80 字：${txt.slice(0, 80).replace(/\s+/g, " ")}）`); return null; }
}
const listOf = (r) => (r && r.code === 0 && r.data && (r.data.list || r.data.result)) || [];
const rankSets = [];
for (const rid of (RIDS.length ? RIDS : ["0"])) {
  const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`;
  const r = await apiJson(url, RIDS.length ? `分区榜 rid=${rid}` : "热榜 ranking/v2");
  const list = listOf(r);
  note(`rid=${rid} 榜单 ${list.length} 条${r && r.code !== 0 ? `（code=${r && r.code}）` : ""}`);
  rankSets.push({ rid, list, source: url, code: r && r.code });
}
if (!rankSets.some((s) => s.list.length)) {
  note("榜单全空（风控？），退到 x/web-interface/popular");
  const url = "https://api.bilibili.com/x/web-interface/popular?ps=100&pn=1";
  const pop = await apiJson(url, "热门 popular");
  rankSets.length = 0;
  rankSets.push({ rid: "popular", list: listOf(pop), source: url, code: pop && pop.code });
}
const rankSource = rankSets.map((s) => s.source).join(" + ");
const rankCode = rankSets[0].code;
const rawList = rankSets.flatMap((s) => s.list);
note(`榜单条目合计 ${rawList.length} 条（${rankSets.length} 个来源）`);

// ── 3. 挑视频拿 cid，再取弹幕（给了 RIDS：每个分区第一名；否则全站前 2 条）──
const picks = (RIDS.length
  ? rankSets.map((s) => s.list.find((v) => v && v.bvid))
  : rawList.filter((v) => v && v.bvid).slice(0, 2)
).filter(Boolean).filter((v, i, a) => a.findIndex((x) => x.bvid === v.bvid) === i);
const danmaku = [];
const videoInfo = [];
for (const v of picks) {
  const view = await apiJson("https://api.bilibili.com/x/web-interface/view?bvid=" + v.bvid, "view " + v.bvid);
  const cid = view && view.code === 0 && view.data && view.data.cid;
  const title = (view && view.data && view.data.title) || v.title || "";
  videoInfo.push({ bvid: v.bvid, tname: v.tname || null, title, cid: cid || null });
  if (!cid) { note(`${v.bvid} 没拿到 cid，跳过弹幕`); continue; }
  const r = await visit(`https://comment.bilibili.com/${cid}.xml`, { kind: "xml", label: "弹幕 " + cid });
  if (!r.ok) { note(`${cid} 弹幕空响应/被挡`); continue; }
  const lines = await ev("[...document.querySelectorAll('d')].map(d=>d.textContent)");
  note(`${cid}（${title.slice(0, 24)}）弹幕 ${lines.length} 条`);
  for (const t of lines) danmaku.push(t);
}

// ── 4. 过滤（每一步都记数，README 要如实写）────────────────────────────────
const spam = /(https?:\/\/|加群|群号|扫码|公众号|加微信|QQ群|私信我|代练|出售|下载|广告|返利)/;
const counts = { titlesRaw: rawList.length, titlesKept: 0, titlesDup: 0, titlesEmpty: 0,
  danmakuRaw: danmaku.length, danmakuKept: 0, danmakuDup: 0, danmakuSpam: 0, danmakuLong: 0, danmakuRepeat: 0 };
const seenT = new Set();
const titles = [];
for (const v of rawList) {
  const t = String((v && (v.title || v.name)) || "").trim();
  if (!t) { counts.titlesEmpty++; continue; }
  if (seenT.has(t)) { counts.titlesDup++; continue; }
  seenT.add(t); titles.push(t);
}
counts.titlesKept = titles.length;
const seenD = new Set();
const kept = [];
for (const raw of danmaku) {
  const t = String(raw || "").replace(/[\u0000-\u001f]/g, "").trim();
  if (!t) continue;
  if (t.length > 60) { counts.danmakuLong++; continue; }
  if (spam.test(t)) { counts.danmakuSpam++; continue; }
  if (/^(.)\1{7,}$/.test(t)) { counts.danmakuRepeat++; continue; }   // 一个字重复 8 次以上
  if (seenD.has(t)) { counts.danmakuDup++; continue; }
  seenD.add(t); kept.push(t);
}
counts.danmakuKept = kept.length;

const hotFile = `${OUT}\\bili-hot-${DATE}${TAG}.txt`;
const danFile = `${OUT}\\bili-danmaku-${DATE}${TAG}.txt`;
const logFile = `${OUT}\\fetch-log-${DATE}${TAG}.txt`;
writeFileSync(hotFile, titles.join("\n") + "\n", "utf8");
writeFileSync(danFile, kept.join("\n") + "\n", "utf8");
const summary = { date: DATE, tag: TAG, rids: RIDS, at: new Date().toISOString(), cdp: CDP, navCount, maxNav: MAX_NAV, minGapMs: MIN_GAP_MS,
  rankSource, rankCode, videos: videoInfo, counts, steps, files: { hot: hotFile, danmaku: danFile, log: logFile },
  log };
writeFileSync(logFile, JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
ws.close();
