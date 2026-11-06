# B 站模块「观察者模式」升级方案

> 状态：方案定稿，待实施
> 版本：v1.0 · 2026-11-06
> 适用：`dsh-aurabot-qq`（Aurabot / RimBot）内置 `bili` 模块
> 本文档是施工依据。开发、测试、验收在独立对话中按第 9～10 节执行。

---

## 0. 一句话

把 B 站模块从**「会说话的角色」**改成**「只看只记的观察者」**：拆掉全部公开互动（评论、回评论、发弹幕、改资料），补上采集侧短板（推荐流、读弹幕、档位、判重表、日报归档、转写兜底），账号对外只保留**点赞**和**收藏**两种私有写入。

这不是"移植 dsh-bili-scroll"，是**用它在真实用户身上验证过的产品设计，补本模块的采集侧**。代码一行不搬。

---

## 1. 红线（不可协商）

| 档位 | 动作 |
|---|---|
| ✅ **只读** | 推荐流、搜索、视频信息、字幕、热评、**弹幕**、封面/抽帧、UP 主动态、消息列表 |
| ⚠️ **允许的写**（账号私有，不产生公开内容） | **点赞**（只给「值得看」，每日上限 5）、**收藏**（按档位进两个夹） |
| ❌ **禁止** | 评论、回复评论、发弹幕、私信、@人、关注/取关、投币、发动态、改头像、改签名 |

**红线必须落在代码里，不落在配置里**：`src/bili/api.js` 加统一写闸门，`posture === 'observer'` 时只有 `like` / `fav` 两类放行，其余写方法直接返回 `{ ok: false, blocked: 'observer' }`，**一个网络请求都不发**。理由：策略不能依赖"面板没点错"。

> ⚠️ 一个必须写进面板提示的事实：点赞和收藏都需要 `bili_jct`（CSRF token），只有 `SESSDATA` 时这两件事会失败，但不影响采集。

---

## 2. 已拍板的关键决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | `posture` 默认值 | 新装默认 `observer`；**老配置升级也强制 `observer`**，并打一条日志 + 面板提示 |
| 2 | 日报摘要推送 | **要推**：每天一条 QQ 私聊，汇总当天值得看的 |
| 3 | 收藏夹 | **分两个**：`值得看` 一个、`可以看` 一个；`不值当` 不收藏 |
| 4 | 点赞日上限 | **5 条/天**，且只给「值得看」 |
| 5 | QQ 私聊推送 | 不算"网上互动"，保留并鼓励（`shareToOwner` 保留） |
| 6 | 订阅 UP 主动态 | 保留（纯读） |

---

## 3. 现状盘点

### 3.1 文件地图

| 文件 | 行数 | 职责 | 本次动作 |
|---|---|---|---|
| `src/core/config.js` | 853 | `bili` 默认值（~155-199）、`normalize()`（~492）、`profilePerms`（22 行） | 改 |
| `src/bili/api.js` | 407 | B 站接口层，导出 19 个方法 | 改：加闸门、加 4 个接口 |
| `src/bili/duty.js` | 424 | 刷视频 / 回评论 / 看链接 / 改资料 | 大改 |
| `src/bili/dynamics.js` | 556 | UP 主动态订阅 | 不动 |
| `src/bili/judge.js` | 368 | 动态 AI 过滤 | 不动 |
| `src/bili/vision.js` | 178 | ffmpeg 抽帧 | 不动 |
| `src/bili/shots.js` | 148 | 截图库 | 不动 |
| `src/bili/login-pause.js` | 19 | 登录失效暂停恢复 | 不动（点赞/收藏也会撞 -101） |
| `src/bili/danmaku.js` | 49 | 发弹幕的前置（`prepareDanmaku`） | **删** |
| `src/modules/bili/index.js` | 225 | 工具注册 + 面板路由 | 大改 |
| `src/modules/bili/danmaku.js` | 195 | 发弹幕模块 | **删** |
| `client/client.js` | ~5200 | 面板 UI（`Bili` 组件约 3994-4130；权限页 1427-1429） | 改 |
| `src/chat/access.js` | — | `PROFILE_PERM_KEYS`（51 行） | 改 |

### 3.2 现有写路径（必须全部处理）

