// B站订阅在面板上的接线：接口注册了没、工具是不是只有主人能用、配置项在不在。不访问真实 B 站。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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

test('面板接线：订阅的四个接口和定时任务都注册上了', () => {
  const { routes, timers } = boot()
  for (const p of ['/bili/subs', '/bili/sub/add', '/bili/sub/del', '/bili/subs/check']) {
    assert.ok(routes.has(p), `缺接口 ${p}`)
  }
  assert.ok(timers.includes('订阅B站动态'), '每分钟要有一次订阅 tick')
  assert.ok(timers.includes('刷B站'), '原来的刷视频 tick 不能被挤掉')
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
  assert.equal(c.bili.subsOnly, false, '默认不改变原有行为')
})

test('只要订阅：只剩三个订阅工具，看视频 / 评论 / 截图 / 改资料全不给她', () => {
  const { builders, chat } = boot({ bili: { subsOnly: true } })
  const names = builders[0]({ chat, sessionId: 's1' }).map((t) => t.name).sort()
  assert.deepEqual(names, ['bili_subs', 'bili_subscribe', 'bili_unsubscribe'])
  assert.deepEqual(builders[1]({ chat, sessionId: 's1' }), [], '改头像 / 签名也不给')
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

test('只要订阅：手动「刷一轮 / 看回复」的接口也拒绝（面板藏了按钮，接口还在）', async () => {
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, subsOnly: true } })
  const bili = createBili({ getConfig: () => cfg, hub: {}, log: { info() {}, warn() {}, debug() {} }, api: {} })
  assert.match((await bili.run({ force: true })).message, /只要订阅/)
  assert.match((await bili.checkReplies()).message, /只要订阅/)
})
