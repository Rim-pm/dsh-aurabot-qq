# B 站判定 golden set

2026-11-19 用订阅「嘟嘟脸恶作剧」`mid=3537117026191454` 当天真实动态做重放时留下的样本。

- `replay.json` 的 `items` 是 `dynamicFeed` 解析后的形状（正文只保留 `aiFilterMaxChars` 截断前的原文）。
- `runs[].raw` 是模型（`magpie-responses/10/spark-x2.6`）**当次真实输出**，逐字保存，未做清洗；
  空字符串代表那一次被 `max-tokens` 截断、一个字都没写出来。
- `runs[].status` / `reasoningTokens` / `outputTokens` 取自网关响应的 `status` 和
  `usage.output_tokens_details.reasoning_tokens`，用来判断「预算够不够」。

样本量只有 1 天、1 个号、3 个批次，只用于防回归，不能当作模型能力的统计结论。
重放脚本不入库（在 `E:\scratch\tmp\opencode\`）；要加样本就照 `replay.json` 的结构追加，
并在 `test/bili-judge-golden.test.js` 里补对应断言。