| 写路径 | 位置 | 触发 |
|---|---|---|
| `api.postComment` | `duty.js` `run()` 内、`checkReplies()`、`comment()` | 刷完自动评论 / 回楼中楼 / 主人要求 |
| `api.likeVideo` | `duty.js` `run()` 决策循环 | 看过的**每个**视频都点，无上限 |
| `api.postDanmaku` | `modules/bili/danmaku.js` | 面板手动 / 聊天工具 / 刷完自动 |
| `api.setSign` | `duty.js` `setSign()` | 聊天工具 |
| `api.setFace` | `duty.js` `setAvatar()` | 聊天工具 |

### 3.3 现有工具（10 个）

| 工具 | 本次 |
|---|---|
| `bili_watch` | ✅ 保留（被动看链接） |
| `bili_comment` | ❌ 删 |
| `bili_subscribe` / `bili_unsubscribe` / `bili_subs` | ✅ 保留 |
| `qq_send_shot` / `qq_list_shots` | ✅ 保留 |
| `bili_set_avatar` / `bili_set_sign` | ❌ 删 |
| `bili_danmaku` | ❌ 删（顺带解决与 dsh-bili-scroll 的 `bili_danmaku` 撞名） |

---

## 4. 目标架构

```
            ┌─ 采集源 ─────────────────────────────┐
            │ 关键词为空 → 推荐流（账号画像）        │
            │ 关键词有值 → 搜索（兴趣+记忆+配置）    │
            │ 推荐流失败 → 热门兜底                  │
            └──────────────┬───────────────────────┘
                           ↓
            ┌─ 读深一层 ───────────────────────────┐
            │ 视频信息 / 字幕 / 热评 / 弹幕 30 条    │
            │ 无字幕 → 转写兜底（可选，local.asr）   │
            │ 可选：ffmpeg 抽帧看画面                │
            └──────────────┬───────────────────────┘
                           ↓
            ┌─ 判 ─────────────────────────────────┐
            │ tier: worth / ok / skip               │
            │ 硬规则：worth 必须有字幕或画面证据      │
            └──────────────┬───────────────────────┘
                           ↓
            ┌─ 记 ─────────────────────────────────┐
            │ 判重表 bili-seen.json（2000 条滚动）   │
            │ 日报   bili-reports/YYYY-MM-DD.md     │
            │ 归档   bili-digest/YYYY-MM.md         │
            │ 记忆   memory.addEvent(tags:['B站'])  │
            └──────────────┬───────────────────────┘
                           ↓
            ┌─ 写（唯一） ─────────────────────────┐
            │ 点赞：worth，≤5/天                    │
            │ 收藏：worth→夹A，ok→夹B，≤10/天        │
            └──────────────┬───────────────────────┘
                           ↓
            ┌─ 出 ─────────────────────────────────┐
            │ 分享给主人（worth）                    │
            │ 每天 21:00 日报摘要私聊                │
            │ 面板「它刷过的视频」+「今天的日报」      │
            └──────────────────────────────────────┘
```

---

## 5. 详细设计

### 5.1 姿态开关与写闸门

**配置**（`src/core/config.js`）：

```js
bili: {
  posture: 'observer',   // observer | social
  // ...
}
```

**`normalize()` 规则**（`src/core/config.js` 约 492 行处）：

```js
b.posture = b.posture === 'social' ? 'social' : 'observer'
if (b.posture === 'observer') {
  b.comment = false
  b.reply = false
  b.danmakuEnabled = false
  b.autoDanmaku = false
}
```

> 字段保留不删，避免老配置读取时报错；`social` 模式可以完整恢复旧行为。

**写闸门**（`src/bili/api.js`）：

```js
export function createBiliApi({ getCookie, log, fetchImpl = fetch, allowWrite = () => true }) {
  const deny = (kind) => !allowWrite(kind) ? { ok: false, blocked: 'observer', kind } : null
  // 每个写方法开头：
  //   const blocked = deny('comment'); if (blocked) return blocked
}
```

| 方法 | kind | observer 下 |
|---|---|---|
| `postComment` | `comment` | 拒绝 |
| `postDanmaku` | `danmaku` | 拒绝（方法随模块一起删，闸门留作兜底） |
| `setSign` | `profile` | 拒绝 |
| `setFace` | `profile` | 拒绝 |
| `likeVideo` | `like` | **放行** |
| `favVideo`（新增） | `fav` | **放行** |

`duty.js` 构造 api 时传：

```js
allowWrite: (kind) => cfg().posture === 'social' || kind === 'like' || kind === 'fav'
```

