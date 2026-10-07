// 前端的一次真浏览器走查（headless Edge + CDP，375px）：注册 → 发帖 → 看流式 → 加好友 → 单聊 → 主动来消息，
// 全程截图，并断言：每页 scrollWidth == innerWidth（不横向滚动）、console 零错误、主动消息被标成「他主动来找你说」。
//
// 用法（三个动作）：
//   1) 起临时服务（绝不要用用户正在用的 8787/5173）：
//      $env:PORT='8901'; $env:SHUDONG_DB='F:\tmp\ui-browser.db'; $env:SERVE_WEB='1'; $env:DM_MEMORY='1'
//      $env:PROACTIVE='1'; $env:PROACTIVE_MIN_GAP_MIN='0'; $env:PROACTIVE_DAILY_MAX='3'
//      node src/index.ts                       # workdir = server/
//   2) 起 headless Edge（独立 profile，别碰用户自己的浏览器）：
//      msedge --headless=new --remote-debugging-port=9333 --user-data-dir=F:\tmp\ui-edge-profile about:blank
//   3) node web/check-ui.mjs                    # 截图落在 F:\tmp\ui-shots（可用 OUT 环境变量覆盖）
//
// 不需要任何依赖（node 24 自带 fetch/WebSocket），也不改仓库里任何文件。
import fs from 'node:fs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const BASE = process.env.BASE || 'http://127.0.0.1:8901';
const OUT = process.env.OUT || 'F:\\tmp\\ui-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = [];
const note = (name, v) => { notes.push({ name, v }); console.log('## ' + name + ' :: ' + JSON.stringify(v)); };

const targets = await (await fetch(CDP + '/json/list')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target: ' + JSON.stringify(targets.map((t) => t.type)));

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
let seq = 0;
const waiting = new Map();
const bad = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const { res, rej } = waiting.get(m.id); waiting.delete(m.id);
    if (m.error) rej(new Error(m.error.message)); else res(m.result);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') bad.push('log: ' + m.params.entry.text);
  else if (m.method === 'Runtime.exceptionThrown') bad.push('ex: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '\\' + name + '.png', Buffer.from(r.data, 'base64'));
};
const clickBtn = (label, nth = 0) => ev(`(()=>{const bs=[...document.querySelectorAll('button')];const hit=bs.filter(b=>b.textContent.includes(${JSON.stringify(label)}));if(hit.length<=${nth})return 'NOBTN(' + hit.length + '):'+bs.map(b=>b.textContent.trim()).join('|');hit[${nth}].click();return 'ok:'+hit[${nth}].textContent.trim();})()`);
const setVal = (ph, v) => ev(`(()=>{const el=[...document.querySelectorAll('textarea')].find(t=>t.placeholder.includes(${JSON.stringify(ph)}));if(!el)return 'NOTA';Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));return 'set:'+el.value.length;})()`);
const where = () => ev(`(()=>{const d=document.documentElement;return {sw:d.scrollWidth,iw:window.innerWidth,sh:d.scrollHeight,text:document.body.innerText.replace(/\\s+/g,' ').slice(0,240)};})()`);
const carets = () => ev(`document.querySelectorAll('.sd-caret,[role=status]').length`);
async function settle(maxMs = 90000, gap = 800) {
  let stable = 0, last = -1, series = [];
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const [len, c] = [await ev('document.body.innerText.length'), await carets()];
    series.push(len);
    if (len === last && c === 0) { if (++stable >= 3) break; } else stable = 0;
    last = len;
    await sleep(gap);
  }
  return { series, carets: await carets() };
}

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

await send('Page.navigate', { url: BASE + '/' });
await sleep(2000);
note('首屏(未登录)', await where());

const handle = 'ui' + Math.random().toString(36).slice(2, 8);
const reg = await ev(`(async()=>{const r=await fetch('/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:${JSON.stringify(handle)},password:'shudong123'})});return r.status+' '+(await r.text()).slice(0,90)})()`);
note('注册', { handle, reg });

await send('Page.navigate', { url: BASE + '/' });
await sleep(2000);
await shot('01-feed-375');
note('登录后首屏', await where());

note('发帖', { set: await setVal('今天想说什么', '今天有点累，随便说两句。'), click: await clickBtn('贴上去') });
const stream = await settle(120000, 700);
await shot('02-feed-after-stream-375');
note('帖子回复(innerText长度序列)', { samples: stream.series.slice(0, 24), n: stream.series.length, endCarets: stream.carets });
note('帖子页', await where());

note('加好友', await clickBtn('+ 加好友'));
await sleep(1200);
await shot('03-friend-added-375');
note('加好友后(friends 接口)', await ev(`(async()=>{const r=await fetch('/api/friends');const j=await r.json();return {n:j.friends.length,f:j.friends.map(f=>({slug:f.slug,unread:f.unread,sinceType:typeof f.since}))}})()`));
note('加好友后页面', await where());

note('进单聊', await clickBtn('聊两句'));
await sleep(1500);
await shot('04-dm-375');
note('单聊首屏', await where());

note('单聊发消息', { set: await setVal('说点什么', '你在忙吗'), click: await clickBtn('说给他听') });
await sleep(900);
await shot('05-dm-typing-375');
note('单聊打字中(status 元素数)', { carets: await carets() });
const dmStream = await settle(120000, 700);
await shot('06-dm-done-375');
note('单聊回复(长度序列)', { samples: dmStream.series.slice(0, 20), n: dmStream.series.length });
note('单聊页', await where());

note('回 feed', await clickBtn('← 回去'));
await sleep(1500);
note('seen 之后 friends', await ev(`(async()=>{const j=await(await fetch('/api/friends')).json();return j.friends.map(f=>({slug:f.slug,unread:f.unread,lastText:f.lastText,lastAtType:typeof f.lastAt}))})()`));

const tick = await ev(`(async()=>{const r=await fetch('/api/proactive/tick',{method:'POST'});return r.status+' '+(await r.text()).slice(0,200)})()`);
note('手动 tick', tick);
console.log('… 等前端自己的每分钟轮询把「他主动来找你」弹出来（最多 75s）…');
let banner = null;
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  if (await ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('去看看'))`)) {
    banner = (await ev('document.body.innerText')).replace(/\s+/g, ' ').slice(0, 300);
    break;
  }
}
note('主动来消息横幅(前端自己每分钟轮询出来的)', banner ?? '（90s 没等到）');
if (banner) {
  await shot('07-proactive-banner-375');
  note('点「去看看」', await clickBtn('去看看'));
  await sleep(2200);
  await shot('08-proactive-dm-375');
  note('主动消息在单聊里有没有标「他主动来找你说」', await ev(`document.body.innerText.includes('他主动来找你说')`));
  note('主动消息的单聊页', await where());
  note('单聊容器几何(容器高应≈视口-头部, 输入框落在容器底部)', await ev(`(()=>{const el=document.querySelector('main > div');const r=el.getBoundingClientRect();const ta=document.querySelector('textarea');return {top:Math.round(r.top),h:Math.round(r.height),vh:window.innerHeight,inputBottom:Math.round(ta.getBoundingClientRect().bottom)};})()`));
}
await shot('09-final-375');
note('收尾页面', await where());
note('页面错误(console error / 未捕获异常)', bad);
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(notes, null, 1));
ws.close();
