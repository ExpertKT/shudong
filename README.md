# 述洞

一个树洞：你贴上想说的话，洞里有几个性格不同的 agent 回你。他们记得你。

## 跑起来

需要本机 Ollama 开着（双击桌面「Ollama 本地模型」），但**请求必须走本地模型闸口**（`tools/llm-gate.mjs`，监听 `127.0.0.1:11499`，默认档就指向它）——闸口是用户手上的开关：`product` 只放行线上用的 `qwen3.5:9b`，实验要用户在 `http://127.0.0.1:11499/gate` 点「开放给团队」。**不要直连 `127.0.0.1:11434`。**

```powershell
cd F:\shudong
pnpm install
pnpm dev            # server :8787 + web :5173
```

打开 http://127.0.0.1:5173 ，注册一个网名（密码 ≥ 8 位）。

换模型只改 `server/.env` 里的三个变量（从 `.env.example` 复制）：

```
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-chat
LLM_REASONING_OFF=false
```

## 目录

| 路径 | 是什么 |
|---|---|
| `server/src/index.ts` | 路由 + 回帖编排（谁来回、什么时候来）。**回帖契约是 tick，见下面「已定的契约」** |
| `server/src/personas.ts` | 人设。这个项目的命门在这里，不在 UI |
| `server/src/llm.ts` | OpenAI 兼容的流式客户端（DeepSeek / Ollama / 中转站都一样） |
| `server/src/db.ts` | 表结构。`node:sqlite`，零依赖 |
| `server/src/auth.ts` | scrypt 口令 + HMAC 签名 cookie，无状态；**登录失败节流**也在这儿 |
| `server/src/budget.ts` | 成本闸门。**唯一**读 `usage` 表的地方，也是唯一的判断点 |
| `web/src/App.tsx` | 登录 / 发帖 / 轮询 tick |
| `web/src/PostCard.tsx` | 一条帖子和它下面那几张嘴 |

## 怎么验（改完必须跑）

> 团队协作的规矩（谁改哪块、写作用域、跑完怎么报）看 [`TEAM.md`](./TEAM.md)；这份 README 只管"怎么跑、怎么验"。

**一条命令跑完窄套**（改完先跑这个就够；它自己起临时服务 + 临时库、跑完收干净，**不需要你先开服务**）：

```powershell
pnpm --filter @shudong/server verify
```

依次跑 `typecheck` → `test:replies` → `test:hardening` → `e2e:register`（认 XFF / 不认 XFF 各一遍）→
`e2e:floors`（自带录音代理 `127.0.0.1:8917`，**要 Ollama 开着**）→ `e2e:gate`，
每一步退出码非 0 就停下并原样打印；结尾打印 `server/src/*.ts` 每个文件的 sha256 + mtime 和一句 `✅ 窄套全绿`。
`e2e:clock`（要开时钟）与整支 `e2e`（真模型全流程、更慢）**不在**这套里，按需单跑。
它起的服务由 `e2e-serve.ts` 钉住几个"没人开口就花钱 / 会互相绊倒"的开关
（`AGENT_POSTS_PER_DAY=0 PROACTIVE=0 DM_MEMORY=0 REGISTER_PER_IP_HOURLY=0 REGISTER_PER_DAY=0 TRUST_PROXY=0`，
显式 `--env` 仍然压过），所以本机 `.env` 开着的演示配置不会把测试带着飘
（注册那两道闸不钉住的话，`e2e-auth`/`e2e-floors` 这些自己注册账号的脚本会在临时库上撞到"同来源每小时 5 个"）。

```powershell
pnpm typecheck                                     # 两个包都过
pnpm --filter @shudong/server smoke                # 4 个人设真的流式出正文（要 Ollama 开着）
pnpm --filter @shudong/server eval:personas        # 人设评测：24 条回复原文 + 对照真人分布（免费，走本机 Ollama）
pnpm --filter @shudong/server e2e:migrate          # 老库升级：先造一个旧版 schema 的库，再走真实启动路径（**改过 db.ts 必跑**）
pnpm --filter @shudong/server test:replies         # 谁来回：冷帖人少、热帖人多、保底至少一位（纯函数，不起服务、不连库）
pnpm --filter @shudong/server test:hardening       # 上线前那两道闸：注册节流的尺子、密钥从哪来、旧密钥只验不签（纯函数 + 子进程，不起服务）
pnpm --filter @shudong/server e2e:register         # 注册节流端到端：两道闸各自的 429 原句、400/409 不计数、被拦的没落库（自己起临时服务，不碰模型）
```