**迁移提示**：模块 `setup()` 里检查 `dataDir('bili-posture.json')`，不存在则写入并 `log.info('B 站模块已切到「观察者模式」：不再评论/发弹幕/改资料，只保留点赞和收藏')`。只提示一次。

---

### 5.2 采集源：推荐流

**新增接口**（`src/bili/api.js`）：

```js
/** 首页推荐流（按账号画像）。没登录也能返回，但内容偏泛。 */
async function recommend({ ps = 30 } = {}) {
  await ensureBuvid()
  const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd', {
    web_location: 1430654, y_num: 5, fresh_type: 4, feed_version: 'V8',
    fresh_idx: 1, fresh_idx_1h: 1, brush: 0, homepage_ver: 1, ps,
  }))
  return (d.item || [])
    .filter((v) => v.goto === 'av' && v.bvid)
    .map((v) => ({
      bvid: v.bvid, aid: v.id,
      title: stripHtml(v.title), author: v.owner?.name,
      play: v.stat?.view || 0, pubdate: (v.pubdate || 0) * 1000,
      duration: v.duration, desc: stripHtml(v.desc || '').slice(0, 200),
    }))
}
```

**取源规则**（`duty.js` `run()`）：

```js
const kws = (c.keywords || []).filter(Boolean)
let pool = []
if (!kws.length) {
  // 推荐流：不过滤播放量/发布时间（推荐流本来就是老新混合）
  pool = filterVideos(await api.recommend({ ps: 30 }), { seen }).map((v) => ({ ...v, kw: '推荐' }))
  if (!pool.length) pool = filterVideos(await api.popular({ ps: 20 }), { seen }).map((v) => ({ ...v, kw: '热门' }))
} else {
  for (const kw of await chooseKeywords()) { /* 现有逻辑 */ }
  if (pool.length < c.perRun) { /* 现有热门兜底 */ }
}
```

- 推荐流失败（抛错）→ 记 `log.debug` → 回退 `popular`
- 推荐流模式下**不调用 `chooseKeywords()`**，省一次模型调用

---

### 5.3 读深一层

#### 5.3.1 读弹幕（当前完全没有）

> 现状：`danmakuInfo()` 只返回 `{cid, aid, ...}`，是**发**弹幕的前置，不读内容。

**新增接口**：

```js
/** 读一个 cid 的弹幕（前 limit 条）。失败返回 []，不抛。 */
async function danmakuText(cid, { limit = 30 } = {}) {
  try {
    const r = await fetchImpl(`https://api.bilibili.com/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    })
    const buf = Buffer.from(await r.arrayBuffer())
    const xml = inflate(buf).toString('utf8')   // deflate raw → 兜底 inflate → 兜底原文
    const list = [...xml.matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)].map((m) => decodeEntities(m[1]).trim())
    return pickDanmaku(list, limit)
  } catch (error) {
    log?.debug?.('读弹幕失败：', error.message)
    return []
  }
}
```

- 解压顺序：`zlib.inflateRawSync` → `zlib.inflateSync` → 原文（三种都要试，B 站不同 CDN 返回不一样）
- 过滤：长度 2～30、去掉纯数字/纯符号、去重
- 采样：按时间均匀取 `limit` 条（不是取最新 30 条，避免全是"打卡"）
- 返回 `string[]`

**接入** `duty.js` `lookAt()`：

```js
const [subtitle, comments, danmaku] = await Promise.all([
  api.subtitle(info).catch(() => ''),
  api.comments(info.aid).catch(() => []),
  api.danmakuText(info.cid).catch(() => []),
])
```

`digestOf()` 增加一段：

```
弹幕（节选）：哈哈哈 这波稳了 / 前方高能 / 爷爷你关注的UP更新了
```

#### 5.3.2 转写兜底（P3，可选）

- 触发：`subtitle` 为空 **且** `bili.transcribe === true`
- 流程：`ffmpeg -i <dash audio url> -vn -ac 1 -ar 16000 -f wav pipe:1` → POST 到 `local.asr`
- `src/local/local.js` 已有 `asr` 通道定义（`asr.mjs`，外部服务），按现有本地接口约定调用
- 失败 → 静默跳过，并在日报写「因无字幕跳过 N 条」
- 没有 ffmpeg / 没有 ASR 服务 → 直接跳过，不报错

---

### 5.4 判定：档位

**提示词改动**（`duty.js` `run()` 里的 `think()` 调用）：

```
对每个视频给一个对象：
{"i":序号,
 "tier":"worth|ok|skip",
 "why":"为什么值得（两三句，具体到内容，别说套话）",
 "feeling":"一句你的真实感受",
 "share":"想私聊分享给主人的话（觉得他会喜欢才写，不然空字符串）",
 "remember":"值得记住的一件事（没有就空字符串）"}

