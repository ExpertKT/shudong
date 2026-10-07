// 主站走查：读得到 / 点得到（对比度 · 命中区 · 字号阶梯）+ 五档溢出 + 真点一遍
//
// ── 怎么跑 ────────────────────────────────────────────────────────────────────
// 全程用 pwsh（别让命令经 cmd /d /s /c，会弹 Windows Terminal，见 TEAM.md §2）。三步：
//
//   1) 改完 web/src/** 先重新 build（SERVE_WEB=1 吐的是 web/dist，不 build 看到的还是旧版）：
//        Start-Process -WindowStyle Hidden -Wait -FilePath cmd -ArgumentList '/c','pnpm --filter @shudong/web build'
//
//   2) 起临时服务（8901，绝不碰用户那个 8787）+ 给本次走查一个新库：
//        $env:PORT='8901'; $env:SHUDONG_DB='F:\tmp\site-before.db'; $env:SERVE_WEB='1'; $env:TICK_INTERVAL_SEC='0'
//        Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'src/index.ts' -WorkingDirectory F:\shudong\server
//        TICK_INTERVAL_SEC=0 disables the server clock; tests explicitly POST /api/feed/tick when needed.
//
//   3) 起 headless Edge（9333）再跑本脚本：
//        Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList `
//          '--headless=new','--remote-debugging-port=9333','--user-data-dir=F:\tmp\site-edge-before','--no-first-run','--disable-gpu','about:blank'
//        $env:SITE_TAG='before'; $env:SITE_DB='F:\tmp\site-before.db'; node web/check-site.mjs
//      （after 一轮换成 SITE_TAG='after' / 另一个库与 profile / SITE_STRICT=1；跑完把服务、Edge、8901、9333 都收掉）
//
// 可用环境变量：SITE_TAG / SITE_CDP / SITE_PAGE / SITE_DB / SITE_SHOTS / SITE_OUT / SITE_STRICT
//   SITE_STRICT=1 时有违规就非零退出（当回归闸用）；不带它只出表（改前那一轮就是要看违规）
//
// ── 五条别踩的坑 ──────────────────────────────────────────────────────────────
//   · 这一帖必须"有楼层"才有「接一句」：`document.querySelector('article')` 常常拿到最新那帖（没楼层），
//     而且 xl 三栏下非选中帖被 `xl:hidden` ⇒ 量到的是被隐藏内容之外的假象。先按内容选中目标帖再量。
//   · 楼层行里 DOM 顺序是「加好友」在前、「接一句」在后 —— 按文字找，别按下标找。
//   · 注册的网名不能带连字符：服务端 `HANDLE_RE` 只认中英文/数字/下划线（2~16 位）。
//   · 判断界面状态用 querySelectorAll/属性，别拿 placeholder 文案去比 innerText（永远假）。
//   · CDP WS 一断 Emulation.setDeviceMetricsOverride 就失效、视口回落 800×600（假象）。
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';

const TAG = process.env.SITE_TAG || 'before';
const CDP = process.env.SITE_CDP || 'http://127.0.0.1:9333';
const PAGE = process.env.SITE_PAGE || 'http://127.0.0.1:8901/';
const DB = process.env.SITE_DB || `F:/tmp/site-${TAG}.db`;
const SHOTS = `${process.env.SITE_SHOTS || 'F:/tmp/site-shots'}/${TAG}`;
const OUT = process.env.SITE_OUT || `F:/tmp/site-check-${TAG}.json`;
const STRICT = process.env.SITE_STRICT === '1';
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HANDLE = `ui23${TAG}`;
const PASS = 'kancha-23-ok';

async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(CDP + '/json/list').then((r) => r.json());
      const t = list.find((x) => x.type === 'page');
      if (t) return t.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('no page target at ' + CDP);
}

