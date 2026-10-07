/**
 * 注册节流的端到端断言（**不碰模型**，秒过）。
 *
 * 只许通过 `e2e-serve.ts` 起一台临时 server 跑：它会往 `users` 表和"全站每天开了几个号"的
 * 计数里写东西，指着线上 8787 跑就是往真库塞垃圾账号。所以脚本自己拒绝没有 `SHUDONG_BASE` 的情况。
 *
 *   pnpm --filter @shudong/server e2e:register
 *   node src/e2e-serve.ts --script src/e2e-register.ts --env TRUST_PROXY=1 \
 *     --env REGISTER_PER_IP_HOURLY=3 --env REGISTER_PER_DAY=4
 *
 * 两种模式（同一份脚本，靠 `TRUST_PROXY` 分叉 —— harness 会把 `--env` 原样传给客户端）：
 *   `TRUST_PROXY=1`：换一个 `X-Forwarded-For` 就是一个新桶 ⇒ 验"两道闸各自的 429 原句
 *      ＋ 400/409 不计数 ＋ 被拦的号没落库"；
 *   `TRUST_PROXY=0`（默认）：XFF 谁都能伪造 ⇒ 换多少个 XFF 也是同一个桶。
 */
const base = process.env.SHUDONG_BASE;
if (!base) {
  console.error('✗ 这个脚本会往库里写账号，只许由 e2e-serve.ts 起临时 server 跑：');
  console.error('  pnpm --filter @shudong/server e2e:register');
  process.exit(1);
}

const TRUST = process.env.TRUST_PROXY === '1';
const CAP_IP = Number(process.env.REGISTER_PER_IP_HOURLY ?? -1);
const CAP_DAY = Number(process.env.REGISTER_PER_DAY ?? -1);
const PW = 'shudong-test-123';