档位判据：
- worth = 你真心希望他花这十几分钟；**必须读过字幕或看过画面**才能给
- ok    = 有信息，但不看也不亏
- skip  = 标题党 / 复读 / 水分大；不进日报
手里只有标题、时长、简介这类表层信息时，最多给 ok。
```

**代码兜底**（不信任模型）：

```js
const hasEvidence = Boolean(x.subtitle) || Boolean(x.vision)
const tier = ['worth', 'ok', 'skip'].includes(d.tier) ? d.tier : 'ok'
const finalTier = tier === 'worth' && !hasEvidence ? 'ok' : tier
```

`skip` 不进日报、不点赞、不收藏，只进判重表。

---

### 5.5 记账

#### 5.5.1 判重表 `bili-seen.json`

```json
{
  "version": 1,
  "items": [
    {
      "bvid": "BV1xx411c7mD",
      "title": "标题",
      "up": "UP 名",
      "tier": "worth",
      "why": "一句话理由",
      "at": 1762400000000,
      "status": "seen"
    }
  ]
}
```

- 倒序，最多 **2000** 条，超出裁尾
- `status`：`seen`（看过）→ `liked` / `faved`（有写入时追加）
- **迁移**：`bili-seen.json` 不存在且 `bili.json` 有 `seen` 数组 → 一次性转成 items（`tier:'ok'`、`why:''`、`status:'seen'`），完成后写 `version:1`
- `run()` 里的 `const seen = new Set(s.seen)` 改为从判重表构建

#### 5.5.2 日报 `bili-reports/YYYY-MM-DD.md`

追加写入，**每条挑中的视频单独一段，首行固定 `### BV号`**：

```md
### BV1xx411c7mD
- 标题 / UP / 播放 12.3 万 / https://www.bilibili.com/video/BV1xx411c7mD
- **档位**：值得看
- 为什么值得：讲了 X 和 Y，第 3 分钟那个演示很具体
- 她的一句话：这个我服

### BV1yy411c7mE
...
```

- `### BV` 行数 = 当天挑中的条数，**用来对账每日配额**（面板和日报摘要都数这个）
- 文件末尾固定一行：`因无字幕跳过 N 条`（N=0 也写）
- 保留 **90 天**，写入时顺带清理更早的

#### 5.5.3 归档 `bili-digest/YYYY-MM.md`

一行一条，**挑中的和跳过的都记**：

```
11-06 · BV1xx411c7mD · 标题 · UP名 · 值得看 · https://...
11-06 · BV1yy411c7mE · 标题 · UP名 · 跳过（标题党） · https://...
```

#### 5.5.4 记忆

保留现有 `memory.addEvent({ tags: ['B站'], ... })`，`text` 用 `feeling + remember`。

---

### 5.6 写：点赞 + 收藏

#### 5.6.1 点赞

- 只对 `tier === 'worth'`
- 每日上限 **5**（`maxLikesPerDay`），计数进 `bili.json` 的 `likes`，随 `today()` 重置
- 失败静默（`-352` 走现有 `pauseIf` 逻辑）

#### 5.6.2 收藏（新增）

**接口**：

```js
/** 收藏夹列表：[{id, title, media_count}]。面板下拉用。 */
async function favFolders() {
  const { mid } = await nav()   // nav() 已经返回 mid
  if (!mid) throw new Error('没登录 B 站，读不到收藏夹')
  const d = await req(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`)
  return (d.list || []).map((f) => ({ id: f.id, title: f.title, count: f.media_count }))
}

