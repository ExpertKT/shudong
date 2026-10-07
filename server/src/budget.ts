/**
 * 成本闸门。`usage` 表是账本，这个文件是**唯一**读它的地方，也是**唯一**判断
 * "还能不能再花"的地方 —— 闸门只有一处，才不会出现某条路径漏过去。
 *
 * 口径是 token 而不是钱：换模型/换供应商时单价会变，token 是唯一稳定的量。
 * 以后要按钱算，就在 usage 表加一列 cost（落账时按当时的单价算好），改这里两个 SQL。
 */
import { db } from './db.ts';
import { env } from './env.ts';

/** 本机时区的今天 0 点。 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 每用户的今日开销。
 *
 * 两个匹配口都要，不是一个：
 * - `u.user_id` 是落账时写下的，**私聊/主动来消息也要写**（它们没有 post_id）；
 * - `p.user_id` 是历史行（加 user_id 这一列之前落的账）唯一的来源。
 * 所以是 LEFT JOIN + OR：漏了前一个口，私聊就绕过每用户额度；漏了后一个口，
 * 老账会凭空少算。
 */
const usedByUser = db.prepare(
  `SELECT COALESCE(SUM(u.prompt_tokens + u.completion_tokens), 0) AS n
     FROM usage u LEFT JOIN posts p ON p.id = u.post_id
    WHERE (u.user_id = ? OR p.user_id = ?) AND u.created_at >= ?`,
);
const usedAll = db.prepare(
  `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM usage WHERE created_at >= ?`,
);

export type Ledger = { userToday: number; allToday: number; userLimit: number; globalLimit: number };

export function spent(userId: number): Ledger {
  const since = startOfToday();
  const u = usedByUser.get(userId, userId, since) as { n: number } | undefined;
  const a = usedAll.get(since) as { n: number } | undefined;
  return {
    userToday: u?.n ?? 0,
    allToday: a?.n ?? 0,
    userLimit: env.userDailyTokens,
    globalLimit: env.globalDailyTokens,
  };
}

/**
 * 还能不能再花。可以花返回 null，否则返回一句给用户看的话。
 * 判断在**发帖那一刻**做：答不了的帖子，干脆不接下来。
 */
export function gate(userId: number): string | null {
  const l = spent(userId);
  if (l.userLimit > 0 && l.userToday >= l.userLimit) return '今天说得够多了，洞也要歇一会儿，明天再来';
  if (l.globalLimit > 0 && l.allToday >= l.globalLimit) return '洞里今天太吵了，明天再来吧';
  return null;
}
