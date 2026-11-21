// 手机端 App 的七个只读聚合接口（/open/app/*）。
//
// 为什么要有这条：B 层 24 条字段原本只在管理面（远端 403）或未鉴权模块路由上，
// App 不能依赖后者（无 Bearer、无 DNS rebinding 防护，其中还有写操作）。
// 这七个接口全部注册在 open() 下，复用既有 Bearer 鉴权 + skipHostCheck，
// 不改面板闸、不开 panelRemoteAccess、不碰写操作。
//
// 本文件锁死四类行为：
//   · 远端 + 正确 Bearer → HTTP 200 且 body.ok=true
//   · 远端 + 无 Bearer → HTTP 200 但 body.ok=false / code=401（不是 HTTP 401）
//   · 恶意 Host 不绕过 Bearer 判定（skipHostCheck）
//   · 不泄敏感字段（raw / cookie / token / apiKey / password），结构契约对得上
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
let fake, api, dataDir, token

const PATHS = [
  '/open/app/overview', '/open/app/self', '/open/app/memory',
  '/open/app/expression', '/open/app/platforms', '/open/app/system',
  '/open/app/logs',
]
const auth = () => ({ authorization: 'Bearer ' + token })

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-open-app-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true,
    botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5099
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
  // 打开联动并取密钥（/open/* 只在 bridge.http 打开且有密钥时放行）
  api.setConfig({ ...api.getConfig(), bridge: { ...api.getConfig().bridge, http: true } })
  token = (await fake.call('/bridge/token', null, { host: '127.0.0.1:5099' })).json().token
})

after(async () => {
  try { fake.dispose() } catch (e) {}
})

test('七个接口：正确 Bearer + 远端来源 → 放行', async () => {
  for (const p of PATHS) {
    const r = await fake.call(p, null, auth(), '203.0.113.7')
    assert.equal(r.status, 200, `${p} 面板闸不该拦 /open/*`)
    assert.equal(r.json().ok, true, `${p} 业务放行`)
  }
})

test('七个接口：不带 Bearer → HTTP 200 但 body.ok=false / code=401', async () => {
  for (const p of PATHS) {
    const r = await fake.call(p, null, {}, '203.0.113.7')
    assert.equal(r.status, 200, '鉴权失败也是 HTTP 200（answer() 统一 send(res,200,…)）')
    assert.equal(r.json().ok, false)
    assert.equal(r.json().code, 401)
  }
})

test('七个接口：恶意 Host 不影响 Bearer 判定（skipHostCheck）', async () => {
  for (const p of PATHS) {
    const r = await fake.call(p, null, { host: 'evil.example', ...auth() }, '203.0.113.7')
    assert.equal(r.status, 200, `${p} 恶意 Host 不该触发 Host 闸`)
    assert.equal(r.json().ok, true, `${p} skipHostCheck 下只认 Bearer`)
  }
})

test('不泄敏感字段', async () => {
  const j = (await fake.call('/open/app/self', null, auth())).json()
  assert.equal(j.ok, true)
  assert.equal(j.persona.raw, undefined, '人格 raw 原文不能回')
  const sys = (await fake.call('/open/app/system', null, auth())).json()
  assert.doesNotMatch(JSON.stringify(sys), /token|cookie|apiKey|password/i, 'system 响应不能含密钥字段名')
  const plat = (await fake.call('/open/app/platforms', null, auth())).json()
  assert.doesNotMatch(JSON.stringify(plat), /cookie/i, 'platforms 响应不能含 cookie')
})

