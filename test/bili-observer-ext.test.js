// B 站观察者扩展：把 extensions/bili-observer 装进临时 dataDir，用 fake-dsh 起真实 host 验证
// 「模块能跑、工具/规则跟着 cfg.bili.enabled 开关、面板读写 core 的 cfg.bili 且脱敏」。
// 内置 bili 已经从 BUILTINS 摘除，这里顺便确认摘除后没有任何东西再假设它是内置的。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

let mock, fake, api, dataDir
const ext = join(import.meta.dirname, '..', 'extensions', 'bili-observer')
const call = async (path, body) => (await fake.call(path, body)).json()

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-bili-ext-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    group: { interjectChance: 0 },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 }, stickers: { autoChance: 0 },
    bili: { enabled: true, cookie: 'SESSDATA=secret1234; bili_jct=csrf5678' },
  }))
  // 按 install.mjs 的做法只装运行时要的文件
  const target = join(dataDir, 'modules', 'bili-observer')
  mkdirSync(target, { recursive: true })
  cpSync(ext, target, { recursive: true, filter: (s) => !s.includes('index.test.mjs') && !s.includes('scripts') })
  fake = createFakeDsh({ brain: async () => '好' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(0), 200).unref()
})

test('扩展作为用户模块跑起来：6 个工具、有面板、没有报错', async () => {
  const list = (await call('/modules')).list
  const me = list.find((m) => m.id === 'bili-observer')
  assert.ok(me, 'bili-observer 出现在模块列表里')
  assert.equal(me.running, 'user')
  assert.equal(me.error, '')
  assert.equal(me.builtin, false)
  assert.deepEqual(me.tools, ['bili_watch', 'bili_subscribe', 'bili_unsubscribe', 'bili_subs', 'qq_send_shot', 'qq_list_shots'])
  assert.equal(me.panel, true)
  assert.equal(list.some((m) => m.id === 'bili'), false, '内置 bili 已经不在模块列表里')
})

test('面板读 core 的 cfg.bili：密钥脱敏、cookie 不回传', async () => {
  const r = await call('/ext/bili-observer/config')
  assert.equal(r.ok, true)
  assert.equal(Object.keys(r.bili).length > 40, true, 'bili 配置项都在')
  assert.equal(r.bili.cookie, '', 'cookie 原值不回传')
  assert.match(r.bili.sessdataHint, /1234$/)
  assert.match(r.bili.biliJctHint, /5678$/)
  assert.equal(r.bili.sessdata, '', '脱敏后的密钥字段不回传原值')
})

test('面板保存：空串保留原值，没收到 bili 就报错', async () => {
  const r = await call('/ext/bili-observer/config/save', { bili: { perRun: 7, sessdata: '', biliJct: '' } })
  assert.equal(r.ok, true)
  assert.equal(r.bili.perRun, 7)
  assert.match(api.getConfig().bili.cookie, /SESSDATA=secret1234/)
  const bad = await call('/ext/bili-observer/config/save', {})
  assert.equal(bad.ok, false)
  assert.match(bad.message, /没收到 bili 配置/)
})

test('观察者的只读接口都通，未登录时收藏夹是 ok:false 而不是抛错', async () => {
  const st = await call('/ext/bili-observer/bili/state')
  assert.equal(st.ok, true)
  assert.equal(st.posture, 'observer')
  assert.equal(st.account.isLogin, false)
  for (const path of ['/bili/subs', '/bili/seen', '/bili/report', '/bili/shots']) {
    assert.equal((await call('/ext/bili-observer' + path)).ok, true, path)
  }
  assert.equal((await call('/ext/bili-observer/bili/fav/folders')).ok, false)
})

test('模型列表走扩展路由', async () => {
  const r = await call('/ext/bili-observer/models')
  assert.equal(r.ok, true)
  assert.equal(Array.isArray(r.list), true)
})

test('规则和工具跟着 cfg.bili.enabled 走：关掉后她不再说自己会刷 B 站', async () => {
  const on = fake.variables.get('aurabot_rules_private')()
  assert.match(on, /你会刷 B 站/)
  const tools = () => call('/modules/tools?as=owner&kind=private').then((r) => r.list.map((t) => t.name))
  assert.ok((await tools()).includes('bili_watch'))
  assert.ok((await tools()).includes('qq_send_shot'))

  await call('/ext/bili-observer/config/save', { bili: { enabled: false } })
  await until(() => !/你会刷 B 站/.test(fake.variables.get('aurabot_rules_private')()))
  assert.equal((await tools()).includes('bili_watch'), false)

  await call('/ext/bili-observer/config/save', { bili: { enabled: true } })
  await until(() => /你会刷 B 站/.test(fake.variables.get('aurabot_rules_private')()))
  assert.ok((await tools()).includes('bili_watch'))
})

test('只要订阅模式下不给看视频和截图的工具', async () => {
  await call('/ext/bili-observer/config/save', { bili: { subsOnly: true } })
  const rules = await until(() => { const r = fake.variables.get('aurabot_rules_private')(); return /盯着几个 B 站 UP 主/.test(r) ? r : null })
  assert.doesNotMatch(rules, /bili_watch/)
  const names = (await call('/modules/tools?as=owner&kind=private')).list.map((t) => t.name)
  assert.ok(names.includes('bili_subscribe'))
  assert.equal(names.includes('bili_watch'), false)
  assert.equal(names.includes('qq_send_shot'), false)
  await call('/ext/bili-observer/config/save', { bili: { subsOnly: false } })
})

test('panel.js 能拿到且能被 new Function 编译', async () => {
  const r = await fake.call('/modules/panel?id=bili-observer')
  assert.equal(r.status, 200)
  const src = r.raw()
  assert.ok(src.length > 1000)
  const C = new Function('React', 'h', 'ui', 'call', src)({}, () => null, {}, () => Promise.resolve({}))
  assert.equal(typeof C, 'function', 'panel.js 要 return 一个组件')
})
