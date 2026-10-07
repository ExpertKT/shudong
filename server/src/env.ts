import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : v === '1' || v.toLowerCase() === 'true';

/** 0 = 不限额。写错了（NaN/负数）就当没写，别把闸门悄悄打开。 */
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** 没设 SESSION_SECRET 时用的那把 —— 公开的、谁都能拿去签 cookie。 */
const DEV_SECRET = 'dev-only-insecure-secret';

/** 上线时没设 SESSION_SECRET 就直接拒绝启动 —— 免得用开发默认密钥把签名 cookie 发到公网。 */
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须设置 SESSION_SECRET（>=16 字符）');
  }
  return DEV_SECRET;
}

/**
 * 上一把密钥，**只用来验旧 cookie、绝不用来签新的**（见 `auth.ts` 的 `readSession`）。
 * 换密钥的那一刻，已经发出去的 cookie（30 天）全都会失效；要在发布窗口里平滑过渡时才给这个。
 * 本次上线是**硬切**、不设它 —— 旧的正是上面那串公开的开发密钥，留成并行旧密钥等于给可伪造的 cookie 续命。
 */
function secretOld(): string {
  const s = process.env.SESSION_SECRET_OLD;
  return s && s.length >= 16 && s !== secret() ? s : '';
}

const sessionSecret = secret();

