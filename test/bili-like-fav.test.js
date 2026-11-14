// 点赞和收藏：只对 worth 点赞、日上限、两个夹分开、没配夹子 / 没 bili_jct 不发请求。
import './helpers/bili-lib.js'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBili } from '../extensions/bili-observer/bili/duty.js'
import { normalize } from '../src/core/config.js'
import { reportFile, dateKey } from '../extensions/bili-observer/bili/report.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-bili-write-'))
process.env.AURABOT_DATA_DIR = root
const log = { info() {}, warn() {}, debug() {} }
const fresh = () => { for (const p of ['bili.json', 'bili-seen.json', 'bili-reports', 'bili-digest']) rmSync(join(root, p), { recursive: true, force: true }) }

before(() => { process.env.AURABOT_DATA_DIR = root })

const bv = (i) => 'BV1' + String(i).padStart(9, '0')
const vid = (i, title) => ({ bvid: bv(i), aid: 100 + i, title: title || `视频${i}`, author: 'UP', play: 1, pubdate: Date.now() })

const DECISIONS = [
  { i: 1, tier: 'worth', why: '讲了三种米饭', feeling: '饿了' },
  { i: 2, tier: 'ok', why: '有信息', feeling: '还行' },
  { i: 3, tier: 'skip', why: '标题党', feeling: '没意思' },
]

function boot({ decisions = DECISIONS, videos = [vid(1), vid(2), vid(3)], cfgOver = {}, likeError = null, favError = null } = {}) {
  const calls = []
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001',
    bili: {
      enabled: true, keywords: [], perRun: 10, cookie: 'SESSDATA=x; bili_jct=tok',
      like: true, maxLikesPerDay: 5, favWorthFolderId: 11, favOkFolderId: 22, maxFavsPerDay: 10,
      ...cfgOver,
    },
  })
  const api = {
    nav: async () => ({ isLogin: true }),
    recommend: async () => videos,
    view: async ({ bvid }) => {
      const v = videos.find((x) => x.bvid === bvid) || videos[0]
      return { bvid, aid: v.aid, cid: 9, title: v.title, author: 'UP', play: 1, desc: '' }
    },
    subtitle: async () => '字幕',
    comments: async () => [],
    danmakuText: async () => [],
    likeVideo: async (aid) => { calls.push({ kind: 'like', aid }); if (likeError) throw likeError },
    favVideo: async (aid, folder) => { calls.push({ kind: 'fav', aid, folder }); if (favError) throw favError },
  }
  const bili = createBili({
    getConfig: () => cfg,
    hub: { runSystemTurn: async () => JSON.stringify(decisions), sendText: async () => ({}) },
    log,
    api,
  })
  return { bili, calls, cfg }
}

test('只给 worth 点赞；收藏按档位分两个夹；skip 只进判重表', async () => {
  fresh()
  const { bili, calls } = boot()
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls.filter((c) => c.kind === 'like'), [{ kind: 'like', aid: 101 }], 'ok / skip 不点赞')
  assert.deepEqual(calls.filter((c) => c.kind === 'fav'), [
    { kind: 'fav', aid: 101, folder: 11 },
    { kind: 'fav', aid: 102, folder: 22 },
  ])
  assert.equal(r.likes, 1)
  assert.equal(r.favs, 2)
  assert.equal(r.skipped, 1)
})

test('点赞日上限：第 6 条不再发请求', async () => {
  fresh()
  const videos = Array.from({ length: 6 }, (_, i) => vid(i + 1))
  const decisions = videos.map((_, i) => ({ i: i + 1, tier: 'worth', why: '好', feeling: '嗯' }))
  const { bili, calls } = boot({ videos, decisions, cfgOver: { maxLikesPerDay: 5 } })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(calls.filter((c) => c.kind === 'like').length, 5, '第 6 条被上限拦住')
  assert.equal(bili.state().likes, 5)
})

test('收藏日上限：到上限就不发请求', async () => {
  fresh()
  const videos = [vid(1), vid(2), vid(3)]
  const { bili, calls } = boot({ videos, cfgOver: { maxFavsPerDay: 1 } })
  await bili.run({ force: true })
  assert.equal(calls.filter((c) => c.kind === 'fav').length, 1)
})

test('没配收藏夹：一条收藏请求都不发，点赞照常', async () => {
  fresh()
  const { bili, calls } = boot({ cfgOver: { favWorthFolderId: 0, favOkFolderId: 0 } })
  await bili.run({ force: true })
  assert.equal(calls.filter((c) => c.kind === 'fav').length, 0)
  assert.equal(calls.filter((c) => c.kind === 'like').length, 1)
})

test('没有 bili_jct：点赞和收藏全跳过，采集和日报照常', async () => {
  fresh()
  const { bili, calls } = boot({ cfgOver: { cookie: 'SESSDATA=only' } })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(calls.length, 0, '一个写请求都不发')
  assert.equal(r.watched, 3)
  assert.ok(existsSync(reportFile(dateKey())), '日报还是写了')
})

test('点赞撞风控：当天不再试下一条，暂停原因写进 state', async () => {
  fresh()
  const err = Object.assign(new Error('B 站返回 -352'), { code: -352 })
  const videos = [vid(1), vid(2)]
  const decisions = videos.map((_, i) => ({ i: i + 1, tier: 'worth', why: '好', feeling: '嗯' }))
  const { bili, calls } = boot({ videos, decisions, likeError: err })
  await bili.run({ force: true })
  assert.equal(calls.filter((c) => c.kind === 'like').length, 1, '第一条失败后不再试')
  assert.match(bili.state().pauseReason, /风控/)
  assert.equal(bili.state().canPost, false)
})

test('试运行：一个写请求都不发', async () => {
  fresh()
  const dry = boot()
  dry.cfg.dryRun = true
  const r = await dry.bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(dry.calls.length, 0)
  assert.equal(r.likes, 0)
  assert.equal(r.favs, 0)
})
