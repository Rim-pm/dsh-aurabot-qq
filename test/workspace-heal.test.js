// QQ 会话自愈：启动后把掉出「Aurabot · QQ」工作区的会话按 sessions.json 重新挂回去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }

function config(workspaceDir) {
  return normalize({ enabled: true, dryRun: true, setupDone: true, workspaceDir })
}

// 每个用例独立的数据目录和工作区目录，绝不碰真实的 ~/.dsh
function setup(t, { chats = {}, workspace = true, path = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-heal-'))
  const data = join(root, 'data')
  const wsDir = path || join(root, 'ws')
  mkdirSync(data, { recursive: true })
  mkdirSync(wsDir, { recursive: true })
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = data
  writeFileSync(join(data, 'sessions.json'), JSON.stringify({ chats }))
  const fake = createFakeDsh({ brain: async () => '' })
  if (workspace) fake.registry.addWorkspace({ path: wsDir })
  const cfg = config(wsDir)
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))]))
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: { async call() { return {} } } })
  t.after(() => {
    try { hub.dispose() } finally {
      fake.dispose()
      if (old === undefined) delete process.env.AURABOT_DATA_DIR
      else process.env.AURABOT_DATA_DIR = old
      rmSync(root, { recursive: true, force: true })
    }
  })
  return { hub, fake, ws: fake.workspaces[0], wsDir, data }
}

const chatsOf = (...sids) => Object.fromEntries(sids.map((sid, i) => [`private:${1000 + i}`, { sessionId: sid, createdAt: Date.now() }]))

test('掉出工作区的会话按映射补挂回去，返回补挂数量', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  assert.equal(await hub.healWorkspace(), 2)
  assert.deepEqual([...ws.sessionIds].sort(), ['sid-a', 'sid-b'])
  assert.equal(fake.registry.attachCalls.length, 2)
  assert.ok(fake.logs.some((line) => /自愈：把 2 个/.test(line)), '补挂了要有日志')
})

test('自愈只跑一次：第二次返回 0，不重复挂', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  assert.equal(await hub.healWorkspace(), 2)
  assert.equal(await hub.healWorkspace(), 0)
  assert.equal(fake.registry.attachCalls.length, 2)
  assert.equal(ws.sessionIds.length, 2)
})

test('已经在工作区里的会话跳过，不再调用 attachSession', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  ws.sessionIds.push('sid-a')
  assert.equal(await hub.healWorkspace(), 1)
  assert.deepEqual(fake.registry.attachCalls.map((c) => c.sessionId), ['sid-b'])
})

test('已归档的会话不捞回来', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  fake.registry.archivedSessionIds.push('sid-a')
  assert.equal(await hub.healWorkspace(), 1)
  assert.deepEqual(fake.registry.attachCalls.map((c) => c.sessionId), ['sid-b'])
  assert.deepEqual(ws.sessionIds, ['sid-b'])
})

test('单个会话挂载失败不中断整轮，也不抛错', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b', 'sid-c') })
  fake.registry.attachBehavior = (sid) => { if (sid === 'sid-b') throw new Error('cwd 对不上') }
  assert.equal(await hub.healWorkspace(), 2)
  assert.deepEqual([...ws.sessionIds].sort(), ['sid-a', 'sid-c'])
  assert.ok(fake.logs.some((line) => /挂不回工作区（cwd 对不上）/.test(line)), '失败要记 debug')
})

test('注册表为空时不消耗一次性标志，建好工作区后再调仍能自愈', async (t) => {
  const { hub, fake, wsDir } = setup(t, { chats: chatsOf('sid-a'), workspace: false })
  assert.equal(await hub.healWorkspace(), 0)
  assert.equal(fake.registry.attachCalls.length, 0)
  const ws = fake.registry.addWorkspace({ path: wsDir })
  assert.equal(await hub.healWorkspace(), 1)
  assert.deepEqual(ws.sessionIds, ['sid-a'])
})

