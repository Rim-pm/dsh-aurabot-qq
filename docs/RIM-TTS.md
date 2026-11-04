# 接 RimTTS 当 Rim 的声音

面板「语音」页的引擎里多了一项 **RimTTS（Rim 的声音）**：用 RimTTS 项目（同机另一个仓库）训练好的
GPT-SoVITS 权重，把她要说的话念成琳的声音发语音条。

这个模型很大，所以默认**不常驻**：要说话时才把推理服务拉起来，说完空闲一会儿就关掉，把内存和显存还回去。
冷启动的代价是真的（几十秒），代码里用三种办法把它藏起来，见下面「冷启动怎么藏」。

## 为什么不直接把「本地 GPT-SoVITS」指过去

原来的 `gptsovits` 引擎假定**服务已经常驻**：它只发请求，不管进程死活。拿它接 RimTTS 会有两个问题：

- 服务没起的时候，第一句直接失败（连接被拒），退回 Windows 机械音；
- 就算用户自己挂一个常驻服务，那正好是这次要避免的——约 4.3 GB 内存 + 2.2 GB 显存一直占着。

所以这里加了一个**自己管进程**的引擎：`src/voice/rimtts.js`。

## 实测数据（RTX 4060 Ti，turbo 配置，`tts_infer_rim_turbo.yaml`）

| 指标 | 实测 |
|---|---|
| 冷启动（spawn → `/docs` 返回 200） | **15.2 s**（系统文件缓存热）/ **36.9 s**（真正冷盘） |
| 起来后第一次合成（CUDA 预热） | 7.4 s |
| 热着合成一句 15 字 | 2.3 – 2.6 s |
| 常驻内存 RSS | 起来时约 1.7 GB，用过后约 **4.3 GB** |
| 显存 | +2.2 GB（1888 → 4064 MiB） |
| 关闭（`/control?command=exit` + taskkill） | **0.4 s**，显存立刻回到 1712 MiB，无残留进程 |

结论：让它常驻确实不划算（4 GB 内存换一个大部分时间不用的能力）；但「每句都冷启动」也太慢。
折中就是默认值——**空闲 180 秒后关**，一段对话里连着说几句只付一次冷启动。

## 生命周期

```
idle ──要说话──▶ starting ──就绪──▶ ready ──(warmup)──▶ 合成 ──touch──▶ ready
                    │                                        │
                    └──超时/进程退出──▶ idle（杀掉，报错）    └──空闲 idleSeconds──▶ stopping ──▶ idle
```

几条硬规则，都在 `src/voice/rimtts.js` 里：

- **单飞**：几个会话同时要语音，只会真的启动一次（`starting` 那个 Promise 大家共用）。
- **单队列**：合成请求串行。单卡上两个请求同时进来只会互相排队，还容易把第一句拖成 30 秒。
- **只关自己起的**：端口上已经有服务在跑（比如你自己开着 RimTTS 的划词朗读 `rimreader`）就直接用，
  不抢端口，也**绝不会**去关不是我们起的进程。
- **DSH 退出兜底**：`process.once('exit')` 里同步 `taskkill /T /F`，不会把模型进程留在后台吃内存。
- **日志**：`~/.dsh/plugins-data/aurabot/rimtts/api.log`（超过 4 MB 会截断），起不来时错误信息里会带最后几行。
- **卡死自愈**：合成超时就把进程杀掉，下一句重新起，而不是对着一个僵住的进程反复超时。

## 冷启动怎么藏

1. **预启动（`prewarm`，默认开）**：对方明确要语音时，hub 在这一轮**开始**就先把服务叫起来
   （`hub.js` → `tts.prewarm()`），和她思考怎么回并行。冷启动 30 秒大部分能被思考时间吃掉。
2. **冷着就先发文字（`hot()` 闸门，默认开）**：短回复「顺手变语音」只在服务热着时才做。
   冷着的时候等 40 秒再蹦出一条语音，体验比直接发文字差得多——真要听可以说「发语音」。
3. **预热（`warmup`，默认开）**：起来后先合成一句「こんにちは、準備できました。」把 CUDA 预热掉，
   真正要说的那句就不用再等 7 秒。
4. **空闲缓冲（`idleSeconds`，默认 180）**：连着说几句不用反复冷启动。

最坏情况（真正冷盘 + 没预启动 + 直接要语音）：**约 45 秒**出一句语音。有预启动时通常 10–20 秒。

## 面板里能调什么

