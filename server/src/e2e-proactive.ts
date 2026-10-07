/**
 * M2 端到端：agent 主动来消息、一键开关、印象（记忆）开关。
 *
 * 按 `PROACTIVE_MODE` 分四种场景，**要对四种不同环境变量起的 server 各跑一遍**：
 *   off：PORT=8913 SHUDONG_DB=<临时库> PROACTIVE=0 PROACTIVE_MIN_GAP_MIN=0 PROACTIVE_DAILY_MAX=1 TICK_INTERVAL_SEC=1
 *   cap：PORT=8914 SHUDONG_DB=<临时库> PROACTIVE=1 PROACTIVE_MIN_GAP_MIN=0 PROACTIVE_DAILY_MAX=3 DM_MEMORY=1 TICK_INTERVAL_SEC=0
 *   gap：PORT=8915 SHUDONG_DB=<临时库> PROACTIVE=1 PROACTIVE_MIN_GAP_MIN=1 PROACTIVE_DAILY_MAX=5 TICK_INTERVAL_SEC=0
 *   clock：PORT=8916 SHUDONG_DB=<临时库> PROACTIVE=1 PROACTIVE_MIN_GAP_MIN=0 PROACTIVE_DAILY_MAX=1 TICK_INTERVAL_SEC=1
 * 然后：SHUDONG_BASE=http://127.0.0.1:8913 PROACTIVE_MODE=off node src/e2e-proactive.ts
 *
 * off 那份**必须显式写 `PROACTIVE=0`，不能靠"不设"**：本机 `server/.env` 里开发时是开着的
 * （否则今晚就看不见主动消息），而显式环境变量 > `--env-file`，不显式关就会被它打开。
 * 脚本自己会先核一遍（不是 off 配置就当场退出），省得下次再吃一堆假 FAIL。
 *
 * 只有 cap 那份把间隔设成 0（"一天最多几条"和"一键关"才真有机会被触发到）；
 * gap 那份留着间隔，专门验"这条线还没安静够就不来"。
 * **cap / gap 的服务器必须 `TICK_INTERVAL_SEC=0`**：它们验的是"页面敲一下才来一条"，
 * 让服务端时钟在背后自己跑，那些"恰好一条"的断言就会飘。
 * **off / clock 两份必须 `TICK_INTERVAL_SEC=1`**：off 用它验"总闸关着时连时钟都不动"，
 * clock 用它验"页面一次都没叫，消息自己到了"（task-10）。
 */
const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const mode = process.env.PROACTIVE_MODE ?? '';
if (!['off', 'cap', 'gap', 'clock'].includes(mode)) throw new Error('PROACTIVE_MODE 得是 off / cap / gap / clock');

let failed = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

// --- 一个极小的 HTTP 客户端（带 cookie） ------------------------------------
type Res = { status: number; body: any; cookie: string | null };

async function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* 非 JSON 就原样留着 */ }
  return { status: res.status, body, cookie: set ? set.split(';')[0]! : null };
}

/** 读一条 SSE 流，直到 complete（或超时）。返回事件 + 每条消息 id 拼起来的话。 */
async function stream(path: string, cookie: string): Promise<{ status: number; events: any[]; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  try {
    const res = await fetch(base + path, { headers: { cookie }, signal: ctrl.signal });
    if (!res.ok || !res.body) return { status: res.status, events: [], text: '' };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const events: any[] = [];
    const texts = new Map<number, string>();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let ev: any;
        try { ev = JSON.parse(raw); } catch { continue; }
        events.push(ev);
        if (ev.type === 'delta' && typeof ev.id === 'number') {
          texts.set(ev.id, (texts.get(ev.id) ?? '') + (ev.text ?? ''));
        }
        if (ev.type === 'complete') {
          await reader.cancel();
          return { status: res.status, events, text: [...texts.values()].join('') };
        }
      }
    }
    return { status: res.status, events, text: [...texts.values()].join('') };
  } finally {
    clearTimeout(timer);
  }
}