test('工作区路径不匹配时不消耗一次性标志，工作区建好后仍能自愈', async (t) => {
  const { hub, fake, wsDir } = setup(t, { chats: chatsOf('sid-a'), workspace: false })
  fake.registry.addWorkspace({ path: join(wsDir, '别处') })
  assert.equal(await hub.healWorkspace(), 0)
  assert.equal(fake.registry.attachCalls.length, 0)
  const ws = fake.registry.addWorkspace({ path: wsDir })
  assert.equal(await hub.healWorkspace(), 1)
  assert.deepEqual(ws.sessionIds, ['sid-a'])
})

test('卸载后自愈直接返回 0，不碰注册表', async (t) => {
  const { hub, fake } = setup(t, { chats: chatsOf('sid-a') })
  hub.dispose()
  assert.equal(await hub.healWorkspace(), 0)
  assert.equal(fake.registry.attachCalls.length, 0)
})

test('并发触发只跑一轮：共用同一个 in-flight，不会挂出重复的 sessionId', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  // 挂载放慢，保证两次调用真的重叠（ensureWorkspace 和 host boot 撞在一起就是这个场景）
  fake.registry.attachBehavior = () => new Promise((r) => setTimeout(r, 20))
  const [a, b] = await Promise.all([hub.healWorkspace(), hub.healWorkspace()])
  assert.equal(fake.registry.attachCalls.length, 2, '每个会话只该挂一次')
  assert.equal(a, 2)
  assert.equal(b, 2, '后到的调用拿到同一轮的结果')
  assert.deepEqual([...ws.sessionIds].sort(), ['sid-a', 'sid-b'])
})

test('部分失败不消耗 once：下次触发只补挂漏掉的那条', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  fake.registry.attachBehavior = (sid) => { if (sid === 'sid-b') throw new Error('cwd 对不上') }
  assert.equal(await hub.healWorkspace(), 1)
  assert.deepEqual(ws.sessionIds, ['sid-a'])
  fake.registry.attachBehavior = null
  assert.equal(await hub.healWorkspace(), 1, '只补挂上次失败的那条')
  assert.deepEqual([...ws.sessionIds].sort(), ['sid-a', 'sid-b'])
  assert.equal(fake.registry.attachCalls.length, 3, 'sid-a 不重复挂')
  assert.equal(await hub.healWorkspace(), 0, '全部挂上后才算跑过')
})

test('ensureWorkspace 会顺手触发一次自愈', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  assert.equal((await hub.ensureWorkspace()).id, ws.id)
  await settle()
  assert.deepEqual([...ws.sessionIds].sort(), ['sid-a', 'sid-b'])
})

test('registry 没就绪时 list() 抛错：返回 0 且不消耗 once，就绪后仍能自愈', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a') })
  const realList = fake.registry.list
  // 真实 registry 初始化完成前 requireState() 会抛这个错，而不是返回空数组
  fake.registry.list = () => { throw new Error('workspace registry is not started yet') }
  assert.equal(await hub.healWorkspace(), 0)
  assert.equal(fake.registry.attachCalls.length, 0)
  fake.registry.list = realList
  assert.equal(await hub.healWorkspace(), 1)
  assert.deepEqual(ws.sessionIds, ['sid-a'])
})

test('整轮全挂不上时返回 0 且不消耗 once，修好后再调能成功', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  fake.registry.attachBehavior = () => { throw new Error('cwd 对不上') }
  assert.equal(await hub.healWorkspace(), 0)
  assert.equal(fake.registry.attachCalls.length, 2)
  assert.deepEqual(ws.sessionIds, [])
  fake.registry.attachBehavior = null
  assert.equal(await hub.healWorkspace(), 2)
  assert.deepEqual([...ws.sessionIds].sort(), ['sid-a', 'sid-b'])
})

