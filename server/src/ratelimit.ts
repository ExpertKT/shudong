/**
 * 注册节流的两把尺子（`index.ts` 的注册路由用，顺序是 **校验 → 重名 → 节流 → scrypt+入库**）。
 *
 * ① **同来源每小时**：进程内存里的滑动窗口，形状照抄 `auth.ts` 的登录节流（第一个请求开窗、
 *    窗口过期就重建）。单个来源也就几条记录，不落库。「来源」怎么认见 `clientKey`。
 * ② **全站每天**：不在这里，是 `users` 表上的一句 `COUNT(*)`（`index.ts` 里），
 *    **落库、重启不炸** —— 这道才是真在公网上挡批量注册的闸；①只是挡"同一条网线/本机脚本"。
 *
 * 两道的免费项一致：**400（网名/密码不合法）与 409（网名被占）都不计数** ——
 * 填错一个字就被罚，正常用户会先撞上这道墙。
 *
 * 为什么不放在 `auth.ts`：那里是"会话与密码"，这里是"开号频率"，各管一摊；
 * 另外 `makeLimiter` 是纯的（时钟可注入），`test-hardening.ts` 不用起 server 就能验。
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { env } from './env.ts';

export const REGISTER_WINDOW_MS = 60 * 60_000;
export const REGISTER_DAY_MS = 24 * 60 * 60_000;

export type LimitVerdict = { ok: true } | { ok: false; waitMin: number };

export type Limiter = {
  /** 记一次并判：没超就 ok，超了给出"还要等几分钟"。 */
  take(key: string): LimitVerdict;
  /** 现在记着几个来源（给测试看；产品路径不用）。 */
  size(): number;
};

/**
 * 每 `key` 每 `windowMs` 最多 `limit` 次。`limit <= 0` = 不限额（env 里 0 就是这个意思）。
 * `now` 可注入，所以测试不用等真实时间。
 */
export function makeLimiter(limit: number, windowMs: number, now: () => number = Date.now): Limiter {
  const hits = new Map<string, { n: number; first: number }>();
  return {
    take(key) {
      if (limit <= 0) return { ok: true };
      const t = now();
      const h = hits.get(key);
      if (!h || t - h.first > windowMs) {
        hits.set(key, { n: 1, first: t });
        return { ok: true };
      }
      if (h.n >= limit) {
        return { ok: false, waitMin: Math.max(1, Math.ceil((windowMs - (t - h.first)) / 60_000)) };
      }
      h.n++;
      return { ok: true };
    },
    size: () => hits.size,
  };
}

export const registerLimiter = makeLimiter(env.registerPerIpHourly, REGISTER_WINDOW_MS);

/**
 * 这次请求算哪个来源。
 *
 * 默认**只认 socket 地址**（`getConnInfo`，与 `board.ts` 的 `isLocal` 同一个来源）。
 * `X-Forwarded-For` 是客户端自己写得出来的，所以默认一个字都不看 —— 信它等于让刷号的人
 * 自己决定"我算几个 IP"。只有 `TRUST_PROXY=1`（确认前面那一跳会追加 XFF）时才读，
 * 而且**只认最后一段**：前面几段是客户端自己塞的，最后一段才是那跳反代写进去的。
 *
 * 拿不到地址时统一算 `unknown`（宁可所有匿名来源共用一个桶，也不要各算各的、等于没限）。
 */
export function clientKey(c: Context): string {
  if (env.trustProxy) {
    const last = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
