# B 站订阅判定：重放实验暴露的问题与整改清单

2026-11-19 用当天真实动态（订阅「嘟嘟脸恶作剧」`mid=3537117026191454`）做离线重放，
复现了线上「判定超时 → 原样转发」的过程，并对照了新参数。结论：病根是**输出预算被推理
token 吃光**，不是模型能力问题。下面是当时列出的问题与处理状态。

重放脚本与完整报告在 `E:\scratch\tmp\opencode\`（`bili-replay.mjs`、`bili-old.mjs`、
`bili-variance.mjs`、`bili-replay-report.md`），不入库。

## 复现数据

| 批次 | 旧版（1500+600·n，45s） | 新版（2500+800·n，120s） |
| --- | --- | --- |
| 10:08 维护开始（1 条，带图） | `reasoning=523/520`，输出 0 字符 → fail-open | 摘要 + 2 要点 + 图 |
| 11:11 视频投稿（1 条） | 正常判出 | 摘要 |
| 15:44 维护结束 + 兑换码（2 条） | `reasoning=844/840`，输出 0 → 两条都原文转发 | 合并 digest |

单条判定实测推理消耗 1400~1900 token（老样本，长图文），远超旧预算 1500。波动很大：
同一批样本重放三次，推理 token 从 167 到 1332 都有。这也是为什么预算要给足、
并且在 `max-tokens` 截断时还要能放宽重试。

## 清单

### 1. 输出预算仍然偏紧（已改）

`extensions/bili-observer/bili/judge.js` 的 `JUDGE_MAX_TOKENS_BASE` / `PER_ITEM` 从
1500/600 提到 2500/800。旧值下 2100 预算被用到 88%，单条仍有约一半概率打满。

### 2. 截断后不会重试（已改）

`src/core/llm.js` 原来只在「输出完全为空」时放宽预算重试。截断场景是「输出半截 JSON」，
非空 → 不重试 → 直接 fail-open。现在 `runStream` 把 finish 的 `kind` 带出来，`max-tokens`
也触发一次放宽重试（`maxTokens` 翻三倍，上限 8000）。

### 3. 判定模型没有推理元数据（已查清，无需改配置）

`~/.dsh/profiles/web/cordis.patch.yml` 里 `magpie-responses/10/spark-x2.6` 只声明了
`input` 和 `compat`，没有 `reasoningEfforts`；网关 `/v1/models` 也报
`reasoning: false`、`reasoning_levels: []`。所以 `pickReasoningEffort` 查不到就干脆不传。

一度以为是问题所在，实测**不是**：

| 传入 reasoning | 推理 token / 输出 token | 耗时 |
| --- | --- | --- |
| 不传 | 758 / 878 | 16.5s |
| `minimal` | 706 / 827 | 18.1s |
| `low` | 749 / 874 | 14.9s |
| `medium` | 612 / 737 | 26.0s |
| `high` | 421 / 554 | 13.1s |

网关接受所有档位（响应里会回显 `effort`），但**推理 token 消耗与档位无关**，都落在
420~760。也就是说 effort 既省不下预算也压不住波动，`reasoningEfforts` 属于锦上添花。

真正决定成败的是输出预算：不传 reasoning、只用 2500，把三条历史 `by=fail` 样本走一遍
`askModel` 真实路径，全部判出（66s / 24s / 22s，1/1、1/1、1/1）。
**结论：不改 profile，靠第 1、2 条的预算 + 放宽重试即可。**

### 4. salvage 只能算兜底（待做）

`judge.js` 的 `salvageObjects` 只能救「完整的前几个对象」。截断落在第一个对象内部时救不
回来（单条判定必然如此）。另外日志把「被截断」和「模型乱说」混成一句「没解析出结果」，
排查时看不出区别。建议把 finish kind 记进 debug 日志。

### 5. 观测缺失（待做）

`status` / `finish_reason` / `reasoning_tokens` 现在哪儿都没记。这次是手工抓网关响应才
看出来的。建议进 `usage.json` 或 debug 日志。

### 6. `by=fail` 时仍然全文转发（待做，产品层）

fail-open 是故意的（宁可多推不可漏推），但转发的是完整原文，包含「立即下载首日可获取
130 抽」这类广告尾。可以退化成「标题 + 前两行」，或直接提示「这条没判成，自己去看」。

### 7. 判定串行，多订阅号会拖长一轮（待做）

单次判定实测 32~63 秒，`poll` 串行且有 `busy` 锁。一个号没事，三五个号一轮可能 3 分钟，
而 `tick` 每 60 秒会跳过。扩订阅前需要并发或限流。

### 8. 样本量太小（待做）

n=4 条、1 天、1 个号。建议把重放固化成 golden set：录 N 天的原始动态 JSON + 模型原始
输出，之后每次改判定逻辑跑一遍防回归。

## 这类测试叫什么

- **记录-回放测试 / record & replay**：录真实输入，改完代码原样喂回去。最贴切。
- **影子运行 / shadow mode**：新旧两版并行跑同一份真实数据，只对比不发送。
- **差分测试 / differential testing**：同一输入喂两个版本比差异。
- **黄金样本回归 / golden-set regression**：固定样本做基准，防退化。
- 最后一步由人看合不合适，整体叫 **human-in-the-loop evaluation**。