| 项 | 默认 | 说明 |
|---|---|---|
| RimTTS 目录 | 空 | RimTTS 项目根目录，里面有 `tools/GPT-SoVITS` 和 `pipeline/refs_pool.json` |
| 配置文件 | `GPT_SoVITS/configs/tts_infer_rim_turbo.yaml` | 相对 `tools/GPT-SoVITS`。turbo 最快；`tts_infer_rim.yaml`（v5dev）音质更好但慢一倍 |
| 端口 | 9880 | 端口上已有服务就直接用它 |
| 说完多久关掉 | 180 秒 | `0` = 每句念完立刻关（最省内存，但每句都要冷启动） |
| 预热 | 开 | 起来先合成一句 |
| 预启动 | 开 | 有人明确要语音时提前拉起服务 |
| 起不来时 | 开着 = 改发文字 | 关掉就退回 Windows 机械音（不推荐） |

参考音频不用手填：默认读 RimTTS 的 `pipeline/refs_pool.json`，取 `narration` 分组的**第一条**并固定用它。
（RimTTS 那边实测过：轮换参考会让服务端每次重编码 prompt，同一句从 5 秒变 39 秒。）

## 配置步骤

1. 面板「语音」页 → 引擎选「RimTTS（Rim 的声音）」。
2. 「RimTTS 目录」填 RimTTS 项目根目录，例如 `D:\Nakk\AutoClawPJs\RimTTS`。
3. 保存，点「试听」——第一次会等半分钟（要起模型），之后 2–3 秒。
4. 状态条会显示「模型已加载（pid …，空闲 N 秒）」/「模型没在跑」，旁边有「立刻关掉」可以马上把内存还回去。

不需要提前跑 `start_api.ps1`，也不需要常开 `rimreader`。

## 已知限制

- **冷启动是硬成本**：api_v2 没有「卸载模型但留进程」的接口，只能整进程起停。
- **单卡串行**：同时有两句要合成时，第二句要等第一句。
- **显存被别的程序占满**时 api_v2 会 OOM 退出，表现为「起来就退了」，错误里带服务日志，面板会显示上次出错。
- **只支持 Windows 路径写法**：venv 在 `.venv\Scripts\python.exe`，关进程走 `taskkill`。Linux 上要另测。
- 每次启动都要重新读一遍 BERT / HuBERT / 权重，磁盘冷的时候就是 37 秒那档。

## 自己验一遍

不经过 DSH，直接看生命周期对不对。存成 `rimtts-smoke.mjs` 放在插件仓库根目录，跑 `node rimtts-smoke.mjs`
（会真的起一次模型、合成两句、再等空闲关掉，约 1 分钟）：

```js
import { rimttsSynth, status, stop } from './src/voice/rimtts.js'

const cfg = {
  root: 'D:\\Nakk\\AutoClawPJs\\RimTTS',
  configYaml: 'GPT_SoVITS/configs/tts_infer_rim_turbo.yaml',
  port: 9880, refGroup: 'narration', speed: 1,
  idleSeconds: 8, warmup: true, prewarm: true, maxWaitSeconds: 180, noFallback: true,
}
const log = { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) }

let t = Date.now()
const f1 = await rimttsSynth('你好呀，我是琳。今天也辛苦了，早点休息吧。', cfg, log)
console.log(`① 冷启动+合成：${((Date.now() - t) / 1000).toFixed(1)} s`, f1, status(cfg))

t = Date.now()
await rimttsSynth('第二句，模型已经热了，这句应该很快。', cfg, log)
console.log(`② 热着再合成一句：${((Date.now() - t) / 1000).toFixed(1)} s`)

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if (!status(cfg).running) break
}
console.log('③ 空闲后：', status(cfg))
await stop()
process.exit(0)
```

正常的输出：① 十几到三十几秒（第一次）、② 2–3 秒、③ `running: false`。
中间用 `Get-NetTCPConnection -LocalPort 9880` 能看到端口在起、关两个阶段的变化。

## 以后还能怎么优化

- 把 `bert_base_path` 换小模型（中文 BERT 占启动时间的大头），音色基本不受影响。
- 常驻一个**不加载模型**的壳，收到请求再 `os.execl` 重启自己（省掉 Python + torch 的 import，约 5–8 秒）。
- 高频句子（「晚安」「在呢」）走磁盘缓存，命中就不起服务——RimTTS 自己的 `ttsclient.py` 就是这么做的。
