# RimBot · 本机跑通记录

这份文件是本仓库在本机的落地笔记（不是上游内容）。

| remote | 地址 | 用途 |
|---|---|---|
| `origin` | https://github.com/Rim-pm/dsh-aurabot-qq | 自己的 fork，日常提交推这里 |
| `upstream` | https://github.com/aureth-labs/dsh-aurabot-qq | 原作者仓库，只用来拉更新 |

## 本机环境（2026-11-03）

| 项 | 值 |
|---|---|
| DSH | `0.2.1-rc.5`（scoop 安装，`dsh` 在 PATH） |
| 宿主 profile | **`web`**（`~/.dsh/profiles/web`）= `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` |
| Node / pnpm | v26.4.0 / 12.16.1 |
| 本仓库 | `D:\Nakk\OrcaPJs\RimBot`，main |
| SnowLuma | 2.4.0，`C:\Aurabot\snowluma`（自带 `node.exe`） |
| QQ | `D:\APPs\QQNT\QQ.exe` 9.9.36，小号 2313035775 / 王木木 |

## ⚠ 必须跑在 web profile，不能跑 TUI

`src/chat/hub.js:215` 拿的是 `dsh.get('sessionController')`，拿不到就直接抛：

```
[chat] 转进 DSH 失败（private:2898565937）： 宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）
```

TUI 宿主里消息能收（`received` 会 +1），但**建不出 DSH 会话，永远回复不了**。
所以 `dsh-tui` 那边已经把这个插件卸掉了——两个 profile 都装的话，两个宿主会抢同一个
OneBot 连接，消息会被重复消费。

## 安装

```powershell
# 1. 建 web profile（首次会从 shipped template 组合 dsh-base + dsh-web-app）
dsh --profile web --dump-config

# 2. 本地 link 安装插件
dsh plugin --profile web add D:\Nakk\OrcaPJs\RimBot
```

pnpm 写的是 `"dsh-aurabot-qq": "link:D:/Nakk/OrcaPJs/RimBot"`，
`node_modules/dsh-aurabot-qq` 是指向本目录的 junction，并加进 `dsh.profile.bundles`。
**改这里的代码 → 重启 `dsh web` 就生效**。

web profile 的 `cordis.patch.yml` 需要模型配置（`llm-pi-ai` 的 magpie providers +
`agent-default-model`），本机是从 `dsh-tui` 那份直接复制过去的；API key 在
`~/.dsh/.env` 的 `MAGPIE_GATEWAY_KEY`。

## 启动

```powershell
dsh web          # 等价于 dsh --profile web，默认 127.0.0.1:3080
```

- 面板：`http://127.0.0.1:3080`（要 DSH web 的登录态，直接 curl 会 401）
- Aurabot 接口：`http://127.0.0.1:3080/aurabot/api/*`
- 日志：`%USERPROFILE%\.dsh\plugins-data\aurabot\logs\aurabot-<日期>.log`
- 数据：`%USERPROFILE%\.dsh\plugins-data\aurabot\`

启动后插件会自己把 SnowLuma 拉起来、自己注入机器人号、自己连 OneBot，日志：

```
[core] SnowLuma： 已启动
[onebot] QQ 网关：connected
[core] 接入机器人号： 机器人号（pid 64708）已接入
```

**SnowLuma 是宿主的子进程**，宿主一停它就跟着退（端口 5099/3000/3001 一起没）。
所以 `dsh web` 要常驻，别随手关。

## 已端到端验证

```
22:26:13 [chat] 为 private:2898565937 新建了 DSH 会话 21236f80（aurabot-private）
22:26:13 [chat] private:2898565937 的模型切到 magpie::workbuddy-ai/deepseek-v4.1-flash-sg::low
22:26:16 [chat] 试运行（没真发）→ private:2898565937：在呢在呢 怎么啦
22:27:03 [snowluma] [OneBot] 私聊 2898565937 | 发送：【Aurabot 自测】大肥鱼到此一游～
```

- 主人私聊 → 建会话 → 选模型 → 生成回复：一轮 3 秒
- 关掉试运行后真实发送成功（`stats.sent = 1`）
- 仓库自带测试：`node --test "test/**/*.test.js"` → 669 passed / 0 failed

## 常用接口

```powershell
$base = 'http://127.0.0.1:3080'

