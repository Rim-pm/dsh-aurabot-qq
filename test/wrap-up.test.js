// 收尾 / 等待：<wait> / <close> 标记 + 定时器 + 会话状态（私聊 MVP）。
// 一半是纯逻辑（解析 / 状态机 / 配置），一半是走真 hub 的链路（假 DSH + 假网关）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWrapUp, stripWrapMarkers, createWrapUpState, looksLikeQuestion, looksLikeHelpRequest } from '../src/chat/wrap-up.js'
import { normalize } from '../src/core/config.js'

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
// ---------- 标记解析 ----------

test('收尾 / 等待：<wait> 用默认时长，标记本身从正文里摘掉', () => {
  const r = parseWrapUp('我先去倒杯水\n<wait>', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(r.text, '我先去倒杯水')
  assert.equal(r.waitMs, 300_000)
  assert.equal(r.close, false)
  assert.equal(r.hadWait, true)
})

test('收尾 / 等待：<wait:30> / <wait:1m> / <wait:30秒> / <wait 30> 都认，秒和分钟分得开', () => {
  for (const [tag, ms] of [['<wait:30>', 30_000], ['<wait：30>', 30_000], ['<wait:1m>', 60_000], ['<wait:30秒>', 30_000], ['<wait 30>', 30_000], ['<wait/>', 300_000], ['<wait></wait>', 300_000]]) {
    const r = parseWrapUp(`好${tag}`, { waitSec: 300, maxWaitSec: 1800 })
    assert.equal(r.waitMs, ms, tag)
    assert.equal(r.text, '好', tag)
  }
})

test('收尾 / 等待：<wait:9999> 夹到上限，<wait:0> = 取消等待', () => {
  assert.equal(parseWrapUp('<wait:9999>', { waitSec: 300, maxWaitSec: 1800 }).waitMs, 1_800_000)
  const cancel = parseWrapUp('算了<wait:0>', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(cancel.waitMs, 0)
  assert.equal(cancel.text, '算了')
})

test('收尾 / 等待：<close> 优先于 <wait>，闭合标签只去标记', () => {
  const r = parseWrapUp('那我先睡啦\n<wait>\n<close>', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(r.text, '那我先睡啦')
  assert.equal(r.close, true)
  assert.equal(r.waitMs, null, '收尾优先，不再等')
  assert.equal(r.hadWait, true)
  assert.equal(parseWrapUp('晚安</close>', {}).text, '晚安')
})

test('收尾 / 等待：括号写法只认单独占最后一行的，正常说话里的词不误伤', () => {
  const a = parseWrapUp('好 我等你\n[等待]', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(a.text, '好 我等你')
  assert.equal(a.waitMs, 300_000)
  assert.equal(parseWrapUp('好\n【等30秒】', { waitSec: 300, maxWaitSec: 1800 }).waitMs, 30_000)
  const b = parseWrapUp('晚安\n[收尾]', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(b.close, true)
  assert.equal(b.text, '晚安')
  // 不是整行、或者只是句子里提到，都不算标记
  assert.equal(parseWrapUp('我在[等待]你回我', {}).waitMs, null)
  assert.equal(parseWrapUp('他让我[等待]一下再说', {}).text, '他让我[等待]一下再说')
})

test('收尾 / 等待：整行括号标记出现在哪儿都剥掉，但不改状态（也不漏到 QQ）', () => {
  const a = parseWrapUp('[收尾]\n晚安', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(a.close, false, '不是最后一行的括号标记只算正文，不收尾')
  assert.equal(a.text, '晚安')
  assert.doesNotMatch(a.text, /\[收尾\]/)

  const b = parseWrapUp('好\n[等待]\n继续', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(b.waitMs, null, '夹在中间的 [等待] 不改状态')
  assert.equal(b.text, '好\n继续')
  assert.doesNotMatch(b.text, /\[等待\]/)

  // 各种写法都认整行
  assert.equal(stripWrapMarkers('【收尾】\n晚安'), '晚安')
  assert.equal(stripWrapMarkers('[等30秒]\n等我'), '等我')
  assert.equal(stripWrapMarkers('[结束]\n\n\n拜拜'), '拜拜', '连续空行合并')
  // 句子里的词不剥（避免误伤正常说话）
  assert.equal(stripWrapMarkers('我在[等待]你'), '我在[等待]你')
  assert.equal(stripWrapMarkers('他让我[等待]一下再说'), '他让我[等待]一下再说')
})

test('收尾 / 等待：正文中间提到尖括号标记只剥掉、不改状态，末尾才算意图', () => {
  const a = parseWrapUp('你可以写 <wait> 让我等你', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(a.waitMs, null, '解释语法不是真的在等')
  assert.equal(a.close, false)
  assert.doesNotMatch(a.text, /<wait>/, '标记还是不能漏出去')

  const b = parseWrapUp('比如这样：<wait:30>', { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(b.waitMs, null, '行尾但前面是「：」的当例子')

  assert.equal(parseWrapUp('好<wait:30>', { waitSec: 300, maxWaitSec: 1800 }).waitMs, 30_000, '标记跟在正文后面照认')
  assert.equal(parseWrapUp('晚安<close>', {}).close, true)
  assert.equal(parseWrapUp('晚安\n<close>', {}).close, true, '单独占最后一行照认')
})

test('收尾 / 等待：<close> 后面可以写「摘要 / 下次」，解析出来并从正文里摘掉', () => {
  const r = parseWrapUp('晚安，明天见。\n\n<close>\n摘要：他今天加班到十点，明天上午面试，情绪有点低\n下次：问面试顺不顺利，别再提加班', {})
  assert.equal(r.close, true)
  assert.equal(r.text, '晚安，明天见。', '摘要 / 下次 不能发出去')
  assert.equal(r.summary, '他今天加班到十点，明天上午面试，情绪有点低')
  assert.equal(r.resume, '问面试顺不顺利，别再提加班')

  const long = parseWrapUp(`<close>\n摘要：${'甲'.repeat(300)}\n下次：${'乙'.repeat(200)}`, {})
  assert.equal(long.summary.length, 240, '摘要截到 240 字')
  assert.equal(long.resume.length, 160, '下次截到 160 字')

  const plain = parseWrapUp('晚安<close>', {})
  assert.equal(plain.summary, '')
  assert.equal(plain.resume, '', '没写就留空，交给 hub 回退')
  // <close> 后面还有正文：不算收尾（只认末尾），也不当 payload
  const messy = parseWrapUp('晚安\n<close>\n摘要：这句\n接着说别的', {})
  assert.equal(messy.close, false, '后面还有正文就不算收尾')
  assert.equal(messy.summary, '')
  assert.match(messy.text, /接着说别的/)
})

test('收尾 / 等待：普通回复不受影响，别的协议标签照旧保留', () => {
  const raw = '嗯嗯<sticker:开心>|||<voice>晚安</voice><poke>'
  const r = parseWrapUp(raw, { waitSec: 300, maxWaitSec: 1800 })
  assert.equal(r.text, raw)
  assert.equal(r.waitMs, null)
  assert.equal(r.close, false)
  // 只是含 wait 字样的普通标签不认
  assert.equal(parseWrapUp('<waiting>', {}).text, '<waiting>')
})

test('stripWrapMarkers：只去标记，别的原样留着', () => {
  assert.equal(stripWrapMarkers('好<wait:30>呀<close>'), '好呀')
  assert.equal(stripWrapMarkers('没有标记的一句'), '没有标记的一句')
  assert.equal(stripWrapMarkers('<sticker:开心>'), '<sticker:开心>')
})

// ---------- 会话状态 ----------

test('会话状态：等待是一次性的，对方一开口就消费掉', () => {
  let now = 1000
  const st = createWrapUpState({ now: () => now })
  st.markWait('private:1', 5000)
  assert.equal(st.peek('private:1').waiting, true)
  assert.equal(st.peek('private:1').waitLeftMs, 5000)
  now += 2000
  assert.equal(st.peek('private:1').waitLeftMs, 3000)
  assert.deepEqual(st.takeWait('private:1'), { waitedMs: 2000, plannedMs: 5000, reason: 'wait' })
  assert.equal(st.takeWait('private:1'), null, '第二次就是普通消息了')
  assert.equal(st.peek('private:1').waiting, false)
})

test('会话状态：定时器到点才算等满，对方中途开口就不算', () => {
  let now = 0
  const st = createWrapUpState({ now: () => now })
  st.markWait('private:1', 1000)
  now = 500
  assert.equal(st.expire('private:1'), null, '还没到点')
  now = 1000
  assert.deepEqual(st.expire('private:1'), { plannedMs: 1000, reason: 'wait' })
  assert.equal(st.expire('private:1'), null, '只算一次')

  now = 2000
  st.markWait('private:1', 1000)
  st.takeWait('private:1') // 对方中途开口
  now = 4000
  assert.equal(st.expire('private:1'), null, '被消费掉之后定时器什么都不做')
})

test('会话状态：收尾清掉等待；收尾状态也是一次性的', () => {
  let now = 0
  const st = createWrapUpState({ now: () => now })
  st.markWait('private:1', 5000)
  st.markClose('private:1', 60_000)
  assert.equal(st.peek('private:1').waiting, false, '收尾之后不再等')
  assert.equal(st.peek('private:1').closed, true)
  now = 30_000
  assert.deepEqual(st.takeClose('private:1'), { closedMs: 30_000, summary: '', resume: '' })
  assert.equal(st.peek('private:1').closed, false)
  assert.equal(st.takeClose('private:1'), null)
  // 又决定等了：收尾状态作废
  st.markClose('private:1', 60_000)
  st.markWait('private:1', 1000)
  assert.equal(st.peek('private:1').closed, false)
  assert.equal(st.peek('private:1').waiting, true)
})

test('会话状态：<wait:0> 取消等待；prune 清掉过期空壳', () => {
  let now = 0
  const st = createWrapUpState({ now: () => now })
  st.markWait('private:1', 1000)
  st.markWait('private:1', 0)
  assert.equal(st.peek('private:1').waiting, false)
  st.markWait('private:2', 1000)
  st.markWait('private:3', 10_000)
  now = 5000
  assert.equal(st.prune(), 1, '过期的那些被清掉，只剩还在等的')
  assert.equal(st.peek('private:3').waiting, true)
  st.clearAll()
  assert.equal(st.size(), 0)
})

test('looksLikeQuestion：问号 / 句尾语气词才算问句，晚安不算', () => {
  assert.equal(looksLikeQuestion('晚安'), false)
  assert.equal(looksLikeQuestion('明天几点起？'), true)
  assert.equal(looksLikeQuestion('你吃了吗'), true)
  assert.equal(looksLikeQuestion('在吗～'), true)
  assert.equal(looksLikeQuestion('好 晚安\n明天见'), false)
  assert.equal(looksLikeQuestion(''), false)
})

test('looksLikeHelpRequest：求她做事 / 找她帮忙也算（收尾保护用）', () => {
  assert.equal(looksLikeHelpRequest('帮我看看这个文件'), true)
  assert.equal(looksLikeHelpRequest('请问这个怎么弄'), true)
  assert.equal(looksLikeHelpRequest('能不能帮我查下快递'), true)
  assert.equal(looksLikeHelpRequest('晚安'), false)
  assert.equal(looksLikeHelpRequest('在吗'), false, '「在吗」交给 looksLikeQuestion 管')
  assert.equal(looksLikeHelpRequest(''), false)
})

test('会话状态：等待 / 收尾 / 摘要 / 下次怎么接 / 提示都能落盘恢复（重启不丢）', () => {
  let now = 1000
  const a = createWrapUpState({ now: () => now })
  a.markWait('private:1', 5000, { reason: 'question' })
  a.markClose('private:2', 60_000, { summary: '对方：晚安\n你：晚安', resume: '问面试顺不顺利' })
  a.pushNote('private:3', '【兜底摘要】')
  const snap = a.snapshot()
  assert.equal(snap.v, 1)
  assert.equal(snap.chats['private:2'].closeResume, '问面试顺不顺利', '「下次」跟着收尾状态一起落盘')

  now = 2000
  const b = createWrapUpState({ now: () => now })
  const r = b.restore(snap)
  assert.equal(r.loaded, 3)
  assert.equal(b.peek('private:1').waiting, true)
  assert.equal(b.peek('private:1').waitReason, 'question', '问句保护改成的等待也记着')
  assert.equal(b.peek('private:2').closed, true)
  assert.match(b.peek('private:2').summary, /对方：晚安/, '摘要跟着收尾状态一起回来')
  assert.equal(b.peek('private:2').resume, '问面试顺不顺利', '「下次怎么接」也一起回来')
  assert.deepEqual(b.takeNotes('private:3'), ['【兜底摘要】'])
})

test('会话状态：重启前已经等满的，恢复时告诉 hub 补摘要', () => {
  let now = 1000
  const a = createWrapUpState({ now: () => now })
  a.markWait('private:1', 5000)
  const snap = a.snapshot()
  now = 7000 // 已经过了等待窗口
  const b = createWrapUpState({ now: () => now })
  const r = b.restore(snap)
  assert.equal(r.loaded, 0, '过期的等待不再挂状态')
  assert.deepEqual(r.expiredWaits, [{ chatId: 'private:1', plannedMs: 5000, reason: 'wait' }])
})

test('会话状态：提示会过期，不会一直挂着', () => {
  let now = 0
  const st = createWrapUpState({ now: () => now, noteTtlMs: 1000 })
  st.pushNote('private:1', '一会儿前的')
  now = 2000
  assert.deepEqual(st.takeNotes('private:1'), [])
})

// ---------- 配置 ----------

test('配置：wrapUp 默认等 5 分钟、收尾留 12 小时，数值夹回合理范围，写坏了回落默认', () => {
  const c = normalize({})
  assert.equal(c.wrapUp.enabled, true)
  assert.equal(c.wrapUp.waitSec, 300, '默认等 5 分钟')
  assert.equal(c.wrapUp.maxWaitSec, 1800)
  assert.equal(c.wrapUp.closeSec, 43200, '默认收尾状态保留 12 小时')
  assert.equal(c.wrapUp.replyDelaySec, 1)
  assert.equal(c.wrapUp.recap, true)
  assert.equal(c.wrapUp.questionGuard, true)
  assert.equal(c.wrapUp.proactiveMute, true)

  const off = normalize({ wrapUp: { enabled: false } })
  assert.equal(off.wrapUp.enabled, false)
  assert.equal(off.wrapUp.waitSec, 300, '关掉也保留其它字段')

  const dirty = normalize({ wrapUp: { waitSec: -5, maxWaitSec: 1, closeSec: 999999, replyDelaySec: 999, questionGuard: false, proactiveMute: false } })
  assert.equal(dirty.wrapUp.waitSec, 1)
  assert.equal(dirty.wrapUp.maxWaitSec, 1, 'maxWaitSec 不会比 waitSec 还小')
  assert.equal(dirty.wrapUp.closeSec, 86400)
  assert.equal(dirty.wrapUp.replyDelaySec, 60)
  assert.equal(dirty.wrapUp.questionGuard, false)
  assert.equal(dirty.wrapUp.proactiveMute, false)

  const broken = normalize({ wrapUp: null })
  assert.equal(broken.wrapUp.enabled, true, 'null 回落默认')
  assert.equal(broken.wrapUp.waitSec, 300)
})

// ---------- 真链路（假 DSH + 假网关） ----------

const OWNER = '10000001'
const BOT = '20000002'
const PRIV = `private:${OWNER}`

let fake
let hub
let calls
let cfg
let dataDir
const logs = []

async function brain({ text }) {
  // 只看对方这一句：前面可能带着 resume 摘要，摘要里的字不能当成对方说的话
  if (text.includes('【私聊】')) text = text.slice(text.lastIndexOf('【私聊】'))
  if (text.includes('倒杯水')) return '好 我等你\n<wait:2>'
  if (text.includes('几点起')) return '晚安 明天几点起？<close>'
  if (text.includes('先睡啦')) return '好 晚安<close>'
  if (text.includes('等我一下')) return '嗯 你忙<wait:1>'
  if (text.includes('马上回来')) return '<wait:2>'
  if (text.includes('帮我看看这个文件')) return '好的<close>'
  if (text.includes('关掉测试')) return '好呀<wait>'
  if (text.includes('在吗')) return '在<close>'
  if (text.includes('面试')) return '晚安 明天见\n<close>\n摘要：他明天上午面试，情绪有点低\n下次：问面试顺不顺利，别再提加班'
  if (text.includes('今天好累')) return '那你早点睡 明天几点起？<close>'
  if (text.includes('群里等待测试')) return '好<wait>'
  return '嗯'
}

const priv = (text) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(BOT), user_id: Number(OWNER), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(OWNER), nickname: 'xiaoming' }, message: [{ type: 'text', data: { text } }] })
const grp = (text) => ({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: Number(BOT), group_id: 555, user_id: 777, message_id: Math.floor(Math.random() * 1e6), sender: { user_id: 777, nickname: '群友', card: '群友', role: 'member' }, message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + text } }] })
const sentPriv = () => calls.filter((c) => c.action === 'send_private_msg')
const sentGroup = () => calls.filter((c) => c.action === 'send_group_msg')
const textOfMsg = (c) => (c.params.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join('')

/**
 * 发一条私聊，并且等她这一轮真的发出去了再返回。
 * 不这样做的话，上一个用例还没发完的回复会串到下一个用例里，把 `until(条数变多)` 提前满足。
 */
async function say(text) {
  const before = sentPriv().length
  await hub.onMessage(priv(text))
  await until(() => sentPriv().length > before)
  return sentPriv().at(-1)
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-wrapup-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  fake = createFakeDsh({ brain })
  calls = []
  const onebot = { call: async (action, params) => { calls.push({ action, params }); return { message_id: String(calls.length) } } }
  cfg = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: ['555'] },
    merge: { waitSec: 0.05, maxSec: 5, groupWaitSec: 0.05, groupMaxSec: 5 },
    stickers: { enabled: false, autoChance: 0, collect: false },
    voice: { enabled: false, autoChance: 0 },
    files: { enabled: false },
    group: { interjectChance: 0 },
    wrapUp: { waitSec: 5, maxWaitSec: 10, closeSec: 60, replyDelaySec: 0.1 },
  })
  const { createHub } = await import('../src/chat/hub.js')
  hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    onebot,
    stickers: { enabled: false, match: () => null, pickForReply: () => null, segmentFor: () => null, markUsed: () => {} },
    tts: {},
    random: () => 1,
  })
  fake.ctx.on('session/event', (session, event) => hub.onSessionEvent(session, event))
})