/** 收藏一个视频到指定收藏夹。要 bili_jct。 */
async function favVideo(aid, folderId) {
  const csrf = parseCookie(getCookie()).bili_jct
  if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
  await req('https://api.bilibili.com/x/v3/fav/resource/deal', {
    method: 'POST',
    form: { rid: aid, type: 2, add_media_ids: folderId, csrf },
  })
}
```

**规则**：

| 档位 | 收藏到 | 配置项 |
|---|---|---|
| `worth` | 收藏夹 A | `favWorthFolderId`（0 = 不收藏） |
| `ok` | 收藏夹 B | `favOkFolderId`（0 = 不收藏） |
| `skip` | 不收藏 | — |

- 每日上限 **10**（`maxFavsPerDay`）
- 没配收藏夹 / 没有 `bili_jct` → 跳过，`log.debug`，不阻塞整轮
- 同一视频不重复收藏（判重表 `status` 已记 `faved` 就跳过）

> ⚠️ 面板必须提示：**B 站收藏夹默认是公开的**，别人点进主页能看到。要"不参与互动"就把这两个夹设成私密——插件只能选夹子，改不了可见性。

---

### 5.7 出口

#### 5.7.1 分享给主人（保留）

`shareToOwner` 保留，只在 `tier === 'worth'` 时发：

```
{share}
https://www.bilibili.com/video/{bvid}
```

#### 5.7.2 日报摘要推送（新增，已确认要推）

- 配置：`dailyDigest: true`、`dailyDigestHour: 21`
- 触发：`tick()` 里判断「今天还没推过」且当前小时 ≥ `dailyDigestHour`
- 内容：读当天日报，取 `###` 段前 5 条

```
今天刷了 6 条，3 条值得看：
· 《标题》 BV1xx411c7mD
· 《标题》 BV1yy411c7mE
· 《标题》 BV1zz411c7mF

跳过 2 条，因无字幕跳过 1 条。
```

- 当天没刷（0 条）→ 不发，避免刷屏
- 状态记 `bili.json` 的 `digestDay`

#### 5.7.3 截图（保留）

`shotChance` / `shotLibrary` / 截图库路由全部保留，逻辑不变。

---

### 5.8 面板

**B 站页（`client/client.js` `Bili` 组件，约 3994-4130）**

新增：

| 位置 | 内容 |
|---|---|
| 卡片顶部 | 姿态切换（观察者 / 社交），`posture` 字段，切换时确认框 |
| 「刷 B 站」卡片 | 关键词说明改为「留空 = 刷账号推荐流；填了才按关键词搜」 |
| 新卡片 | **它刷过的视频**：`/bili/seen` 列表，按档位筛（全部 / 值得看 / 可以看 / 跳过），分页 20 条 |
| 新卡片 | **今天的日报**：`/bili/report` 渲染 markdown 纯文本，可切日期 |
| 点赞行 | 改为「顺手点赞（只给值得看）」，显示「每天最多 N 条」 |
| 收藏行 | 两个下拉：值得看→夹 A、可以看→夹 B，加公开性提示 |

删除：

| 行（约） | 内容 |
|---|---|
| 4021 | 自己发评论 + 每天最多 |
| 4022 | 回别人回ta的评论 + 每天最多 |
| 4023 附近 | 保留「分享给你」 |
| 4064-4100 | 整个弹幕面板卡片 |
| 1427-1429 | 权限页 `biliSign` / `biliAvatar` / `biliComment` 三行 |

**新增路由**（`src/modules/bili/index.js`）：

```js
api.route('/bili/seen', ...)        // { items, total, tier? }
api.route('/bili/report', ...)      // { date, markdown }
api.route('/bili/fav/folders', ...) // { ok, folders }
```

**删除路由**：

```
/bili/replies
/bili/danmaku/state
/bili/danmaku/inspect
/bili/danmaku/send
```

---

## 6. 配置项清单

### 6.1 新增

| 键 | 默认 | 说明 |
|---|---|---|
| `posture` | `'observer'` | `observer` / `social` |
| `maxLikesPerDay` | `5` | 点赞日上限 |
| `maxFavsPerDay` | `10` | 收藏日上限 |
| `favWorthFolderId` | `0` | 值得看 → 收藏夹 id（0 = 不收藏） |
| `favOkFolderId` | `0` | 可以看 → 收藏夹 id（0 = 不收藏） |
| `dailyDigest` | `true` | 每天推一条日报摘要 |
| `dailyDigestHour` | `21` | 几点推（0-23） |
| `transcribe` | `false` | 无字幕时走本地 ASR（P3） |

### 6.2 保留但 observer 下强制关

`comment` `maxCommentsPerDay` `reply` `maxRepliesPerDay` `danmakuEnabled` `autoDanmaku` `maxDanmakuPerDay` `ownerName`

### 6.3 语义变化

