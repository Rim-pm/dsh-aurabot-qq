// 离线测试：fetch 换成固定数据，不打真网络。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from './index.mjs'

const realFetch = globalThis.fetch
const realNow = Date.now
after(() => { globalThis.fetch = realFetch; Date.now = realNow })

const pad = (n) => String(n).padStart(2, '0')
const CITIES = {
  合肥: { name: '合肥', admin1: '安徽', latitude: 31.86, longitude: 117.28 },
  上海: { name: '上海', admin1: '上海', latitude: 31.22, longitude: 121.46 },
}

// 两天逐小时，早上 7~9 点降雨概率 70%，其余 10%
const HOURS = []
const POPS = []
for (const day of [5, 6]) {
  for (let h = 0; h < 24; h++) {
    HOURS.push(`2026-11-${pad(day)}T${pad(h)}:00`)
    POPS.push(h >= 7 && h <= 9 ? 70 : 10)
  }
}

const FORECAST = {
  current: { time: '2026-11-05T07:10', temperature_2m: 15.2, apparent_temperature: 14.4, precipitation: 0, weather_code: 2, wind_speed_10m: 6 },
  daily: {
    time: ['2026-11-05', '2026-11-06'],
    temperature_2m_max: [20, 19],
    temperature_2m_min: [11, 10],
    precipitation_probability_max: [80, 0],
    weather_code: [61, 3],
  },
  hourly: { time: HOURS, precipitation_probability: POPS },
}

const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
globalThis.fetch = async (url) => {
  const u = new URL(String(url))
  if (u.hostname.includes('geocoding')) {
    const found = CITIES[u.searchParams.get('name')]
    return reply({ results: found ? [found] : [] })
  }
  return reply(FORECAST)
}

/** 把「现在」钉在 2026-11-05 早上 7:10（北京时间）。 */
function atMorning(t) {
  Date.now = () => new Date('2026-11-05T07:10:00+08:00').getTime()
  t.after(() => { Date.now = realNow })
}

