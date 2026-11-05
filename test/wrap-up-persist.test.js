// 收尾 / 等待：状态落盘（wrap-up.json），插件卸载再装 / DSH 重启后等待、收尾、摘要都还在。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(30)
  }
  throw new Error('等不到条件成立')
}

const OWNER = '10000001'
const BOT = '20000002'
const PRIV = `private:${OWNER}`

let fake
let cfg
let dataDir
let calls = []
let createHub

async function brain({ text }) {
  // 只看对方这一句：前面可能带着 resume 摘要，摘要里的字不能当成对方说的话
  if (text.includes('【私聊】')) text = text.slice(text.lastIndexOf('【私聊】'))
  if (text.includes('面试')) return '晚安 明天见\n<close>\n摘要：他明天上午面试，情绪有点低\n下次：问面试顺不顺利，别再提加班'
  if (text.includes('晚安')) return '晚安 明天见<close>'
  if (text.includes('等我一下')) return '好 我等你<wait:120>'
  return '嗯'
}

const priv = (text) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(BOT), user_id: Number(OWNER), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(OWNER), nickname: 'xiaoming' }, message: [{ type: 'text', data: { text } }] })
const sentPriv = () => calls.filter((c) => c.action === 'send_private_msg')
const textOfMsg = (c) => (c.params.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join('')

/** 建一个 hub（模拟一次插件加载），返回 { hub, off }。 */
function loadHub() {
  const onebot = { call: async (action, params) => { calls.push({ action, params }); return { message_id: String(calls.length) } } }
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onebot,
    stickers: { enabled: false, match: () => null, pickForReply: () => null, segmentFor: () => null, markUsed: () => {} },
    tts: {},
    random: () => 1,
  })
  const off = fake.ctx.on('session/event', (session, event) => hub.onSessionEvent(session, event))
  return { hub, off }
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-wrapup-persist-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const { normalize } = await import('../src/core/config.js')
  fake = createFakeDsh({ brain })
  cfg = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    merge: { waitSec: 0.05, maxSec: 5, groupWaitSec: 0.05, groupMaxSec: 5 },
    stickers: { enabled: false, autoChance: 0, collect: false },
    voice: { enabled: false, autoChance: 0 },
    files: { enabled: false },
    group: { interjectChance: 0 },
    wrapUp: { waitSec: 60, maxWaitSec: 120, closeSec: 43200, replyDelaySec: 0.05 },
  })
  ;({ createHub } = await import('../src/chat/hub.js'))
})

after(() => {
  fake?.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('收尾状态和摘要落盘：重启后还在，对方回来时带着摘要 resume', async () => {
  const a = loadHub()
  try {
    const before = sentPriv().length
    await a.hub.onMessage(priv('晚安'))
    await until(() => sentPriv().length > before)
    assert.equal(textOfMsg(sentPriv().at(-1)), '晚安 明天见')
    assert.equal(a.hub.wrapStateOf(PRIV).closed, true)
    const file = join(dataDir, 'wrap-up.json')
    assert.ok(existsSync(file), '状态要落盘')
    assert.match(readFileSync(file, 'utf8'), /closeSummary/)
  } finally {
    a.hub.dispose()
    a.off()
  }

  const b = loadHub()
  try {
    const st = b.hub.wrapStateOf(PRIV)
    assert.equal(st.closed, true, '重启后收尾状态还在')
    assert.match(st.summary, /你：晚安 明天见/, '摘要也在')
    assert.equal(st.resume, '接着上次的话题，别装作没发生过', '没写「下次」时的兜底也在')
    assert.equal(b.hub.proactiveMuted(PRIV), true, '重启后主动静音照样生效')

    const turns = fake.turns.length
    await b.hub.onMessage(priv('早'))
    await until(() => fake.turns.length > turns)
    assert.match(fake.turns.at(-1).userText, /收尾前你们最后聊的是/)
    assert.match(fake.turns.at(-1).userText, /你：晚安 明天见/)
    assert.match(fake.turns.at(-1).userText, /【下次可以这样接：接着上次的话题，别装作没发生过】/)
    assert.equal(b.hub.wrapStateOf(PRIV).closed, false, 'resume 一次就消费掉')
  } finally {
    b.hub.dispose()
    b.off()
  }
})

test('等待窗口落盘：重启后还在等，对方接着说还是快接', async () => {
  const a = loadHub()
  try {
    const before = sentPriv().length
    await a.hub.onMessage(priv('等我一下'))
    await until(() => sentPriv().length > before)
    assert.equal(textOfMsg(sentPriv().at(-1)), '好 我等你')
    assert.equal(a.hub.wrapStateOf(PRIV).waiting, true)
  } finally {
    a.hub.dispose()
    a.off()
  }

  const b = loadHub()
  try {
    const st = b.hub.wrapStateOf(PRIV)
    assert.equal(st.waiting, true, '重启后还在等')
    assert.ok(st.waitLeftMs > 0)
    assert.ok(st.waitLeftMs <= 120_000)

    cfg.merge.waitSec = 2 // 平时要等 2 秒；等待中的这一句应该缩到 replyDelaySec
    const turns = fake.turns.length
    const t0 = Date.now()
    await b.hub.onMessage(priv('我回来了'))
    await until(() => fake.turns.length > turns)
    assert.ok(Date.now() - t0 < 1500, '重启后等待窗口里的消息也要快接：' + (Date.now() - t0) + 'ms')
    assert.match(fake.turns.at(-1).userText, /你刚才说了先等一会儿/)
    assert.equal(b.hub.wrapStateOf(PRIV).waiting, false)
  } finally {
    cfg.merge.waitSec = 0.05
    b.hub.dispose()
    b.off()
  }
})

test('收尾时写的摘要 / 下次也落盘：重启后 resume 还是她写的那份', async () => {
  const a = loadHub()
  try {
    const before = sentPriv().length
    await a.hub.onMessage(priv('我明天面试 先睡了'))
    await until(() => sentPriv().length > before)
    assert.equal(textOfMsg(sentPriv().at(-1)), '晚安 明天见', '摘要 / 下次 不能发出去')
    const st = a.hub.wrapStateOf(PRIV)
    assert.equal(st.closed, true)
    assert.equal(st.summary, '他明天上午面试，情绪有点低')
    assert.equal(st.resume, '问面试顺不顺利，别再提加班')
    const file = join(dataDir, 'wrap-up.json')
    assert.match(readFileSync(file, 'utf8'), /closeResume/, '「下次」也要写进文件')
  } finally {
    a.hub.dispose()
    a.off()
  }

  const b = loadHub()
  try {
    const st = b.hub.wrapStateOf(PRIV)
    assert.equal(st.closed, true, '重启后收尾状态还在')
    assert.equal(st.summary, '他明天上午面试，情绪有点低')
    assert.equal(st.resume, '问面试顺不顺利，别再提加班', '「下次」跟着状态一起回来')

    const turns = fake.turns.length
    await b.hub.onMessage(priv('早'))
    await until(() => fake.turns.length > turns)
    assert.match(fake.turns.at(-1).userText, /收尾前你们最后聊的是/)
    assert.match(fake.turns.at(-1).userText, /【下次可以这样接：问面试顺不顺利，别再提加班】/)
    assert.equal(b.hub.wrapStateOf(PRIV).closed, false, 'resume 一次就消费掉')
  } finally {
    b.hub.dispose()
    b.off()
  }
})