after(() => {
  hub?.dispose()
  fake?.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('私聊：她写 <wait> 时标记不发出去，等待期间对方接着说会被马上接上', async () => {
  await say('我去倒杯水 等我一下')
  assert.equal(textOfMsg(sentPriv().at(-1)), '好 我等你', '标记不能漏到 QQ 上')
  assert.equal(hub.wrapStateOf(PRIV).waiting, true)
  assert.ok(hub.wrapStateOf(PRIV).waitLeftMs > 0)

  // 平时要等 2 秒（连发合并），等待中的这一句只等 0.1 秒
  cfg.merge.waitSec = 2
  const turns = fake.turns.length
  const sentBefore = sentPriv().length
  const t0 = Date.now()
  await hub.onMessage(priv('我回来了'))
  await until(() => fake.turns.length > turns)
  assert.ok(Date.now() - t0 < 1500, '等待中的消息应该马上交给她：' + (Date.now() - t0) + 'ms')
  assert.match(fake.turns.at(-1).userText, /你刚才说了先等一会儿/)
  assert.equal(hub.wrapStateOf(PRIV).waiting, false, '等待是一次性的')
  await until(() => sentPriv().length > sentBefore)
  cfg.merge.waitSec = 0.05
})

test('私聊：等满没人说话，下一轮带上兜底摘要（不主动发消息）', async () => {
  const before = sentPriv().length
  await say('等我一下 我去拿个快递')
  assert.equal(textOfMsg(sentPriv().at(-1)), '嗯 你忙')
  assert.equal(hub.wrapStateOf(PRIV).waiting, true)
  await sleep(1300) // <wait:1> 到点
  assert.equal(hub.wrapStateOf(PRIV).waiting, false, '到点就清掉')
  assert.equal(sentPriv().length, before + 1, '没等到人也不主动往 QQ 发东西')

  const turns = fake.turns.length
  const sentBefore = sentPriv().length
  await hub.onMessage(priv('回来了'))
  await until(() => fake.turns.length > turns)
  assert.match(fake.turns.at(-1).userText, /这段时间对方没有再说话/)
  await until(() => sentPriv().length > sentBefore)
})

test('私聊：<close> 之后对方再来，会带上收尾前的摘要 resume；只提醒一次', async () => {
  await say('我先睡啦')
  assert.equal(textOfMsg(sentPriv().at(-1)), '好 晚安')
  const closed = hub.wrapStateOf(PRIV)
  assert.equal(closed.closed, true)
  assert.match(closed.summary, /你：好 晚安/, '收尾时留了摘要')
  assert.equal(closed.resume, '接着上次的话题，别装作没发生过', '没写「下次」就用兜底那句')
  assert.equal(hub.proactiveMuted(PRIV), true, '收尾后不主动找对方')

  // 收尾期间：模块主动推的（主动搭话 / 扩展早安问候都走这条）一律先不发
  const beforePush = fake.turns.length
  await hub.pushToSession({ chatId: PRIV, kind: 'private', userId: OWNER, nickname: 'xiaoming' }, [{ type: 'text', text: '【系统提醒】早安' }], '')
  await sleep(200)
  assert.equal(fake.turns.length, beforePush, '主动静音：收尾期间不主动打扰')

  let turns = fake.turns.length
  let sentBefore = sentPriv().length
  await hub.onMessage(priv('晚安 你也早点睡'))
  await until(() => fake.turns.length > turns)
  assert.match(fake.turns.at(-1).userText, /这段你之前收过尾/)
  assert.match(fake.turns.at(-1).userText, /收尾前你们最后聊的是/)
  assert.match(fake.turns.at(-1).userText, /你：好 晚安/, '摘要跟着 resume 一起给她')
  assert.match(fake.turns.at(-1).userText, /【下次可以这样接：接着上次的话题，别装作没发生过】/)
  assert.equal(hub.wrapStateOf(PRIV).closed, false, '收尾状态只用一次')
  assert.equal(hub.proactiveMuted(PRIV), false, '对方开口就解除主动静音')
  await until(() => sentPriv().length > sentBefore)

  turns = fake.turns.length
  sentBefore = sentPriv().length
  await hub.onMessage(priv('明天见'))
  await until(() => fake.turns.length > turns)
  assert.doesNotMatch(fake.turns.at(-1).userText, /收过尾/)
  await until(() => sentPriv().length > sentBefore)
})

test('私聊：收尾那句是问句时不收尾，改成等一会儿（问句保护）', async () => {
  await say('我先睡啦 明天几点起')
  assert.equal(textOfMsg(sentPriv().at(-1)), '晚安 明天几点起？', '问句照常发，标记不漏')
  const st = hub.wrapStateOf(PRIV)
  assert.equal(st.closed, false, '问了人就不收尾')
  assert.equal(st.waiting, true, '改成等对方回答')
  assert.equal(st.waitReason, 'question')
  assert.equal(hub.proactiveMuted(PRIV), false, '没收尾就不算主动静音')

  const turns = fake.turns.length
  const sentBefore = sentPriv().length
  await hub.onMessage(priv('七点'))
  await until(() => fake.turns.length > turns)
  assert.match(fake.turns.at(-1).userText, /你刚才问了他一句/)
  assert.doesNotMatch(fake.turns.at(-1).userText, /收尾前你们最后聊的是/)
  assert.equal(hub.wrapStateOf(PRIV).waiting, false, '回答完就不再等')
  await until(() => sentPriv().length > sentBefore)
})

test('私聊：整轮只写 <wait> 时她不出声，但等待照样记上', async () => {
  const before = sentPriv().length
  await hub.onMessage(priv('我马上回来'))
  await until(() => hub.wrapStateOf(PRIV).waiting)
  await sleep(200)
  assert.equal(sentPriv().length, before, '只有一个标记，一个字都不该发')
  assert.equal(hub.wrapStateOf(PRIV).waiting, true)
  // 对方接着说：马上接上
  cfg.merge.waitSec = 2
  const turns = fake.turns.length
  const sentBefore = sentPriv().length
  await hub.onMessage(priv('我回来了'))
  await until(() => fake.turns.length > turns)
  assert.match(fake.turns.at(-1).userText, /你刚才说了先等一会儿/)
  await until(() => sentPriv().length > sentBefore)
  cfg.merge.waitSec = 0.05
})

test('关掉 wrapUp：标记照样不发出去，但不再有等待 / 收尾 / 兜底摘要', async () => {
  cfg.wrapUp.enabled = false
  try {
    await say('关掉测试 在吗')
    assert.equal(textOfMsg(sentPriv().at(-1)), '好呀')
    assert.equal(hub.wrapStateOf(PRIV).waiting, false)

    const turns = fake.turns.length
    const sentBefore = sentPriv().length
    await hub.onMessage(priv('接着说'))
    await until(() => fake.turns.length > turns)
    assert.doesNotMatch(fake.turns.at(-1).userText, /先等一会儿|已经收尾了/)
    await until(() => sentPriv().length > sentBefore)
  } finally {
    cfg.wrapUp.enabled = true
  }
})

test('群聊暂不接（MVP）：标记不发出去，也不记状态', async () => {
  const before = sentGroup().length
  await hub.onMessage(grp('群里等待测试'))
  await until(() => sentGroup().length > before)
  const msg = sentGroup().at(-1).params.message
  assert.ok(!JSON.stringify(msg).includes('<wait>'), '群里的标记也不能漏出去')
  assert.equal(hub.wrapStateOf('group:555').waiting, false)
})

test('私聊：对方在问问题 / 求她帮忙时，她的 <close> 不生效', async () => {
  await say('帮我看看这个文件 明天要交')
  assert.equal(textOfMsg(sentPriv().at(-1)), '好的', '<close> 不能漏到 QQ 上')
  assert.equal(hub.wrapStateOf(PRIV).closed, false, '对方在求她做事，不该收尾')
  assert.equal(hub.proactiveMuted(PRIV), false, '没收尾就不算主动静音')

  await say('在吗')
  assert.equal(textOfMsg(sentPriv().at(-1)), '在')
  assert.equal(hub.wrapStateOf(PRIV).closed, false, '对方在问「在吗」，不该收尾')
})

test('私聊：系统 / 主动消息带 <close> 只剥标记，不改状态', async () => {
  // 出站清洗会把「【系统提醒】…」整行当提示词复读拦掉，这里只看状态：不能收尾
  await hub.deliver(PRIV, '【系统提醒】晚安<close>')
  assert.equal(hub.wrapStateOf(PRIV).closed, false, '系统消息不该让她收尾')
  assert.equal(hub.proactiveMuted(PRIV), false)

  // 没有 own 的投递（模块 / 工具代发）也一样：话照发，标记照剥，状态不动
  const before = sentPriv().length
  await hub.deliver(PRIV, '晚安<close>')
  await until(() => sentPriv().length > before)
  assert.equal(textOfMsg(sentPriv().at(-1)), '晚安', '<close> 不能漏到 QQ 上')
  assert.equal(hub.wrapStateOf(PRIV).closed, false, '不是她这一轮说的话，不改状态')

  // 主动回合（目的引擎那种 own: true + 【系统提醒…】的 userText）同样不改状态
  await hub.deliver(PRIV, '晚安<close>', { own: true, userText: '【系统提醒，不是主人说的话】（她主动找你）' })
  assert.equal(hub.wrapStateOf(PRIV).closed, false, '主动消息不该让她收尾')
})

test('私聊：<close> 带「摘要 / 下次」时，resume 用她写的，下次能接上', async () => {
  await say('我明天面试 先睡了')
  assert.equal(textOfMsg(sentPriv().at(-1)), '晚安 明天见', '摘要 / 下次 不能发出去')
  const st = hub.wrapStateOf(PRIV)
  assert.equal(st.closed, true, '正常聊天回合的 <close> 仍然生效')
  assert.equal(st.summary, '他明天上午面试，情绪有点低')
  assert.equal(st.resume, '问面试顺不顺利，别再提加班')
  assert.equal(hub.proactiveMuted(PRIV), true)

  let turns = fake.turns.length
  let sentBefore = sentPriv().length
  await hub.onMessage(priv('早'))
  await until(() => fake.turns.length > turns)
  const said = fake.turns.at(-1).userText
  assert.match(said, /收尾前你们最后聊的是/)
  assert.match(said, /他明天上午面试/)
  assert.match(said, /【下次可以这样接：问面试顺不顺利，别再提加班】/)
  assert.equal(hub.wrapStateOf(PRIV).closed, false, 'resume 只用一次')
  await until(() => sentPriv().length > sentBefore)

  turns = fake.turns.length
  sentBefore = sentPriv().length
  await hub.onMessage(priv('今天上班'))
  await until(() => fake.turns.length > turns)
  assert.doesNotMatch(fake.turns.at(-1).userText, /下次可以这样接/, 'resume 不会一直挂着')
  await until(() => sentPriv().length > sentBefore)
})

test('私聊：她自己收尾那句是问句时，照旧改成等一会儿（对方那句不是问句）', async () => {
  await say('今天好累')
  assert.equal(textOfMsg(sentPriv().at(-1)), '那你早点睡 明天几点起？', '问句照常发，标记不漏')
  const st = hub.wrapStateOf(PRIV)
  assert.equal(st.closed, false, '问了人就不收尾')
  assert.equal(st.waiting, true, '改成等对方回答')
  assert.equal(st.waitReason, 'question')
})

test('提示词：开着时教她用标记，关掉就不教', async () => {
  const { rulesText } = await import('../src/persona/personas.js')
  const on = rulesText('private', normalize({}))
  assert.match(on, /<wait>/)
  assert.match(on, /<close>/)
  assert.match(on, /摘要：/, '教她收尾时可以写摘要')
  assert.match(on, /下次：/, '教她收尾时可以写下怎么接')
  assert.match(on, /帮你|求助|让你帮忙/, '提醒她对方在问问题 / 等她做事时别收尾')
  const off = rulesText('private', normalize({ wrapUp: { enabled: false } }))
  assert.doesNotMatch(off, /<wait>/)
  assert.doesNotMatch(off, /<close>/)
})
