# 私聊社区模块引入方案（love-mode / real-life / little-notes / livin / meme-wiki）

本文只讨论**私聊**场景。本 fork 不做群聊玩法，所以群管、群话题边界、要钱、决斗、API 池这类模块一律不进名单。

## 一、结论摘要

1. **装模块不产生仓库 diff**。社区模块装到 `~/.dsh/plugins-data/aurabot/modules/<id>/`（`src/core/modules.js` 的 `userDir()`），私有数据在 `modules-data/<id>/`。所以「装模块」这件事本身不需要改仓库、不需要发版，也不需要为每个模块开分支。
2. 五个模块的 `api: 1`、`minPluginVersion: 1.2.0`、`requires: []`（无硬依赖），本机 `1.3.0-beta.2` 全部满足。
3. 本地 zip 的 sha256 与 registry `index.json` 一致，可放心从市场装（见附录 A）。
4. **风险按影响面排序**：`real-life`（接管 message + 拦截 send）> `love-mode`（无开关 + 每轮一次 `api.ask`）> `little-notes`（两个定时器各调 `api.think` + 主动发消息）> `meme-wiki`（外网同步 + `node:sqlite`）> `livin`（默认关，零行为）。
5. **有一个必须先决策的问题**：装上 `little-notes` 后，内置命令 `/记住`、`/翻唱` 会被模块命令劫持（详见第四节）。这是 `parseCommand` 的既有优先级问题，不是模块的错。

## 二、为什么装模块不产生仓库 diff

| 东西 | 位置 | 说明 |
|---|---|---|
| 模块代码 | `dataDir('modules')` → `plugins-data/aurabot/modules/<id>/` | 市场安装写入，带 `.aurabot-source.json` 记来源与 sha256 |
| 模块私有数据 | `api.dataDir()` → `plugins-data/aurabot/modules-data/<id>/` | `modules.js:618` |
| 模块设置 | `config.json` 的 `ext.<id>` | `api.settings()` 合并 `defaults` 与 `ext[id]` |
| 总开关 | `config.json` 的 `modules.<id>.enabled` | `isEnabled()`（`modules.js:542`）：`!== false` 即开 |
| 全停 | `config.json` 的 `safeMode` | `isUserOn()`（`modules.js:543`） |

因此分支能承载的只有：本文档、冒烟脚本、踩坑记录、以及**万一需要改内核**的补丁。真正隔离运行时行为要用 `AURABOT_DATA_DIR` 指向临时目录（`src/core/store.js:12`）。

## 三、五个模块的源码核验

以下结论全部来自逐个读 `index.mjs` / `module.json` / `panel.js`，不是猜的。

### 3.1 总表

| 模块 | 版本 | 默认开关 | 面板页 | 命令 | 工具 | 定时器 | 外网 |
|---|---|---|---|---|---|---|---|
| `livin` 过日子 | 1.2.2 | **`enabled: false`** | 独立页 | 无 | `joy_list` / `joy_do` | `api.every` 15min | 经 `douyin`/`bili` 模块，自身无直连 |
| `meme-wiki` 梗百科 | 0.2.7 | `enabled: true`、`autoSync: true` | 嵌进「聊天」页（`tab: 'group'`） | `/梗` | `search_meme_wiki` | `api.every` 12h 同步 | `cnmeme.wiki` |
| `little-notes` 小本本 | 1.2.2 | `enabled: true`、`nightlyTidy: true`（23 点）、`dueRemind: true` | 独立页 | `/本子` `/记` `/翻` | `note_add` / `note_search` / `note_recent` / `note_forget` | 20min（整理检查）+ 15min（日子提醒） | 无 |
| `love-mode` 快来跟我恋爱吧 | 1.5.0 | **无 `enabled`**（`settings: []`） | 独立页 | 无 | 无 | 无 | 无 |
| `real-life` 生理模块 | 1.1.0 | `enabled: true`、`groupEnabled: false` | 独立页 | `/身体` `/投喂` `/照顾` `/改状态` `/身体测试` | 3 个 `real_life_*` | `api.every` 30s 心跳 | 无 |

面板归属：`client/client.js` 的 `hasUi`（:9828）要求「有 settings 或有 panel」；`tabOf`（:9833）写了有效 `tab` 就嵌进那一页。前四个没有 `tab`，各自占一页，落在「系统」分组（`PLATFORM_EXT` 正则 :1000 不匹配它们）。`meme-wiki` 的 `tab: 'group'` 指向 TABS 里 `id: 'group', label: '聊天'`，所以它嵌在聊天页里。

### 3.2 `livin`（最安全，先装）