let failures = 0;
function ok(label: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ok   ${label}${extra ? ` — ${extra}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 每个"来源"一个 cookie 罐（注册成功会种会话 cookie，用它反查是不是真建号了）。 */
type Jar = { cookie: string; xff: string };
const newJar = (xff: string): Jar => ({ cookie: '', xff });

async function api(jar: Jar, path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': jar.xff,
      ...(jar.cookie ? { cookie: jar.cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) jar.cookie = setCookie.map((c) => c.split(';')[0] ?? '').join('; ');
  return res;
}

const register = (jar: Jar, handle: string, password = PW) =>
  api(jar, '/api/auth/register', { method: 'POST', body: JSON.stringify({ handle, password }) });
const login = (jar: Jar, handle: string, password = PW) =>
  api(jar, '/api/auth/login', { method: 'POST', body: JSON.stringify({ handle, password }) });

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? '';
}

if (!TRUST) {
  // -------------------------------------------------------------------------
  // 默认档：不信任 XFF ⇒ 换多少个来源标记也只有一个桶
  // -------------------------------------------------------------------------
  if (CAP_IP !== 2 || CAP_DAY !== 0) {
    console.error(`✗ 这一档要 REGISTER_PER_IP_HOURLY=2 / REGISTER_PER_DAY=0，现在拿到 ${CAP_IP}/${CAP_DAY}`);
    process.exit(1);
  }
  console.log(`\n[默认档] TRUST_PROXY=0：X-Forwarded-For 不当来源（每来源 ${CAP_IP}/小时，全站那道关着）`);
  const handles = ['jia1', 'jia2', 'jia3'];
  const status: number[] = [];
  for (let i = 0; i < handles.length; i++) {
    // 每一条都换一个 XFF —— 信它的话第 3 条就该过，不信它第 3 条就该拦
    const res = await register(newJar(`10.0.0.${i + 1}`), handles[i]!);
    status.push(res.status);
  }
  ok('前 2 条放行、第 3 条被拦（换了 3 个 XFF 也只有一个桶）',
    status[0]! < 300 && status[1]! < 300 && status[2] === 429, `status=${status.join(' | ')}`);

  const spoof = newJar('10.0.0.99');
  const res = await register(spoof, 'jia9');
  ok('再伪造一个新 XFF 也拿不到额度', res.status === 429, `status=${res.status}`);
  ok('此时压根没多余账号落库（新伪造的来源也登不上）',
    (await login(newJar('10.0.0.99'), 'jia9')).status === 401);
} else {
  // -------------------------------------------------------------------------
  // 真档：认 XFF 最后一段 ⇒ 两道闸各自的 429 原句都能看到
  // -------------------------------------------------------------------------
  if (CAP_IP !== 3 || CAP_DAY !== 4) {
    console.error(`✗ 这一档要 REGISTER_PER_IP_HOURLY=3 / REGISTER_PER_DAY=4，现在拿到 ${CAP_IP}/${CAP_DAY}`);
    process.exit(1);
  }
  console.log(`\n[真档] TRUST_PROXY=1：来源＝XFF 最后一段（每来源 ${CAP_IP}/小时，全站 ${CAP_DAY}/天）`);

  const A = '203.0.113.7';
  const B = '198.51.100.9';
  const jarA = newJar(A);
  const jarB = newJar(B);

  console.log('\n[1] 正常注册照常（两道闸都别误伤真人）');
  {
    const res = await register(jarA, 'jia1');
    const me = (await (await api(jarA, '/api/me')).json()) as { user?: { handle?: string } | null };
    ok('第一个号注册成功且种下了会话 cookie', res.status < 300 && !!jarA.cookie, `status=${res.status}`);
    ok('/api/me 拿回来就是这个号（注册这条链是通的，不只是回了个 id）',
      me.user?.handle === 'jia1', `handle=${me.user?.handle ?? 'null'}`);
  }

  console.log('\n[2] 400/409 都不算数（填错一个字不该被罚）');
  {
    const dup = await register(jarA, 'jia1');
    ok('同名再注册 409', dup.status === 409, `status=${dup.status} error="${await errorOf(dup)}"`);
    const bad = await register(jarA, 'x');
    ok('网名不合法 400', bad.status === 400, `status=${bad.status} error="${await errorOf(bad)}"`);
    const badPw = await register(jarA, 'jia5', 'short');
    ok('密码太短 400', badPw.status === 400, `status=${badPw.status} error="${await errorOf(badPw)}"`);
  }

  console.log(`\n[3] 同一个来源的第 ${CAP_IP + 1} 个号被拦（上面那几条 400/409 没占额度）`);
  {
    const r2 = await register(jarA, 'jia2');
    const r3 = await register(jarA, 'jia3');
    ok(`第 2、3 个号成功（若 400/409 也计数，这两个就该被拦）`,
      r2.status < 300 && r3.status < 300, `status=${r2.status} | ${r3.status}`);
    const r4 = await register(jarA, 'jia4');
    const err = await errorOf(r4);
    ok('第 4 个号 429 拦住', r4.status === 429, `status=${r4.status} error="${err}"`);
    ok('给的是"这个网络开号开得太快了"那句（不是全站那句）',
      /^这个网络开号开得太快了，过 \d+ 分钟再来$/.test(err), err);
    const wait = Number(err.match(/过 (\d+) 分钟/)?.[1] ?? 0);
    ok('等待时间在 1~60 分钟之间（一小时窗口）', wait >= 1 && wait <= 60, `waitMin=${wait}`);
    ok('被拦的响应里没有会话 cookie（不许拦一半还把人登进去）',
      r4.headers.getSetCookie().length === 0);
  }

  console.log(`\n[4] 全站每天那道：别人换个来源也开不了（今天已经 ${CAP_DAY} 个号）`);
  {
    const b1 = await register(jarB, 'yi1');
    ok(`第 ${CAP_DAY} 个号刚好开出来（换个来源是真的新桶）`, b1.status < 300, `status=${b1.status}`);
    const b2 = await register(jarB, 'yi2');
    const err = await errorOf(b2);
    ok('下一个 429 拦住', b2.status === 429, `status=${b2.status} error="${err}"`);
    ok('给的是"今天洞里的新号满了"那句（全站那道）', err === '今天洞里的新号满了，明天再来', err);
  }

  console.log('\n[5] 被拦下来的号一个都没落库');
  {
    for (const h of ['jia4', 'yi2']) {
      const res = await login(newJar(A), h);
      ok(`${h} 登不上（密码是对的也 401）`, res.status === 401, `status=${res.status} error="${await errorOf(res)}"`);
    }
    // 已经建成的号当然还能登（别把闸门做成"注册完就登不进"）
    const good = await login(newJar(A), 'jia1');
    ok('已注册的号照常登录 200（闸门只拦开号）', good.status === 200, `status=${good.status}`);
  }

  console.log('\n[6] 按钟点返回此刻在洞里的吧友');
  {
    const online = async (hour: string) => {
      const res = await api(jarA, `/api/agents/online?hour=${hour}`);
      return { res, body: (await res.json().catch(() => ({}))) as { agents?: { slug?: string; name?: string }[] } };
    };
    const a = await online('3');
    const b = await online('13');
    const d = await online('20');
    const slugs = (x: { agents?: { slug?: string }[] }) => (x.agents ?? []).map((p) => p.slug ?? '');
    const sa = slugs(a.body), sb = slugs(b.body), sd = slugs(d.body);
    ok('早/午/晚三档各返回 4 位且集合两两不同',
      a.res.status === 200 && b.res.status === 200 && d.res.status === 200
        && sa.length === 4 && sb.length === 4 && sd.length === 4
        && new Set(sa).size === 4 && new Set(sb).size === 4 && new Set(sd).size === 4
        && sa.every((s) => !sb.includes(s)) && sa.every((s) => !sd.includes(s)) && sb.every((s) => !sd.includes(s)),
      `${sa.join(',')} | ${sb.join(',')} | ${sd.join(',')}`);
    const anon = await api(newJar('203.0.113.8'), '/api/agents/online?hour=3');
    ok('未登录访问在线集合 → 401', anon.status === 401, `status=${anon.status}`);
    const bad24 = await api(jarA, '/api/agents/online?hour=24');
    const badText = await api(jarA, '/api/agents/online?hour=abc');
    ok('hour=24 / hour=abc → 400', bad24.status === 400 && badText.status === 400,
      `24=${bad24.status} abc=${badText.status}`);
  }
}

console.log(failures === 0 ? '\n注册节流正常。\n' : `\n有 ${failures} 项没过。\n`);
process.exit(failures === 0 ? 0 : 1);