const uniq = Date.now().toString(36);
async function register(tag: string): Promise<{ cookie: string; handle: string }> {
  const handle = `pm${tag}${uniq}`.slice(0, 12);
  const r = await req('POST', '/api/auth/register', { body: { handle, password: 'pass12345' } });
  if (!r.cookie) throw new Error(`注册失败（${r.status}）: ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, handle };
}

const anhe = 'anhe';   // PERSONAS[0]（第一位吧友）

const usage = async (cookie: string) => (await req('GET', '/api/usage', { cookie })).body ?? {};
const thread = async (cookie: string) => (await req('GET', `/api/dm/${anhe}`, { cookie })).body ?? {};
const proactiveCount = (t: any) => (t.messages ?? []).filter((m: any) => m.origin === 'proactive').length;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 反复问，直到 condition 为真或超时。time 是用来等"火忘式"的记忆更新的。 */
async function until(label: string, ms: number, condition: () => Promise<boolean>, cookie: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) {
      console.log(`    （${label} 等了 ${ms / 1000}s 还没到）`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n[1] 没登录进不来（${mode}）`);
{
  ok('未登录看开关 → 401', (await req('GET', '/api/proactive')).status === 401);
  ok('未登录改开关 → 401', (await req('PUT', '/api/proactive', { body: { enabled: false } })).status === 401);
  ok('未登录 tick → 401', (await req('POST', '/api/proactive/tick')).status === 401);
}

console.log(`\n[2] 先做一个人：加好友、说句话、等回复`);
const A = await register('a');
// off 模式：先核"这个 server 真的是 off 配置"，而且放在花 token 之前。
// 本机 .env 里 PROACTIVE 是开着的，显式环境变量 > --env-file，不显式传 PROACTIVE=0 就会被它打开，
// 后面十几条全成假 FAIL —— 不如当场说清楚、直接退出。
if (mode === 'off') {
  const st0 = await req('GET', '/api/proactive', { cookie: A.cookie });
  if (st0.body?.on !== false) {
    console.log(
      `  FAIL 这个 server 不是 off 配置（PROACTIVE 被 .env 打开了，on=${JSON.stringify(st0.body?.on)}）。` +
      `起服务时显式传 PROACTIVE=0 再跑。`,
    );
    process.exit(1);
  }
}
{
  console.log(`    注册：${A.handle}`);
  await req('POST', '/api/friends', { cookie: A.cookie, body: { slug: anhe } });

  const bad = await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: 'yes' } });
  ok('enabled 不是 true/false → 400', bad.status === 400, bad);

  // clock 模式的服务端时钟在背后跑着：先把自己的开关关掉（这也正是 [3] 第一条要验的），
  // 否则时钟可能在"先聊出一句回复"之后立刻插一条，把后面的断言全带乱。
  if (mode === 'clock') await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: false } });

  const sent = await req('POST', `/api/dm/${anhe}`, { cookie: A.cookie, body: { text: '在吗？今天有点累。' } });
  const s = await stream(`/api/dm/${anhe}/stream?after=${sent.body.userMessageId}`, A.cookie);
  ok('先聊出一句他的回复（有来有回才算"认识"）', s.text.length > 0, s.text.slice(0, 60));

  const t = await thread(A.cookie);
  const doneAgents = (t.messages ?? []).filter((m: any) => m.role === 'agent' && m.state === 'done');
  ok('线程里他回过一条', doneAgents.length === 1, t.messages);
  ok('回的那条 origin=reply', doneAgents[0]?.origin === 'reply', doneAgents[0]);

  const before = await usage(A.cookie);
  ok('聊完记了账', (before.allToday ?? 0) > 0, before);
}

