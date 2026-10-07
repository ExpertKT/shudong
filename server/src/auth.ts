import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from './env.ts';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [algo, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sign = (payload: string) => createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');

/** 只用来**验**旧密钥签出来的 cookie；签发永远只用当前那把（否则换密钥等于没换）。 */
const signOld = (payload: string) => createHmac('sha256', env.sessionSecretOld).update(payload).digest('base64url');

/** 等长比较；长度不同直接 false（`timingSafeEqual` 长度不等会抛）。 */
const macMatches = (mac: string, expected: string) =>
  mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected));

/** 无状态会话：userId.过期时间戳.签名 —— 不用建 session 表。 */
export function signSession(userId: number): string {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function readSession(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [idStr, expStr, mac] = parts as [string, string, string];
  const payload = `${idStr}.${expStr}`;
  // 当前密钥优先；没验过再试旧密钥（`SESSION_SECRET_OLD`，默认没设 ⇒ 这段等于不存在）。
  if (!macMatches(mac, sign(payload)) && !(env.sessionSecretOld && macMatches(mac, signOld(payload)))) {
    return null;
  }
  if (Number(expStr) < Date.now()) return null;
  const id = Number(idStr);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (env.cookieSecure) flags.push('Secure');
  return `sd_session=${token}; ${flags.join('; ')}`;
}

export const COOKIE_NAME = 'sd_session';

// ---------------------------------------------------------------------------
// 登录失败节流
//
// 没有这道闸，知道网名就能无限次猜密码 —— 上线前这是硬伤，不是可选项。
// 只在内存里，进程重启就清空：单进程部署够用，多实例要挪到表里。
// 失败的网名**存不存在的都记**：只拦存在的网名，等于用 429 告诉人家哪个网名是真的。
// ---------------------------------------------------------------------------
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = env.loginMaxFails;
const attempts = new Map<string, { n: number; first: number }>();

const attemptKey = (handle: string) => handle.toLowerCase();

/** 还要等几分钟才能再试；0 = 没被拦。 */
export function loginWaitMinutes(handle: string): number {
  if (MAX_FAILS <= 0) return 0;
  const a = attempts.get(attemptKey(handle));
  if (!a) return 0;
  const elapsed = Date.now() - a.first;
  if (elapsed > FAIL_WINDOW_MS) {
    attempts.delete(attemptKey(handle));
    return 0;
  }
  return a.n >= MAX_FAILS ? Math.max(1, Math.ceil((FAIL_WINDOW_MS - elapsed) / 60_000)) : 0;
}

export function noteLoginFailure(handle: string): void {
  if (MAX_FAILS <= 0) return;
  const k = attemptKey(handle);
  const a = attempts.get(k);
  if (!a || Date.now() - a.first > FAIL_WINDOW_MS) attempts.set(k, { n: 1, first: Date.now() });
  else a.n++;
}

export function clearLoginFailures(handle: string): void {
  attempts.delete(attemptKey(handle));
}
