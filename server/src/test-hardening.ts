/**
 * "上线前那两道闸"的断言 —— **不起 server、不连库、不碰模型**（纯模块 + 子进程）。
 *
 * 验三件事：
 *   ① 注册节流那把尺子（`ratelimit.ts` 的 `makeLimiter`）：到点就拦、窗口过了自己松开、
 *      两个来源各算各的、`0 = 不限额`（别把闸门悄悄关上）；
 *   ② 会话密钥的取法（`env.ts` 的 `secret`）：没设密钥时**用的是那串公开的开发密钥**
 *      （所以启动日志必须喊 —— 这里只验取值本身）、`NODE_ENV=production` 时没设就直接拒绝启动；
 *   ③ `SESSION_SECRET_OLD` 只验不签（`auth.ts` 的 `readSession`）：旧密钥签的 cookie 还认、
 *      当前密钥签的照常认、**别的密钥签的不认**（它是口子，不是万能钥匙）。
 *
 * 环境变量在 `import` 时就定了，所以密钥那几条只能开子进程验；子进程把结论写进一个临时文件
 * （不用管道：受限沙箱里 node 抓 node 的管道会 EPERM），父进程读回来。
 *
 * 跑法：`pnpm --filter @shudong/server test:hardening`
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLimiter } from './ratelimit.ts';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join('F:\\tmp', `hardening-${process.pid}.json`);

let failed = 0;
function ok(label: string, cond: boolean, extra = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
}

// ---------------------------------------------------------------------------
// ① 同来源那把尺子
// ---------------------------------------------------------------------------
console.log('\n[1] 注册节流：每来源每窗口 N 次（时钟注入，不等真实时间）');
{
  let t = 1_000_000;
  const clock = () => t;
  const lim = makeLimiter(3, 60 * 60_000, clock);

  const v1 = lim.take('a');
  const v2 = lim.take('a');
  const v3 = lim.take('a');
  const v4 = lim.take('a');
  ok('前 3 次放行、第 4 次拦住', v1.ok && v2.ok && v3.ok && !v4.ok);
  ok('拦住时给出"还要等几分钟"（1~60 之间）',
    !v4.ok && v4.waitMin >= 1 && v4.waitMin <= 60, v4.ok ? '' : `waitMin=${v4.waitMin}`);

  t += 30 * 60_000;
  const half = lim.take('a');
  ok('窗口过一半仍在拦（等待时间随剩余时间缩短）', !half.ok && half.waitMin === 30, !half.ok ? `waitMin=${half.waitMin}` : '');

  ok('另一个来源照常放行（不是全站一个桶）', lim.take('b').ok, `size=${lim.size()}`);

  t += 30 * 60_000 + 1;
  ok('窗口（从第一次请求算起）过完自己松开', lim.take('a').ok);

  const off = makeLimiter(0, 60_000, clock);
  let allOk = true;
  for (let i = 0; i < 1000; i++) allOk = allOk && off.take('x').ok;
  ok('0 = 不限额，别把闸门悄悄关上（连打 1000 次全放行）', allOk && off.size() === 0);
}

// ---------------------------------------------------------------------------
// ②③ 密钥：换环境就得换进程（`env.ts` 在 import 时就定下了）
// ---------------------------------------------------------------------------
/** 开一个子进程跑 `code`（ESM），把它的结论从 `PROBE` 读回来。 */
const ERR = join('F:\\tmp', `hardening-${process.pid}.err.txt`);
function probe(envPatch: Record<string, string>, code: string): { status: number | null; data: any; stderr: string } {
  rmSync(PROBE, { force: true });
  // 不动管道（受限沙箱里 node 抓 node 的管道会 EPERM）：结论走文件、stderr 也走文件。
  const errFd = openSync(ERR, 'w');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: serverDir,
    env: { ...process.env, ...envPatch, PROBE_OUT: PROBE },
    stdio: ['ignore', 'ignore', errFd],
    windowsHide: true,
  });
  closeSync(errFd);
  const data = existsSync(PROBE) ? JSON.parse(readFileSync(PROBE, 'utf8')) : null;
  return { status: r.status, data, stderr: readFileSync(ERR, 'utf8') };
}

const READ_ENV = `import { writeFileSync } from 'node:fs';
const { env } = await import('./src/env.ts');
writeFileSync(process.env.PROBE_OUT, JSON.stringify({ len: env.sessionSecret.length, isDev: env.sessionSecretIsDev, old: env.sessionSecretOld.length }));
`;