function makeHost({ settings = {}, lastOwnerChatAt = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weather-test-'))
  const st = {
    city: '合肥', district: '蜀山区', umbrella: 40, morningOn: true,
    morningFrom: '07:00', morningTo: '08:30', weekendLater: true, skipIfChatted: true, ...settings,
  }
  const reg = { contexts: [], rules: [], tools: [], commands: [], routes: new Map(), events: {} }
  const pushed = []
  const hub = {
    lastOwnerChatAt,
    pushToSession: async (chat, content) => { pushed.push({ chat, text: content[0].text }) },
  }
  const api = {
    id: 'weather',
    settings: () => st,
    config: () => ({ ownerQQ: '10001', ownerName: '教主', enabled: true, dryRun: false }),
    isOwner: (u) => String(u) === '10001',
    dataDir: (...p) => join(dir, ...p),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    context: (fn) => reg.contexts.push(fn),
    rule: (fn) => reg.rules.push(fn),
    tool: (fn) => reg.tools.push(fn),
    command: (c) => reg.commands.push(c),
    route: (p, h) => reg.routes.set(p, h),
    on: (ev, fn) => { (reg.events[ev] ||= []).push(fn) },
    every: () => {}, later: () => {},
    defineTool: (t) => t,
    ask: async () => '早呀',
    core: { hub, mutes: { muted: () => false }, personas: { current: () => '你是琳。' } },
  }
  const exp = mod.setup(api)
  return { api, exp, reg, pushed, settings: st }
}

const OWNER = { chat: { kind: 'private', userId: '10001' } }

test('天气：城市、温度、降雨和出门建议', async (t) => {
  atMorning(t)
  const { exp } = makeHost()
  const s = await exp.ensureWeather()
  assert.equal(s.city, '合肥')
  assert.equal(s.desc, '多云')
  assert.equal(Math.round(s.temp), 15)
  assert.equal(s.pop, 80)
  assert.equal(s.pop6, 70, '接下来 6 小时的最大降雨概率')
  const text = exp.formatPlain(s, 40, '合肥 · 蜀山区')
  assert.match(text, /合肥 · 蜀山区/)
  assert.match(text, /带伞/)
  assert.match(text, /穿两件/)
})

test('上下文只给主人私聊', async (t) => {
  atMorning(t)
  const { exp, reg } = makeHost()
  await exp.ensureWeather()
  const mine = reg.contexts[0](OWNER)
  assert.match(mine, /【你手机上的天气】/)
  assert.match(mine, /合肥/)
  assert.match(mine, /出门：/)
  assert.equal(reg.contexts[0]({ chat: { kind: 'group', userId: '2', groupId: '3' } }), '')
  assert.equal(reg.contexts[0]({ chat: { kind: 'private', userId: '2' } }), '')
})

test('群里的天气工具必须先说城市', async (t) => {
  atMorning(t)
  const { reg } = makeHost()
  const groupTool = reg.tools[0]({ chat: { kind: 'group', userId: '2', groupId: '3' } })
  const noCity = await groupTool.execute({})
  assert.equal(noCity.ok, false)
  assert.match(noCity.message, /城市/)
  const shanghai = await groupTool.execute({ city: '上海' })
  assert.equal(shanghai.ok, true)
  assert.match(shanghai.message, /上海/)
})

test('早安触发词：早 / 早上好 / 早安，不误伤「早点睡」', async (t) => {
  atMorning(t)
  const { exp, reg } = makeHost()
  await exp.ensureWeather()
  const hook = reg.events.prompt[0]
  const content = [{ type: 'text', text: '早' }]
  const hit = hook(content, { ...OWNER, queryText: '早' })
  assert.equal(hit.length, 2)
  assert.match(hit.at(-1).text, /带伞/)
  assert.ok(hook(content, { ...OWNER, queryText: '早上好呀' }))
  assert.ok(hook(content, { ...OWNER, queryText: '早安～今天要出门' }))
  assert.equal(hook(content, { ...OWNER, queryText: '早点睡' }), undefined)
  assert.equal(hook(content, { chat: { kind: 'group', userId: '2', groupId: '3' }, queryText: '早' }), undefined)
})

test('主动问候：到点发一次，同一天不重复', async (t) => {
  atMorning(t)
  const { exp, pushed, settings } = makeHost({ settings: { morningTo: '07:10' } })
  exp.tick()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(pushed.length, 1)
  assert.match(pushed[0].text, /早安/)
  assert.match(pushed[0].text, /合肥 · 蜀山区/)
  exp.tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(pushed.length, 1)
  assert.equal(settings.morningOn, true)
})

test('你已经说过话就不打扰', async (t) => {
  atMorning(t)
  const chatted = new Date('2026-11-05T07:05:00+08:00').getTime()
  const { exp, pushed } = makeHost({ lastOwnerChatAt: chatted, settings: { morningTo: '07:10' } })
  exp.tick()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(pushed.length, 0)
})

test('带伞阈值可调', async (t) => {
  atMorning(t)
  const { exp } = makeHost()
  const s = {
    city: '合肥', desc: '多云', temp: 20, feels: 20, min: 15, max: 22,
    pop: 55, pop6: 55, wind: 5, rainNow: false, snowNow: false,
    days: [{ min: 15, max: 22, pop: 55, code: 2 }],
  }
  assert.match(exp.formatPlain(s, 40), /可能会下雨/)
  assert.match(exp.formatPlain(s, 80), /不用带伞/)
})

test('找不到城市时说清楚', async (t) => {
  atMorning(t)
  const { exp, reg, settings } = makeHost()
  settings.city = '不存在'
  const out = await reg.commands[0].run('')
  assert.match(out, /没查到/)
  assert.match(out, /找不到/)
  assert.equal(exp.weatherLine(), '')
})