// ---- off：全局总闸关着 ------------------------------------------------------
if (mode === 'off') {
  console.log(`\n[3] 总闸关着（PROACTIVE=0）：一次上游调用都不该发生`);
  {
    const st = await req('GET', '/api/proactive', { cookie: A.cookie });
    ok('on=false（全局总闸）', st.body?.on === false, st.body);
    ok('enabled=true（每个用户自己的开关默认是开的）', st.body?.enabled === true, st.body);
    ok('能力参数照实返回', st.body?.dailyMax === 1 && st.body?.minGapMin === 0, st.body);

    const before = await usage(A.cookie);
    const t1 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    ok('tick 返回空', t1.status === 200 && Array.isArray(t1.body?.messages) && t1.body.messages.length === 0, t1.body);

    const after = await usage(A.cookie);
    ok('没发生任何上游调用（账本一分没动）', after.allToday === before.allToday, { before, after });

    const t = await thread(A.cookie);
    ok('会话里没多出一条待生成', (t.messages ?? []).length === 2, t.messages);

    const on = await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: true } });
    ok('自己开回来 → enabled=true', on.body?.enabled === true, on.body);
    const t2 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    ok('子开关顶不开总闸：还是空', t2.status === 200 && (t2.body?.messages ?? []).length === 0, t2.body);
    ok('而且 on 仍然=false', t2.body?.on === false, t2.body);

    const off = await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: false } });
    ok('一键关能存下来', off.body?.enabled === false, off.body);
    ok('关掉后读回来还是关的', (await req('GET', '/api/proactive', { cookie: A.cookie })).body?.enabled === false);
  }

  console.log(`\n[4] 总闸关着的时候，服务端时钟那一轮也不许动（task-10）`);
  {
    const h = await req('GET', '/api/health');
    ok('时钟是开着的（不然后面两条是空过）', Number(h.body?.tick ?? 0) > 0, h.body);
    // 把自己那个开关**打开**：这样唯一拦着时钟的就是全局总闸，才验得出总闸
    await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: true } });
    const before = await usage(A.cookie);
    await wait(5000); // 5 秒 = 5 个时钟周期（TICK_INTERVAL_SEC=1）
    const t = await thread(A.cookie);
    ok('等了 5 个时钟周期也没冒出一条主动消息', proactiveCount(t) === 0, t.messages);
    ok('时钟那一轮一次上游调用都没发生', (await usage(A.cookie)).allToday === before.allToday, before);
  }
}

// ---- clock：页面一次都没叫（从不敲 tick，只"看"），他自己来了 -----------------
if (mode === 'clock') {
  console.log(`\n[3] 页面一次都没叫，他自己来找你了（服务端时钟，task-10）`);
  {
    const st = await req('GET', '/api/proactive', { cookie: A.cookie });
    ok('总闸开着、他自己的开关是关的（[2] 里先关掉了）', st.body?.on === true && st.body?.enabled === false, st.body);

    // 1) 自己关着 —— 时钟认这个开关，一次上游调用都不该发生
    const b0 = await usage(A.cookie);
    await wait(5000);
    ok('自己关着时时钟不叫他', proactiveCount(await thread(A.cookie)) === 0);
    ok('自己关着时一次上游调用都没发生', (await usage(A.cookie)).allToday === b0.allToday, b0);

    // 2) 打开自己的开关，然后就只"看"：整段里一次 POST /api/proactive/tick 都不敲
    await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: true } });
    const b1 = await usage(A.cookie);
    // 等的是**生成完**的那条（时钟先落一条 pending 再张嘴，只盯"有行"会撞进生成中间态，
    // 那时账还没记、text 还是 null —— 第一版就是这么假红的）
    const came = await until('主动消息自己到（生成完）', 90_000, async () => {
      const t = await thread(A.cookie);
      return (t.messages ?? []).some((m: any) => m.origin === 'proactive' && m.state === 'done');
    }, A.cookie);
    const t = await thread(A.cookie);
    const one = (t.messages ?? []).find((m: any) => m.origin === 'proactive');
    ok('页面一次都没叫，他自己来了', came && !!one, one);
    ok('来的是他、生成完了、是句人话',
      one?.role === 'agent' && one?.state === 'done' && typeof one?.text === 'string' && one.text.trim().length >= 4, one);
    ok('还没读过（好友列表上该有小红点）', one?.seen === false, one);
    const b1b = await usage(A.cookie);
    ok('时钟那一轮也记了账', (b1b.allToday ?? 0) > (b1.allToday ?? 0), { before: b1, after: b1b });
    ok('好友列表上真有未读', ((await req('GET', '/api/friends', { cookie: A.cookie })).body?.friends?.[0]?.unread ?? 0) >= 1);
    const st2 = await req('GET', '/api/proactive', { cookie: A.cookie });
    ok('sentToday 记成 1（dailyMax=1）', st2.body?.sentToday === 1 && st2.body?.dailyMax === 1, st2.body);
    if (one) console.log(`    他主动说：${String(one.text).replace(/\s+/g, ' ').slice(0, 100)}`);

    // 3) 到了当天上限：时钟再转几圈也不许动
    const b2 = await usage(A.cookie);
    await wait(6000);
    const t2 = await thread(A.cookie);
    ok('到了当天上限就不再叫', proactiveCount(t2) === 1, proactiveCount(t2));
    ok('撞上限的那几轮一次上游调用都没发生', (await usage(A.cookie)).allToday === b2.allToday, b2);
    ok('没有卡在待生成的残骸', (t2.messages ?? []).filter((m: any) => m.state === 'pending').length === 0, t2.messages);
  }

  console.log(`\n[4] 没有好友的人：一次上游调用都不许发生`);
  {
    const B = await register('b'); // 注册了，但一个好友都不加
    ok('他连好友列表都是空的', ((await req('GET', '/api/friends', { cookie: B.cookie })).body?.friends ?? []).length === 0);
    ok('他进不去单聊（不是好友）', (await req('GET', `/api/dm/${anhe}`, { cookie: B.cookie })).status === 403);
    await wait(6000);
    const b = await usage(B.cookie);
    ok('B 一分钱都没花（时钟根本没捞他）', b.userToday === 0, b);
  }
}