test('结构契约：字段齐、类型对', async () => {
  const ov = (await fake.call('/open/app/overview', null, auth())).json()
  assert.equal(typeof ov.mood.value, 'number')
  assert.equal(typeof ov.mood.label, 'string')
  assert.equal(typeof ov.outbox.count, 'number')
  assert.equal(typeof ov.stats.received, 'number')
  assert.equal(ov.mood.history, undefined, 'history 要剥掉')
  assert.equal(ov.mood.emotions, undefined, 'emotions 十条向量不要回')
  assert.ok(ov.mood.emotionTop === null || typeof ov.mood.emotionTop === 'object', 'emotionTop 兜底成 null 或对象')

  const self = (await fake.call('/open/app/self', null, auth())).json()
  assert.equal(typeof self.persona.id, 'string')
  assert.equal(typeof self.persona.chars, 'number')
  assert.equal(typeof self.persona.body, 'string')
  assert.ok(Array.isArray(self.persona.tags))
  assert.equal(typeof self.prefs.voiceEngine, 'string')
  assert.equal(typeof self.memory.count, 'number')
  assert.equal(typeof self.memory.lastConsolidate, 'number')

  const mem = (await fake.call('/open/app/memory', null, auth())).json()
  assert.equal(typeof mem.count, 'number')
  assert.equal(typeof mem.archived, 'number')
  assert.equal(typeof mem.lastConsolidate, 'number')
  assert.equal(typeof mem.vectorReady, 'boolean')

  const ex = (await fake.call('/open/app/expression', null, auth())).json()
  assert.equal(typeof ex.stickers.count, 'number')
  assert.equal(typeof ex.song.enabled, 'boolean')
  assert.equal(typeof ex.song.ready, 'boolean')
  assert.ok(Array.isArray(ex.song.queue))
  assert.equal(typeof ex.voice.edgeInstalled, 'boolean')

  const plat = (await fake.call('/open/app/platforms', null, auth())).json()
  assert.equal(typeof plat.qzone.count, 'number')
  assert.ok(Array.isArray(plat.qzone.history))
  for (const k of ['browse', 'like', 'comment', 'shareOwner', 'dm']) {
    assert.ok(['off', 'owner', 'all'].includes(plat.douyin.perms[k]), `douyin.perms.${k} 值域 off|owner|all`)
  }
  for (const k of ['browse', 'like', 'comment', 'post']) {
    assert.ok(['off', 'owner', 'all'].includes(plat.heybox.perms[k]), `heybox.perms.${k} 值域 off|owner|all`)
  }
  assert.equal(typeof plat.heybox.enabled, 'boolean')

  const sys = (await fake.call('/open/app/system', null, auth())).json()
  assert.equal(typeof sys.endpoint.httpUrl, 'string')
  assert.equal(typeof sys.endpoint.wsUrl, 'string')
  assert.equal(typeof sys.modules.total, 'number')
  assert.equal(typeof sys.modules.running, 'number')
  assert.ok(Array.isArray(sys.settings.groups))
  for (const g of sys.settings.groups) {
    assert.equal(typeof g.id, 'string')
    assert.ok(['off', 'modules', 'chat'].includes(g.mode), '群模式值域 off|modules|chat')
  }
  assert.ok(Array.isArray(sys.settings.privateWhitelist))
  assert.equal(typeof sys.settings.memberFilter.enabled, 'boolean')
  assert.equal(typeof sys.settings.dangerConfirm, 'boolean')
  assert.equal(sys.backup.last, null, '没有备份文件时 last 为 null')
  assert.equal(typeof sys.backup.count, 'number')

  const logs = (await fake.call('/open/app/logs?limit=5', null, auth())).json()
  assert.ok(Array.isArray(logs.entries))
  assert.ok(logs.entries.length <= 5, 'limit 要生效')
  for (const e of logs.entries) {
    assert.equal(typeof e.t, 'number', '日志条目字段是 t，不是 at')
    assert.equal(typeof e.time, 'string')
    assert.equal(typeof e.level, 'string')
    assert.equal(typeof e.area, 'string')
    assert.equal(typeof e.text, 'string')
    assert.equal(e.at, undefined)
  }
})

test('logs 的 limit 有上限钳制', async () => {
  const r = (await fake.call('/open/app/logs?limit=999999', null, auth())).json()
  assert.equal(r.ok, true)
  assert.ok(r.entries.length <= 500, 'limit 不能突破环形缓冲上限 500')
})

test('modules 关着时回空态而不是报错', async () => {
  // 先把 song 打开，让 status() 里 enabled 为 true，再关模块，才验得出「关掉后归一成空态」
  let cfg = api.getConfig()
  api.setConfig({ ...cfg, song: { ...cfg.song, enabled: true } })
  await new Promise((r) => setTimeout(r, 2100))
  let ex = (await fake.call('/open/app/expression', null, auth())).json()
  assert.equal(ex.song.enabled, true, '前置条件：song 模块在跑且开关打开')

  // 模块开关在 cfg.modules[id].enabled（src/core/modules.js:542），不是 cfg.ext，也不是 cfg.song.enabled
  cfg = api.getConfig()
  api.setConfig({ ...cfg, modules: { ...cfg.modules, song: { ...(cfg.modules?.song || {}), enabled: false } } })
  await new Promise((r) => setTimeout(r, 2100)) // 等 overviewOnce 的 2s 缓存过期 + 模块停止
  ex = (await fake.call('/open/app/expression', null, auth())).json()
  assert.equal(ex.ok, true, '模块关着也要 ok:true')
  assert.equal(ex.song.enabled, false)
  assert.equal(ex.song.ready, false)
  assert.equal(ex.song.current, null)
  assert.equal(ex.song.queue.length, 0)
})