| 键 | 变化 |
|---|---|
| `like` | 默认改 `true`；语义从「看过的都点」→「只给 worth，≤5/天」 |
| `keywords` | 留空不再只是"用内置方向"，而是**走推荐流** |
| `minViews` / `maxAgeDays` | 只对搜索/热门生效，**推荐流不过滤** |

---

## 7. 减法清单（精确到位置）

| # | 删什么 | 位置 |
|---|---|---|
| 1 | `bili_comment` 工具 | `src/modules/bili/index.js` 第二个 `defineTool`（约 50-62） |
| 2 | `bili_danmaku` 工具 | 同文件约 196-214 |
| 3 | `bili_set_avatar` / `bili_set_sign` | 同文件整个第二个 `api.tool(...)` 块（约 130-168） |
| 4 | `/bili/replies` 路由 | 约 188 |
| 5 | `/bili/danmaku/*` 三个路由 | 约 189-195 |
| 6 | `checkReplies()` 函数 + `tick()` 调用 | `src/bili/duty.js` 约 305-347、411 |
| 7 | `comment()` / `setSign()` / `setAvatar()` 函数 | `src/bili/duty.js` 约 364-400 |
| 8 | `run()` 里的评论分支、`atOwner()` | `src/bili/duty.js` 约 188-192、241-255 |
| 9 | `afterBrowse` 参数与调用 | `duty.js` 构造参数、约 289-292；`modules/bili/index.js` 27-31 |
| 10 | `src/modules/bili/danmaku.js` 整个文件 | 删除 |
| 11 | `src/bili/danmaku.js`（`prepareDanmaku`） | 删除 |
| 12 | `src/bili/api.js` 的 `postDanmaku` | 删除（或保留但闸门恒拒） |
| 13 | `PROFILE_PERM_KEYS` 里 3 个 B 站项 | `src/chat/access.js` 51 |
| 14 | `profilePerms` 默认值 3 项 | `src/core/config.js` 22 |
| 15 | 面板权限页 3 行 | `client/client.js` 1427-1429 |
| 16 | 面板弹幕卡片 | `client/client.js` 约 4064-4100 |
| 17 | 面板评论/回复两行 | `client/client.js` 4021-4022 |

> 删之前先全仓 `grep -rn "bili_comment\|bili_danmaku\|bili_set_avatar\|bili_set_sign"`，提示词（`personas/`）、文档、测试里可能还有引用。

---

## 8. 数据流（一轮完整走法）

```
tick() 每分钟
  ├─ 总开关 / posture / 作息时段 检查
  ├─ 日报摘要到点？→ 推一条，标记 digestDay
  └─ 到刷的间隔？→ run()

run()
  1. busy 锁
  2. 读判重表 → seen Set
  3. 取源（推荐流 / 关键词搜索 / 热门兜底）
  4. 按 kw 轮取 perRun 个
  5. 逐个 lookAt()：view + subtitle + comments + danmaku +（可选）vision
  6. think() → decisions（含 tier / why / feeling / share / remember）
  7. 逐条处理：
       tier 兜底（worth 无证据 → ok）
       记忆写入
       判重表写入
       日报追加 / 归档追加
       worth → 点赞（≤5）、收藏（夹 A）、分享
       ok   → 收藏（夹 B）
       skip → 只进判重表
  8. 截图（概率）
  9. 写 state（runs/comments→likes/replies→favs/lastRun）
 10. 日报「因无字幕跳过 N 条」
```

---

## 9. 分阶段任务（施工顺序）

### P0 减法 + 闸门（0.5 天）

| 任务 | 验收 |
|---|---|
| P0-1 `posture` 配置 + `normalize()` 强制 | `normalize({bili:{posture:'observer',comment:true}}).bili.comment === false` |
| P0-2 `api.js` 写闸门 | observer 下 `postComment/likeVideo/setSign/setFace` 的 mock fetch 调用次数 = 0（like 除外） |
| P0-3 拆工具 / 路由 / 面板 | 工具列表里没有那 4 个；`/bili/danmaku/send` 404 |
| P0-4 删 `danmaku` 两个文件 + 权限项 | `grep -r bili_danmaku src/` 只剩注释 |
| P0-5 迁移提示 | 首次启动打一次日志，第二次不再打 |

**P0 完成标准：observer 下跑一轮，抓不到任何评论/弹幕/资料变更请求。**

### P1 采集（1 天）

