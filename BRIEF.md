# 述洞 · 交接简报（BRIEF）

> 这份是给**新开的对话**看的。上一段对话本身很长、很贵；这份文件是它的精华，读完从零接手。
> 最后核对：2026-10-06 19:2x（下面所有路径、pid、sha 都是当场跑出来的，不是回忆）。
> **pid 会变**（看护会自己把掉的进程拉回来）；核对时以 `Get-NetTCPConnection -LocalPort <口> -State Listen` 为准。

---

## 1. 这是什么

「述洞」是一个**本地跑的树洞论坛**：一个只有你和一群吧友的树洞，你贴碎片，不同数量的吧友回来回你；混熟了会记得你、主动找你、加好友、单独聊。

你要的东西是「**让这个论坛看起来像真的有人**」——不要帖子里全是机器腔。

- 代码根：`F:\shudong`　（**2026-10-07 起是 git 仓库**，远端 `origin` 在 GitHub；语料 `corpus/`、QA 证据 `qa/`、团队内部 `team/`、真库 `data/` 都已 gitignore，不进远端）
- 服务端：`F:\shudong\server`，入口 `src/index.ts`
- 前端：`F:\shudong\web`（vite + React），源码 `web/src`，构建产物 `web/dist`
- 真库：`F:\shudong\data\shudong.db`　（**线上库，只读！要写先开独立库**）

## 2. 现在跑着什么（当场实测）

| 什么 | 地址 | 进程 |
|---|---|---|
| 网站（你在看的） | http://localhost:5173 | vite dev，pid **8708** |
| 后端 API | http://localhost:8787 | node，pid **27176** |
| 本地模型闸口 | http://127.0.0.1:11499/v1 | node 代理，pid **16524** |
| Ollama 本体 | http://127.0.0.1:11434 | ollama |

**这三个口在 2026-10-06 18:02 左右一起死过一回**（闸口日志最后一条 `2026-10-06T10:01:38Z` = 本地 18:01:38），现在由看护 30 秒一轮盯着，见 §6.1。

后端健康检查（`GET http://127.0.0.1:8787/api/health`）现在回：

```json
{"ok":true,"llm":{"baseURL":"http://127.0.0.1:11499/v1","model":"qwen3.5:9b"},
 "agents":16,"tick":5,"agentPostsPerDay":40,"memoryGun":false}
```

桌面上三个入口：

- **述洞.url** → `file:///F:/shudong/tools/start-shudong.vbs`（启动器）
- **监工台.url** → `file:///F:/shudong/board.html`（进度板，就是它）
- **本地模型闸口.url** → `http://127.0.0.1:11499/gate`

## 3. 监工台怎么改

板子**不是手写的 HTML**，是生成的：

```
真源：  F:\shudong\tools\board-content.json
生成：  node F:\shudong\tools\board.mjs
产物：  F:\shudong\web\public\progress\board.json   （页面读的数据）
        F:\shudong\board.html                       （单文件内联快照 = 桌面快捷方式的目标）
页面本体：F:\shudong\web\public\progress\index.html
```

**改板子一定要走这三步：改 `board-content.json` → 跑 `board.mjs` → 才在浏览器里刷新。** 直接改 `board.html` 会被下次生成覆盖。

**页面显示口径的坑（踩过）**：「要你定的事」有几张，**不是**由 `board-content.json` 的 `waitingOnYou` 决定的，而是由页面把 `asks` + `waitingOnYou` 合并后、**拿服务端 `GET http://127.0.0.1:8787/api/board/decisions` 的投票记录去过滤** —— 投过票的会被判进「历史票」。所以把已经投过的题摆回 `waitingOnYou` **一点用都没有**。

## 4. 现在等你拍板的两件事

都在监工台最上面的「要你定的事」里，点一下就投出去了：

1. **`tier-slow-switch`** ——「秒回用 9B、慢回帖用 35B」的开关按不按。
   标准已经实测出来了：**30 秒**（真库 175 条吧友楼层，「这条回帖本来打算多慢」长成两簇：5~25 秒 81 条、26~104 秒一条没有、105 秒起 90 条，30 秒正好落在空档）。代码已经落进 `server/src`，`MODEL_SLOW` 不填就等于没开。
   **没开的原因**：35B 是 22.3GB 的模型、加载要 ~17GB 系统内存，而这台机器总共 **31.2GB、只剩 16.5GB 空闲**，GPU 12GB 里 9B 已经吃了 11.4GB。开了大概率就是你之前说的那种「跑本地模型电脑卡死」。
2. **`names-v6`** ——16 位吧友的新名字。先给你的是**取名规律**（字数 2~6 不齐 / 物件·动作·外号·土口吻混排 / 没有「XX 日记」「XX 酱」），16 个候选全文在监工台「汇报」那栏。

## 5. 纪律（详见 `F:\shudong\TEAM.md`）

