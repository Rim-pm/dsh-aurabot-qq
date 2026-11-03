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
| profile | `dsh-tui`（`~/.dsh/profiles/dsh-tui`） |
| Node / pnpm | v26.4.0 / 12.16.1 |
| 本仓库 | `D:\Nakk\OrcaPJs\RimBot`，main @ `b3301f6` |

## 安装方式：本地 link，不是从 npm 装

```powershell
dsh plugin --profile dsh-tui add D:\Nakk\OrcaPJs\RimBot
```

pnpm 会在 profile 的 `package.json` 里写一条
`"dsh-aurabot-qq": "link:D:/Nakk/OrcaPJs/RimBot"`，并在
`node_modules/dsh-aurabot-qq` 建一个指向本目录的 junction，同时把
`dsh-aurabot-qq` 加进 `dsh.profile.bundles`。

所以：**改这里的代码 → 重启 DSH 就生效**，不用重新安装。插件自带的
`cordis.patch.yml` 会挂上 `aurabot` 本体和三个 agent preset
（`aurabot-private` / `aurabot-private-long` / `aurabot-social`）。

卸载：

```powershell
dsh plugin --profile dsh-tui remove dsh-aurabot-qq
```

## 启动

```powershell
dsh --profile dsh-tui
```

- 插件是宿主 + 网页两半。**TUI 里没有面板**（面板是 web client，走 DSH web 的 slots）。
  在 TUI 下只有宿主那半在跑：QQ 网关、会话、工具、定时任务。
- 宿主启动时会起一个 loopback webserver，Aurabot 的接口挂在 `/aurabot/api/*` 上。
  端口是动态的，去这里看：
  `%USERPROFILE%\.dsh\plugins-data\aurabot\modules-data\pet\host.json` 的 `baseUrl`。
- 日志：`%USERPROFILE%\.dsh\plugins-data\aurabot\logs\aurabot-<日期>.log`
- 数据（配置/人格/记忆/表情/模块）：`%USERPROFILE%\.dsh\plugins-data\aurabot\`

启动成功的日志长这样：

```
[core] Aurabot v1.1.24 已加载｜总开关 关｜试运行 开｜工作区 ...\Aurabot\qq-chats
```

## 已验证（无需 QQ 就能测的部分）

```powershell
$base = 'http://127.0.0.1:<端口>'

# 总览：版本、配置、权限、网关状态
Invoke-RestMethod "$base/aurabot/api/state"

# 模型通路（走 DSH 的 llm，回一句「在呢」）
Invoke-RestMethod "$base/aurabot/api/model/ping" -Method Post -ContentType application/json -Body '{}'

# 模块干跑（截获发送，不真发；只跑模块钩子，不跑模型）
Invoke-RestMethod "$base/aurabot/api/modules/simulate" -Method Post -ContentType application/json `
  -Body '{"as":"owner","kind":"private","text":"在吗"}'
```

本机实测：`/state` 200、`/model/ping` 1.6s 回「在呢」、`/save` 能落盘
`config.json`；仓库自带测试 `node --test "test/**/*.test.js"` 669 passed / 0 failed。

## 配置（TUI 下没有面板，走接口或改文件）

```powershell
# 走接口，改完立即生效
Invoke-RestMethod "$base/aurabot/api/save" -Method Post -ContentType application/json -Body (@{
  botQQ   = '机器人小号QQ'
  ownerQQ = '你的QQ'
  gateway = 'snowluma'      # 或 'onebot'
} | ConvertTo-Json)
```

或者直接改 `%USERPROFILE%\.dsh\plugins-data\aurabot\config.json`，改完重启 DSH。

安全默认：`enabled=false`（总开关关）、`dryRun=true`（试运行）。不手动打开，一句都不会发到 QQ。

## 还差什么才能真的收发 QQ 消息

1. 一个**机器人 QQ 小号**，以及它的登录凭据（这个只能你本人扫码/登录）。
2. 一个 OneBot v11 网关：
   - Windows 最省事是 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)：
     自己下载解压，在面板里同意 EULA（插件按它的 5.4 条不代下载、不代同意），
     登录小号后让插件「接入机器人号」；
   - 或者接已有的 NapCat / LLOneBot / Lagrange / Docker 版 SnowLuma，把正向 WS 地址填进来。
3. 填完 `botQQ` / `ownerQQ`，打开总开关，先保持试运行跑一轮，再关掉试运行。

当前本机：`C:\Aurabot` 不存在，全盘也没搜到 SnowLuma，所以**网关这一环还没装**。

## 跟上游同步

```powershell
git fetch upstream
git rebase upstream/main      # 本地改动在 main 上，rebase 完再 push origin main
```

插件本体是纯 ESM、没有 npm 依赖，拉完重启 DSH 即可。

## 注意

- 代码 MIT；但桌宠素材（大肥鱼形象/动画）是 **CC BY-NC-SA 4.0、不可商用**，
  50MB+ 不随仓库分发，插件启动时从 mods 仓库自动下载（本机已下到
  `plugins-data\aurabot\modules-data\pet\packs\`，一次 429 后重试成功）。
- SnowLuma 的 EULA 禁止自动化部署，插件只启停你自己装好的那份。
- 群聊走 `aurabot-social` preset，一个本地工具都不挂；本地工具只在主人私聊里。
