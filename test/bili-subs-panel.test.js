// B站订阅在面板上的接线：接口注册了没、工具是不是只有主人能用、配置项在不在。不访问真实 B 站。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import biliModule from '../src/modules/bili/index.js'
import { normalize } from '../src/core/config.js'
import { createBili } from '../src/bili/duty.js'

before(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-panel-'))
})

function boot({ owner = true, bili = {} } = {}) {
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: '10000001', bili: { enabled: true, subs: [], ...bili } })
  const routes = new Map()
  const builders = []
  const timers = []
  const hub = {
    turnHasOwner: () => owner,
    turnSendersAllOwner: () => owner,
    chatOfSession: () => '',
    sendText: async () => ({ message_id: 'sim-1' }),
    sendImage: async () => ({ message_id: 'sim-2' }),
  }
  biliModule.setup({
    config: () => cfg,
    setConfig: (fn) => { Object.assign(cfg, typeof fn === 'function' ? fn(cfg) : fn) },
    lazy: () => null,
    use: () => null,
    onDispose: () => {},
    // 模块数据目录（弹幕历史等）：和 core/modules.js 的 dataDir 一样落在模块自己的目录里
    dataDir: (...parts) => {
      const d = join(process.env.AURABOT_DATA_DIR, 'modules-data', 'bili')
      mkdirSync(d, { recursive: true })
      return join(d, ...parts)
    },
    log: { info() {}, debug() {}, warn() {} },
    on() {},
    tool: (fn) => builders.push(fn),
    every: (ms, fn, name) => timers.push(name),
    route: (p, fn) => routes.set(p, fn),
    core: { hub, http: { body: async (req) => req.body || {}, query: () => ({}) } },
  })
  const chat = { kind: 'private', userId: '10000001', chatId: 'private:10000001' }
  return { cfg, routes, builders, timers, chat }
}

test('面板接线：订阅的五个接口和定时任务都注册上了', () => {
  const { routes, timers } = boot()
  for (const p of ['/bili/subs', '/bili/sub/add', '/bili/sub/del', '/bili/sub/update', '/bili/subs/check']) {
    assert.ok(routes.has(p), `缺接口 ${p}`)
  }
  assert.ok(timers.includes('订阅B站动态'), '每分钟要有一次订阅 tick')
  assert.ok(timers.includes('刷B站'), '原来的刷视频 tick 不能被挤掉')
  // 观察者新增：刷过的视频 / 当天日报 / 收藏夹下拉
  for (const p of ['/bili/seen', '/bili/report', '/bili/fav/folders']) assert.ok(routes.has(p), `缺接口 ${p}`)
  // 观察者：评论 / 弹幕的路由已经删掉，面板点不到也不该有接口
  for (const p of ['/bili/replies', '/bili/danmaku/state', '/bili/danmaku/inspect', '/bili/danmaku/send']) {
    assert.equal(routes.has(p), false, `不该再有接口 ${p}`)
  }
})

test('面板接口：空列表、取消没订的、查一轮都回得干净（不打网络）', async () => {
  const { routes } = boot()
  const list = await routes.get('/bili/subs')({})
  assert.equal(list.ok, true)
  assert.deepEqual(list.items, [], '面板读 items 渲染列表')
  assert.equal(list.count, 0)

  const del = await routes.get('/bili/sub/del')({ body: { mid: '161775300' } })
  assert.equal(del.ok, false)
  assert.match(del.message, /没订阅/)

  const check = await routes.get('/bili/subs/check')({})
  assert.equal(check.ok, false)
  assert.match(check.message, /还没有订阅/)
})

test('工具：订阅类工具在，改订阅只有主人能改', async () => {
  const ownerBoot = boot({ owner: true })
  const tools = ownerBoot.builders[0]({ chat: ownerBoot.chat, sessionId: 's1' })
  const names = tools.map((t) => t.name)
  for (const n of ['bili_subscribe', 'bili_unsubscribe', 'bili_subs']) assert.ok(names.includes(n), `缺工具 ${n}`)
  for (const n of ['bili_comment', 'bili_danmaku', 'bili_set_avatar', 'bili_set_sign']) assert.equal(names.includes(n), false, `观察者不该再有 ${n}`)
  assert.equal(ownerBoot.builders.length, 1, '改头像 / 签名的那个工具块整个删掉了')

  const subsTool = tools.find((t) => t.name === 'bili_subs')
  const r = await subsTool.execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /还没订阅/)

  // 非主人：注册着也执行不了
  const guestBoot = boot({ owner: false })
  const guestTools = guestBoot.builders[0]({ chat: guestBoot.chat, sessionId: 's2' })
  const sub = guestTools.find((t) => t.name === 'bili_subscribe')
  assert.match((await sub.execute({ who: '161775300' })).message, /只有主人/)
  const unsub = guestTools.find((t) => t.name === 'bili_unsubscribe')
  assert.match((await unsub.execute({ who: '161775300' })).message, /只有主人/)
})

test('工具：B站没打开时一个工具都不给', () => {
  const { cfg, builders, chat } = boot()
  cfg.bili.enabled = false
  assert.deepEqual(builders[0]({ chat, sessionId: 's1' }), [])
})