// ---- cap：开着，间隔=0，一天最多 3 条 ---------------------------------------
if (mode === 'cap') {
  console.log(`\n[3] 他自己来找你 + 一天最多几条 + 一键关`);
  {
    const st = await req('GET', '/api/proactive', { cookie: A.cookie });
    ok('on=true 且 enabled=true', st.body?.on === true && st.body?.enabled === true, st.body);
    ok('dailyMax=3（另外两件事才有机会被触发）', st.body?.dailyMax === 3, st.body);

    const before = await usage(A.cookie);
    const t1 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    const one = t1.body?.messages?.[0];
    ok('tick 真的来了一条', t1.status === 200 && t1.body?.messages?.length === 1, t1.body);
    ok('来的是那位吧友、内容已经生成好了', one?.slug === anhe && typeof one?.text === 'string' && one.text.trim().length > 0, one);
    // 之前这里只验"非空"，结果 2 个 token 的"吧"也算过 —— 现在要求是句人话
    ok('主动发来的是句人话（不是一两个字）', typeof one?.text === 'string' && one.text.trim().length >= 4, one?.text);
    ok('sentToday 记成 1', t1.body?.sentToday === 1, t1.body);
    if (one) console.log(`    他主动说：${String(one.text).replace(/\s+/g, ' ').slice(0, 100)}`);

    const after = await usage(A.cookie);
    ok('主动消息也记了账', (after.allToday ?? 0) > before.allToday, { before, after });

    const t = await thread(A.cookie);
    const last = t.messages?.at(-1);
    ok('这条落在会话末尾、生成完了、还没读、标着 proactive', last?.role === 'agent' && last?.state === 'done' && last?.origin === 'proactive' && last?.seen === false, last);
    ok('id 对得上', last?.id === one?.id, { last, one });

    const friends = await req('GET', '/api/friends', { cookie: A.cookie });
    ok('好友列表上有未读小红点', (friends.body?.friends?.[0]?.unread ?? 0) >= 1, friends.body?.friends?.[0]);

    // 主动那条已经生成好了：再开流只该回放，不该重新生成
    const replay = await stream(`/api/dm/${anhe}/stream?after=0`, A.cookie);
    const doneAgents = (t.messages ?? []).filter((m: any) => m.role === 'agent' && m.state === 'done');
    ok('回放时不为主动那条重开一次生成', replay.events.filter((e) => e.type === 'agent_start').length === doneAgents.length, replay.events.map((e) => e.type));
    ok('回放后会话没变长', ((await thread(A.cookie)).messages ?? []).length === (t.messages ?? []).length);

    const off = await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: false } });
    ok('一键关', off.body?.enabled === false, off.body);
    const b4 = await usage(A.cookie);
    const t2 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    ok('关掉后 tick 是空的（不然这会儿还会来一条）', t2.status === 200 && (t2.body?.messages ?? []).length === 0, t2.body);
    ok('关掉后一次上游调用都没发生', (await usage(A.cookie)).allToday === b4.allToday, b4);

    const on = await req('PUT', '/api/proactive', { cookie: A.cookie, body: { enabled: true } });
    ok('一键开回来', on.body?.enabled === true, on.body);
    const t3 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    const two = t3.body?.messages?.[0];
    ok('开回来又来了（第 2 条）', (t3.body?.messages ?? []).length === 1 && t3.body?.sentToday === 2, t3.body);
    ok('第 2 条也是句人话', typeof two?.text === 'string' && two.text.trim().length >= 4, two?.text);
    const t4 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    const three = t4.body?.messages?.[0];
    ok('第 3 条也来了（上限 3）', (t4.body?.messages ?? []).length === 1 && t4.body?.sentToday === 3, t4.body);
    ok('第 3 条也是句人话', typeof three?.text === 'string' && three.text.trim().length >= 4, three?.text);

    const b5 = await usage(A.cookie);
    const t5 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    ok('到了当天上限就不再来了', t5.status === 200 && (t5.body?.messages ?? []).length === 0, t5.body);
    ok('上限那次也没烧 token', (await usage(A.cookie)).allToday === b5.allToday, b5);

    console.log(`\n[4] 记忆开关（DM_MEMORY=1）不是按了没反应的开关`);
    {
      const got = await until('印象更新', 120_000, async () => {
        const imp = (await thread(A.cookie)).impression;
        return typeof imp === 'string' && imp.length > 0;
      }, A.cookie);
      const imp = (await thread(A.cookie)).impression;
      ok('他真的记住了这个人（impression 有内容）', got && typeof imp === 'string' && imp.length > 0, imp);
      if (got) console.log(`    他记住的：${imp}`);
    }
  }
}