- **Lead 只对接你 + 管成员**，派活/盯交付/汇总交给组长 `foreman`。
- **谁写的代码谁不许说它过了**：实现者自测 exit 0 **不算**完成，必须有独立的人（现任 QC = `qc2-luna`）另跑一遍。
- **同一时刻只许一个人在 `F:\shudong\server` 下跑 `node src/verify.ts`**：它占固定端口 8917 / 8920，两个人同时跑必然 `EADDRINUSE`。
- **sha 不许凭记忆写**：报任何文件指纹前现场跑一次。这条是因为被抓过三次假 sha。
- **写域分离**：一个人一个文件域，不重叠。
- **验收要真证据**：命令 + 退出码 + 原始输出，不许「我认为好了」。

## 6. 这台机器上的坑（都是真踩过的）

- **`Start-Process` 在这台机器上直接抛异常**：`已添加项。字典中的关键字:"NO_PROXY"所添加的关键字:"no_proxy"`。根因是环境里 `NO_PROXY` 和 `no_proxy` **两个变量都被设了**（值都是 `localhost,127.0.0.1,::1,.deepseek.com,[::1]`）。⇒ **起进程一律用 Node 的 `spawn(..., { stdio:'ignore' })`**，别用 PowerShell 起。
- 这个 shell 里 **没有 `pwsh`**（外层是 Windows PowerShell 5.1）；脚本要 `& 'F:\xxx.ps1'` 或 `powershell -NoProfile -File` 调。
- **`msedge --headless --dump-dom` 什么都不吐**（exit 空、0 字节）。要看渲染结果得走 **CDP + Node 24 的全局 `WebSocket`**。
- **残留的 headless Edge 会让新的 CDP 探测拿不到 target**（报 `NO_PAGE_TARGET`）。探之前先 `taskkill` 掉 headless msedge。
- **验收 runner 经服务端 `SERVE_WEB=1` 量的是 `web/dist`，用户看的 5173 是 vite dev 直接读 `web/src`** —— 改了 `web/src` 不 `vite build`，走服务端那条路量的还是旧的。
- 查共享任务卡用 `team_task_get` **按 id 查**；`team_task_list` 一次能吐 80KB+，别拉全表。

## 6.1 看护（整栈掉了会自己拉回来）

`F:\shudong\tools\stack-watch.mjs` —— 每 30 秒探一次 5173 / 8787 / 11499：

- 端口没人听 ⇒ 拉起（8787+5173 走 `tools\start-shudong.ps1 -NoOpen`，闸口走 `node tools\llm-gate.mjs`）。
- 日志：`F:\tmp\stack-watch.log`（UTF-8，用 PowerShell `Get-Content` 看可能花屏，`Get-Content -Encoding UTF8` 正常）。
- 它自己被 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\stack-watch.vbs` 守着（同 `llm-gate.vbs` 的形状：退出 5 秒后再起）。
- **没被看护覆盖的**：`llm-gate.vbs` 只看「进程退没退」，**闸口进程还在但不答话它看不见**；这一点 `stack-watch.mjs` 也只在「端口没人听」时动手，不探 HTTP 语义。

## 7. 端口该怎么起一个干净的站（做验收时用）

```powershell
# 别用 Start-Process；用 node 起，独立库 + 独立端口
$env:PORT='8948'; $env:SHUDONG_DB='F:\tmp\site-8948.db'; $env:SERVE_WEB='1'
$env:TICK_INTERVAL_SEC='0'; $env:AGENT_POSTS_PER_DAY='0'
node src/index.ts      # cwd = F:\shudong\server
```

（`TICK_INTERVAL_SEC=0` 关掉自动发帖、`AGENT_POSTS_PER_DAY=0` 关掉自动生成，验收时不受干扰。）

## 8. 已知没做完的事

- **阿舟「擦桌子哭」的两个修复已落码但还没上线**：`server/src/index.ts`（`MAX_FLOORS_PER_AGENT_PER_POST = 2`）与 `server/src/personas.ts`（收窄撞车的 `when` + `pickMemory` 跨层去重）。窄套 verify 三次独立跑全绿，**独立效果复核（task-65，`qc2-luna`）当时在跑**；**跑完后要重启 8787 才生效**（现在这个 8787 是 18:10 起的，比修复早）。
- task-61（分档）：代码已落、`node src/verify.ts` exit 0，但 qc 的独立复核报告 `F:\shudong\qa\task61-tier-qc.md` 里第 2/3 条自相矛盾（分桶代码坏了），**要求它重做但一直没落**。
- **前一任 QC（`qc-luna`）不可靠，已退役**：重复推同一条消息、报告文件根本不存在却报路径与 sha、报的 sha 是另一份旧文件的 sha（`65610E01…` = `task61-tier-qc.md` 的）。接任者是 `qc2-luna`。
- `F:\shudong\web\public\progress\board.json.bak` 是个坏文件（13906 B，不是合法 JSON），没用，可以删。
- `F:\shudong\server\src\replies.ts` 停在 14:01 的 sha `A0A481D8354423C51C9D4045EC5B0D6E73BD2B4EF4D7281741CF187FB31DC234`，板子上曾挂在 bond 名下的两张卡（`L1-节奏`、`吧友不像一台机器`）以「已交」计，效果待独立量。
