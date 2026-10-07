/**
 * 只验登录节流：对**已经跑起来**的 server 打，不碰模型，秒过。
 *
 * 前置：服务端和本脚本要用同一个 LOGIN_MAX_FAILS 起。默认 8 也能跑，就是多打几次：
 *   $env:LOGIN_MAX_FAILS='3'; pnpm --filter @shudong/server dev
 *   $env:LOGIN_MAX_FAILS='3'; pnpm --filter @shudong/server e2e:auth
 */
const base = process.env.SHUDONG_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const MAX = Number(process.env.LOGIN_MAX_FAILS ?? 8);
const PW = 'shudong-test-123';

let failures = 0;

function ok(label: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  ok   ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 每个身份一个 cookie 罐 —— 这个脚本要同时扮演好几个人。 */
type Jar = { cookie: string };
const newJar = (): Jar => ({ cookie: '' });

async function api(jar: Jar, path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(jar.cookie ? { cookie: jar.cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) jar.cookie = setCookie.map((c) => c.split(';')[0] ?? '').join('; ');
  return res;
}

const login = (jar: Jar, handle: string, password: string) =>
  api(jar, '/api/auth/login', { method: 'POST', body: JSON.stringify({ handle, password }) });

const register = (jar: Jar, handle: string, password = PW) =>
  api(jar, '/api/auth/register', { method: 'POST', body: JSON.stringify({ handle, password }) });

const stamp = Date.now() % 100000;
const victim = `甲的号${stamp}`;
const bystander = `乙的号${stamp}`;
const ghost = `根本没这个人${stamp}`;

console.log(`\n[1] 先有两个真账号（节流上限 LOGIN_MAX_FAILS=${MAX}）`);
{
  const a = await register(newJar(), victim);
  const b = await register(newJar(), bystander);
  ok('两个账号都注册上了', a.status < 300 && b.status < 300, `victim=${a.status} bystander=${b.status}`);
}

console.log(`\n[2] 对着真网名连错 ${MAX} 次密码`);
{
  const jar = newJar();
  let lastStatus = 0;
  let lastBody = '';
  for (let i = 0; i < MAX; i++) {
    const res = await login(jar, victim, `wrong-password-${i}`);
    lastStatus = res.status;
    lastBody = JSON.stringify(await res.json());
  }
  ok(
    `错了 ${MAX} 次都只是 401，还没封`,
    lastStatus === 401,
    `status=${lastStatus} ${lastBody}`,
  );
}

console.log('\n[3] 这时候就算密码是对的，也得先等着');
{
  const res = await login(newJar(), victim, PW);
  const body = (await res.json()) as { error?: string };
  ok('429 拦住了', res.status === 429, `status=${res.status} error="${body.error ?? ''}"`);
  ok('给出了还要等多久', /\d+\s*分钟后再试/.test(body.error ?? ''), body.error ?? '');
}

console.log('\n[4] 别误伤别人：另一个账号照常登录');
{
  const res = await login(newJar(), bystander, PW);
  ok('旁观者正常登录 200', res.status === 200, `status=${res.status}`);
}

console.log('\n[5] 不存在的网名也照样节流（否则 429 就成了"这个网名是真的"的探针）');
{
  const jar = newJar();
  for (let i = 0; i < MAX; i++) await login(jar, ghost, `wrong-${i}`);
  const res = await login(jar, ghost, PW);
  ok('不存在的网名一样被拦', res.status === 429, `status=${res.status}`);
}

console.log('\n[6] 没到上限时登录成功，失败次数要清零');
{
  const jar = newJar();
  for (let i = 0; i < Math.max(0, MAX - 1); i++) await login(jar, bystander, `wrong-${i}`);
  const good = await login(jar, bystander, PW);
  ok(`错了 ${MAX - 1} 次后仍能登录成功`, good.status === 200, `status=${good.status}`);

  const jar2 = newJar();
  for (let i = 0; i < Math.max(0, MAX - 1); i++) await login(jar2, bystander, `wrong-${i}`);
  const good2 = await login(jar2, bystander, PW);
  ok('上次的失败记录没留着（成功一次就清零）', good2.status === 200, `status=${good2.status}`);
}

console.log(failures === 0 ? '\n节流正常。\n' : `\n有 ${failures} 项没过。\n`);
process.exitCode = failures === 0 ? 0 : 1;