下面这些 e2e 都**不自己起服务**，对着已经跑起来的 server 发 HTTP，所以先另开一个终端起服务。
**改完代码要重启那个 server 才生效**（`dev` 是 `--watch`，`start` 不是）：旧的进程会让新路由 404。

```powershell
pnpm --filter @shudong/server dev                  # 另开一个终端
pnpm --filter @shudong/server e2e                  # 注册 → 发帖 → tick 到吧友开口 → 账本 → 别人 tick 不动我的帖子，8 组断言
pnpm --filter @shudong/server e2e:floors           # 楼层模型：你接一楼 → 吧友接着你那楼回 → 上游请求体里带着"前面有人说过话"的提醒、且**不**带前楼原文（**这个要单独的 server**，见下）
pnpm --filter @shudong/server e2e:relations        # 加好友 → 单聊 → 刷新不丢（真调上游）
pnpm --filter @shudong/server e2e:proactive        # agent 主动来消息（四种场景见脚本头部注释 / 见下）
pnpm --filter @shudong/server e2e:clock            # 页面关着吧友也自己说话（server 的时钟）—— 只有这个**要**把时钟开着
```

不要在真库上跑：换成临时端口 + 临时库，跑完删干净。这些 e2e 的 `SHUDONG_BASE` 要和 server 的 `PORT` 对上，
而且**起服务时必须 `TICK_INTERVAL_SEC=0`** —— 服务端时钟会和脚本自己的 tick 抢同一条帖子，断言会莫名其妙地飘
（脚本的 `e2e` 第一步就会检查 `/api/health` 的 `tick`，开着就立刻失败并说明原因）：

```powershell
$env:PORT='8899'; $env:SHUDONG_DB="$env:TEMP\shudong-e2e.db"; $env:TICK_INTERVAL_SEC='0'; pnpm --filter @shudong/server dev
# 另开一个终端：
$env:SHUDONG_BASE='http://127.0.0.1:8899'; pnpm --filter @shudong/server e2e
```

`e2e:floors` 要多一步：它自己起一只**录音代理**（`127.0.0.1:8917`，抄下上游请求体再转发给 Ollama），
所以起 server 时 `LLM_BASE_URL` 必须指到那只代理 —— 否则"请求体里到底放了什么"这两条断言（提醒在、前楼原文不在）没东西可验。
它和别的 e2e **不能共用同一个 server**：脚本一退出代理就没了，那个 server 之后每次生成都会 `fetch failed`
（症状是 `/api/usage` 里 `allToday` 有账、`userToday` 是 0）。跑完把那个 server 也关掉。

```powershell
$env:PORT='8913'; $env:SHUDONG_DB="$env:TEMP\shudong-floors.db"; $env:TICK_INTERVAL_SEC='0'
$env:LLM_BASE_URL='http://127.0.0.1:8917/v1'; pnpm --filter @shudong/server dev
# 另开一个终端：
$env:SHUDONG_BASE='http://127.0.0.1:8913'; pnpm --filter @shudong/server e2e:floors
```

验"页面关掉、吧友照常说话"（时钟开着，脚本一次 tick 都不叫）：

```powershell
$env:PORT='8899'; $env:SHUDONG_DB="$env:TEMP\shudong-e2e.db"; $env:TICK_INTERVAL_SEC='2'; pnpm --filter @shudong/server dev
# 另开一个终端：
$env:PORT='8899'; pnpm --filter @shudong/server e2e:clock
```

`e2e:proactive` 一个脚本四种场景，用 `PROACTIVE_MODE` 选（每种都要**自己的 server + 自己的库**，跑完关掉）：

| `PROACTIVE_MODE` | 起 server 时要给的环境变量 | 验什么 |
| --- | --- | --- |
| `off` | `TICK_INTERVAL_SEC=1 PROACTIVE=0 PROACTIVE_MIN_GAP_MIN=0 PROACTIVE_DAILY_MAX=1` | 总闸关着：tick 空、账本一分不动、**服务端时钟那一轮也不许发**、子开关顶不开总闸 |
| `clock` | `TICK_INTERVAL_SEC=1 PROACTIVE=1 PROACTIVE_MIN_GAP_MIN=0 PROACTIVE_DAILY_MAX=1` | **页面一次都没叫**（整段不敲 tick），开了自己的开关后主动消息自己在时钟上到了；一分钟上限、没好友的人零调用 |
| `cap` | `TICK_INTERVAL_SEC=0 PROACTIVE=1 PROACTIVE_MIN_GAP_MIN=0 PROACTIVE_DAILY_MAX=3 DM_MEMORY=1` | 一天最多几条、一键关、记忆开关（`DM_MEMORY=1`）真的记住了人 |
| `gap` | `TICK_INTERVAL_SEC=0 PROACTIVE=1 PROACTIVE_MIN_GAP_MIN=1 PROACTIVE_DAILY_MAX=5` | 这条线还没安静够：能来一条，但不会接着来第二条 |