test('枚举中途被卸载：不再挂后面的会话，返回已成功的数量', async (t) => {
  const { hub, fake, ws } = setup(t, { chats: chatsOf('sid-a', 'sid-b') })
  // 挂第一个时触发卸载：循环下一轮应立刻 break，第二个不碰
  fake.registry.attachBehavior = () => { hub.dispose() }
  assert.equal(await hub.healWorkspace(), 1)
  assert.equal(fake.registry.attachCalls.length, 1)
  assert.deepEqual(ws.sessionIds, ['sid-a'])
})

test('boot 没完成时日志说明是「启动没完成」，不是「自愈没跑成」', { timeout: 20000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-heal-boot-'))
  const data = join(root, 'data')
  const wsDir = join(root, 'ws')
  mkdirSync(data, { recursive: true })
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(data, 'sessions.json'), JSON.stringify({ chats: {} }))
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true, workspaceDir: wsDir,
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma') },
  }))
  const stub = join(root, 'modules-stub.mjs')
  writeFileSync(stub, [
    'export const API_VERSION = 1',
    "export const createModules = () => new Proxy({}, { get: () => () => Promise.reject(new Error('模拟 boot 失败')) })",
  ].join('\n'), 'utf8')
  const hostUrl = new URL('../src/host.js', import.meta.url).href
  // 子进程里用 registerHooks 把 host.js 的 createModules 换掉，让 boot 必然失败
  const script = `
    import { registerHooks } from 'node:module'
    import { readFileSync, readdirSync } from 'node:fs'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    process.on('unhandledRejection', () => {})
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './core/modules.js' && String(context.parentURL || '').endsWith('/src/host.js')) {
        return { url: pathToFileURL(${JSON.stringify(stub)}).href, shortCircuit: true }
      }
      return next(specifier, context)
    } })
    const { apply } = await import(${JSON.stringify(hostUrl)})
    const api = apply({
      logger: { info() {}, warn() {}, error() {} },
      provide() {}, effect(fn) { fn() }, on() { return () => {} }, interval() { return () => {} },
      systemPrompt: { variable() { return () => {} } },
      webServer: { register() { return () => {} } },
      get() { return null },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    })
    await api.ready.catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    const dir = join(${JSON.stringify(data)}, 'logs')
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\\n')
    console.log(JSON.stringify({ start: text.includes('启动没完成'), fail: text.includes('自愈没跑成') }))
    process.exit(0)
  `
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, AURABOT_DATA_DIR: data, AURABOT_REGISTRY_URL: process.env.AURABOT_REGISTRY_URL || 'http://127.0.0.1:9/index.json' },
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  const result = JSON.parse(String(child.stdout).trim().split('\n').pop())
  assert.equal(result.start, true, 'boot 失败要报「启动没完成」')
  assert.equal(result.fail, false, '别把 boot 失败说成自愈没跑成')
})

test('host 在 boot 完成后调用一次 hub.healWorkspace，并把会话挂上', { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-heal-host-'))
  const data = join(root, 'data')
  const wsDir = join(root, 'ws')
  mkdirSync(data, { recursive: true })
  mkdirSync(wsDir, { recursive: true })
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = data
  writeFileSync(join(data, 'sessions.json'), JSON.stringify({ chats: chatsOf('sid-a', 'sid-b') }))
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true, workspaceDir: wsDir,
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma') },
  }))
  const fake = createFakeDsh({ brain: async () => '' })
  const ws = fake.registry.addWorkspace({ path: wsDir })
  const { apply } = await import('../src/host.js')
  const api = apply(fake.ctx)
  const real = api.hub.healWorkspace
  let called = 0
  api.hub.healWorkspace = (...args) => { called++; return real.apply(api.hub, args) }
  t.after(() => {
    try { api.hub.dispose() } finally {
      fake.dispose()
      if (old === undefined) delete process.env.AURABOT_DATA_DIR
      else process.env.AURABOT_DATA_DIR = old
      rmSync(root, { recursive: true, force: true })
    }
  })
  await api.ready
  await settle()
  assert.equal(called, 1, 'boot 完成后应调用一次自愈')
  assert.deepEqual([...ws.sessionIds].sort(), ['sid-a', 'sid-b'])
})
