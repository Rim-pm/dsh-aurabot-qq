# AGENTS.md

给在本仓库里干活的 agent / 协作者看的约定。更偏「怎么跑、怎么合、别踩什么坑」；
产品说明见 `README.md`，本机部署笔记见 `RIMBOT.md`。

## 项目形状

- 纯 ESM，`"type": "module"`，没有构建步骤，也没有运行时依赖（`optionalDependencies` 只有 `onnxruntime-node`）。
- 入口 `src/host.js`，Web 面板在 `client/client.js`（用 `React.createElement`，不是 JSX）。
- 模块在 `src/modules/*`，内置模块清单在 `src/modules/index.js` 的 `BUILTINS`。
- 扩展在 `extensions/*`（自带 `panel.js`，路由挂 `/ext/<name>/*`）。
- 测试在 `test/*.test.js` 与 `extensions/**/*.test.mjs`，用 Node 内置 `node --test`。

## 命令

```powershell
npm test          # 全量测试（约 3~4 分钟）
npm run lint      # 行尾 / 缩进 / 语法检查（秒级）
npm run check     # lint + test
```

提交前至少跑 `npm run lint`；改到逻辑就跑对应测试文件，收尾跑全量。
`test/e2e.test.js` 在本机并发跑全量时偶发 flaky，单独跑全绿即可。

## 代码风格

- 2 空格缩进，不加分号，单引号；行尾统一 LF（见 `.gitattributes`）。
- 注释和文档用中文，注释只解释「为什么」，不复述代码。
- 不引第三方依赖；要新能力先看仓库里有没有现成工具（`src/core/*`）。
- 新模块/新面板要配测试；面板改结构时同步改断言，别放宽到「能渲染就行」。

## 分支与合并

- `origin` = 自己的 fork（`Rim-pm/dsh-aurabot-qq`），`upstream` = 原作者仓（`aureth-labs/dsh-aurabot-qq`）。
- 同步上游走 release/beta 线：`git fetch upstream` 后 `git merge upstream/release/1.3.0`（或 `upstream/beta`）。
- 合进 `main` 一律走分支 + PR + CI（`.github/workflows/pr-check.yml`），**用 merge commit，不要 squash**，否则丢上游提交归属。
- PR 正文写清楚「哪些差异是有意的」，尤其是与上游相反的设计（见下）。

### 同步上游不开 PR

上游提交已在上游仓过 review + CI，信任传递，不重复走 PR：

```powershell
git fetch upstream
git merge upstream/release/1.3.0   # 或 upstream/beta
npm test                           # 冲突解决后必跑
git push origin main
gh workflow run "PR Check" --repo Rim-pm/dsh-aurabot-qq --ref main
```

最后一步是补 CI 证据：`pr-check.yml` 只监听 `pull_request` 与 `workflow_dispatch`，没有 `push` 触发器，直接 push 不会留测试记录。`--ref main` 表示用 main 当前代码跑，所以必须在 push 之后触发。

例外：如果冲突解决时改动了上游原意（不只是机械合并），就退回走 PR，因为此时结果已经不是「上游审过的那份代码」了。

## fork 与上游的有意差异（改到这些地方先看这里）

- **B 站只观察不写**：B 站在本 fork 是 `extensions/bili-observer` 扩展，内核没有 `src/bili/`、`src/modules/bili/`；不采用上游「内容平台」页签（`CONTENT_PLATFORMS` / `ContentTab` / `Bili` / `BiliDanmaku` / `ShotCell`），`/bili/*` 根路由不存在。
- `src/modules/index.js` 的 `BUILTINS` 不含 `speakup`、`bili`；`src/features/companion.js` 与 `src/modules/speakup` 已随上游退场删除，能力在 `purpose`。
- `src/core/config.js` 保留 posture/observer 强制关、配额、`dailyDigestHour` 归一化。
- 抖音 / 小黑盒保留各自的独立页签。

## 别做的事

- 不要把本机数据写进仓库：QQ 号、token、`~/.dsh/plugins-data/` 的内容、`TESTLOG.md` 都只在本地。
- 不要为了让测试变绿而放宽断言或跳过用例；flake 就单独跑一遍确认。
- 不要顺手 `git push --force` 到 `main`，也不要在没要求时改版本号。