test('面板要读的配置项都在（默认值）', () => {
  const c = normalize({})
  assert.deepEqual(c.bili.subs, [])
  assert.equal(c.bili.subIntervalMin, 15)
  assert.equal(c.bili.subGapSec, 6)
  assert.equal(c.bili.subMaxPerPoll, 3)
  assert.equal(c.bili.subForwardImages, true)
  assert.equal(c.bili.subDigest, true, 'AI 开着时默认合并成一条')
  assert.equal(c.bili.subsOnly, false, '默认不改变原有行为')
  // AI 过滤默认关：升级后行为和以前一模一样，不偷偷花 token
  assert.equal(c.bili.aiFilter, false)
  assert.equal(c.bili.aiFilterPrompt, '')
  assert.deepEqual(c.bili.aiFilterModel, { provider: '', model: '' })
  assert.equal(c.bili.aiFilterMinLevel, 2)
  assert.equal(c.bili.aiFilterVision, false)
  assert.equal(c.bili.aiFilterMaxChars, 800)
  assert.equal(c.bili.aiFilterLink, false, '摘要默认不带原链接')
  assert.equal(c.bili.cardRenderer, 'none', '卡片渲染是第二期，先留位子')
})

test('面板接口：每号的判定设置能改，列表能把它们读回来（不联网）', async () => {
  const { routes, cfg } = boot({ bili: { subs: [{ mid: '161775300', name: 'A' }] } })
  const r = await routes.get('/bili/sub/update')({
    body: {
      mid: '161775300', prompt: '只看公告', mode: 'raw', minLevel: 3,
      examples: [{ text: '新活动开启', keep: true, why: '主人在玩' }, { text: '角色生日', keep: false }],
    },
  })
  assert.equal(r.ok, true)
  assert.equal(cfg.bili.subs[0].prompt, '只看公告')
  assert.equal(cfg.bili.subs[0].mode, 'raw')
  assert.equal(cfg.bili.subs[0].minLevel, 3)
  assert.equal(cfg.bili.subs[0].examples.length, 2)

  const list = await routes.get('/bili/subs')({})
  assert.equal(list.items[0].prompt, '只看公告')
  assert.equal(list.items[0].mode, 'raw')
  assert.equal(list.items[0].minLevel, 3)
  assert.deepEqual(list.items[0].examples, [
    { text: '新活动开启', keep: true, why: '主人在玩' },
    { text: '角色生日', keep: false, why: '' },
  ])
  assert.deepEqual(list.judged, [], '还没判过就是空数组，面板照着渲染')

  const miss = await routes.get('/bili/sub/update')({ body: { mid: '999', prompt: 'x' } })
  assert.equal(miss.ok, false)
  assert.match(miss.message, /没订阅/)
})

test('配置：每号的 prompt / mode / minLevel 会被归一化（老配置也认）', () => {
  const c = normalize({
    bili: {
      subs: [
        { mid: '161775300', name: 'A' },
        { mid: '200', name: 'B', prompt: '只看卡池', mode: 'raw', minLevel: 3 },
        { mid: '300', mode: '乱写', minLevel: 99 },
      ],
    },
  })
  assert.equal(c.bili.subs[0].mode, 'auto', '老配置没有 mode 就是跟随开关')
  assert.equal(c.bili.subs[0].prompt, '')
  assert.equal(c.bili.subs[0].minLevel, 0)
  assert.deepEqual(c.bili.subs[0].examples, [], '老配置没有例子就是空数组')
  assert.equal(c.bili.subs[1].prompt, '只看卡池')
  assert.equal(c.bili.subs[1].mode, 'raw')
  assert.equal(c.bili.subs[1].examples.length, 0)
  assert.equal(c.bili.subs[2].mode, 'auto')
  assert.equal(c.bili.subs[2].minLevel, 3, '越界的阈值夹回来')
})

test('只要订阅：只剩三个订阅工具，看视频 / 截图 / 改资料全不给她', () => {
  const { builders, chat } = boot({ bili: { subsOnly: true } })
  const names = builders[0]({ chat, sessionId: 's1' }).map((t) => t.name).sort()
  assert.deepEqual(names, ['bili_subs', 'bili_subscribe', 'bili_unsubscribe'])
  assert.equal(builders.length, 1, '改头像 / 签名的那个工具块整个删掉了')
})

test('只要订阅：刷视频那条线整个不跑', async () => {
  const calls = []
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, subsOnly: true, autoBrowse: true, reply: true } })
  const bili = createBili({
    getConfig: () => cfg,
    hub: { runSystemTurn: async () => { calls.push('turn'); return '' } },
    log: { info() {}, warn() {}, debug() {} },
    api: {
      nav: async () => { calls.push('nav'); return { isLogin: true, uname: '', mid: 0 } },
      search: async () => { calls.push('search'); return [] },
      popular: async () => { calls.push('popular'); return [] },
      replyFeed: async () => { calls.push('replyFeed'); return [] },
    },
  })
  await bili.tick()
  assert.deepEqual(calls, [], 'subsOnly 下不该向 B 站发任何请求')
})

test('只要订阅：手动「刷一轮」的接口也拒绝（面板藏了按钮，接口还在）', async () => {
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, subsOnly: true } })
  const bili = createBili({ getConfig: () => cfg, hub: {}, log: { info() {}, warn() {}, debug() {} }, api: {} })
  assert.match((await bili.run({ force: true })).message, /只要订阅/)
  assert.equal(typeof bili.checkReplies, 'undefined', '回评论的入口已经删掉')
})