console.log('\n[2] 密钥从哪来（起子进程验，环境变量在 import 时就定了）');
delete process.env.SESSION_SECRET;
{
  const dev = probe({ SESSION_SECRET: '', SESSION_SECRET_OLD: '', NODE_ENV: '' }, READ_ENV);
  ok('没设 SESSION_SECRET 时用的是那把公开的开发密钥（长度 24、isDev=true）',
    dev.status === 0 && dev.data?.len === 24 && dev.data?.isDev === true,
    `exit=${dev.status} ${JSON.stringify(dev.data)}`);

  const weak = probe({ SESSION_SECRET: 'too-short', NODE_ENV: '' }, READ_ENV);
  ok('设了但不足 16 字，一样当没设（退回开发密钥）', weak.data?.isDev === true && weak.data?.len === 24, JSON.stringify(weak.data));

  const prod = probe({ SESSION_SECRET: '', NODE_ENV: 'production' }, READ_ENV);
  ok('生产环境没设密钥 ⇒ 直接拒绝启动', prod.status !== 0 && /SESSION_SECRET/.test(prod.stderr),
    `exit=${prod.status} ${prod.stderr.split(/\r?\n/).find((l) => l.includes('SESSION_SECRET')) ?? ''}`);

  const good = probe({ SESSION_SECRET: 'a'.repeat(64), NODE_ENV: 'production' }, READ_ENV);
  ok('生产环境设了 64 字随机串 ⇒ 正常起来且不再是开发密钥',
    good.status === 0 && good.data?.len === 64 && good.data?.isDev === false, `exit=${good.status} ${JSON.stringify(good.data)}`);
}

console.log('\n[3] SESSION_SECRET_OLD：只验不签，是口子不是万能钥匙');
{
  // auth.ts 的 readSession 只认 HMAC，这里就手算一把"旧密钥签的 cookie"。
  const exp = Date.now() + 86_400_000;
  const payload = `7.${exp}`;
  const oldMac = createHmac('sha256', 'o'.repeat(32)).update(payload).digest('base64url');
  const curMac = createHmac('sha256', 'c'.repeat(32)).update(payload).digest('base64url');
  const strangerMac = createHmac('sha256', 'x'.repeat(32)).update(payload).digest('base64url');
  const past = Date.now() - 1000;
  const oldPastMac = createHmac('sha256', 'o'.repeat(32)).update(`7.${past}`).digest('base64url');

  const READ_SESSION = `import { writeFileSync } from 'node:fs';
const { readSession } = await import('./src/auth.ts');
const t = (m) => readSession(\`7.\${process.env.PROBE_EXP}.\${m}\`);
writeFileSync(process.env.PROBE_OUT, JSON.stringify({ old: t(process.env.PROBE_OLD), cur: t(process.env.PROBE_CUR), stranger: t(process.env.PROBE_STRANGER) }));
`;
  const withOld = probe(
    {
      SESSION_SECRET: 'c'.repeat(32), SESSION_SECRET_OLD: 'o'.repeat(32),
      PROBE_EXP: String(exp), PROBE_OLD: oldMac, PROBE_CUR: curMac, PROBE_STRANGER: strangerMac,
    },
    READ_SESSION,
  );
  ok('旧密钥签的 cookie 仍认（换密钥时留一个发布周期用）', withOld.data?.old === 7, JSON.stringify(withOld.data));
  ok('当前密钥签的照常认', withOld.data?.cur === 7, JSON.stringify(withOld.data));
  ok('既不是当前也不是旧密钥签的 ⇒ 不认', withOld.data?.stranger === null, `stranger=${JSON.stringify(withOld.data?.stranger)}`);

  const withoutOld = probe(
    {
      SESSION_SECRET: 'c'.repeat(32), SESSION_SECRET_OLD: '',
      PROBE_EXP: String(exp), PROBE_OLD: oldMac, PROBE_CUR: curMac, PROBE_STRANGER: strangerMac,
    },
    READ_SESSION,
  );
  ok('没设 SESSION_SECRET_OLD（本次上线的样子）⇒ 旧 cookie 立刻不认，硬切',
    withoutOld.data?.old === null && withoutOld.data?.cur === 7, JSON.stringify(withoutOld.data));

  const expired = probe(
    { SESSION_SECRET: 'c'.repeat(32), SESSION_SECRET_OLD: 'o'.repeat(32), PROBE_EXP: String(past), PROBE_OLD: oldPastMac, PROBE_CUR: curMac, PROBE_STRANGER: strangerMac },
    READ_SESSION,
  );
  ok('就算签名对，过期了也不认', expired.data?.old === null, `old=${JSON.stringify(expired.data?.old)}`);

  const sameKey = probe({ SESSION_SECRET: 'o'.repeat(32), SESSION_SECRET_OLD: 'o'.repeat(32) }, READ_ENV);
  ok('SESSION_SECRET_OLD 跟当前密钥相同就不算旧密钥（省得自欺欺人）', sameKey.data?.old === 0, JSON.stringify(sameKey.data));
}

rmSync(PROBE, { force: true });
rmSync(ERR, { force: true });
console.log(failed ? `\n${failed} 条失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