| 任务 | 验收 |
|---|---|
| P1-1 `api.recommend()` | fixture 解析出 `{bvid,aid,title,author,play,pubdate}`；失败回退 popular |
| P1-2 `api.danmakuText()` | deflate XML fixture 解析正确；坏数据返回 `[]` |
| P1-3 `lookAt()` 接入弹幕 | digest 里出现「弹幕（节选）」段 |
| P1-4 档位提示词 + 代码兜底 | worth 无字幕无画面 → 降级 ok |
| P1-5 判重表 | 迁移、去重、2000 条裁剪 |

### P2 记账与写（1 天）

| 任务 | 验收 |
|---|---|
| P2-1 日报 | 追加不覆盖；`### BV` 行数 = 挑中条数；90 天清理 |
| P2-2 归档 | 挑中的和跳过的都有一行 |
| P2-3 点赞改造 | 只对 worth；第 6 条不再发请求 |
| P2-4 收藏 | 两个夹分开；没配夹子不发请求；没 `bili_jct` 跳过 |
| P2-5 日报摘要推送 | 到点推一次；当天 0 条不推；重启不重推 |
| P2-6 面板三个新卡片 + 删除旧行 | 手动点一遍，无控制台报错 |

### P3 可选（0.5 天）

| 任务 | 验收 |
|---|---|
| P3-1 转写兜底 | 无 ASR 服务时静默降级，日报写「跳过 N 条」 |
| P3-2 日报摘要里带档位分布 | 文案可读 |

---

## 10. 测试计划

### 10.1 新增测试文件

| 文件 | 覆盖 |
|---|---|
| `test/bili-observer-guard.test.js` | 闸门：observer 下 5 个写方法的 fetch 调用数为 0；social 下正常 |
| `test/bili-recommend.test.js` | 推荐流解析、非 `goto=av` 过滤、失败回退 |
| `test/bili-danmaku-read.test.js` | deflate XML 解析、实体解码、采样、坏数据降级 |
| `test/bili-tier.test.js` | 档位解析、非法值兜底、worth 无证据降级 |
| `test/bili-seen.test.js` | 旧 `seen` 迁移、去重、2000 裁剪、倒序 |
| `test/bili-report.test.js` | 日报追加、`###` 计数、归档格式、90 天清理 |
| `test/bili-like-fav.test.js` | 只对 worth、日上限、两个夹、无 csrf 跳过 |

### 10.2 需要改的现有测试

| 文件 | 改什么 |
|---|---|
| `test/bili.test.js` | 删评论 / `setSign` / `setFace` 用例；保留 `filterVideos` / `digestOf` |
| `test/bili-danmaku.test.js` | 删除（模块已删） |
| `test/bili-danmaku-api.test.js` | 删除（`prepareDanmaku` 已删） |
| `test/bili-avatar-source.test.js` | 删除（工具已删） |
| `test/bili-subs-panel.test.js` | 工具列表断言更新；路由断言更新 |
| `test/bili-login-pause.test.js` | 保留 |
| `test/bili-login-recovery.test.js` | 保留 |

### 10.3 必须覆盖的边界

- `posture` 缺失 / 非法值 → 落到 `observer`
- 推荐流返回空 → 回退热门 → 还是空 → 返回 `{ok:false, message:'这次没搜到合适的视频'}`
- 弹幕接口返回 HTML 错误页 → `[]`，不影响整轮
- 日报文件不存在 → 新建；存在 → 追加
- 当天推过日报摘要 → 不重推
- `bili_jct` 缺失 → 点赞/收藏全跳过，采集照常

---

## 11. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 推荐流风控 / 返空 | 必须回退 `popular`；日志记 code |
| 推荐流需要登录态，未登录时内容偏泛 | 面板提示「没登录也能刷，但推荐不准」 |
| 弹幕 XML 格式变化 | 解析失败静默返回 `[]`，不阻塞 |
| 收藏夹接口需要 `bili_jct` | 面板明示；缺失时跳过并 debug |
| 升级静默关掉老用户的评论 | CHANGELOG 写清楚；面板姿态切换器可见；首次启动日志 |
| 删工具后提示词仍引用 | 删前全仓 grep；`personas/` 里若有 `bili_comment` 一并改 |
| 收藏夹默认公开，暴露浏览偏好 | 面板提示「建议设成私密」 |

**回滚**：`posture: 'social'` 即可恢复旧行为（工具和路由已删，但刷/评/回的主链路保留在 `duty.js`）。若连工具也要恢复，`git revert` P0 那个提交。

> 实施时建议：**P0 单独一个 commit**，P1/P2 各一个，方便回滚。

