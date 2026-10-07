// 监工台：一条命令把 tools/board-content.json（人手写的真源）变成
//   ① web/public/progress/board.json（网页版读的数据，updatedAt 由本脚本填真实钟点）
//   ② F:\shudong\board.html（内联同一份数据的独立快照，述洞/5173 挂着时也能双击看）
// 为什么要有 ① 这一步：以前 board.json 是 Lead 用一次性脚本手改的，出过"时间戳硬写成假值"的事故。
// 现在人手只改 board-content.json，时间戳一律由这里用真实钟点填，改完跑一次这个脚本就够。
//
// 用法：node F:\shudong\tools\board.mjs （workdir 任意）
//
// 页面本来只认 `fetch('board.json')`，而 file:// 下浏览器不许读本地文件；
// 所以这里除了内联数据，还把一个**只截 board.json 的 fetch 垫片**塞在前面：
// 页面照原样写它的 fetch，快照文件里也能出数据。等 ui 落地了页面自己的
// `window.__BOARD__` 回退，这个垫片就是冗余的（不冲突），到时候可以删掉。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'F:/shudong';
// 路径都能用环境变量改：走查要拿一份临时板子验 image 内联，不许动 Lead 的真源
const P = (k, d) => process.env[k] || d;
const PUB = P('BOARD_PUBLIC', `${ROOT}/web/public/progress`); // 页面同目录：票面 image 的相对路径就在这儿
const CONTENT = P('BOARD_CONTENT', `${ROOT}/tools/board-content.json`); // 人手写的真源
const DATA = P('BOARD_DATA', `${ROOT}/web/public/progress/board.json`); // 生成的
const PAGE = P('BOARD_PAGE', `${ROOT}/web/public/progress/index.html`);
const OUT = P('BOARD_OUT', `${ROOT}/board.html`);
const MARKER = '</body>'; // 垫片插在 body 末尾：classic script 先于 deferred module 执行

// ---------------------------------------------------------------------------
// 1) 读真源 + 自检（缺了就在生成前炸掉，别等页面白屏）
// 校验口径 = 页面对数据的**真实契约**（index.html:532-694 用到的键），不是"看起来该有"的键：
// title/goal 直接 textContent；updatedAt 缺了页面显示"（没写时间）"；subtitle/sections 页面没读，
// 只当元数据（sections 里是新板子的中文分组标题，留给以后用）。
// ---------------------------------------------------------------------------
const content = JSON.parse(readFileSync(CONTENT, 'utf8'));
const STRINGS = ['title', 'goal'];
const LISTS = {
  waitingOnYou: ['id'],
  owed: ['q'],
  now: ['id', 'title', 'owner'],
  queued: ['id', 'title', 'owner'],
  done: ['id', 'title', 'owner'],
  milestones: ['title'],
  crew: ['name', 'role', 'scope'],
  reports: ['at', 'text'],
  asks: ['id', 'q'],
};
const bad = [];
for (const k of STRINGS) if (typeof content[k] !== 'string' || !content[k].trim()) bad.push(`${k} 不是非空字符串`);
for (const [k, fields] of Object.entries(LISTS)) {
  if (!Array.isArray(content[k])) { bad.push(`${k} 不是数组`); continue; }
  content[k].forEach((item, i) => {
    if (!item || typeof item !== 'object') { bad.push(`${k}[${i}] 不是对象`); return; }
    for (const f of fields) {
      if (f === 'id' ? (typeof item[f] !== 'string' || !item[f].trim()) : (item[f] === undefined || item[f] === null || item[f] === '')) {
        bad.push(`${k}[${i}].${f} 缺`);
      }
    }
    // image 可选；写了就得是 PUB 下真实存在的一张图（页面按相对路径取，单文件版换成 data URI）
    const img = item.image;
    if (img !== undefined && img !== null && img !== '') {
      if (typeof img !== 'string' || img.indexOf('..') >= 0 || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(img)) {
        bad.push(`${k}[${i}].image 不是安全的相对路径：${img}`);
      } else if (!existsSync(`${PUB}/${img}`)) {
        bad.push(`${k}[${i}].image 指的是 ${img}，但 ${PUB}/${img} 不存在`);
      }
    }
  });
}
if (!Array.isArray(content.asks) && !Array.isArray(content.waitingOnYou)) bad.push('asks 与 waitingOnYou 都不是数组（页面两个都要不到）');
for (const k of ['asks', 'waitingOnYou']) {
  for (const [i, item] of (Array.isArray(content[k]) ? content[k].entries() : [])) {
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item.options) || item.options.length === 0) {
      if (typeof item.kind !== 'string' || !item.kind.trim()) bad.push(`${k}[${i}].kind 缺（options 为空）`);
    }
  }
}
if (content.sections !== undefined && (typeof content.sections !== 'object' || content.sections === null)) bad.push('sections 不是对象');
if (bad.length) throw new Error(`board-content.json 自检不过：\n  - ${bad.join('\n  - ')}`);

