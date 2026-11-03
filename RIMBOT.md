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

```powershell
git fetch upstream
git rebase upstream/main      # 本地改动在 main 上，rebase 完再 push origin main
```

插件本体是纯 ESM、没有 npm 依赖，拉完重启 `dsh web` 即可。

## 注意

- 代码 MIT；但桌宠素材（大肥鱼形象/动画）是 **CC BY-NC-SA 4.0、不可商用**，
  50MB+ 不随仓库分发，插件启动时从 mods 仓库自动下载（本机已下到
  `plugins-data\aurabot\modules-data\pet\packs\`）。
- SnowLuma 是 source-available 非商业许可，二进制另受 EULA 约束；EULA 5.4 禁止
  通过自动化脚本部署，所以插件只启停你自己装好的那份，协议由你本人同意。
- 群聊走 `aurabot-social` preset，一个本地工具都不挂；本地工具只在主人私聊里。
- `config.json` 里存着 QQ 号和网关 token，它在 `~/.dsh/plugins-data/`，不在本仓库。
