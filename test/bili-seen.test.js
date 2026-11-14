// 判重表：老 seen 数组迁移、去重、2000 条滚动、倒序、状态只升不降。
import './helpers/bili-lib.js'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEEN_LIMIT, loadSeen, markSeen, migrateSeen, normalizeSeen, pushSeen, saveSeen, seenFile, seenSet } from '../extensions/bili-observer/bili/seen.js'
import { dataDir, writeJson } from '../src/core/store.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-bili-seen-'))
process.env.AURABOT_DATA_DIR = root
const fresh = () => { rmSync(join(root, 'bili-seen.json'), { force: true }); rmSync(join(root, 'bili.json'), { force: true }) }

const bv = (n) => 'BV' + String(n).padStart(10, '0')

before(() => { process.env.AURABOT_DATA_DIR = root })

test('迁移：老的 bili.json seen 数组转成 items（tier=ok、why 空、status=seen）', () => {
  const state = migrateSeen(['BV1aaaaaaaaa', 'BV1bbbbbbbbb', 'bad', 'BV1aaaaaaaaa'], { now: 1762400000000 })
  assert.equal(state.version, 1)
  assert.deepEqual(state.items.map((x) => x.bvid), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb'], '非法值和重复的丢掉')
  assert.equal(state.items[0].tier, 'ok')
  assert.equal(state.items[0].why, '')
  assert.equal(state.items[0].status, 'seen')
  assert.equal(state.items[0].at, 1762400000000)
})

test('整理：缺字段补默认值，脏档位 / 脏状态回到 ok / seen', () => {
  const state = normalizeSeen({ items: [
    { bvid: 'BV1aaaaaaaaa', title: ' 标题 ', tier: '乱写', status: '乱写' },
    { bvid: 'BV1bbbbbbbbb', author: 'UP主' },
  ] })
  assert.equal(state.items[0].title, '标题')
  assert.equal(state.items[0].tier, 'ok')
  assert.equal(state.items[0].status, 'seen')
  assert.equal(state.items[1].up, 'UP主', '老字段 author 也认')
})

test('写入：新条目在最前面，同一个 bvid 不重复，超过 2000 条裁尾', () => {
  let state = { version: 1, items: [] }
  state = pushSeen(state, { bvid: 'BV1aaaaaaaaa', title: 'A', tier: 'worth', why: '好' })
  state = pushSeen(state, { bvid: 'BV1bbbbbbbbb', title: 'B', tier: 'ok' })
  assert.deepEqual(state.items.map((x) => x.bvid), ['BV1bbbbbbbbb', 'BV1aaaaaaaaa'], '倒序')
  state = pushSeen(state, { bvid: 'BV1aaaaaaaaa', title: 'A2', tier: 'ok' })
  assert.deepEqual(state.items.map((x) => x.bvid), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb'], '再看一次挪到最前面，不重复')
  assert.equal(state.items[0].title, 'A2', '信息更新成最新的')

  const many = Array.from({ length: SEEN_LIMIT + 50 }, (_, i) => ({ bvid: bv(i) }))
  const capped = normalizeSeen({ items: many })
  assert.equal(capped.items.length, SEEN_LIMIT)
  const pushed = pushSeen(capped, { bvid: 'BV1zzzzzzzzz' })
  assert.equal(pushed.items.length, SEEN_LIMIT)
  assert.equal(pushed.items[0].bvid, 'BV1zzzzzzzzz')
})

test('状态：seen → liked → faved 只升不降，别的 bvid 不动', () => {
  let state = { version: 1, items: [{ bvid: 'BV1aaaaaaaaa', status: 'seen' }, { bvid: 'BV1bbbbbbbbb', status: 'seen' }] }
  state = markSeen(state, 'BV1aaaaaaaaa', 'liked')
  assert.equal(state.items[0].status, 'liked')
  state = markSeen(state, 'BV1aaaaaaaaa', 'faved')
  assert.equal(state.items[0].status, 'faved')
  state = markSeen(state, 'BV1aaaaaaaaa', 'seen')
  assert.equal(state.items[0].status, 'faved', '不降级')
  assert.equal(state.items[1].status, 'seen')
  assert.deepEqual([...seenSet(state)].sort(), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb'])
})

test('落盘：文件不存在读到空表，写进去能读回来', () => {
  fresh()
  assert.deepEqual(loadSeen().items, [])
  saveSeen({ items: [{ bvid: 'BV1aaaaaaaaa', title: 'A', tier: 'worth', why: '讲了米饭', status: 'liked' }] })
  assert.ok(existsSync(seenFile()))
  const back = loadSeen()
  assert.equal(back.version, 1)
  assert.equal(back.items[0].title, 'A')
  assert.equal(back.items[0].status, 'liked')
})

test('刷一轮：第一次跑先把 bili.json 的老 seen 迁进判重表，老视频不再看', async () => {
  fresh()
  const { normalize } = await import('../src/core/config.js')
  const { createBili } = await import('../extensions/bili-observer/bili/duty.js')
  writeJson(dataDir('bili.json'), { day: '', seen: ['BV1aaaaaaaaa'], history: [] })
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, keywords: [], perRun: 5 } })
  const looked = []
  const bili = createBili({
    getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    hub: {
      runSystemTurn: async () => JSON.stringify([{ i: 1, tier: 'ok', why: '还行', feeling: '嗯' }]),
      sendText: async () => ({}),
    },
    api: {
      nav: async () => ({ isLogin: true }),
      recommend: async () => [
        { bvid: 'BV1aaaaaaaaa', aid: 1, title: '老视频', author: 'UP', play: 1, pubdate: Date.now() },
        { bvid: 'BV1bbbbbbbbb', aid: 2, title: '新视频', author: 'UP', play: 1, pubdate: Date.now() },
      ],
      view: async ({ bvid }) => { looked.push(bvid); return { bvid, aid: 2, cid: 9, title: '新视频', author: 'UP', play: 1, desc: '' } },
      subtitle: async () => '字幕',
      comments: async () => [],
      danmakuText: async () => [],
    },
  })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(looked, ['BV1bbbbbbbbb'], '老 seen 里的不再看')
  const state = loadSeen()
  assert.deepEqual(state.items.map((x) => x.bvid).sort(), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb'])
  assert.equal(state.items.find((x) => x.bvid === 'BV1bbbbbbbbb').tier, 'ok')
  assert.equal(state.items.find((x) => x.bvid === 'BV1bbbbbbbbb').why, '还行')
})