// ---------------------------------------------------------------------------
// 2) 填真实钟点 → 写 board.json
// ---------------------------------------------------------------------------
const t = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const updatedAt = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
const data = { updatedAt, ...content };
writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
// 自检：刚落盘的 board.json 必须能 parse，且时间戳就是刚才这个真实钟点（±90 秒内）
const check = JSON.parse(readFileSync(DATA, 'utf8'));
if (check.updatedAt !== updatedAt) throw new Error(`board.json 回读的 updatedAt=${check.updatedAt} ≠ ${updatedAt}`);
if (Math.abs(new Date(updatedAt.replace(' ', 'T')).getTime() - Date.now()) > 90_000) {
  throw new Error(`updatedAt=${updatedAt} 不是真实钟点（与现在差太多）`);
}

// ---------------------------------------------------------------------------
// 3) 把页面 + 数据合成独立快照
// ---------------------------------------------------------------------------
const page = readFileSync(PAGE, 'utf8');
// 必须找**最后一个** </body>：页面脚本的注释里也会出现字面 `</body>`
// （页面上就踩过这个坑 —— 垫片被插进注释里，自带 </script> 提前掐死了主脚本，
//  快照页把 JS 源码当文本渲染）。第一个出现的位置不是文档末尾，不能用于注入。
const at = page.lastIndexOf(MARKER);
if (at < 0) throw new Error(`${PAGE} 里没有 ${MARKER}，先确认页面结构`);
// 注入点必须是文档末尾那个真标签之后 —— 它后面只允许有空白/</html>
const tail = page.slice(at + MARKER.length);
if (!/^[\s]*<\/html>[\s]*$/i.test(tail) && tail.replace(/[\s]/g, "") !== "") {
  throw new Error(`最后一个 ${MARKER} 后面还有 ${tail.length} 字符正文，注入点可疑，先看页面结构`);
}
// 单文件 file:// 版：board.html 旁边没有那个 png（相对路径会裂），所以快照里换成 data URI；
// board.json 里仍然写相对路径（http 那版照常按文件取）。
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
let inlined = 0;
const inlineImages = (list) => (list || []).map((a) => {
  const img = a && a.image;
  if (!img || img.indexOf('data:') === 0) return a;
  const mime = MIME[String(img).split('.').pop().toLowerCase()];
  if (!mime) throw new Error(`票面 image ${img} 的后缀认不出（只认 ${Object.keys(MIME).join('/')}）`);
  inlined++;
  return { ...a, image: `data:${mime};base64,${readFileSync(`${PUB}/${img}`).toString('base64')}` };
});
const snap = { ...data };
for (const k of ['asks', 'waitingOnYou']) if (Array.isArray(data[k])) snap[k] = inlineImages(data[k]);
const json = JSON.stringify(snap).replace(/<\//g, '<\\/');

const shim = `<script>
window.__BOARD__ = ${json};
(function () {
  var of = window.fetch;
  window.fetch = function (u, o) {
    if (String(u).indexOf('board.json') >= 0) {
      return Promise.resolve(new Response(JSON.stringify(window.__BOARD__),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return of.call(this, u, o);
  };
})();
</script>`;

const outHtml = page.slice(0, at) + shim + "\n" + page.slice(at);
// 生成后自检：script 开合必须各多一个，且垫片要落在**最后**一个 </script> 之后
// （踩过：插进注释里 → 页面主脚本被提前掐断，快照页显示一堆源码）
const count = (s, re) => (s.match(re) || []).length;
const opened = count(outHtml, /<script/gi), closed = count(outHtml, /<\/script>/gi);
const openedIn = count(page, /<script/gi), closedIn = count(page, /<\/script>/gi);
if (opened !== openedIn + 1 || closed !== closedIn + 1) {
  throw new Error(`自检不过：script 开合 ${openedIn}/${closedIn} → ${opened}/${closed}（应各多 1）`);
}
if (at < page.lastIndexOf("</script>")) {
  throw new Error(`自检不过：注入点(${at}) 在页面最后一个 </script>(${page.lastIndexOf("</script>")}) 之前，垫片会掉进脚本里`);
}
// 自检：注入到 board.html 里的那段 JSON，原样抠出来必须能 JSON.parse（`</` 被转义过，先还原）
const m = outHtml.match(/window\.__BOARD__ = ([\s\S]*?);\n\(function/);
if (!m) throw new Error('自检不过：board.html 里找不到注入的 window.__BOARD__');
const injected = JSON.parse(m[1].replace(/<\\\//g, '</'));
if (injected.updatedAt !== updatedAt || injected.now.length !== data.now.length) {
  throw new Error('自检不过：抠回来的 __BOARD__ 与 board.json 不是同一份');
}
writeFileSync(OUT, outHtml);
console.log(`board.json 已生成 · 真实钟点 ${updatedAt}`);
console.log(
  `board.html 已生成 · 在做 ${data.now.length} 项 · 等拍板 ${data.waitingOnYou.length} 项 · 排队 ${data.queued.length} 项 · ` +
    `做完 ${data.done.length} 项 · 汇报 ${data.reports.length} 条 · 内联图 ${inlined} 张 · 自检 script ${opened} 开 ${closed} 合 · __BOARD__ 可 parse ✓`,
);