Invoke-RestMethod "$base/aurabot/api/state"                       # 总览
Invoke-RestMethod "$base/aurabot/api/snowluma/processes"          # QQ 进程 + 号
Invoke-RestMethod "$base/aurabot/api/snowluma/attach" -Method Post -ContentType application/json -Body '{}'
Invoke-RestMethod "$base/aurabot/api/save" -Method Post -ContentType application/json -Body '{"dryRun":false}'
Invoke-RestMethod "$base/aurabot/api/test-send" -Method Post -ContentType application/json -Body '{}'
```

`/save` 可改 `enabled`（总开关）、`dryRun`（试运行）、`botQQ` / `ownerQQ` 等。
安全默认是 `enabled=false` + `dryRun=true`。

## 跟上游同步

上游 **1.2.0 起把桌宠 / 抖音 / 小黑盒 / 群管搬出了内核**，改由社区模块库
（[`aureth-labs/dsh-aurabot-qq-mods`](https://github.com/aureth-labs/dsh-aurabot-qq-mods)）分发：
插件启动时 `community.migrate()` 会把「原来在用」的自动装回来（配置和登录状态不变），
其余在面板「模块市场」里按需装。所以同步上游要合 **release 分支**，不是 main：

```powershell
git fetch upstream
git merge upstream/release/1.3.0     # 换成当时最新的 release/1.3.x
# 冲突重点：package.json、src/core/config.js、client/client.js、
#          src/chat/hub.js、src/persona/personas.js、
#          extensions/bili-observer/bili/api.js
# 本地要保住：RimTTS（已弃用，待清理）、抖音/B站链接转存扩展、琳的人格卡（personas/）、
#            B 站「只观察不写」的闸门（见下）
npm test                              # 2521 条；e2e / hub-lifecycle 个别用例并发下会抖，单跑能过
```

社区模块索引：
`https://raw.githubusercontent.com/aureth-labs/dsh-aurabot-qq-mods/registry/index.json`

插件本体是纯 ESM、没有 npm 依赖，拉完重启 `dsh web` 即可（本机 web profile 是
`link:D:/Nakk/OrcaPJs/RimBot`，改完源码重启就生效）。

### 1.3.0 合并要点（2026-11-14）

上游 1.3.0 往 B 站**加写能力**（`group-share` 群分享、`qr-login` 扫码登录、`danmaku` 发弹幕），
本机方向相反：B 站只观察不写。所以这一版把 B 站**彻底扩展化**：

- 内核不再有 `src/bili/`、`src/modules/bili/`；`cleanExamples` 迁到 `src/core/examples.js`。
- B 站全部逻辑在 `extensions/bili-observer/bili/*`（vendored，靠 `globalThis.aurabot.lib`
  取内核源码）；测试改指扩展，桩在 `test/helpers/bili-lib.js`。
- 上游的 `group-share.js` / `qr-login.js` / `danmaku.js`（写）**没有合入**；
  弹幕**读取**（`danmakuText` / `pickDanmaku` + `docs/BILI-DANMAKU.md`）保留。
- `extensions/bili-observer/bili/api.js` 的 `createBiliApi({ getCookie, log, fetchImpl, allowWrite })`
  是唯一出口：写操作先过 `allowWrite(kind)`，被挡时返回 `{ ok: false, blocked: 'observer', kind }`，
  只有 `like` / `fav` 放行；`setFace` / `setSign` 的实现留着但被 `deny('profile')` 挡在最前。
- 配置里 `bili.groupShare.*` 的死键已删；`buvid3` / `buvid4` / `dedeUserId` 因上游
  `buildBiliCookie` / `splitBiliCookie` 仍在用而保留。
- 扩展的 `duty.js` 补上了 `chat/session-backoff.js` 语义（`hub.systemSessionCooldown('bili')` +
  `isSessionBackoff` 直接 rethrow，避免后台会话退避时继续打 B 站）。

## 小黑盒（社区模块 heybox 1.3.1，2026-11-04 装）

- 内核里已经没有 `src/heybox/`；模块装在 `plugins-data\aurabot\modules\heybox\`，
  带 `.aurabot-source.json`（id / version / sha256），面板「模块市场」能更新。
- 登录：面板「小黑盒」页**扫码**（`/heybox/qr/start`，用小黑盒 App 确认），或继续粘 Cookie。
- 自动逛：`tick` 每分钟看一次，遵守总开关 / 试运行 / 醒着时段 / 谷时 / 每日轮数 / 间隔；
  先拉信息流，再把帖子列表交给**无工具**的后台会话判断「记什么、分享哪条」，结果不发 QQ。
- 老内置版（1.1.24）的坑（`hasLogin` 未定义、后台会话没工具、不判醒着时段）在这个版本已修。

## 注意

- 代码 MIT；但桌宠素材（大肥鱼形象/动画）是 **CC BY-NC-SA 4.0、不可商用**，
  50MB+ 不随仓库分发，插件启动时从 mods 仓库自动下载（本机已下到
  `plugins-data\aurabot\modules-data\pet\packs\`）。
- SnowLuma 是 source-available 非商业许可，二进制另受 EULA 约束；EULA 5.4 禁止
  通过自动化脚本部署，所以插件只启停你自己装好的那份，协议由你本人同意。
- 群聊走 `aurabot-social` preset，一个本地工具都不挂；本地工具只在主人私聊里。
- `config.json` 里存着 QQ 号和网关 token，它在 `~/.dsh/plugins-data/`，不在本仓库。