const ws = new WebSocket(await cdp());
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let seq = 0;
const waiters = new Map();
const pageErr = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); w(m); return; }
  if (m.method === 'Runtime.exceptionThrown') pageErr.push('ex: ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text));
  if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') pageErr.push('log: ' + m.params.entry.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') pageErr.push('console: ' + (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiters.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('ev failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const waitFor = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(200); } return false; };
const metrics = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const nav = async () => { await send('Page.navigate', { url: PAGE }); await waitFor('document.readyState==="complete"'); await sleep(1000); };
const shot = async (name, full = false, clip = null) => {
  const p = { format: 'png', captureBeyondViewport: full };
  if (clip) p.clip = { ...clip, scale: 1 };
  const r = await send('Page.captureScreenshot', p);
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  return name;
};
/** 按文字点一个"看得见"的按钮（不按下标：DOM 顺序和隐藏节点都会骗人）。 */
const clickText = async (text, scope = '') => {
  const r = await ev(`(() => {
    const ns = [...document.querySelectorAll(${JSON.stringify(scope ? scope + ' button' : 'button')})].filter(n => n.offsetParent !== null);
    const n = ns.find(b => (b.innerText || '').trim() === ${JSON.stringify(text)}) || ns.find(b => (b.innerText || '').includes(${JSON.stringify(text)}));
    if (!n) return 'missing: ' + ns.map(b => (b.innerText || '').trim()).slice(0, 10).join(' / ');
    n.scrollIntoView({ block: 'center' }); n.click(); return 'ok'; })()`);
  await sleep(400); return r;
};
const pickFloorsPost = () => ev(`(() => { const rows = [...document.querySelectorAll('aside button')];
  const r = rows.find(b => (b.innerText || '').includes('时间过得真快')) || rows[0];
  if (!r) return false; r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
/** 另一帖：刚贴上去、一个楼层都还没落地 —— 只有这种帖才看得见「洞里有人听见了。」 */
const pickPendingPost = () => ev(`(() => { const rows = [...document.querySelectorAll('aside button')];
  const r = rows.find(b => (b.innerText || '').includes('橘猫'));
  if (!r) return false; r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
/** 按正文片段换帖（左栏一行就是那一帖）—— 吧友起的话头要用它选出来。 */
const pickPost = (needle) => ev(`(() => { const rows = [...document.querySelectorAll('aside button')];
  const r = rows.find(b => (b.innerText || '').includes(${JSON.stringify(needle)}));
  if (!r) return false; r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
const authText = () => ev(`document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 200)`);

/* ── 页内量测：把「文字可读 / 能点得到」变成数字 ──────────────────────────────
   颜色一律过 canvas 归一化成 rgb（Tailwind v4 的 oklch 直接读出来是 oklch()，比不了大小）。*/
const MEASURE = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d');
  // 任何 CSS 颜色（oklch / color-mix / color(srgb …)）都靠画一格像素再读回来 —— 别解析字符串：
  // 空格分隔的 color(srgb 0.5 0.6 0.7) 会让"按逗号 split"的土办法静默变 NaN。
  const rgb = (css) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = css; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
  const ratio = (a, b) => { const x = L(a), y = L(b); const hi = Math.max(x,y), lo = Math.min(x,y); return Math.round(((hi+0.05)/(lo+0.05))*100)/100; };
  const hex = (c) => '#' + [c[0] || 0, c[1] || 0, c[2] || 0].map(v => Math.round(v).toString(16).padStart(2,'0')).join('');
  const bgOf = (el) => { let n = el; while (n) { const c = rgb(getComputedStyle(n).backgroundColor); if (c[3] > 0.9) return c; n = n.parentElement; } return [14,16,20,1]; };
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), top: Math.round(r.top + window.scrollY) }; };
  const txtOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.tagName).trim().replace(/\\s+/g,' ').slice(0, 18);
  const byText = (sel, t) => [...document.querySelectorAll(sel)].filter(x => x.offsetParent !== null).find(x => (x.innerText || '').trim() === t);

  const all = [...document.querySelectorAll('body *')].filter(e => e.offsetParent !== null);
  // 1) 字号阶梯：只数"渲染出来的叶子文字"
  const sizes = {};
  for (const el of all) { if (!el.innerText || !el.innerText.trim() || el.children.length) continue;
    const s = getComputedStyle(el).fontSize; sizes[s] = (sizes[s] || 0) + 1; }
  // 2) 对比度：每段叶子文字（含 placeholder），按"前景/背景"归并
  const pairs = new Map();
  for (const el of all) {
    const hidden = el.closest('[aria-hidden="true"]') !== null;
    const txt = el.children.length ? '' : (el.innerText || '').trim();
    const ph = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.placeholder || '') : '';
    if (!txt && !ph) continue;
    const color = ph && !txt ? getComputedStyle(el, '::placeholder').color : getComputedStyle(el).color;
    const bg = bgOf(el), c = rgb(color), r = ratio(c, bg);
    const key = hex(c) + ' on ' + hex(bg);
    const p = pairs.get(key) || { key, ratio: r, n: 0, decorative: hidden, font: getComputedStyle(el).fontSize, sample: (txt || ph).slice(0, 16) };
    p.n++; p.decorative = p.decorative && hidden; pairs.set(key, p);
  }
  const contrast = [...pairs.values()].sort((a, b) => a.ratio - b.ratio);
  // 3) 命中区：所有真能点的东西（sr-only 的替身不算，它那行 label 才算）
  const areas = [];
  for (const el of all) {
    if (!el.matches('button, a[href], input, textarea, select, [role="button"], label')) continue;
    if (el.classList.contains('sr-only')) continue;
    const b = box(el);
    if (b.w < 1 || b.h < 1) continue;
    areas.push({ label: txtOf(el), tag: el.tagName.toLowerCase(), ...b, ok: b.w >= 24 && b.h >= 24, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 44) });
  }
  // 4) 几个点名的东西
  const one = (el) => { if (!el) return null; const b = box(el); const c = rgb(getComputedStyle(el).color); const bg = bgOf(el);
    return { text: txtOf(el), font: getComputedStyle(el).fontSize, color: hex(c), bg: hex(bg), ratio: ratio(c, bg), ...b }; };
  const vis = [...document.querySelectorAll('article')].find(a => a.querySelector('ul > li'));
  const floors = vis ? [...vis.querySelectorAll('ul > li')].filter(n => !n.dataset.fold) : [];
  const pendingEl = [...document.querySelectorAll('article p')].find(x => x.innerText.includes('洞里有人听见了'));
  return {
    sizes, contrast, areas,
    named: {
      replyEntry: one(byText('article button', '接一句')),
      addFriend: one(byText('article button', '+ 加好友')),
      railAddFriend: one(byText('aside li button', '+ 加好友')),
      quit: one(byText('header button', '退出')),
      pending: pendingEl ? { font: getComputedStyle(pendingEl).fontSize, color: hex(rgb(getComputedStyle(pendingEl).color)),
        ratio: ratio(rgb(getComputedStyle(pendingEl).color), bgOf(pendingEl)), caret: !!pendingEl.querySelector('.sd-caret'),
        live: pendingEl.getAttribute('aria-live') || (pendingEl.closest('[aria-live]')?.getAttribute('aria-live')) || null, ...box(pendingEl) } : null,
      floorNum: one(document.querySelector('article ul > li > span')),
      tagline: one(document.querySelector('article ul > li .truncate')),
    },
    counts: { floors: floors.length, articles: document.querySelectorAll('article').length,
              innerButtons: vis ? vis.querySelectorAll('button').length : 0 },
    overflow: { sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight,
      offenders: [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && (b.right > window.innerWidth + 1 || b.left < -1); })
        .slice(0, 14).map((e) => { const b = e.getBoundingClientRect();
          return { tag: e.tagName.toLowerCase(), cls: String(e.className || '').slice(0, 44),
            w: Math.round(b.width), right: Math.round(b.right), text: String(e.innerText || '').replace(/\s+/g, ' ').slice(0, 20) }; }) },
    wall: { spine: getComputedStyle(document.querySelector('main.sd-wall'), '::before').content,
            noteIndent: (() => { const d = document.querySelector('article div.border-l');
              return d ? { pad: getComputedStyle(d).paddingLeft, border: getComputedStyle(d).borderLeftColor, w: getComputedStyle(d).borderLeftWidth } : null; })(),
            measure: (() => { const p = vis ? vis.querySelector('p') : null; return p ? Math.round(p.getBoundingClientRect().width) : null; })(),
            fontFamilies: [...new Set(all.map(e => getComputedStyle(e).fontFamily.split(',')[0]))] },
  };
})()`;

const out = { tag: TAG, db: DB, shots: SHOTS };

/* ── 1) 开一个全新的洞（这个库必须是新起的）───────────────────────────────── */
await metrics(1440, 900);
await nav();
await waitFor('!!document.querySelector("input")');
await ev(`(() => { const set = (n, v) => { const s = Object.getOwnPropertyDescriptor(n.constructor.prototype, 'value').set; s.call(n, v); n.dispatchEvent(new Event('input', { bubbles: true })); };
  const i = [...document.querySelectorAll('input')]; set(i[0], ${JSON.stringify(HANDLE)}); set(i[1], ${JSON.stringify(PASS)}); })()`);
out.clickToggle = await clickText('还没有网名');
out.hasRegisterBtn = await ev(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('开一个洞'))`);
out.clickRegister = await clickText('开一个洞');
out.registered = await waitFor('!!document.querySelector("textarea.sd-composer, [data-composer=closed]")', 20000);
if (!out.registered) { out.authScreen = await authText(); throw new Error('register failed: ' + JSON.stringify(out)); }
await sleep(600);
// 首屏那个"空输入框"：收起来的应该只有一行（点一下才摊开）
out.composerClosed = await ev(`(() => { const n = document.querySelector('[data-composer=closed]'); if (!n) return null;
  const r = n.getBoundingClientRect(); return { text: (n.innerText || '').trim(), h: Math.round(r.height), w: Math.round(r.width) }; })()`);
out.shotEmpty1440 = await shot('00-empty-1440');
out.composerClick = await clickText('今天想说什么？');
out.composerOpened = await waitFor('!!document.querySelector("textarea.sd-composer")');
out.composerFocused = await ev('document.activeElement === document.querySelector("textarea.sd-composer")');

/* ── 2) 用界面贴一帖（这一下也是"贴上去"这个按钮真点过）───────────────────── */
await ev(`(() => { const n = document.querySelector('textarea.sd-composer'); const s = Object.getOwnPropertyDescriptor(n.constructor.prototype, 'value').set;
  s.call(n, '今天下班早，路过以前住的那条巷子，店都换了。说说你们最近一次觉得"时间过得真快"是什么时候？');
  n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(200);
out.clickPost = await clickText('贴上去');
await waitFor('!!document.querySelector("article")');
await sleep(600);
const postId = await ev(`fetch('/api/feed').then(r => r.json()).then(d => d.posts[0].id)`);
out.postId = postId;

/* ── 3) 往库里种楼层：seq 用服务端已经给出的最大值 +1（不固定 seq）────────────
   再塞一条 pending（due_at 在一小时后）⇒ 服务端不会马上生成，页面稳定显示「洞里有人听见了。」*/
const db = new DatabaseSync(DB);
const agents = db.prepare('SELECT slug,name,tagline,accent FROM agents ORDER BY sort').all();
const uid = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(postId).user_id;
const texts = [
  [null, '巷口的修表摊还在吗？我去年回去看过一次，师傅不在了，摊子还在，玻璃上贴着张纸条。'],
  [null, '时间过得快这件事，我一般是在填表的时候发现的。'],
  [2, '修表摊没了，换成卖盲盒的。'],
  [2, '我去的时候也愣了一下，不过旁边那家面馆还开着。'],
  [null, '你们说的这些我都没概念，我搬了七次家，没有一个地方能回去看。'],
  [5, '搬七次也挺好的，每次都是新的。'],
  [null, 'https://www.bilibili.com/video/BV1heam6TExz 这个是我最近看的，讲一块芯片怎么长出来的。'],
  [null, '我妈的白头发是突然多的，就那一年。'],
  [3, '盲盒那条街我上周刚去过。'],
  [null, '下班早真好啊。'],
  [null, '每次都是闻着味道想起来的：楼道里的酱油味、下雨天的水泥味。'],
];
const now = Date.now();
const startSeq = (db.prepare('SELECT COALESCE(MAX(seq), 1) AS s FROM floors WHERE post_id = ?').get(postId).s || 1) + 1;
const insFloor = db.prepare(`INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
  VALUES (?, ?, 'agent', ?, 'done', ?, ?, NULL, ?, ?)`);
texts.forEach(([noteSeq, content], i) => {
  const a = agents[i % agents.length];
  insFloor.run(postId, startSeq + i, a.slug, content, noteSeq, now - (texts.length - i) * 7 * 60000, now - (texts.length - i) * 7 * 60000);
});
db.prepare(`INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
  VALUES (?, ?, 'agent', ?, 'pending', NULL, NULL, ?, NULL, ?)`).run(postId, startSeq + texts.length, agents[0].slug, now + 3600e3, now);
const insPost = db.prepare('INSERT INTO posts (user_id, content, created_at, author_slug) VALUES (?, ?, ?, NULL)');
insPost.run(uid, '有没有人跟我一样，外卖点开看半小时，最后煮了碗面。', now - 30 * 3600e3);
// 再一帖：刚贴上去、还没人说话（只有这种帖才显示「洞里有人听见了。」）—— 一条 pending 就够
const pendingPost = Number(insPost.run(uid, '今天在楼下看到一只很胖的橘猫，晒太阳，谁都不理。', now - 3 * 60000).lastInsertRowid);
const pendingSeq = (db.prepare('SELECT COALESCE(MAX(seq), 1) + 1 AS s FROM floors WHERE post_id = ?').get(pendingPost).s);
db.prepare(`INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
  VALUES (?, ?, 'agent', ?, 'pending', NULL, NULL, ?, NULL, ?)`).run(pendingPost, pendingSeq, agents[1 % agents.length].slug, now + 3600e3, now);
/* 吧友自己起的话头：楼主是 agent（`author_slug` 有值）。前端得走吧友那套（名字/头像/他自己那一色），
   不能写成"你" —— 跟"你发的帖"一眼分得开。再落两楼，让截图里是一栋完整的楼。 */
const AGENT_POST_TEXT = '楼下那家便利店把招牌灯换了，夜里白得发蓝。';
const agentPost = Number(db.prepare('INSERT INTO posts (user_id, content, created_at, author_slug) VALUES (?, ?, ?, ?)')
  .run(uid, AGENT_POST_TEXT, now - 30 * 1000, agents[0].slug).lastInsertRowid);
const agentSaid = [
  [null, agents[1 % agents.length], '两点多我去买烟，那灯照得人脸上一点血色都没有。'],
  [null, agents[2 % agents.length], '白得发蓝那种，我在楼上都看得见。'],
];
const agentFloorIds = [];
agentSaid.forEach(([noteId, a, content], i) => {
  const r = insFloor.run(agentPost, 2 + i, a.slug, content, noteId, now - (10 - i * 3) * 1000, now - (10 - i * 3) * 1000);
  agentFloorIds.push(Number(r.lastInsertRowid));
});
db.prepare('UPDATE floors SET note_id = ? WHERE id = ?').run(agentFloorIds[0], agentFloorIds[1]);
out.agentPost = { id: agentPost, slug: agents[0].slug, name: agents[0].name, floors: agentSaid.length, floorIds: agentFloorIds, mutualNoteId: agentFloorIds[0] };

/* 密度（16 位吧友）：再来 7 栋"吧友自己起的"楼，让左栏「洞里的帖子」真的变长；
   作者索引特意挑成能把 16 个 slug 全覆盖（含楼里接话的人），"新名字"就都有机会被走到。 */
const MORE_LORDS = [
  ['巷子口那家理发店，老板从我爸那辈就在那儿剪。', 11],
  ['有没有人跟我一样，半夜醒来会先看一眼几点。', 13],
  ['我把小时候的相册翻出来了，照片都发黄了。', 14],
  ['楼下新开的面馆排了四十分钟，值得吗？', 4],
  ['搬来这个小区第三年，才发现隔壁楼有棵石榴树。', 6],
  ['你们会记得梦吗？我醒来五分钟就忘干净了。', 8],
  ['今天电梯里有人放了一路的歌，我没敢说。', 10],
];
const FILLERS = ['我也是。', '这事儿我也有过。', '你说的那家我知道。'];
out.moreLords = MORE_LORDS.map(([content, ai], k) => {
  const at = now - (24 + k * 13) * 60000;
  const slug = agents[ai % agents.length].slug;
  const pid = Number(db.prepare('INSERT INTO posts (user_id, content, created_at, author_slug) VALUES (?, ?, ?, ?)')
    .run(uid, content, at, slug).lastInsertRowid);
  const n = 1 + (k % 3);
  for (let i = 0; i < n; i++) {
    const a = agents[(ai + i + 1) % agents.length];
    insFloor.run(pid, 2 + i, a.slug, FILLERS[i % FILLERS.length], null, at + (i + 1) * 90000, at + (i + 1) * 90000);
  }
  return { id: pid, slug, floors: n };
});

db.close();
out.seeded = { startSeq, floors: texts.length, pending: 1, pendingPost, pendingSeq };

/* ── 4) 另外三档：溢出（明细统一在 1440 那轮量）──────────────────────────── */
out.widths = {};
for (const [w, h] of [[1920, 1080], [1024, 800], [768, 900]]) {
  await metrics(w, h); await nav();
  if (w >= 1280) { await waitFor('!!document.querySelector("aside button")'); await pickFloorsPost(); await sleep(400); }
  else await waitFor('!!document.querySelector("article ul > li")');
  await sleep(500);
  const m = await ev(MEASURE);
  if (w === 1024 || w === 768) await shot('08-' + w);
  out.widths[w] = { sw: m.overflow.sw, iw: m.overflow.iw, docH: m.overflow.sh, offenders: m.overflow.offenders, articles: m.counts.articles, named: { pending: m.named.pending, replyEntry: m.named.replyEntry } };
}

/* ── 5) 1440：命中区 + 对比度 + 字号阶梯 + 首屏/特写 ─────────────────────── */
await metrics(1440, 900); await nav();
await waitFor('!!document.querySelector("aside button")');
// 5a) 先量"刚贴上去、还没人说话"那一帖：那句「洞里有人听见了。」只在这时候出现
out.pendingPicked = await pickPendingPost();
await sleep(700);
const MP = await ev(MEASURE);
out.pendingNamed = MP.named.pending;
out.pendingCounts = MP.counts;
out.shotPending1440 = await shot('06-pending-1440');
const clipOf = async (expr, pad = 12) => ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect();
  return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y + window.scrollY - ${pad}), width: Math.min(r.width + ${pad}*2, 1200), height: r.height + ${pad}*2 }; })()`);
const clipPending = await clipOf(`[...document.querySelectorAll('article p')].find(x => x.innerText.includes('洞里有人听见了'))`, 16);
if (clipPending) out.shotPending = await shot('03-closeup-pending', true, clipPending);
// 5b) 再量有楼层那一帖
await pickFloorsPost(); await sleep(700);
const M = await ev(MEASURE);
out.fontSizes = M.sizes;
out.contrast = M.contrast;
out.hitAreas = M.areas;
out.named1440 = M.named;
out.wall = M.wall;
out.counts = M.counts;
out.widths[1440] = { sw: M.overflow.sw, iw: M.overflow.iw, docH: M.overflow.sh, offenders: M.overflow.offenders, articles: M.counts.articles, named: { pending: M.named.pending, replyEntry: M.named.replyEntry } };
out.shotFirst1440 = await shot('01-first-1440');
// 5c) 首屏：内容从哪儿开始（"空输入框占掉 37% 首屏"就是这条）
out.firstScreen = await ev(`(() => {
  const b = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
    return { y: Math.round(r.top + window.scrollY), h: Math.round(r.height) }; };
  const a = [...document.querySelectorAll('article')].find(n => n.getBoundingClientRect().height > 0);
  const c = document.querySelector('textarea.sd-composer, [data-composer=closed]');
  return { composer: b(c), article: b(a), vh: window.innerHeight,
    pct: a ? Math.round((a.getBoundingClientRect().top + window.scrollY) / window.innerHeight * 100) : null }; })()`);
// 5d) 长楼折叠：11 楼 ⇒ 头 6 + 尾 3 + 「中间还有 2 楼 · 展开」
const foldRead = () => ev(`(() => {
  const arts = [...document.querySelectorAll('article')].filter(n => n.getBoundingClientRect().height > 0 && n.querySelector('ul'));
  const art = arts.sort((a, b) => b.querySelector('ul').children.length - a.querySelector('ul').children.length)[0];
  const ul = art && art.querySelector('ul'); if (!ul) return null;
  const rows = [...ul.children].filter(n => !n.dataset.fold);
  const nums = rows.map(n => ((n.querySelector('span') || {}).innerText || '').trim()).filter(t => / 楼$/.test(t));
  const btn = (k) => { const b = ul.querySelector('[data-fold=' + k + ']'); return b ? (b.innerText || '').trim() : null; };
  return { rows: rows.length, nums, open: btn('open'), close: btn('close'),
    ulH: Math.round(ul.getBoundingClientRect().height) };
})()`);
out.foldBefore = await foldRead();
const clipFold = await clipOf('document.querySelector(\'article ul [data-fold=row]\')', 28);
if (clipFold) out.shotFoldRow = await shot('07-closeup-fold', true, clipFold);
out.articleH = await ev('(() => { const arts = [...document.querySelectorAll("article")].filter(n => n.getBoundingClientRect().height > 0 && n.querySelector("ul")); const a = arts.sort((x, y) => y.querySelector("ul").children.length - x.querySelector("ul").children.length)[0] || [...document.querySelectorAll("article")].find(n => n.getBoundingClientRect().height > 0); return Math.round(a.getBoundingClientRect().height); })()');
out.foldClick = await clickText('展开', 'article ul');
await sleep(400);
out.foldAfter = await foldRead();
out.foldClose = await clickText('收起', 'article ul');
await sleep(400);
out.foldBack = await foldRead();
const clipReply = await clipOf(`[...document.querySelectorAll('article ul > li button')].find(b => (b.innerText||'').trim() === '接一句')`, 16);
if (clipReply) out.shotReplyEntry = await shot('02-closeup-reply-entry', true, clipReply);
/* 5e) 吧友自己起的话头：楼主是 agent 的那一帖 —— 要走"名字 + 头像"那套，不能写成"你" */
out.agentPicked = await pickPost('便利店把招牌灯');
await sleep(700);
out.agentLord = await ev(`(() => {
  const art = [...document.querySelectorAll('article')].find(n => n.getBoundingClientRect().height > 0);
  if (!art) return null;
  const meta = art.querySelector('[data-lord]') || art.querySelector('div.mt-3');
  const txt = (art.innerText || '').replace(/\\s+/g, ' ').trim();
  const mt = meta ? (meta.innerText || '').replace(/\\s+/g, ' ').trim() : null;
  return { kind: meta ? meta.getAttribute('data-lord') : null, text: mt,
    avatar: !!(meta && meta.querySelector('div.rounded-full')),
    hasName: !!mt && mt.includes(${JSON.stringify(out.agentPost.name)}),
    hasTagline: !!mt && mt.includes(${JSON.stringify(agents[0].tagline)}),
    hasHandle: !!mt && mt.includes(${JSON.stringify(HANDLE)}),
    you: txt.includes('你') };
})()`);
out.shotAgent1440 = await shot('09-agent-lord-1440');

/* ── 5f) 密度：16 人下左栏（洞里的帖子）与右栏（16 人名册）到底怎么排 ────────── */
out.density = await ev(`(() => {
  const box = (n) => { const b = n.getBoundingClientRect(); return { y: Math.round(b.top + window.scrollY), h: Math.round(b.height) }; };
  const asides = [...document.querySelectorAll('aside')].filter((a) => a.offsetParent !== null);
  const pick = (t) => asides.find((a) => (a.innerText || '').includes(t)) || null;
  const clean = (n) => n ? String(n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 26) : null;
  const info = (a) => {
    if (!a) return null;
    const sc = a.querySelector('ul');
    const rows = sc ? [...sc.children].filter((n) => !n.dataset.rosterFade) : [];
    const vis = rows.filter((n) => { const b = n.getBoundingClientRect(); return b.bottom > 0 && b.top < window.innerHeight; });
    return {
      asideH: box(a).h, asideY: box(a).y,
      listH: sc ? Math.round(sc.getBoundingClientRect().height) : null,
      scrollH: sc ? Math.round(sc.scrollHeight) : null,
      clientH: sc ? Math.round(sc.clientHeight) : null,
      canScroll: sc ? sc.scrollHeight > sc.clientHeight + 1 : null,
      rows: rows.length, rowsInView: vis.length,
      first: clean(rows[0]), last: clean(rows[rows.length - 1]),
    };
  };
  const right = pick('洞里住着的人');
  const sw = right ? right.querySelector('input[type=checkbox]') : null;
  const swBox = sw ? (sw.closest('label') || sw).getBoundingClientRect() : null;
  const m = document.querySelector('main');
  return {
    vh: window.innerHeight, pageH: document.documentElement.scrollHeight, feedH: m ? box(m).h : null,
    left: info(pick('洞里的帖子')), right: info(right),
    switchY: swBox ? Math.round(swBox.top + window.scrollY) : null,
    switchViewTop: swBox ? Math.round(swBox.top) : null,
    switchBelowFold: swBox ? swBox.top > window.innerHeight : null,
  };
})()`);
out.shotRailLeft = await shot('10-rail-left-1440');
out.shotRoster = await shot('11-roster-1440');
/* 名册底边处理：初态底边切在哪一行 + 滚到底最后一行离下沿多远 + 渐隐条在不在 */
const rosterUl = "(() => { const a = [...document.querySelectorAll('aside')].filter((x) => x.offsetParent !== null).find((x) => (x.innerText || '').includes('洞里住着的人')); return a ? a.querySelector('ul') : null; })()";
out.rosterCut = await ev(`(() => {
  const sc = ${rosterUl}; if (!sc) return null;
  sc.scrollTop = 0;
  const rows = [...sc.children].filter((n) => !n.dataset.rosterFade);
  const sb = sc.getBoundingClientRect();
  const cut = rows.filter((n) => { const b = n.getBoundingClientRect(); return b.top < sb.bottom && b.bottom > sb.bottom; });
  return { rows: rows.length, cutRows: cut.length, cutText: cut.length ? String(cut[0].innerText || '').slice(0, 24) : null };
})()`);
out.shotRosterCut = await shot('13-roster-cut-1440', true, await ev(`(() => { const sc = ${rosterUl}; if (!sc) return null;
  const b = sc.getBoundingClientRect(); return { x: b.x - 6, y: b.y + window.scrollY + b.height - 120, width: b.width + 12, height: 120 }; })()`));
out.rosterBottom = await ev(`(() => {
  const sc = ${rosterUl}; if (!sc) return null;
  sc.scrollTop = sc.scrollHeight;
  const rows = [...sc.children].filter((n) => !n.dataset.rosterFade);
  const last = rows[rows.length - 1];
  const lb = last.getBoundingClientRect(), sb = sc.getBoundingClientRect();
  const fade = sc.querySelector('[data-roster-fade]');
  const fb = fade ? fade.getBoundingClientRect() : null;
  return { gap: Math.round(sb.bottom - lb.bottom), fade: !!fade, fadeH: fb ? Math.round(fb.height) : null,
    fadeVisible: !!(fb && fb.bottom <= sb.bottom + 1 && fb.top >= sb.top - 1),
    lastText: last ? String(last.innerText || '').slice(0, 26) : null };
})()`);
out.shotRosterBottom = await shot('12-roster-bottom-1440', true, await ev(`(() => { const sc = ${rosterUl}; if (!sc) return null;
  const b = sc.getBoundingClientRect(); return { x: b.x - 6, y: b.y + window.scrollY + b.height - 120, width: b.width + 12, height: 120 }; })()`));

/* 名册能不能滚到底：把里面那个 ul 滚到最后，看最后一行是否真的露出来 */
out.densityScroll = await ev(`(() => {
  const a = [...document.querySelectorAll('aside')].filter((x) => x.offsetParent !== null).find((x) => (x.innerText || '').includes('洞里住着的人'));
  const sc = a && a.querySelector('ul'); if (!sc) return null;
  sc.scrollTop = sc.scrollHeight;
  const rows = [...sc.children].filter((n) => !n.dataset.rosterFade); const last = rows[rows.length - 1];
  const lb = last.getBoundingClientRect(); const ab = a.getBoundingClientRect();
  return { maxScroll: Math.round(sc.scrollHeight - sc.clientHeight), scrolledTo: Math.round(sc.scrollTop),
    lastVisible: lb.bottom <= ab.bottom + 2 && lb.top >= ab.top - 2,
    lastText: (last.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 26) };
})()`);
/* 16 个 slug 逐个查：名册（名字/签名/头像）与楼里（名字/头像）都要成立 */
out.slugs = await ev(`(() => {
  const want = ${JSON.stringify(agents.map((a) => ({ slug: a.slug, name: a.name, tagline: a.tagline })))};
  const railBox = [...document.querySelectorAll('aside')].find((a) => (a.innerText || '').includes('洞里住着的人')) || document;
  const railRows = [...railBox.querySelectorAll('li')];
  const floorRows = [...document.querySelectorAll('article [data-lord], article ul > li')];
  const av = (n) => !!(n && n.querySelector('.rounded-full'));
  const has = (rows, a) => rows.find((n) => (n.innerText || '').includes(a.name)) || null;
  return want.map((a) => {
    const rr = has(railRows, a), fr = has(floorRows, a);
    const txt = rr ? (rr.innerText || '').replace(/\s+/g, ' ') : '';
    return { slug: a.slug, rail: !!rr, railLine2: !!rr && (txt.includes(a.tagline) || txt.includes('他：')), railAv: av(rr),
      thread: !!fr, threadAv: av(fr) };
  });
})()`);
/* 吸顶：页面往下滚 600px，两根栏还钉在原地吗 */
out.densitySticky = await ev(`(() => {
  window.scrollTo(0, 600);
  const asides = [...document.querySelectorAll('aside')].filter((a) => a.offsetParent !== null);
  const pick = (t) => asides.find((a) => (a.innerText || '').includes(t)) || null;
  const top = (a) => a ? Math.round(a.getBoundingClientRect().top) : null;
  const r = { scrollY: Math.round(window.scrollY), leftTop: top(pick('洞里的帖子')), rightTop: top(pick('洞里住着的人')) };
  window.scrollTo(0, 0);
  return r;
})()`);


/* ── 6) 375：整页 + 首屏（此时还登录着）─────────────────────────────────── */
await metrics(375, 812); await nav();
await waitFor('!!document.querySelector("article ul > li")'); await sleep(700);
const m375 = await ev(MEASURE);
out.widths[375] = { sw: m375.overflow.sw, iw: m375.overflow.iw, docH: m375.overflow.sh, offenders: m375.overflow.offenders, articles: m375.counts.articles, named: { pending: m375.named.pending, replyEntry: m375.named.replyEntry } };
out.fold375 = await foldRead();
out.shot375Full = await shot('04-375-full', true);
out.shot375 = await shot('05-375-fold');

/* ── 6b) "你不在的时候"回访摘要：夹具 + 四种状态（首次 / 有基线 / 点掉 / 再刷新）──
   夹具照服务端的写法：一条"我"的楼层 + 三条指着它的吧友回话（`note_id` = 真楼层 id）
   + 两条吧友自发帖。`since` 是夹具里的"上次来看"（5 分钟前）。 */
await metrics(1440, 900);
const dnow = Date.now();
const since = dnow - 300000;
const ddb = new DatabaseSync(DB);
const dmaxSeq = ddb.prepare('SELECT COALESCE(MAX(seq), 1) AS s FROM floors WHERE post_id = ?').get(postId).s;
const mySeq = dmaxSeq + 1;
const myFloorId = Number(ddb.prepare(`INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
  VALUES (?, ?, 'user', NULL, 'done', ?, NULL, NULL, ?, ?)`)
  .run(postId, mySeq, '（走查夹具：我接的一句）', dnow - 240000, dnow - 240000).lastInsertRowid);
const dInsFloor = ddb.prepare(`INSERT INTO floors (post_id, seq, author_kind, author_slug, state, content, note_id, due_at, replied_at, created_at)
  VALUES (?, ?, 'agent', ?, 'done', ?, ?, NULL, ?, ?)`);
const dAgents = [5, 6, 7].map((i) => agents[i % agents.length]);
dAgents.forEach((a, i) => {
  const at = dnow - (30 - i * 10) * 1000;
  dInsFloor.run(postId, mySeq + 1 + i, a.slug, `（走查夹具：回你的第 ${mySeq} 楼 ${i + 1}）`, myFloorId, at, at);
});
const dPosts = [50, 40].map((ago, i) => Number(ddb.prepare('INSERT INTO posts (user_id, content, created_at, author_slug) VALUES (?, ?, ?, ?)')
  .run(uid, `（走查夹具：吧友自己起的话头 ${i + 1}）`, dnow - ago * 1000, agents[(3 + i) % agents.length].slug).lastInsertRowid));
/* 期望值用 SQL 另算一遍（跟页面那套实现走的是两条路），这样夹具之外真冒出来的东西也能算对 */
const saidInDb = ddb.prepare(`SELECT COUNT(*) AS n FROM floors WHERE author_kind = 'agent' AND state = 'done' AND replied_at > ?`).get(since).n;
const dNewPosts = ddb.prepare('SELECT id FROM posts WHERE author_slug IS NOT NULL AND created_at > ?').all(since);
const saidExpected = saidInDb + dNewPosts.filter((p) =>
  ddb.prepare(`SELECT COUNT(*) AS n FROM floors WHERE post_id = ? AND author_kind = 'agent' AND replied_at > ?`).get(p.id, since).n === 0).length;
const bullets = dAgents.map((a) => `${a.name} 回了你 ${mySeq} 楼`);
out.digestSeed = { mySeq, myFloorId, posts: dPosts, saidInDb, newPosts: dNewPosts.length, saidExpected, bullets };
ddb.close();

/** 摘要当前长什么样 + 本地那两样存了什么。 */
const digestState = () => ev(`(() => {
  const n = document.querySelector('[data-digest]');
  const items = [...document.querySelectorAll('[data-digest-item]')].map((b) => (b.innerText || '').replace(/\\s+/g, ' ').trim());
  const c = document.querySelector('[data-digest-close]');
  const cb = c ? c.getBoundingClientRect() : null;
  const m = n ? (n.innerText.match(/([0-9]+)\\s*句话/) || []) : [];
  return { present: !!n, said: m[1] ? Number(m[1]) : null,
    text: n ? (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90) : null, items,
    close: cb ? { w: Math.round(cb.width), h: Math.round(cb.height) } : null,
    stored: localStorage.getItem('sd.lastSeen'), off: localStorage.getItem('sd.digestOff') };
})()`);

// 6b.1 首次访问：本地什么都没记 → 刷新，不该弹；但要把基线记下（否则下次还是"首次"）
await ev(`(() => { localStorage.removeItem('sd.lastSeen'); localStorage.removeItem('sd.digestOff'); })()`);
await nav();
await waitFor('!!document.querySelector("article ul > li")');
await sleep(600);
out.digest = { firstVisit: await digestState(), expected: { said: saidExpected, bullets } };
// 6b.2 有"上次来看" → 该弹，计数与三条要点都要对
await ev(`localStorage.setItem('sd.lastSeen', String(${since})); localStorage.removeItem('sd.digestOff');`);
await nav();
await waitFor('!!document.querySelector("article ul > li")');
await sleep(600);
out.digest.shown = await digestState();
out.shotDigest = await shot('14-digest-1440');
// 6b.3 点掉那颗 × → 立刻消失 + 记住"别给我看了"
out.digest.clickClose = await ev(`(() => { const b = document.querySelector('[data-digest-close]'); if (!b) return false; b.click(); return true; })()`);
await sleep(400);
out.digest.dismissed = await digestState();
// 6b.4 再刷新一遍 → 还是不该弹（"关了就一直不出现"）
await nav();
await waitFor('!!document.querySelector("article ul > li")');
await sleep(600);
out.digest.afterReload = await digestState();

/* ── 6c) task-48：今天流两类事件、真实目标楼定位、lastAt 空态 ──────────────── */
await metrics(1440, 900); await nav();
await waitFor('!!document.querySelector("article")');
out.todayFlowOpen = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '打开'); if (!b) return false; b.click(); return true; })()`);
await sleep(300);
out.todayFlow = await ev(`(() => {
  const box = [...document.querySelectorAll('main button')].some(b => b.offsetParent !== null && b.closest('ul')); 
  const bs = [...document.querySelectorAll('main button')].filter(b => b.offsetParent !== null && b.closest('ul'));
  const texts = bs.map(b => (b.innerText || '').replace(/\\s+/g, ' ').trim());
   const agentSlugs = ${JSON.stringify(agents.map(a => a.slug))};
   const ownHandle = ${JSON.stringify(HANDLE)};
   const withoutOwnHandle = (t) => t.split(ownHandle).join("");
   return { present: !!box, texts, namesOnly: texts.every(t => !agentSlugs.some(s => withoutOwnHandle(t).includes(s))), hasAgentStart: texts.some(t => t.includes(${JSON.stringify(AGENT_POST_TEXT)})), hasMutualReply: texts.some(t => t.includes("白得发蓝那种")) };
})()`);
const clickToday = (needle) => ev(`(() => { const b = [...document.querySelectorAll('main button')].find(x => x.offsetParent !== null && (x.innerText || '').includes(${JSON.stringify(needle)})); if (!b) return false; b.click(); return true; })()`);
 out.shotTodayFlow = await shot('15-today-flow');
out.todayAgentClick = await clickToday(AGENT_POST_TEXT);
await sleep(500);
out.todayAgentTarget = await ev(`(() => { const a = [...document.querySelectorAll('article')].find(x => x.getBoundingClientRect().height > 0 && (x.innerText || '').includes(${JSON.stringify(AGENT_POST_TEXT)})); const meta = a?.querySelector('[data-lord="agent"]'); return { visible: !!a, agent: !!meta, top: a ? Math.round(a.getBoundingClientRect().top) : null }; })()`);
out.todayMutualClick = await clickToday('白得发蓝那种');
await sleep(700);
out.todayTarget = await ev(`(() => { const id = ${JSON.stringify(agentFloorIds[1])}; const n = document.querySelector('[data-floor-id="' + id + '"]'); if (!n) return { id, exists: false, inView: false, top: null }; const r = n.getBoundingClientRect(); return { id, exists: true, top: Math.round(r.top), inView: r.bottom >= -24 && r.top <= window.innerHeight + 24 }; })()`);
out.shotTodayTarget = await shot('16-today-target-floor');
out.sidebarNullTime = await ev(`(async () => { const api = await fetch('/api/agents').then(r => r.json()); const target = api.agents.find(a => a.slug === ${JSON.stringify(agents[1].slug)}); const rows = [...document.querySelectorAll('aside li')].filter(x => x.offsetParent !== null); const r = rows.find(x => (x.innerText || '').includes(${JSON.stringify(agents[1].name)})); if (!target || !r) return { found: false, apiLastAt: target?.lastAt ?? null }; const text = (r.innerText || '').replace(/\\s+/g, ' ').trim(); return { found: true, apiLastAt: target.lastAt, text, noTime: target.lastAt === null && !/(刚刚|[0-9]+ 分钟前|[0-9]+ 小时前|[0-9]+ 天前)/.test(text) }; })()`);
/* ── 7) 真点一遍：改过的每个可点元素（退出放最后）───────────────────────── */
await metrics(1440, 900); await nav();
await waitFor('!!document.querySelector("aside button")'); await pickFloorsPost(); await sleep(700);
out.clicks = {};
// 7.1 接一句 → 输入框展开且拿到焦点
out.clicks.replyEntry = await clickText('接一句', 'article');
out.clicks.replyEntryOpen = await ev(`(() => { const n = document.querySelector('article textarea:not(.sd-composer)');
  return n ? { focused: document.activeElement === n, placeholder: n.placeholder } : null; })()`);
// 7.2 算了 → 收回去
out.clicks.cancel = await clickText('算了', 'article');
out.clicks.cancelClosed = await ev(`!document.querySelector('article textarea:not(.sd-composer)')`);
// 7.3 就这句 → 我这一楼真的落地（seq 由服务端给）
await clickText('接一句', 'article');
await sleep(300);
await ev(`(() => { const n = document.querySelector('article textarea:not(.sd-composer)'); const s = Object.getOwnPropertyDescriptor(n.constructor.prototype, 'value').set;
  s.call(n, '我也是——那家面馆的招牌换成了奶茶店。'); n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(200);
out.clicks.send = await clickText('就这句', 'article');
out.clicks.myFloor = await waitFor(`[...document.querySelectorAll('article ul > li')].some(li => li.innerText.includes('那家面馆的招牌换成了奶茶店'))`, 12000);
// 7.4 右栏名录的「+ 加好友」→ 那一行变成「进去说」
out.clicks.addFriend = await clickText('加好友', 'aside li');
out.clicks.friended = await waitFor(`[...document.querySelectorAll('aside li button')].some(b => b.innerText.includes('进去说'))`, 12000);
// 7.5 横幅的「知道了」：拦掉一次 /api/feed 让横幅出来，再点掉
const handler = ws.onmessage;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') void send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Failed' });
  handler({ data: e.data });
};
await send('Fetch.enable', { patterns: [{ urlPattern: '*api/feed*' }] });
await ev(`fetch('/api/feed').catch(() => {})`);
await sleep(800);
out.clicks.noticeShown = await waitFor(`[...document.querySelectorAll('button')].some(b => (b.innerText||'').trim() === '知道了')`, 6000);
out.clicks.noticeDismiss = out.clicks.noticeShown ? await clickText('知道了') : null;
out.clicks.noticeGone = await waitFor(`![...document.querySelectorAll('button')].some(b => (b.innerText||'').trim() === '知道了')`, 6000);
await send('Fetch.disable');
ws.onmessage = handler;
// 7.6 退出（最后一个点：点完就在登录页了）
out.clicks.quit = await clickText('退出', 'header');
out.clicks.loggedOut = await waitFor(`!!document.querySelector('input') && !document.querySelector('header')`, 12000);

/* ── 8) 汇总 + 门槛 ─────────────────────────────────────────────────────── */
const bad = [];
for (const [k, v] of Object.entries(out.widths)) if (v.sw > v.iw) bad.push(`溢出 ${k}: sw ${v.sw} > iw ${v.iw}`);
for (const c of out.contrast || []) if (!c.decorative && c.ratio < 4.5) bad.push(`对比度 ${c.ratio}:1 · ${c.n} 处 · ${c.sample}`);
for (const a of out.hitAreas || []) if (!a.ok) bad.push(`命中区 ${a.label} ${a.w}×${a.h}`);
for (const [k, v] of Object.entries(out.clicks)) if (v === false || (typeof v === 'string' && v.startsWith('missing'))) bad.push(`点击没生效 ${k}: ${v}`);
// 吧友起的话头：必须走吧友那套（`data-lord=agent` + 名字 + 签名 + 头像），也不能写成"你"
const AL = out.agentLord;
if (!AL || AL.kind !== 'agent' || !AL.avatar || !AL.hasName || !AL.hasTagline || AL.hasHandle || AL.you)
  bad.push('吧友起的话头没走吧友那套: ' + JSON.stringify(AL));
// 16 位密度：名册 16 人必须全在（名字 + 签名 + 头像），楼里也要把 16 个 slug 走遍
const SL = out.slugs || [];
if (SL.length !== 16) bad.push('名册不是 16 人: ' + SL.length);
for (const s of SL) {
  if (!s.rail || !s.railLine2 || !s.railAv) bad.push('名册里没渲染全: ' + JSON.stringify(s));
  if (!s.thread || !s.threadAv) bad.push('楼里没渲染全: ' + JSON.stringify(s));
}
if (out.density && out.density.right && out.density.right.canScroll && !(out.densityScroll && out.densityScroll.lastVisible))
  bad.push('名册滚不到底: ' + JSON.stringify(out.densityScroll));
// 名册底边：滚到底最后一行离下沿要有留白（不是被硬切），且底边那条渐隐必须在
const RB = out.rosterBottom;
if (!RB || !RB.fade || !RB.fadeVisible) bad.push('名册底边没有渐隐条: ' + JSON.stringify(RB));
if (!RB || RB.gap < 8) bad.push('名册最后一行离下沿太近: ' + JSON.stringify(RB));
// "你不在的时候"：首次访问不弹 + 基线记下；有基线才弹，且计数/要点对得上；点掉之后不再出现
{
  const DG = out.digest || {};
  const FV = DG.firstVisit || {};
  if (FV.present) bad.push('首次访问就弹了摘要: ' + JSON.stringify(FV));
  else if (!(Number(FV.stored) > since + 60000)) bad.push('首次访问没记下"上次来看"的基线: ' + JSON.stringify(FV));
  const SH = DG.shown || {};
  if (!SH.present) bad.push('有"上次来看"却没弹摘要: ' + JSON.stringify(SH));
  else {
    if (Number(SH.said) !== saidExpected) bad.push(`摘要计数不对: 页面 ${SH.said} / 库里该是 ${saidExpected}`);
    for (const t of bullets) if (!SH.items.some((x) => x.includes(t))) bad.push(`摘要要点里缺「${t}」: ` + JSON.stringify(SH.items));
    if (SH.items.length > 3) bad.push('摘要要点超过 3 条: ' + JSON.stringify(SH.items));
    if (!SH.close || SH.close.w < 24 || SH.close.h < 24) bad.push('摘要那颗关掉太小: ' + JSON.stringify(SH.close));
  }
  if (!DG.dismissed || DG.dismissed.present) bad.push('点了关掉还在: ' + JSON.stringify(DG.dismissed));
  if (!DG.dismissed || DG.dismissed.off !== '1') bad.push('关掉没记住: ' + JSON.stringify(DG.dismissed));
  if (!DG.afterReload || DG.afterReload.present) bad.push('关掉后又冒出来了: ' + JSON.stringify(DG.afterReload));
}
if (!out.todayFlow?.present || !out.todayFlow.hasAgentStart || !out.todayFlow.hasMutualReply || !out.todayFlow.namesOnly) bad.push('今天流两类事件/展示名断言失败: ' + JSON.stringify(out.todayFlow));
if (!out.todayAgentTarget?.agent || !out.todayMutualClick || !out.todayTarget?.exists || !out.todayTarget.inView) bad.push('今天流未定位到目标楼: ' + JSON.stringify({ agent: out.todayAgentTarget, target: out.todayTarget }));
if (!out.sidebarNullTime?.found || !out.sidebarNullTime.noTime) bad.push('lastAt=null 的侧栏行出现时间: ' + JSON.stringify(out.sidebarNullTime));
// 走查自己会拦一次 /api/feed 造横幅 —— 只允许那两条 net::ERR_FAILED，别的报错都算违规。
for (const e of pageErr) if (!String(e).endsWith('net::ERR_FAILED')) bad.push('控制台报错: ' + e);
out.violations = bad;
out.pageErr = pageErr;
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  tag: TAG, out: OUT, shots: SHOTS, postId, counts: M.counts, sizes: out.fontSizes,
  minContrast: (out.contrast || []).filter((c) => !c.decorative).slice(0, 8),
  smallTargets: (out.hitAreas || []).filter((a) => !a.ok).map((a) => `${a.label} ${a.w}×${a.h}`),
  named: out.named1440, clicks: out.clicks,
  overflow: Object.fromEntries(Object.entries(out.widths).map(([k, v]) => [k, v.sw + '/' + v.iw])),
  composer: { closed: out.composerClosed, opened: out.composerOpened, focused: out.composerFocused },
  firstScreen: out.firstScreen, articleH: out.articleH,
  fold: { before: out.foldBefore, after: out.foldAfter, back: out.foldBack, w375: out.fold375 },
  agentLord: out.agentLord, agentPost: out.agentPost,
  density: out.density, densityScroll: out.densityScroll, densitySticky: out.densitySticky, slugs: out.slugs,
  rosterCut: out.rosterCut, rosterBottom: out.rosterBottom,
  digest: out.digest, digestSeed: out.digestSeed,
  wall: out.wall, violations: bad, pageErr,
}, null, 1));
ws.close();
if (STRICT && bad.length) process.exit(2);