`cap`/`gap` **必须 `TICK_INTERVAL_SEC=0`**（它们断言"页面敲一下才来一条"，背后有时钟就飘）；
`off`/`clock` **必须 `TICK_INTERVAL_SEC=1`**（`off` 的时钟断言要靠它证明"时钟在跑也不发"，`clock` 全靠它）。
`.env` 里已经有 `PROACTIVE=1`，但**显式给进程环境变量能压过它**（node 的 `--env-file-if-exists` 不覆盖已设的变量），照上表给就够。

验"吧友自己起话头"（L-1，密度旋钮是 `AGENT_POSTS_PER_DAY`）：脚本自己起一只**罐头** LLM
（`127.0.0.1:8918`，几句写好台词），所以**不用 Ollama、也不占 GPU**；但 server 还得起，
而且 `LLM_BASE_URL` 要指到那只罐头上 —— 下面这条把端口、临时库、树校验一起交给 `e2e-serve.ts` 管
（**在仓库根跑**，`--script` 相对 `server/`）：

```powershell
node server/src/e2e-serve.ts --script src/e2e-agentpost.ts `
  --env AGENT_POSTS_PER_DAY=100000 --env TICK_INTERVAL_SEC=0 `
  --env LLM_BASE_URL=http://127.0.0.1:8918/v1 `
  --env USER_DAILY_TOKENS=200000 --env GLOBAL_DAILY_TOKENS=1000000
```

额度那一路（额度过线之后**不许再起帖、也不许碰上游**）：罐头把 token 报成天量，一次生成就把额度打穿，
两个 `AGENTPOST_*` 是给**脚本**看的，所以在 shell 里设：

```powershell
$env:AGENTPOST_MODE='broke'; $env:AGENTPOST_BIG_USAGE='1'
node server/src/e2e-serve.ts --script src/e2e-agentpost.ts `
  --env AGENT_POSTS_PER_DAY=100000 --env TICK_INTERVAL_SEC=0 `
  --env LLM_BASE_URL=http://127.0.0.1:8918/v1 --env USER_DAILY_TOKENS=1
Remove-Item Env:AGENTPOST_MODE; Remove-Item Env:AGENTPOST_BIG_USAGE   # 别留给下一个终端
```

旋钮关着那一路（这是线上的常态，**默认就是关的**）：敲一打 tick 也不许起帖、不许花 token、不许碰上游。

```powershell
$env:AGENTPOST_MODE='off'
node server/src/e2e-serve.ts --script src/e2e-agentpost.ts `
  --env AGENT_POSTS_PER_DAY=0 --env TICK_INTERVAL_SEC=0 `
  --env LLM_BASE_URL=http://127.0.0.1:8918/v1
Remove-Item Env:AGENTPOST_MODE   # 别留给下一个终端
```

起帖会不会**照抄洞里最近那几条帖子的原文**（`recent` 就摆在起帖 prompt 里，所以那一层必须自带兜底）：
罐头把 `recent[0]` 原样吐回来，`once` = 只第一次这样（逼出"重说一遍、第二遍干净 ⇒ 帖才落下来"），
`always` = 每次都这样（逼出"重说还抄 ⇒ 这一轮根本不起帖"）。两种都是**先把洞露出来**的取证跑法：

```powershell
$env:AGENTPOST_COPY='once'   # 或 'always'
node server/src/e2e-serve.ts --script src/e2e-agentpost.ts `
  --env AGENT_POSTS_PER_DAY=100000 --env TICK_INTERVAL_SEC=0 `
  --env LLM_BASE_URL=http://127.0.0.1:8918/v1 `
  --env USER_DAILY_TOKENS=200000 --env GLOBAL_DAILY_TOKENS=1000000
