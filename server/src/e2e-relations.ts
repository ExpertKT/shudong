/**
 * M1 端到端：加好友 → 单独聊天 → 刷新不丢。
 *
 * 跟 e2e.ts 一样，对着**已经跑起来**的 server 发 HTTP 请求（临时端口 + 临时库）：
 *   $env:PORT='8899'; $env:SHUDONG_DB='F:\tmp\dm-e2e.db'; pnpm start
 *   $env:SHUDONG_BASE='http://127.0.0.1:8899'; pnpm e2e:relations
 *
 * 要真花 token（真的调上游生成回复），所以要配好 .env 里的 key。
 */
const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;

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
  const handle = `dm${tag}${uniq}`.slice(0, 12);
  const r = await req('POST', '/api/auth/register', { body: { handle, password: 'pass12345' } });
  if (!r.cookie) throw new Error(`注册失败（${r.status}）: ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, handle };
}

const anhe = 'anhe';   // PERSONAS[0]（第一位吧友）

// ---------------------------------------------------------------------------
console.log(`\n[1] 没登录 / 参数不对`);
{
  const r = await req('POST', '/api/friends', { body: { slug: anhe } });
  ok('未登录加好友 → 401', r.status === 401, r);
}

const A = await register('a');
console.log(`    注册 A：${A.handle}`);

console.log(`\n[2] 加好友`);
{
  const bad = await req('POST', '/api/friends', { cookie: A.cookie, body: { slug: 'nobody-here' } });
  ok('加不存在的吧友 → 400', bad.status === 400, bad);

  const r1 = await req('POST', '/api/friends', { cookie: A.cookie, body: { slug: anhe } });
  ok('加好友成功', r1.status === 200 && r1.body?.ok === true, r1);

  const r2 = await req('POST', '/api/friends', { cookie: A.cookie, body: { slug: anhe } });
  ok('重复加好友是幂等的', r2.status === 200 && r2.body?.ok === true, r2);

  const list = await req('GET', '/api/friends', { cookie: A.cookie });
  ok('好友列表里有他', list.body?.friends?.length === 1 && list.body.friends[0].slug === anhe, list.body);
  ok('新好友未读为 0', list.body?.friends?.[0]?.unread === 0, list.body);
}

console.log(`\n[3] 没加好友进不去单聊`);
{
  const B = await register('b');
  const r = await req('GET', `/api/dm/${anhe}`, { cookie: B.cookie });
  ok('非好友看单聊 → 403', r.status === 403, r);

  const r2 = await req('GET', `/api/dm/nobody-here`, { cookie: A.cookie });
  ok('未知吧友 → 404', r2.status === 404, r2);
}

console.log(`\n[4] 发消息 + 生成回复`);
let firstText = '';
let agentId = 0;
{
  const empty = await req('POST', `/api/dm/${anhe}`, { cookie: A.cookie, body: { text: '   ' } });
  ok('空消息 → 400', empty.status === 400, empty);

  const long = await req('POST', `/api/dm/${anhe}`, { cookie: A.cookie, body: { text: '字'.repeat(2001) } });
  ok('超长消息 → 400', long.status === 400, long);

  const sent = await req('POST', `/api/dm/${anhe}`, { cookie: A.cookie, body: { text: '在吗？今天有点累。' } });
  ok('发消息成功', sent.status === 200 && typeof sent.body?.agentMessageId === 'number', sent);
  agentId = sent.body?.agentMessageId;

  const s = await stream(`/api/dm/${anhe}/stream?after=${sent.body.userMessageId}`, A.cookie);
  ok('流里有 agent_start', s.events.some((e) => e.type === 'agent_start' && e.id === agentId), s.events.map((e) => e.type));
  ok('流里有 delta', s.events.some((e) => e.type === 'delta' && e.text), s.events.length);
  ok('流以 done + complete 收尾', s.events.some((e) => e.type === 'done') && s.events.at(-1)?.type === 'complete', s.events.at(-1));
  ok('真的生成了内容', s.text.length > 0, s.text.slice(0, 80));
  firstText = s.text;
  console.log(`    他回：${s.text.replace(/\s+/g, ' ').slice(0, 100)}`);
}

console.log(`\n[5] 刷新不丢：重连只回放、不重新生成`);
{
  const again = await stream(`/api/dm/${anhe}/stream?after=0`, A.cookie);
  ok('重连回放的内容跟第一次一模一样', again.text === firstText && firstText.length > 0, { firstText, againText: again.text });
  ok('重连没有再生成第二条', again.events.filter((e) => e.type === 'agent_start').length === 1, again.events.length);

  const thread = await req('GET', `/api/dm/${anhe}`, { cookie: A.cookie });
  const msgs = thread.body?.messages ?? [];
  ok('会话里有 1 条我 + 1 条他', msgs.length === 2, msgs);
  ok('角色对得上', msgs[0]?.role === 'user' && msgs[1]?.role === 'agent', msgs.map((m: any) => m.role));
  ok('两条都已生成完', msgs.every((m: any) => m.state === 'done' && typeof m.text === 'string' && m.text.length > 0), msgs);
  ok('返回的头像/资料是那位吧友', thread.body?.agent?.slug === anhe && typeof thread.body.agent?.name === 'string', thread.body?.agent);
  ok('好友标记为真', thread.body?.friend === true, thread.body?.friend);
}

console.log(`\n[6] 连发不排一队回复`);
{
  const m3 = await req('POST', `/api/dm/${anhe}`, { cookie: A.cookie, body: { text: '顺便问一句。' } });
  const m4 = await req('POST', `/api/dm/${anhe}`, { cookie: A.cookie, body: { text: '还有一句。' } });
  ok('连发复用同一条待生成回复', m3.body?.agentMessageId === m4.body?.agentMessageId, [m3.body, m4.body]);

  const s = await stream(`/api/dm/${anhe}/stream?after=${m3.body.userMessageId}`, A.cookie);
  ok('只生成一条回复', s.events.filter((e) => e.type === 'agent_start').length === 1, s.events.map((e) => e.type));

  const thread = await req('GET', `/api/dm/${anhe}`, { cookie: A.cookie });
  const agentRows = (thread.body?.messages ?? []).filter((m: any) => m.role === 'agent');
  ok('会话里一共 2 条他的回复（不是 3 条）', agentRows.length === 2, agentRows.length);
}

console.log(`\n[7] 未读小红点`);
{
  const before = await req('GET', '/api/friends', { cookie: A.cookie });
  ok('他说话后未读 >= 1', (before.body?.friends?.[0]?.unread ?? 0) >= 1, before.body);

  const seen = await req('POST', `/api/dm/${anhe}/seen`, { cookie: A.cookie });
  ok('标记已读成功', seen.status === 200, seen);

  const after = await req('GET', '/api/friends', { cookie: A.cookie });
  ok('标记后未读归零', after.body?.friends?.[0]?.unread === 0, after.body);
  ok('最后一条消息摘要出现在好友列表', typeof after.body?.friends?.[0]?.lastText === 'string' && after.body.friends[0].lastText.length > 0, after.body?.friends?.[0]);
}

console.log(`\n[8] 别人看不到我的单聊`);
{
  const B = await register('c');
  ok('陌生人非好友 → 403', (await req('GET', `/api/dm/${anhe}`, { cookie: B.cookie })).status === 403);
  await req('POST', '/api/friends', { cookie: B.cookie, body: { slug: anhe } });
  const bThread = await req('GET', `/api/dm/${anhe}`, { cookie: B.cookie });
  ok('他加了同一个吧友，但会话是空的', (bThread.body?.messages ?? []).length === 0, bThread.body?.messages);
}

console.log(`\n[9] 花费记了账`);
{
  const usage = await req('GET', '/api/usage', { cookie: A.cookie });
  ok('全站今天花掉 > 0', (usage.body?.allToday ?? 0) > 0, usage.body);
  ok('单聊的花费也记在这个用户头上（不再掉出每用户额度）', (usage.body?.userToday ?? 0) > 0, usage.body);
  console.log(`    ${JSON.stringify(usage.body)}`);
}

console.log(`\n[10] 删好友就进不去了`);
{
  const del = await req('DELETE', `/api/friends/${anhe}`, { cookie: A.cookie });
  ok('删好友成功', del.status === 200, del);
  ok('删完再进单聊 → 403', (await req('GET', `/api/dm/${anhe}`, { cookie: A.cookie })).status === 403);
  const again = await req('DELETE', `/api/friends/${anhe}`, { cookie: A.cookie });
  ok('重复删不会崩', again.status === 200, again);
  ok('删未知吧友 → 404', (await req('DELETE', '/api/friends/nobody-here', { cookie: A.cookie })).status === 404);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);