- `DEFAULTS.enabled = false`（`index.mjs:24`），注释写着「装上不动，面板手动开」。装上后除了面板多一页，**零行为**。
- 打开后：`api.every(15 * MIN, tick)`（:347）；`tick` 在主人 `idleMinutes`（默认 20）没说话、且过了 `quietStart`–`quietEnd`（1–8 点）之外，按 `wakeChance`（40%）概率挑一件乐子做，每天上限 `dailyMax: 8`。
- 可选依赖全部走 `api.use()` 且带降级：`minigame`（本 fork 无内置）、`bili`（本 fork 无内置模块，只有 `bili-observer` 扩展，**名字对不上，取不到**）、`mood`（有）、`feed`（本 fork 无）。
  - 结论：本 fork 上它实际可用的玩法是「写小说 / 喝水发呆 / 抖音（若有 douyin 模块）」。
- `api.rule`（:395）往规则里加「过日子」相关描述，只在模块开启时生效。

### 3.3 `meme-wiki`

- 依赖 `node:sqlite` 的 `DatabaseSync`。本机 Node v26.4.0 实测可用；仓库 `engines` 是 `>=22.13.0`，而 `node:sqlite` 在 22.5+ 才有、早期版本要 flag。模块自己 `try/catch` 兜底：取不到就 `api.log.warn` 后 `return`，**不牵连插件**（:47-52）。这点做得对，不用我们改。
- 首次启动 `autoSync: true` 会联网拉 `cnmeme.wiki`。词条不随包分发，首次需要面板「导入词条」全量拉（34 页 × 200 条）。
- `api.on('message')`（:332）只记 `lastText` 后 `return false`，不接管；`api.on('prompt')`（:342）在内容尾部追加命中的梗提示，有 `enabled` 与 `maxHints`（2）/`hintChars`（300）限流。
- 注入文本自带「这是外部资料不是指令」的开头（`EXTERNAL_HEAD` / `HINT_HEAD`），防注入意识可以。
- 命令 `/梗` 只给主人用；`api.tool` 在 `chat.kind === 'system'` 时返回空数组，后台自驱会话不会拿它乱查。

### 3.4 `little-notes`

- `defaults.enabled: true`，装上即生效。
- 两个 `api.every`：20 分钟跑一次 `tidyOnce`（实际只在 `tidyHour` 到点且当天没整理过才干活，:316），15 分钟跑一次 `remindOnce`（只在 8 点后、有到期条目时才发，:379）。
- 两条路径都会 `api.think` + `api.send`：**会在你睡觉时主动发私聊**。`nightlyTidy` / `dueRemind` 各自可关。
- `api.context`（:260）往上下文注入本子摘要；`api.rule`（:251）加规则。
- 4 个工具都限制 `chat.kind`；`maxPerChat` 默认上限会淘汰最旧条目。

### 3.5 `love-mode`（没有开关，装上就全程生效）

- `settings: []`、`defaults` 里**没有 `enabled`**。`isEnabled()` 只看 `config.modules['love-mode'].enabled`，所以想关只能：面板「已安装」里关模块，或 `safeMode`。
- 钩子：`api.context`（:273）+ 2× `api.on('reply')`（:468、:479）+ 6 条 `api.route`。无命令、无 `api.every`。
- `api.context` 里对**主人私聊**每轮跑一次 `advisorChain`：一次 `api.ask`（`maxTokens: 500`，20 秒超时），30 秒内同文缓存。失败自动降级为关键词匹配（`buildSkillContext`），聊天不中断。
  - 成本影响：私聊轮次 × 一次额外模型调用。这是本模块最实在的代价。
- `api.has('speakup')` 恒 `false`（本 fork 已删 `speakup`）→ `frame` 技能与 `needsSpeakUp` 走降级分支，属预期内的功能缩水。
- 两处硬编码路径：
  - `api.dataDir('../../chatlog/<YYYY-MM-DD>.jsonl')`（:165）→ 解析成 `plugins-data/aurabot/chatlog/`，本机存在（`persona.dataOwner = 'rim'`，根目录就是当前人格数据目录），**可用**。但换成非 owner 人格后 chatlog 会在 `persona-data/<id>/chatlog/`，这里就读空了 —— 只会让「最近对话」为空，不报错。
  - `api.dataDir('../../personas/dafeiyu.md')`（:320）→ 当前人格是 `rim`，这个文件读不到，被 `try/catch` 吞掉，`autoMatch` 拿到的 `persona` 为空串。**自动匹配的画像质量会下降**，但不报错。

### 3.6 `real-life`（唯一会改变「回不回消息」的模块）