---

## 12. 明确不做

| 不做 | 原因 |
|---|---|
| 峰谷时段 | 它省的是"一整圈 agent 循环"的钱；本模块一轮只有 2 次模型调用 |
| 评论风格闸门 | 不评论了，没有闸门可守 |
| 私信双向 | 不做 |
| 内置 Whisper（1 GB） | 太重；走 `local.asr` 外部服务 |
| 移植 Python MCP | `api.js` 已覆盖八成读能力 |
| 整包安装 dsh-bili-scroll | 两套账号、两套配额、两套去重，且不进 QQ |
| 关注 / 投币 / 发动态 | 红线 |

---

## 13. 最终验收清单

- [ ] `npm test` 全绿
- [ ] `posture` 默认 `observer`；老配置升级后自动切观察者，日志提示一次
- [ ] observer 下**不存在**任何评论 / 弹幕 / 改资料的工具和路由
- [ ] 一轮刷完，网络层只能看到：读接口 + 点赞（≤5）+ 收藏（≤10）
- [ ] 推荐流生效；关键词为空时走推荐流且不调用 `chooseKeywords`
- [ ] digest 里能看到字幕 / 热评 / **弹幕** /（可选）画面
- [ ] 判重表有档位和理由，2000 条滚动
- [ ] 日报 `### BV` 行数 = 当天挑中条数；归档挑中的和跳过的都有
- [ ] 每天 21:00 收到一条日报摘要；当天 0 条时不发
- [ ] 面板：姿态切换、刷过的视频、今天的日报、两个收藏夹下拉都在；评论/弹幕/权限三项已消失
- [ ] CHANGELOG 有一条「B 站模块改为观察者模式（默认）」
- [ ] `docs/USER-MANUAL.md` 第 106-111 行、`docs/DESIGN.md` 第 15-16 行同步更新
- [ ] `docs/BILI-DANMAKU.md` 标记为已废弃或删除

---

## 14. 交接提示词（复制到新对话）

```text
你接手一个已经定稿的方案的实施：把 Aurabot（RimBot）的 B 站模块从"会说话的角色"改成"只看只记的观察者"。

仓库：D:\Nakk\OrcaPJs\RimBot（Node 22，ESM，无构建步骤，测试用 node --test）

第一步：完整读 docs/BILI-OBSERVER-PLAN.md，再读这些文件确认现状：
  src/core/config.js（bili 默认值约 155-199，normalize 约 492，profilePerms 22 行）
  src/bili/api.js（407 行，导出 19 个方法）
  src/bili/duty.js（424 行）
  src/modules/bili/index.js（225 行，工具 + 路由）
  src/modules/bili/danmaku.js（195 行，将被删除）
  client/client.js（Bili 组件约 3994-4130，权限页 1427-1429）
  src/chat/access.js（51 行 PROFILE_PERM_KEYS）

红线（方案第 1 节，必须原样遵守）：
  - 禁止任何形式的公开互动：评论、回评论、发弹幕、私信、@人、关注、投币、发动态、改头像、改签名
  - 只允许两种私有写入：点赞（只给"值得看"，≤5/天）、收藏（按档位进两个夹，≤10/天）
  - 红线要落在代码里：api.js 加写闸门，observer 下被禁的方法直接返回 {ok:false,blocked:'observer'}，一个请求都不发

已拍板的决策（不要重新讨论）：
  - posture 默认 'observer'，老配置升级也强制 observer，日志提示一次
  - 日报摘要每天推（默认 21:00）
  - 收藏夹分两个：值得看→favWorthFolderId，可以看→favOkFolderId
  - 点赞上限 5/天

施工顺序：P0 减法+闸门 → P1 采集 → P2 记账与写 → P3 可选。每阶段单独 commit，跑通测试再进下一阶段。
不要改 dynamics.js / judge.js / vision.js / shots.js / login-pause.js（订阅、AI 过滤、抽帧、截图库、登录暂停都保留）。
不要顺手重构无关模块，不要改其他平台的代码。

验收标准：方案第 13 节清单逐条打勾。跑 npm test 全绿，并新增方案第 10.1 节列的 7 个测试文件。

完成后给我一份简报：改了哪些文件、删了哪些、测试结果、以及面板上需要人工点一遍的地方。
```

---

## 15. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-11-06 | v1.0 定稿：确认 posture 默认、日报推送、双收藏夹、点赞上限 |
