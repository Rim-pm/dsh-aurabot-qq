// B 站判定 golden set 回归：用 2026-11-19 真实重放存下来的模型原始输出，锁住
// 「解析 → 判定 → 摘要」这条链的输出。不联网、不调模型。
//
// 样本说明见 test/fixtures/bili-judge/README.md：raw 是当次模型输出逐字记录，
// 空字符串代表那一次被 max-tokens 截断。
import './helpers/bili-lib.js'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bili-judge/replay.json', import.meta.url), 'utf8'))

let judge
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-golden-'))
  judge = await import('../extensions/bili-observer/bili/judge.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

const silent = { info() {}, warn() {}, debug() {} }
const SUB = { mid: '3537117026191454', name: '嘟嘟脸恶作剧' }

/** 把 fixture 里的 items 还原成 dynamicFeed 的输出形状。 */
const toItem = (raw) => ({
  id: raw.id,
  kind: raw.kind,
  text: raw.text,
  title: raw.title,
  author: '嘟嘟脸恶作剧',
  mid: '3537117026191454',
  pubTs: 0,
  images: Array.from({ length: raw.images || 0 }, (_, i) => `img${i + 1}.jpg`),
  bvid: '',
  live: null,
  forward: raw.kind === 'forward',
  lottery: false,
  url: raw.url,
})

const batch = (label) => {
  const b = fixture.batches.find((x) => x.label === label)
  assert.ok(b, `fixture 里少了批次：${label}`)
  return b
}

test('golden：解析结果与当次真实判定一致（逐条对 level / title / points / images）', () => {
  for (const b of fixture.batches) {
    for (const run of b.runs) {
      const got = judge.parseVerdicts(run.raw, b.items.length)
      assert.deepEqual(
        got.map((v) => ({ i: v.i, keep: v.keep, level: v.level, title: v.title, points: v.points, images: v.images })),
        run.verdicts.filter((v) => v.by === 'ai').map((v) => ({
          i: v.i, keep: v.keep, level: v.level, title: v.title, points: v.points, images: v.images,
        })),
        `${b.label} / ${run.status}：解析结果变了`,
      )
    }
  }
})

test('golden：截断样本（一个字都没写）→ 整条 fail-open，不是「判成不重要」', async () => {
  const b = batch('10:08 维护开始')
  const cut = b.runs.find((r) => r.status === 'incomplete')
  assert.ok(cut, '样本里应该有那次截断')
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  const j = judge.createJudge({ getConfig: () => cfg, log: silent, ask: async () => cut.raw })
  const v = await j.judge(SUB, b.items.map(toItem))
  assert.equal(v.length, 1)
  assert.equal(v[0].by, 'fail', '截断要照转，不能当成「不重要」吞掉')
  assert.equal(v[0].keep, true)
})

test('golden：正常判出的批次按模型输出走，摘要用的是模型给的标题不是原文', async () => {
  const b = batch('10:08 维护开始')
  const ok = b.runs.find((r) => r.status === 'completed')
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  const j = judge.createJudge({ getConfig: () => cfg, log: silent, ask: async () => ok.raw })
  const items = b.items.map(toItem)
  const v = await j.judge(SUB, items)
  assert.equal(v[0].by, 'ai')
  assert.equal(v[0].level, 3)
  const text = judge.formatSummary(items[0], SUB, v[0])
  assert.match(text, /服务器已开始维护，完成后发600水晶叶/)
  assert.doesNotMatch(text, /亲爱的圣团长大人/, '推摘要就不该再糊一遍原文')
  assert.match(text, /· 维护时间为昨天（11月19日）10点至16点/)
})

test('golden：双条批次走 digest，两条都在、图号只标真正发出去的那张', async () => {
  const b = batch('15:44 维护结束 + 兑换码')
  const run = b.runs[0]
  const items = b.items.map(toItem)
  const verdicts = judge.parseVerdicts(run.raw, items.length)
  assert.equal(verdicts.length, 2, '两条都要解析出来')
  const d = judge.formatDigest(SUB, items.map((item, i) => ({ item, verdict: verdicts[i] })))
  assert.match(d.text, /【B站动态】嘟嘟脸恶作剧 · 2 条/)
  assert.match(d.text, /1\. 维护已结束，600水晶叶补偿发到邮箱/)
  assert.match(d.text, /2\. 斯皮奇登场纪念礼，兑换码JOWAYOMAID可领/)
  assert.match(d.text, /· 奖励含使徒招募券\*10、南瓜炖菜\*3/)
  assert.deepEqual(d.images, ['img1.jpg'], '两条都只点了图1，合计一张')
  assert.match(d.text, /2\. 斯皮奇[\s\S]*图1/)
})

test('golden：模型换一种写法（同批第二次）解析照样稳，标题细节允许不同', () => {
  const b = batch('15:44 维护结束 + 兑换码')
  const alt = b.runs[1]
  const v = judge.parseVerdicts(alt.raw, b.items.length)
  assert.equal(v.length, 2)
  assert.equal(v[1].level, 2, '这一次模型把兑换码判成 2 级，也是样本的一部分')
  assert.match(v[1].title, /兑换码JOWAYOMAID/)
  assert.equal(v[1].points.length, 2)
})

test('golden：视频投稿（只有标题没有正文）也判得出来', async () => {
  const b = batch('11:11 视频投稿')
  const run = b.runs[0]
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  const j = judge.createJudge({ getConfig: () => cfg, log: silent, ask: async () => run.raw })
  const items = b.items.map(toItem)
  const v = await j.judge(SUB, items)
  assert.equal(v[0].by, 'ai', '只有标题的动态不能当「没东西可判」跳过')
  assert.equal(v[0].level, 2)
  assert.match(v[0].title, /笑话集/)
})

test('golden：样本里的预算参数与当前实现一致，改了预算要同步改 fixture 说明', () => {
  assert.equal(fixture.maxTokens, '2500 + 800n')
  for (const b of fixture.batches) {
    for (const run of b.runs) {
      assert.equal(run.maxTokens, 2500 + 800 * b.items.length, `${b.label} 的预算对不上`)
    }
  }
})

test('golden：截断样本的推理 token 打满了预算——这是「预算不够」的铁证', () => {
  const b = batch('10:08 维护开始')
  const cut = b.runs.find((r) => r.status === 'incomplete')
  assert.equal(cut.outputTokens, cut.maxTokens, '输出 token 正好等于预算上限')
  assert.ok(cut.reasoningTokens >= cut.maxTokens - 1, `推理就吃掉 ${cut.reasoningTokens}/${cut.maxTokens}，正文自然一个字都剩不下`)
  assert.equal(cut.raw, '', '预算烧光时正文是空的')
})