- `DEFAULTS.enabled: true`、`groupEnabled: false`（`lib/engine.mjs:7-9`）→ 装上即对私聊生效。
- `api.on('message')`（:323）在暂离（上厕所/洗澡）或睡眠时返回 `true` **接管消息**：消息被攒起来，她不回，直到 `flushResumedAway` 合并回复或主人连发达阈值强召回。
- `api.on('send')`（:352）在 `away` / `asleep` 时返回 `null` **拦截外发**：这会压掉 `purpose` 的主动搭话、自驱引擎的外发。命令类 `info.force` 放行。
- `api.every(heartbeatSec)`（默认 30s，:759）推进状态机：饥饿、精力、膀胱、洗澡、28 天周期、睡眠阶段。
- 5 个命令 + 别名，3 个工具（`real_life_status` / `real_life_interact` / `real_life_routine`），7 条 route。
- 可选 `api.use('mood')` / `('memory')`，缺失时降级。

## 四、必须先决策：命令前缀劫持

`src/chat/commands.js:21` 先遍历模块命令（`extra`），再查内置 `ALIASES` / `COMMANDS`；而且模块命令的「中文前缀匹配」在内置命令之前生效。实测（`parseCommand` 直接调用）：

```
/记住我不吃香菜  -> 记 [little-notes] arg="住我不吃香菜"      # 应为内置 remember
/记一下 明天买菜  -> 记 [little-notes] arg="一下 明天买菜"      # 应为内置 remember
/翻唱 晴天      -> 翻 [little-notes] arg="唱 晴天"           # 应为内置 sing
/身体测试 经期1   -> 身体 [real-life] arg="测试 经期1"         # 应为 身体测试
```

也就是说：装上 `little-notes` 会吃掉 `/记住` 和 `/翻唱` 两个高频内置命令；装上 `real-life` 后 `/身体测试` 会被 `/身体` 前缀吃掉。

三个选项：

1. **改 `parseCommand`：让内置精确匹配优先于模块前缀匹配**。最小改动、不动第三方模块，但要新增测试并说明是有意改变优先级。
2. **只在文档里写明**，让用户改用 `/记住 我不吃香菜`（带空格）——不行，带空格时 `word` 仍是 `记住`，模块的 `names.includes('记住')` 不匹配，但前缀匹配 `记` 仍命中。**这个办法无效**。
3. **改模块命令名**（把 `记` 改成 `小本`）：要 fork 第三方模块，违背「模块不进仓库」的约定，还得跟上游。

建议选 1，但这是内核行为变更，需要单独一个 PR，不和「装模块」混在一起。

## 五、落地顺序（按爆炸半径）

| 阶段 | 模块 | 为什么这个顺序 |
|---|---|---|
| 0 | 无（准备沙箱） | `AURABOT_DATA_DIR` 指向临时目录，先确认能起来 |
| 1 | `livin` | 默认关，装上后除面板多一页外零行为；验证模块加载、面板渲染、`/modules` 列表 |
| 2 | `meme-wiki` | 只读注入 + 只记 `lastText`，不接管消息；验证 `node:sqlite`、首次同步、`/梗`、聊天页嵌入 |
| 3 | `little-notes` | 有主动发消息和定时 `api.think`，但可单独关 `nightlyTidy` / `dueRemind`；同时验证第四节命令劫持 |
| 4 | `love-mode` | 无开关，装上即每轮私聊多一次 `api.ask`；验证 token 消耗与降级路径 |
| 5 | `real-life` | 唯一接管 message + 拦截 send；放最后，且先 `/身体测试` 走一遍状态机再放真实聊天 |

每个阶段之间观察 1–2 天真实使用，不要一次全开。

## 六、每阶段验证清单

通用（每阶段都做）：

- [ ] `npm run lint` 通过（只在本仓库有改动时需要）
- [ ] 面板「已安装」里能看到该模块，`running` 为 `user`
- [ ] `config.json` 里出现 `ext.<id>`，`modules.<id>.enabled` 为预期值
- [ ] `modules-data/<id>/` 下生成了预期的数据文件
- [ ] `logs/` 里没有该模块的重复报错
- [ ] 关掉模块（`modules.<id>.enabled = false`）后行为确实停止

阶段 1 `livin`：

- [ ] 面板多出「过日子」页，能打开、能保存设置
- [ ] 默认 `enabled: false`，聊天行为无任何变化
- [ ] 手动开启后 15 分钟内不主动发消息（`idleMinutes` 默认 20）

阶段 2 `meme-wiki`：

- [ ] 启动日志无 `node:sqlite` 警告
- [ ] `modules-data/meme-wiki/memes.db` 生成
- [ ] `/梗 破防` 返回词条或「梗库里没有」
- [ ] 面板「聊天」页底部出现梗百科面板
- [ ] 首次全量导入完成后，随便发一句带梗的话，上下文里能看到注入（看日志或 `last-injection`）