export const env = {
  port: num(process.env.PORT, 8787),
  dbPath: process.env.SHUDONG_DB ?? join(ROOT, 'data', 'shudong.db'),
  sessionSecret,
  /** 现网没设 SESSION_SECRET ⇒ 用的是那串公开的开发密钥。启动日志要把这件事喊出来（别一声不响）。 */
  sessionSecretIsDev: sessionSecret === DEV_SECRET,
  sessionSecretOld: secretOld(),

  /** 默认档 */
  // 默认走本地模型闸口（11499 → 127.0.0.1:11434）：裸 node 起的实验脚本不会读 .env，
  // 若默认直连 11434 就会绕过用户的开关。闸口挂了 = 请求失败，比"悄悄绕过"安全。
  baseURL: process.env.LLM_BASE_URL ?? 'http://127.0.0.1:11499/v1',
  apiKey: process.env.LLM_API_KEY ?? 'ollama-placeholder',
  model: process.env.MODEL_FAST ?? 'qwen3.5:9b',
  /** 慢档可选；留空则保持原先只用 9B 的行为。 */
  slowModel: process.env.MODEL_SLOW ?? '',
  /** 排期延迟超过该秒数才切慢档；30 秒落在 surfer 与 evening 的真实空档。 */
  slowAfterSec: num(process.env.MODEL_SLOW_AFTER_SEC, 30),
  /** 便宜档；留空则复用默认档 */
  smallBaseURL: process.env.SMALL_BASE_URL ?? '',
  smallApiKey: process.env.SMALL_API_KEY ?? '',
  smallModel: process.env.SMALL_MODEL ?? '',
  reasoningOff: bool(process.env.LLM_REASONING_OFF, true),

  maxInflight: num(process.env.MAX_INFLIGHT, 6),

  /** 成本闸门：每天每用户 / 全站的 token 上限。0 = 不限额。 */
  userDailyTokens: num(process.env.USER_DAILY_TOKENS, 30_000),
  globalDailyTokens: num(process.env.GLOBAL_DAILY_TOKENS, 300_000),

  /** 同一个网名在一个窗口里最多允许失败几次登录。0 = 不拦（不建议）。 */
  loginMaxFails: num(process.env.LOGIN_MAX_FAILS, 8),

  /**
   * **注册节流**（`ratelimit.ts`）：同一个来源每小时最多开几个号 / 全站每天最多开几个号。0 = 不限额。
   *
   * 数字怎么来的：全站每天 30 是"真人上限"（现在真用户就一位），同 IP 每小时 5 是"一条网线一台电脑
   * 也开不了几个"；两个都留得很松，正常用户碰不到。
   *
   * 说清楚这两道的强弱：**全站每天那道是硬闸**（数 `users` 表的 `created_at`、落库、重启不炸），
   * 同 IP 那道只是**弱闸** —— 8787 只绑回环、前面没有反代，今天所有请求的来源都是 `127.0.0.1`，
   * 所以它挡的是"本机上的脚本"。真对外开口那天见 `trustProxy` 的注释。
   */
  registerPerIpHourly: num(process.env.REGISTER_PER_IP_HOURLY, 5),
  registerPerDay: num(process.env.REGISTER_PER_DAY, 30),

  /**
   * 前面那一跳会不会追加 `X-Forwarded-For`。**默认关** —— 8787 只绑 `127.0.0.1`、没有反代，
   * 而 XFF 是客户端自己写得出来的头，信它等于让刷号的人自己决定"我算几个 IP"。
   *
   * 真要让外面的人进来时，两条路按这个顺序选（Lead 定的）：
   *   ① 直接绑 tailnet 地址（把 `index.ts` 那行 `hostname: '127.0.0.1'` 做成 env）：来源就是对方真地址，
   *      socket 上看得见，**不需要**这个开关；
   *   ② 加一跳本机反代（`tailscale serve` 那类）+ `TRUST_PROXY=1`：那时只认 XFF 的**最后一段**
   *      （前面几段是客户端自己写的，见 `ratelimit.ts` 的 `clientKey`）。
   */
  trustProxy: bool(process.env.TRUST_PROXY, false),

  /**
   * cookie 上的 Secure 标记。默认只有 NODE_ENV=production 才加。
   * 纯 http 试生产时必须 COOKIE_SECURE=0 —— 加了 Secure 浏览器压根不存这个 cookie，
   * 表现为"登录成功了但刷新一下又是未登录"，很难查。
   */
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),

  /** 顺便把 web/dist 吐出去，单进程上线。开发时交给 vite（有 HMR）。 */
  serveWeb: bool(process.env.SERVE_WEB, process.env.NODE_ENV === 'production'),

  /**
   * **服务端自己的时钟**（秒）：每 N 秒看一眼"谁到点了"，到点就让他说话 ——
   * 跟你开不开页面无关。用户拍板选的语义："吧友有自己的作息，你不在的时候也照常说话。"
   *
   * 代价说清楚：**没人在看的时候也会烧 token**，边界交给每日额度闸门（budget.ts）兜，
   * 而不是靠"不看就不跑"。0 = 关掉时钟，退回"前端敲一下才说话"。
   *
   * 跑 e2e 时要用 `TICK_INTERVAL_SEC=0` 起 server：否则时钟会和脚本自己的 tick
   * 抢同一条帖子，断言会莫名其妙地飘。
   */
  tickIntervalSec: num(process.env.TICK_INTERVAL_SEC, 5),

  /**
   * **agent 主动来消息**（M2）。默认全关 —— 这是"不用人开口就花钱"的调用，
   * 服务器一启动就自己烧 token 是最不该发生的事。
   * `proactiveMinGapMin` 是两次主动消息之间至少隔多少分钟，`proactiveDailyMax` 是每人每天上限。
   * 注意：**单独聊天（用户主动发起）不受这个开关管** —— 那是用户自己按的，管它没道理。
   */
  proactive: bool(process.env.PROACTIVE, false),
  proactiveMinGapMin: num(process.env.PROACTIVE_MIN_GAP_MIN, 720),
  proactiveDailyMax: num(process.env.PROACTIVE_DAILY_MAX, 1),
  /** 私聊之后把聊过的东西写进 impressions（"他记得你"）。低频、花钱，所以单独一个开关。 */
  dmMemory: bool(process.env.DM_MEMORY, false),

  /**
   * **吧友自己起话头**（L-1）：整个吧一天大概开几个新帖。**0 = 关**（默认）。
   *
   * 用户投的票（d1「热闹」）买的是"密度"——"他们不管你在不在都会开口，所以这条定的是花钱速度"。
   * 所以密度按**整个吧**表达：人设池扩到 16 位时不许跟着翻 4 倍；各人再按上网习惯加权分到
   * 自己的间隔（`replies.ts` 的 `PACE_WEIGHT`），谁都不会跟谁同一秒开火。
   *
   * 跑 e2e 必须 0：它会背着脚本自己发帖，"恰好一条"的断言会飘（同 `TICK_INTERVAL_SEC` 的纪律）。
   */
  agentPostsPerDay: num(process.env.AGENT_POSTS_PER_DAY, 0),

  /**
   * **背往事枪**（task-39 的第四把枪：回帖与"这一层真注进去的那条往事"逐字重合 ≥ `MEMORY_RUN` ⇒
   * 重说一次，仍脏就丢弃这层）。**默认关** —— 阈值 `MEMORY_RUN` 还没拍：Lead 的 r167 预登记按
   * 生产温度实测把它判否（产品尺度预期丢弃率 15.6%~28.6%，>10% 生死线）。
   * `MEMORY_GUN=1` 才启用；关着时产品路径与没装这把枪完全一致（不重说、不丢弃、正文照常渲染）。
   */
  memoryGun: bool(process.env.MEMORY_GUN, false),
};