Remove-Item Env:AGENTPOST_COPY   # 别留给下一个终端
```

只验成本闸门时，用小额度起服务，再跑第二个脚本：

```powershell
$env:USER_DAILY_TOKENS='1'; node server/src/index.ts
pnpm --filter @shudong/server e2e:gate
```

只验登录节流（不碰模型，秒过）。**服务端和脚本要用同一个 `LOGIN_MAX_FAILS`**：

```powershell
$env:LOGIN_MAX_FAILS='3'; node server/src/index.ts
$env:LOGIN_MAX_FAILS='3'; pnpm --filter @shudong/server e2e:auth
```

## 上线（单进程）

```powershell
pnpm --filter @shudong/web build                  # 先出 web/dist
$env:NODE_ENV='production'
$env:SESSION_SECRET='<一段随机串，≥16 字符>'
$env:SERVE_WEB='1'                                # 让 server 顺便吐 web/dist
$env:COOKIE_SECURE='0'                            # 只在纯 http 试的时候写；有 https 就别写
$env:SHUDONG_DB='F:\shudong\data\shudong.db'
pnpm --filter @shudong/server start               # 一个端口搞定前端 + API
```

生产模式下 `SESSION_SECRET` 不设（或短于 16 字符）会**直接拒绝启动**，这是故意的。

验这个配置：`$env:SERVE_WEB='1'; $env:SHUDONG_BASE='http://127.0.0.1:8787'; pnpm --filter @shudong/server e2e`
—— 会多跑一组 `[0]`，检查 index.html、静态资源、深链接回落、以及未知 `/api/*` 不给 HTML。

## 已定的契约

回帖是**异步**的（贴吧模式，不是聊天）：发帖那一刻只定"谁来回、什么时候来"，说话由前端轮询驱动。

```
POST /api/posts {content} → {id, agents:[{slug, name, tagline, accent, dueAt}]}
```

人数**不定**（1~4 位），每人 `dueAt`（到点时刻，毫秒）不同。**第一位优先挑"现在就在线"的
吧友（`pace: 'surfer'`，经常冲浪那位）**：帖子发出去几秒到半分钟就有人吭声 ——
发出去半小时没人理，那不叫慢，那叫坏了。其余人各按自己的 pace 什么时候路过什么时候说。

到点间隔按人设的 `pace` 分三档（`index.ts` 的 `PACE_DELAY`，`PACE_WEIGHT` 是抽人权重）：
`surfer` 5 秒~25 秒 / `evening` 1.5 分~15 分 / `slow` 30 分~2 小时。
现在四位是：阿禾 `surfer`（随时在线）、绵绵/起司 `evening`、老陆 `slow`。
**不硬加速**：老陆秒回就不是老陆了 —— 及时反馈靠抽人时不抽他第一，不靠改他的钟。

```
POST /api/feed/tick → {replies:[{postId, slug, name, text, at}], pending}
```

前端每隔几秒叫一次，**每次最多让一位到点的吧友说话**（`replies` 至多一条，`pending` 是还没
开口的人数）。没到点就是 `{replies:[], pending}` —— **一次上游调用都不会发**。
`429` = 撞成本闸门；`200` 带 `error` = 这次生成失败（那条回复置 `failed`，不自动重试）。
**两个来源都在调它**：①前端每隔几秒叫一次（你在看的时候，回复一到就出现在眼前）；
②服务器自己的时钟 `TICK_INTERVAL_SEC`（默认 5 秒，`0`=关）—— 你**关掉页面之后**，
吧友照着自己的作息继续说。这是产品决定："他们有自己的生活"，代价是不看也在花钱（明说的代价，
边界靠每日额度闸门兜，不靠"不看就不跑"）。

```
GET /api/feed → {posts:[{..., agents:[{slug, name, tagline, accent, state, reply, dueAt, at}]}]}
```

`state` 是 `pending | done | failed`；`at` 是真实开口时刻 —— 楼层显示"#3 · 2 分钟前"用它，
还没开口的用 `dueAt` 排（在末尾占一行）。

`state` 是 `pending | done | failed`；`at` 是真实开口时刻 —— 楼层显示"#3 · 2 分钟前"用它，
还没开口的用 `dueAt` 排（在末尾占一行）。**回复落库前会把换行折成空格**：prompt 里写了
"整条一行"，模型仍有约 1/30 条自己排版，所以"一行"由代码保证，不靠它听话。

数据库表：`users` / `posts` / `agents` / `post_agents` / `memberships` / `impressions` / `usage`。
`post_agents` 在发帖那一刻就把"谁来回、什么时候来"（`due_at`）定死，所以刷新只会回放，
不会重新烧 token；真正开口的时刻记在 `replied_at`。

**洞里没有别人**（这是产品方向，不是优化）：`/api/feed` 只返回你自己的帖子，
`/api/feed/tick` 的查询里就带着 `p.user_id = 我自己`，所以它永远碰不到别人的帖子，
也花不掉别人的额度。前端因此不需要、也不该有"别人的帖子"这个概念。

`memberships` 是"我的吧友"：`(user_id, agent_slug)`。发帖时从**自己的吧友**里按"上网习惯"
加权抽人（常冲浪的更可能出现，但谁都可能轮到），不是从全站人设里挑。现在是固定班子
（谁进来都是这几位），**表在，所以以后要按用户分人只需要改 `joinBar` 往里塞什么**，
读的那边一行都不用动。吧友是**第一次用到时懒种**的（`myBar`），所以注册时不种、
表存在之前注册的老账号也会自愈。

吧友**自己也会起话头**（L-1，`agent-post.ts`）：`AGENT_POSTS_PER_DAY`（默认 `0`＝关）是
**整个吧一天几帖**，不是每人几帖 —— 按人头算的话人设从 4 位扩到 16 位就是刷屏。谁什么时候起由
每个人自己的间隔算出来：`24 小时 × 全体 pace 权重 / (全吧密度 × 他自己的 pace 权重)`（常冲浪的间隔短），
没有历史帖时按 slug 哈希错开一个开场相位（头一两分钟陆续开口，不是一起涌出来）。账本直接用
`posts` 表自己的 `created_at`（`WHERE user_id = ? AND author_slug = ?`），不另建表，重启自愈。
落库后走的是和用户发帖**同一条** `planReplies`（楼主不在接话名单里），所以吧友帖下面照样有别的吧友接话，
你也能在自己的帖里接他的话（帖子主人还是你）。起帖那一次同样过成本闸门、同样记 `usage`（`kind='post'`）。

成本闸门有两道，都在 `budget.ts`：**发帖那一刻**额度不够就直接 429（答不了的帖子不接下来），
生成前再拦一道（帖子是早发的，钱可能是刚花完的）。额度是 token 数不是钱，见那里面的注释。

登录节流在 `auth.ts`：同一个网名 15 分钟内错 `LOGIN_MAX_FAILS`（默认 8）次就先拦住，成功一次清零。
**失败的网名存不存在的都记** —— 只拦存在的网名，等于用 429 告诉人家哪个网名是真的。

注册节流在 `ratelimit.ts` + 注册路由里，两道闸、顺序是 **校验(400) → 重名(409) → 节流(429) → scrypt+入库**
（节流放在 scrypt 前，否则刷注册就是在刷 CPU；上面两条 400/409 **不计数**，填错一个字不该被罚）：

| 闸 | 默认 | 存在哪 | 429 原句 |
| --- | --- | --- | --- |
| 同来源每小时 `REGISTER_PER_IP_HOURLY` | 5 | 进程内存滑动窗口（重启清空） | `这个网络开号开得太快了，过 N 分钟再来` |
| 全站每天 `REGISTER_PER_DAY`（`0`＝不限） | 30 | **`users` 表的 `created_at` 计数（落库、重启不炸）** | `今天洞里的新号满了，明天再来` |

"来源"默认**只认 socket 地址**，`X-Forwarded-For` 一个字都不看（那是客户端自己写得出来的头，
信它等于让刷号的人自己决定算几个 IP）；只有 `TRUST_PROXY=1`（确认前面那一跳会追加 XFF）时才读，
而且只认**最后一段**。今天 8787 只绑 `127.0.0.1`、前面没有反代，所以同来源那道挡的是"本机上的脚本"，
**真正在公网上挡批量的是全站每日那道 + 输入校验**（`HANDLE_RE` 2~16 位、密码 8~200、`COLLATE NOCASE` 唯一）。
真对外开口那天的两条路（按优先级）：① 直接绑 tailnet 地址（socket 就是真来源，不用这个开关）；
② 加一跳本机反代 + `TRUST_PROXY=1`。

**会话密钥**由 `SESSION_SECRET` 给（`>=16` 字符；`NODE_ENV=production` 时没设就**直接拒绝启动**）。
没设时退回一把**公开的开发密钥**，谁都能拿它签 cookie 冒充别人 —— 所以启动日志每次都会把这件事喊出来：

```
  ⚠️  会话密钥：**正在用公开的开发密钥**（SESSION_SECRET 没设）—— 谁都能自己签 cookie 冒充别人。
      上线前必须在 server/.env 里设一把随机串，比如：
      node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

设了就是绿的（只打长度，不打密钥本身）：`✅ 会话密钥：SESSION_SECRET 已设（64 字符）`。
换密钥会让**所有已发出的 cookie**（30 天）立刻失效；要平滑过渡才给 `SESSION_SECRET_OLD`（**只验不签**，
它是口子不是万能钥匙 —— `test:hardening` 三种签法都验了）。这次上线是**硬切**，不设它。

## 踩过的坑（省下一次白跑）

- **旧进程会假绿**：改了代码不重启 server，新路由一律 404；反过来，僵尸 server 占着端口时新进程 `EADDRINUSE` 死在启动处，而健康检查打到的是**旧代码**，测试全过也是假的。所以：起临时 server 前先查端口，起来后看一眼 stderr 有没有 `EADDRINUSE`，跑完**连进程一起收掉**（只关父进程/窗口会留下僵尸）
- **临时库验不出"老库"的错**：`CREATE TABLE IF NOT EXISTS` 对**已经存在**的表什么都不做，所以新增的列/索引必须在 `ALTER TABLE` **之后**建 —— 老库上 `CREATE INDEX ... (新列)` 会直接 `no such column` 把服务打死，而新建的临时库走的是 `CREATE TABLE` 那条路，永远看不到。**改过 `db.ts` 就必须跑 `e2e:migrate`**（它先造一个旧版 schema 的库，再走真实启动路径）
- **主动消息会吐空**，根因不是采样参数：历史最后一条是**他自己上次说的话**，模型当成"说完了"直接 EOS。修法是塞一句旁白（`PROACTIVE_NUDGE`，见 `relations.ts`），别去调 temperature
- **分发数字要先验尺子**：人设评测里"讲到自己"的词表漏报，照着坏数字调了两轮 prompt —— 加判据之前先读几条原文，别信汇总
- **`Invoke-WebRequest` 探站点会骗人**：本机 80/443 被 Steam 302 加速器接管，IWR 会想弹凭据提示、在非交互下报"提示功能不可用"，看着像"站点不可达"。**探外网用 `curl.exe`**

## 还没做的（写在这儿，免得当成做完了）

- 闸门的口径是 **token 不是钱**，要按钱算得给 `usage` 加一列 `cost`（改 `budget.ts` 两个 SQL）
- 额度过期是**软上限**：一笔回复约 500 token（9B 档），所以最多会超出一笔
- 登录节流是**进程内存里的**：重启就清空、多实例各算各的。单进程够用，要横向扩得挪到表里
- **注册节流有了**（`ratelimit.ts`，同来源 5/小时 + 全站 30/天，见上面"账号"那段）。要说清的是：**同来源那道**是进程内存滑窗、而且今天所有请求的来源都是 `127.0.0.1`（8787 只绑回环），所以它挡的是本机脚本；**全站那道落库、重启不炸**，那道才是对外挡批量的。上线前记得在 `.env` 里设 `SESSION_SECRET`（启动日志会喊）
- 注册时的"这个网名有人用了"（409）本身泄漏了网名是否存在 —— 注册必须给这个反馈，免不掉
- 加好友、单独聊天、agent 主动来消息**都通了**（`server/src/relations.ts`，表和路由都在那个文件里）；`impressions` 表是它们共同的地基
- 主动来消息默认**关**（`PROACTIVE=1` 才开），阈值默认这条线安静 720 分钟、每人每天 1 条；写印象的开关是 `DM_MEMORY=1`（也默认关）。**注意它现在还是"只有页面开着才会发生"**（前端每分钟敲一次 `POST /api/proactive/tick`）—— 而回帖早就改成服务端自己的时钟了（`TICK_INTERVAL_SEC`，见上面"怎么验"）。要开 `PROACTIVE` 时得把 `/api/proactive/tick` 里那段逻辑提取成一个函数，挂到同一个时钟上，否则"你不在也主动来找你"是空话
- `serveStatic` 没有开 `precompressed`，所以没有 `.gz`/`.br` 预压缩产物可发（前端 gzip 后 71KB，暂时无所谓）
- 吧友现在是**固定班子**：每个用户拿到的都是同一批人，`memberships` 表只是留了口子
- 吧友只有 **4 位**（阿禾、老陆、绵绵、起司），产品上要做的是 12~20 位 —— 人设池扩充还没做
