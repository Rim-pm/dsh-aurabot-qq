// 档位：解析、非法值兜底、worth 没有字幕 / 画面证据时降级成 ok。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let duty
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-tier-'))
  duty = await import('../src/bili/duty.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

test('tierOf：三个合法档位原样返回', () => {
  assert.equal(duty.tierOf({ tier: 'worth' }, true), 'worth')
  assert.equal(duty.tierOf({ tier: 'ok' }, false), 'ok')
  assert.equal(duty.tierOf({ tier: 'skip' }, false), 'skip')
})

test('tierOf：缺字段 / 乱写 / 大小写不对都落到 ok', () => {
  for (const bad of [{}, { tier: '' }, { tier: 'WORTH' }, { tier: '值得看' }, { tier: 1 }, null, undefined]) {
    assert.equal(duty.tierOf(bad, true), 'ok')
  }
})

test('tierOf：worth 没有字幕也没有画面 → 降级 ok', () => {
  assert.equal(duty.tierOf({ tier: 'worth' }, false), 'ok', '只有标题 / 简介时最多给 ok')
  assert.equal(duty.tierOf({ tier: 'worth' }, true), 'worth', '有字幕或画面才留得住 worth')
})

test('刷一轮：模型给 worth 但没有证据时降级 ok，不分享', async () => {
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, keywords: [], perRun: 1 } })
  const sent = []
  const bili = duty.createBili({
    getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    hub: {
      runSystemTurn: async () => JSON.stringify([{ i: 1, tier: 'worth', why: '看起来很好', feeling: '想看', share: '你一定要看' }]),
      sendText: async (chatId, text) => sent.push({ chatId, text }),
    },
    api: {
      nav: async () => ({ isLogin: true }),
      recommend: async () => [{ bvid: 'BV1eeeeeeeee', aid: 1, title: '只有标题', author: 'UP', play: 1, pubdate: Date.now() }],
      view: async ({ bvid }) => ({ bvid, aid: 1, cid: 9, title: '只有标题', author: 'UP', play: 1, desc: '' }),
      subtitle: async () => '',
      comments: async () => [],
      danmakuText: async () => [],
    },
  })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(sent.length, 0, '降级成 ok 就不该按 worth 分享')
})

test('转写兜底：没有 ASR 服务 / 没 ffmpeg 时静默跳过，整轮照常', async () => {
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, keywords: [], perRun: 1, transcribe: true } })
  const bili = duty.createBili({
    getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    hub: { runSystemTurn: async () => JSON.stringify([{ i: 1, tier: 'ok', why: '表层信息', feeling: '嗯' }]), sendText: async () => ({}) },
    api: {
      nav: async () => ({ isLogin: true }),
      recommend: async () => [{ bvid: 'BV1ggggggggg', aid: 1, title: '没字幕', author: 'UP', play: 1, pubdate: Date.now() }],
      view: async ({ bvid }) => ({ bvid, aid: 1, cid: 9, title: '没字幕', author: 'UP', play: 1, desc: '' }),
      subtitle: async () => '',
      comments: async () => [],
      danmakuText: async () => [],
      // 没有 playurl，也没有 local.asr：转写应当安静地跳过
    },
    // local 不传
  })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 1)
  assert.ok(bili.state().noSubtitle >= 1, '日报里记了因无字幕跳过')
})

test('转写兜底：本地 ASR 开关没开就不抽音轨（不碰 playurl）', async () => {
  const calls = []
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, keywords: [], perRun: 1, transcribe: true, ffmpegPath: process.execPath } })
  const bili = duty.createBili({
    getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    hub: { runSystemTurn: async () => JSON.stringify([{ i: 1, tier: 'ok', why: '表层信息', feeling: '嗯' }]), sendText: async () => ({}) },
    api: {
      nav: async () => ({ isLogin: true }),
      recommend: async () => [{ bvid: 'BV1hhhhhhhhh', aid: 1, title: '没字幕', author: 'UP', play: 1, pubdate: Date.now() }],
      view: async ({ bvid }) => ({ bvid, aid: 1, cid: 9, title: '没字幕', author: 'UP', play: 1, desc: '' }),
      subtitle: async () => '',
      comments: async () => [],
      danmakuText: async () => [],
      playurl: async () => { calls.push('playurl'); return { audio: [{ baseUrl: 'https://video.example/a.m4s' }] } },
    },
    // ffmpeg 在（process.execPath 存在），transcribe 也开着，只差本地 ASR 开关
    local: { active: () => false, call: async () => { calls.push('asr'); return '' } },
  })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls, [], 'ASR 没开就不该抽音轨，也不该调识别服务')
  assert.ok(bili.state().noSubtitle >= 1, '照样按无字幕记一笔')
})

test('刷一轮：有字幕的 worth 会分享给主人', async () => {
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, keywords: [], perRun: 1 } })
  const sent = []
  const bili = duty.createBili({
    getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    hub: {
      runSystemTurn: async () => JSON.stringify([{ i: 1, tier: 'worth', why: '讲了三种米饭', feeling: '饿了', share: '这个你会喜欢' }]),
      sendText: async (chatId, text) => sent.push({ chatId, text }),
    },
    api: {
      nav: async () => ({ isLogin: true }),
      recommend: async () => [{ bvid: 'BV1fffffffff', aid: 1, title: '米饭', author: 'UP', play: 1, pubdate: Date.now() }],
      view: async ({ bvid }) => ({ bvid, aid: 1, cid: 9, title: '米饭', author: 'UP', play: 1, desc: '' }),
      subtitle: async () => '今天讲三种米饭',
      comments: async () => [],
      danmakuText: async () => [],
    },
  })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /这个你会喜欢/)
})