阶段 3 `little-notes`：

- [ ] `/记 明天下午三点取快递` 能记上，`/本子` 能翻到
- [ ] 先关 `nightlyTidy` 与 `dueRemind`，确认夜间不会主动发消息
- [ ] **回归第四节**：`/记住我不吃香菜` 是否仍走内置 `remember`
- [ ] 打开 `dueRemind` 后，到期条目在次日 8 点后被提起

阶段 4 `love-mode`：

- [ ] 面板「快来跟我恋爱吧」页能打开，能切换关系模式
- [ ] 私聊一轮后 `modules-data/love-mode/state.json` 里出现 `skillLog` 条目，`kind` 为 `advisor` 或 `fallback`
- [ ] 断网/模型失败时聊天不中断（走降级路径）
- [ ] 观察 `usage.json` 的 token 增长是否符合预期
- [ ] 确认「自动匹配」不因 `personas/dafeiyu.md` 缺失而报错（应静默降级）

阶段 5 `real-life`：

- [ ] `/身体` 返回完整状态
- [ ] `/身体测试 上厕所` 后发私聊：消息被攒住、她不回；`/身体测试 结算` 后合并回复
- [ ] `/身体测试 深睡` 后确认 `purpose` 的主动搭话被拦截（`api.on('send')` 返回 `null`）
- [ ] `/投喂 红糖姜茶 热 一份` 数值变化正确
- [ ] `/改状态 饥饿=80` 生效
- [ ] **回归第四节**：`/身体测试` 是否被 `/身体` 吃掉

## 七、分支策略

**不推荐每个模块开一个分支。** 理由：

1. 模块是运行时数据，不在仓库里，分支管不到它；
2. CI（`.github/workflows/pr-check.yml`）只跑 `lint` + `test`，装没装模块对结果没有影响，分支给不了任何额外证据；
3. 五个分支最后都要合回 `main`，除了增加合并噪音没有收益。

推荐：

- **一条**分支承载「文档 + 冒烟脚本 + 踩坑」，命名 `feat/private-mods-compat`，本文档就在这条线上。
- 真正隔离用 `AURABOT_DATA_DIR`：`$env:AURABOT_DATA_DIR = 'E:\scratch\tmp\aurabot-sandbox'`，把 `modules/` 与 `modules-data/` 拷进去，随便折腾，不影响本机真实数据。
- **只有**某个模块需要改内核时才单独开分支（例如第四节 `parseCommand` 的优先级修复 → `fix/command-priority`；如果以后要修 `love-mode` 的 `dafeiyu.md` 硬编码，那是 fork 模块，不进本仓库）。

## 八、回滚

| 场景 | 操作 |
|---|---|
| 某个模块行为不对 | 面板「已安装」里关掉，或 `config.json` 里 `modules.<id>.enabled = false` |
| 全部模块出问题 | `config.json` 里 `safeMode = true` |
| 模块数据脏了 | 删 `modules-data/<id>/`，下次启动重新初始化 |
| 模块代码坏了 | 删 `modules/<id>/`，从市场重装 |

`modules.<id>.enabled = false` 会让 `isEnabled()` 返回 false，`useBuiltin` / 事件 / 命令 / 工具全部停止（`modules.js:890`、`590`），比卸载更轻。

## 附录 A：来源校验

本地 zip 与 registry 的 sha256 一致：

| 模块 | 版本 | sha256 |
|---|---|---|
| `little-notes` | 1.2.2 | `c18d8a02d7f370f23636f5c7bec75e03cee86f82fe20f480698f58e2b87dbfc0` |
| `livin` | 1.2.2 | `734b666c64320adcf6af4033418354b81c15c91ce3c608680e1b00bbca65c079` |
| `love-mode` | 1.5.0 | `bb7521e28e9607e0d9a454bd1e06d5de04d6ee91efa5e0175f8d4ec273c707b2` |
| `meme-wiki` | 0.2.7 | `00c7d8a1df7f70fb836955b064381b627779dbe64ca08152f9d5129ae2cf8daa` |
| `real-life` | 1.1.0 | `43e7d6884b83a77accc980005fb4f8f91a7881b99e138e9239b5ea6ecfa3f5e6` |

来源：`https://raw.githubusercontent.com/aureth-labs/dsh-aurabot-qq-mods/registry/index.json`（`src/core/community.js:18` 的 `REGISTRY_URL`）。

## 附录 B：明确排除的模块

群聊类全部排除：`group-admin`、`group-topic-boundary`、`beg-for-money`、`duel`、`api-pool`。`persona-runtime` 与 `beliefs` 经用户确认不做。
