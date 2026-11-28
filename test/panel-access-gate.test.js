// 面板访问闸（2026-11-02 安全基线，2026-11-02 首审后加固）
//
// 为什么要有这条：DSH 的 webServer 对插件路由没有服务器级鉴权，而管理接口能改配置、
// 能装模块、能取联动密钥、能下「客户端包」（包内嵌 host.json，含 bearer 令牌）。
// 同机部署时插件只绑回环，本来打不到；一旦用户把端口经反代发布到公网，整组管理接口就裸奔。
// 这里锁死「默认只许本机」。
//
// 【首审 P1-2 后的口径】**socket 地址是唯一可信来源**，X-Forwarded-For 客户端能自己写。
//   · fake.call 不传 socket = 进程内直调 → 按本机处理；
//   · 传 socket='203.0.113.7' = 外网直连 → 必须拒绝；
//   · 传 socket='127.0.0.1' + 配了 security.trustedProxy = 反代接入 → 看 XFF 最后一跳。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'

let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-gate-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: true,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
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
})

after(async () => {
  try { fake.dispose() } catch (e) {}
  try { await api?.dispose?.() } catch (e) {}
})

test('面板闸：本机（无 socket / 回环 socket）照常放行——同机零退化', async () => {
  const r = await fake.call('/panel/pet/behavior/status')
  assert.equal(r.status, 200, '本机直调放行（无 socket = 进程内）')
  const loop = await fake.call('/panel/pet/behavior/status', null, {}, '127.0.0.1')
  assert.equal(loop.status, 200, '回环 socket 直接放行')
})

test('面板闸：外网来源被 403 拦下（P1-2 回归：看 socket 不看 XFF）', async () => {
  // 直连外网：socket 就是外网地址
  const far = await fake.call('/panel/pet/behavior/status', null, {}, '203.0.113.7')
  assert.equal(far.status, 403, '外网直连面板接口必须拒绝')
  assert.match(String(far.raw() || ''), /只允许本机|panelRemoteAccess/, '错误信息要说明「只允许本机」与开启方式')

  // 【核心回归】直连时伪造 X-Forwarded-For: 127.0.0.1 不能绕过（旧实现就是这么被打穿的）
  const spoofed = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '127.0.0.1' }, '203.0.113.7')
  assert.equal(spoofed.status, 403, '直连伪造 XFF 本机地址不能绕过面板闸')
})

test('面板闸：覆盖所有管理面，不只是 /panel/*（P1-1 回归）', async () => {
  // 这些是首审实测能 200 的核心管理接口，现在必须一起拦
  const paths = ['/state', '/save', '/logs', '/modules', '/bridge/token', '/commands', '/snowluma/password']
  for (const p of paths) {
    const r = await fake.call(p, null, {}, '203.0.113.7')
    assert.equal(r.status, 403, `${p} 属于管理面，外网来源必须拒绝`)
  }
})

test('模块前缀路由默认只许本机（issue #8 回归）', async () => {
  // 以前只有显式 access: 'panel' 的模块路由才过闸，其余远端无密钥就能读写
  // /memories、/memory/graph、/sticker/delete 这些。现在没声明 access 的一律按管理面处理。
  for (const p of ['/memories', '/memory/graph/state', '/stickers', '/song/status']) {
    const far = await fake.call(p, null, {}, '203.0.113.7')
    assert.equal(far.status, 403, `${p} 没声明 access，远端来源必须拒绝`)
    assert.match(String(far.raw() || ''), /只允许本机|panelRemoteAccess/, '拒绝理由要是面板闸')
    const rebind = await fake.call(p, null, { host: 'evil.example' }, '127.0.0.1')
    assert.equal(rebind.status, 403, `${p} 必须挡 DNS rebinding 的异常 Host`)
    const local = await fake.call(p)
    assert.equal(local.status, 200, `${p} 本机照常放行`)
  }
})

test('面板闸：可信反代的最后一跳才算真实来源（P1-1 回归）', async () => {
  // host.js 的 getConfig 返回闭包里的 cfg，热改要走它暴露的 setConfig（改 config.json 不生效）
  const setCfg = (patch) => api.setConfig({ ...api.getConfig(), ...patch })
  setCfg({ security: { ...api.getConfig().security, trustedProxy: '127.0.0.1' } })

  // 反代接入（socket 是回环 + 命中 trustedProxy）：真实来源看 XFF 最后一跳
  const proxied = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1')
  assert.equal(proxied.status, 403, '可信反代 + 真实来源是外网 → 拒绝')

  // 伪造首跳回环也骗不过（只认最后一跳）
  const spoofed = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '127.0.0.1, 203.0.113.7' }, '127.0.0.1')
  assert.equal(spoofed.status, 403, '客户端伪造首跳回环不能骗过闸（只认最后一跳）')

  // 末跳是回环 → 算本机，放行
  const local = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '127.0.0.1' }, '127.0.0.1')
  assert.equal(local.status, 200, '可信反代 + 末跳回环 → 本机，放行')

  // 清理
  setCfg({ security: { ...api.getConfig().security, trustedProxy: '' } })
})

test('面板闸：panelRemoteAccess 打开后放行远端（配置必须可持久化）', async () => {
  const setCfg = (patch) => api.setConfig({ ...api.getConfig(), ...patch })
  setCfg({ security: { ...api.getConfig().security, panelRemoteAccess: true } })

  const open = await fake.call('/panel/pet/behavior/status', null, {}, '203.0.113.7')
  assert.equal(open.status, 200, 'panelRemoteAccess 打开后远端可管理')

  // 关回去必须立刻恢复拦截
  setCfg({ security: { ...api.getConfig().security, panelRemoteAccess: false } })
  const back = await fake.call('/panel/pet/behavior/status', null, {}, '203.0.113.7')
  assert.equal(back.status, 403, '关掉后立刻恢复拦截')
})

test('面板闸：本机网卡地址也算本机（--host 100.x 时本机面板不该被自己 403）', async (t) => {
  // 用 dsh web --host <本机网卡 IP> 起服务、从本机打开面板时，TCP 源地址就是那张网卡的地址，
  // 不是 127.0.0.1。只认回环会把本机面板误判成远端。
  const lan = Object.values(networkInterfaces()).flat()
    .filter((x) => x && !x.internal && x.family === 'IPv4' && x.address !== '127.0.0.1')
    .map((x) => x.address)[0]
  if (!lan) return t.skip('本机没有非回环 IPv4 网卡，跳过')

  const self = await fake.call('/panel/pet/behavior/status', null, { host: lan + ':5099' }, lan)
  assert.equal(self.status, 200, `本机网卡地址 ${lan} 打开面板算本机`)

  // 同一个地址作为 Host 也要过 Host 闸（防 DNS rebinding 的白名单同样认本机网卡）
  const viaHost = await fake.call('/state', null, { host: lan + ':5099' }, '127.0.0.1')
  assert.equal(viaHost.status, 200, 'Host 是本机网卡地址时算同源')

  // 别的机器从自己的地址连进来仍然不是本机
  const far = await fake.call('/panel/pet/behavior/status', null, {}, '203.0.113.7')
  assert.equal(far.status, 403, '非本机地址仍然被拦')

  // 本机网卡地址的 Origin 也算同源（不然从该入口保存配置会被 CSRF 403）
  const save = await fake.call('/save', { ownerName: '主人' }, {
    host: lan + ':5099',
    origin: 'http://' + lan + ':5099',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, lan)
  assert.equal(save.status, 200, '本机网卡地址的 Origin 算同源')
})