// ---- gap：间隔没到就不来 ----------------------------------------------------
if (mode === 'gap') {
  console.log(`\n[3] 这条线还没安静够：能来一条，但不会接着来第二条`);
  {
    const st = await req('GET', '/api/proactive', { cookie: A.cookie });
    ok('minGapMin=1（这次留着间隔）', st.body?.minGapMin === 1, st.body);
    ok('dailyMax=5（够大，所以拦不住第二个 tick）', st.body?.dailyMax === 5, st.body);

    // 刚聊完的人不该马上又被搭话，所以这个场景要真的等过那 1 分钟
    console.log(`    等这条线安静过 1 分钟（间隔 1 分钟）…`);
    await new Promise((r) => setTimeout(r, 65_000));

    const t1 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    ok('安静够久了，来了一条', t1.status === 200 && (t1.body?.messages ?? []).length === 1, t1.body);

    const b = await usage(A.cookie);
    const t2 = await req('POST', '/api/proactive/tick', { cookie: A.cookie });
    ok('刚说完话就不会马上又来', t2.status === 200 && (t2.body?.messages ?? []).length === 0, t2.body);
    ok('被拦不是因为当天上限：sentToday=1 < dailyMax=5', t2.body?.sentToday === 1 && t2.body?.dailyMax === 5, t2.body);
    ok('被拦的那次一次上游调用都没发生', (await usage(A.cookie)).allToday === b.allToday, b);

    const t = await thread(A.cookie);
    ok('会话里只有一条主动消息', (t.messages ?? []).filter((m: any) => m.origin === 'proactive').length === 1, t.messages);
  }
}

console.log(`\n${failed === 0 ? `全部通过（${mode}）` : `${failed} 项失败（${mode}）`}\n`);
process.exit(failed === 0 ? 0 : 1);
