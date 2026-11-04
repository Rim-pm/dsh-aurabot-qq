// B 站动态订阅：解析、游标、过滤器，以及「被风控也不漏」的那几条规则。用假的 B 站接口测。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let api
let dyn
let normalize
let dataDir

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-subs-'))
  api = await import('../src/bili/api.js')
  dyn = await import('../src/bili/dynamics.js')
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ dataDir } = await import('../src/core/store.js'))
})

const reset = () => rmSync(dataDir('bili-subs.json'), { force: true })

/** 一条假的动态（形状跟 parseDynamic 的输出一致）。 */
const item = (id, text = '正文', extra = {}) => ({
  id, kind: 'draw', text, author: '明日方舟', mid: '161775300', pubTs: 0, title: '',
  images: [], bvid: '', live: null, forward: false, lottery: false,
  url: `https://www.bilibili.com/opus/${id}`, ...extra,
})

function makeEngine({ cfg, feed, extraApi = {} }) {
  const state = { cfg: normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', ...cfg }) }
  const sent = []
  const events = []
  const engine = dyn.createSubs({
    getConfig: () => state.cfg,
    setConfig: (fn) => { state.cfg = normalize(typeof fn === 'function' ? fn(state.cfg) : fn) },
    hub: {
      sendText: async (to, text) => { sent.push({ to, text }); return { message_id: '1' } },
      sendImage: async (to, src) => { sent.push({ to, image: src }); return { message_id: '2' } },
    },
    memory: { addEvent: (e) => events.push(e) },
    log: { info() {}, warn() {}, debug() {} },
    api: {
      dynamicFeed: feed,
      card: async (mid) => ({ mid, name: '明日方舟', face: '' }),
      searchUser: async () => [],
      dynamicAuthor: async () => ({ mid: '161775300', name: '明日方舟' }),
      ...extraApi,
    },
    sleep: async () => {},
  })
  return { engine, state, sent, events }
}

test('parseDynamic：图文 / 视频 / 转发 / 直播都摊平成订阅要的字段', () => {
  const draw = api.parseDynamic({
    type: 'DYNAMIC_TYPE_DRAW',
    id_str: '100',
    modules: {
      module_author: { name: '明日方舟', mid: 161775300, pub_ts: 1700000000 },
      module_dynamic: { desc: { text: '新活动开启' }, major: { opus: { pics: [{ url: 'https://i0.example/a.jpg' }, {}] } } },
    },
  })
  assert.equal(draw.kind, 'draw')
  assert.equal(draw.text, '新活动开启')
  assert.equal(draw.mid, '161775300')
  assert.deepEqual(draw.images, ['https://i0.example/a.jpg'], '空的图丢掉')
  assert.equal(draw.url, 'https://www.bilibili.com/opus/100')

  const video = api.parseDynamic({
    type: 'DYNAMIC_TYPE_AV', id_str: '101',
    modules: { module_dynamic: { major: { archive: { bvid: 'BV1xx411c7mD', title: '新 PV' } } } },
  })
  assert.equal(video.kind, 'video')
  assert.equal(video.title, '新 PV')
  assert.equal(video.url, 'https://www.bilibili.com/video/BV1xx411c7mD', '视频动态给视频链接，不是 opus')

  const forward = api.parseDynamic({ type: 'DYNAMIC_TYPE_FORWARD', id_str: '102', modules: {} })
  assert.equal(forward.forward, true)

  const live = api.parseDynamic({
    type: 'DYNAMIC_TYPE_LIVE_RCMD', id_str: '103',
    modules: { module_dynamic: { major: { live: { title: '版本前瞻', live_state: 1 } } } },
  })
  assert.equal(live.kind, 'live')
  assert.deepEqual(live.live, { title: '版本前瞻', status: 1 })

  const lottery = api.parseDynamic({
    type: 'DYNAMIC_TYPE_WORD', id_str: '104',
    modules: { module_dynamic: { desc: { text: '转发抽奖' }, additional: { type: 'ADDITIONAL_TYPE_UPOWER_LOTTERY' } } },
  })
  assert.equal(lottery.lottery, true)
})

test('parseTarget：UID、主页、动态链接、名字各归各位', () => {
  assert.deepEqual(dyn.parseTarget('https://space.bilibili.com/161775300/dynamic'), { mid: '161775300' })
  assert.deepEqual(dyn.parseTarget('161775300'), { ambiguous: '161775300' })
  assert.deepEqual(dyn.parseTarget('mid=12345'), { mid: '12345' })
  // B 站新号的 UID 就是 16 位（嘟嘟脸恶作剧 3537117026191454），跟动态 id 一样长，光看数字分不开
  assert.deepEqual(dyn.parseTarget('3537117026191454'), { ambiguous: '3537117026191454' })
  assert.deepEqual(dyn.parseTarget('https://t.bilibili.com/3537117026191454'), { dynId: '3537117026191454' })
  assert.deepEqual(dyn.parseTarget('https://www.bilibili.com/opus/3537117026191454'), { dynId: '3537117026191454' })
  assert.deepEqual(dyn.parseTarget('明日方舟'), { name: '明日方舟' })
  assert.deepEqual(dyn.parseTarget('  '), {})
  assert.equal(dyn.findMid('3537117026191454'), '', '裸数字不猜，交给接口试')
  assert.equal(dyn.compareId('9', '10'), -1, '字符串比较会错，必须按数值')
  assert.equal(dyn.compareId('1266767661611614208', '1266767661611614208'), 0)
  assert.equal(dyn.compareId('', '5'), -1)
})

test('过滤器：类型词照丢，写错的正则忽略，不误伤', () => {
  const f = dyn.resolveFilters(['lottery', 'forward', '(未闭合', '广告'])
  assert.deepEqual([...f.kinds].sort(), ['forward', 'lottery'])
  assert.equal(f.regex.length, 1, '坏正则被跳过')
  assert.equal(dyn.keepDynamic(item('1', '正常公告'), f), true)
  assert.equal(dyn.keepDynamic(item('2', '抽奖'), { ...item('2'), lottery: true }, f), true, '第二参不是过滤器时不乱丢')
  assert.equal(dyn.keepDynamic({ ...item('3'), lottery: true }, f), false)
  assert.equal(dyn.keepDynamic({ ...item('4'), forward: true }, f), false)
  assert.equal(dyn.keepDynamic(item('5', '这是一条广告'), f), false)
  assert.equal(dyn.keepDynamic({ ...item('6'), kind: 'live', live: { status: 1 } }, ['live_end']), true, '只滤下播，开播留着')
  assert.equal(dyn.keepDynamic({ ...item('7'), kind: 'live', live: { status: 0 } }, ['live_end']), false)
})

test('formatDynamic：视频 / 直播 / 图文各有各的说法', () => {
  assert.match(dyn.formatDynamic(item('1', '公告正文'), { name: '明日方舟' }), /【B站动态】明日方舟[\s\S]*公告正文[\s\S]*opus\/1/)
  assert.match(dyn.formatDynamic(item('2', '', { kind: 'video', title: '新 PV', bvid: 'BV1', url: 'https://www.bilibili.com/video/BV1' }), { name: 'A' }), /投稿了视频《新 PV》/)
  assert.match(dyn.formatDynamic(item('3', '', { kind: 'live', live: { status: 1, title: '版本前瞻' } }), { name: 'A' }), /开播了：版本前瞻/)
  assert.match(dyn.formatDynamic(item('4', '', { kind: 'live', live: { status: 0, title: '' } }), { name: 'A' }), /下播了/)
  assert.match(dyn.formatDynamic(item('5', '带图', { images: ['a', 'b'] }), { name: 'A' }), /配图 2 张/)
})

test('订阅：冷启动只记游标，之后只推新的', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent, events } = makeEngine({
    cfg: { bili: { enabled: true, subs: [{ mid: '161775300', name: '明日方舟' }], subGapSec: 0 } },
    feed: async () => items,
  })
  const first = await engine.poll({ force: true })
  assert.equal(first.pushed, 0, '刚订阅不补发历史')
  assert.equal(sent.length, 0)

  items = [item('102', '新公告'), item('100')]
  const second = await engine.poll({ force: true })
  assert.equal(second.pushed, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'private:10000001')
  assert.match(sent[0].text, /新公告/)
  assert.match(sent[0].text, /opus\/102/)
  assert.ok(events.some((e) => e.tags.includes('动态')), '推送要记成她的经历')
})

test('订阅：-352 和「静默空列表」都不推进游标，成功后清零', async () => {
  reset()
  let mode = 'ok'
  const { engine } = makeEngine({
    cfg: { bili: { enabled: true, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0 } },
    feed: async () => {
      if (mode === 'err') { const e = new Error('B 站返回 -352'); e.code = -352; throw e }
      if (mode === 'empty') return []
      return [item('100')]
    },
  })
  await engine.poll({ force: true })
  assert.equal(engine.list()[0].cursor, '100')

  mode = 'err'
  const failed = await engine.poll({ force: true })
  assert.equal(failed.failed, 1)
  assert.equal(engine.list()[0].fails, 1)
  assert.equal(engine.list()[0].cursor, '100', '失败绝不能动游标，否则新动态就漏了')

  mode = 'empty'
  await engine.poll({ force: true })
  assert.equal(engine.list()[0].fails, 2, '有游标时返回空列表算可疑，不算「没发」')
  assert.equal(engine.list()[0].cursor, '100')
  assert.match(engine.list()[0].lastError, /空列表/)

  mode = 'ok'
  const ok = await engine.poll({ force: true })
  assert.equal(ok.failed, 0)
  assert.equal(engine.list()[0].fails, 0, '成功一次就清零')
})

test('订阅：被过滤掉的也推进游标，不会反复冒出来', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent } = makeEngine({
    cfg: { bili: { enabled: true, subs: [{ mid: '161775300', name: 'A', filters: ['lottery'] }], subGapSec: 0 } },
    feed: async () => items,
  })
  await engine.poll({ force: true })
  items = [item('102', '正常公告'), { ...item('101', '抽奖啦'), lottery: true }, item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 1)
  assert.match(sent[0].text, /正常公告/)
  assert.equal(engine.list()[0].cursor, '102', '抽奖那条也要算看过')
})

test('订阅：一次最多推 subMaxPerPoll 条（推最新的几条）', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent } = makeEngine({
    cfg: { bili: { enabled: true, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0, subMaxPerPoll: 2 } },
    feed: async () => items,
  })
  await engine.poll({ force: true })
  items = [item('105', '第五条'), item('104', '第四条'), item('103', '第三条'), item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 2)
  assert.match(sent[0].text, /第四条/)
  assert.match(sent[1].text, /第五条/)
  assert.equal(engine.list()[0].cursor, '105')
})

test('订阅：试运行只记日志，不发消息', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent } = makeEngine({
    cfg: { dryRun: true, bili: { enabled: true, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0 } },
    feed: async () => items,
  })
  await engine.poll({ force: true })
  items = [item('101', '新公告'), item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 0)
  assert.equal(sent.length, 0)
})

test('订阅 / 取消订阅：认主页链接，写回配置，重复要拦住', async () => {
  reset()
  const { engine, state } = makeEngine({
    cfg: { bili: { enabled: true, subs: [] } },
    feed: async () => [item('100')],
  })
  const r = await engine.subscribe('https://space.bilibili.com/161775300/dynamic')
  assert.equal(r.ok, true)
  assert.equal(state.cfg.bili.subs.length, 1)
  assert.equal(state.cfg.bili.subs[0].mid, '161775300')
  assert.equal(state.cfg.bili.subs[0].name, '明日方舟')

  assert.equal((await engine.subscribe('161775300')).ok, false, '重复订阅要拦住')
  assert.equal((await engine.subscribe('不是UID')).ok, false)

  assert.equal(engine.unsubscribe('161775300').ok, true)
  assert.equal(state.cfg.bili.subs.length, 0)
  assert.equal(engine.unsubscribe('161775300').ok, false, '没订阅的取消要报错')
})

test('订阅：给一条动态的链接，反查作者订上', async () => {
  reset()
  const { engine, state } = makeEngine({
    cfg: { bili: { enabled: true, subs: [] } },
    feed: async () => [item('100')],
    extraApi: { dynamicAuthor: async (id) => ({ mid: '1955897084', name: '鸣潮' }) },
  })
  const r = await engine.subscribe('https://t.bilibili.com/3537117026191454')
  assert.equal(r.ok, true)
  assert.equal(state.cfg.bili.subs[0].mid, '1955897084')
  assert.equal(state.cfg.bili.subs[0].name, '鸣潮')
})

test('订阅：裸数字先当 UID 查（16 位 mid 也认），查不到再当动态 id 反查作者', async () => {
  reset()
  // ① 这串是真实 UID：card 查得到，就直接订
  const asMid = makeEngine({
    cfg: { bili: { enabled: true, subs: [] } },
    feed: async () => [item('100')],
    extraApi: { card: async (mid) => ({ mid, name: '嘟嘟脸恶作剧', face: '' }) },
  })
  const r1 = await asMid.engine.subscribe('3537117026191454')
  assert.equal(r1.ok, true)
  assert.equal(asMid.state.cfg.bili.subs[0].mid, '3537117026191454')
  assert.equal(asMid.state.cfg.bili.subs[0].name, '嘟嘟脸恶作剧')

  // ② 不是 UID（card 报错）：退回动态 id 反查作者
  reset()
  const asDyn = makeEngine({
    cfg: { bili: { enabled: true, subs: [] } },
    feed: async () => [item('100')],
    extraApi: {
      card: async () => { throw new Error('B 站返回 -404') },
      dynamicAuthor: async () => ({ mid: '1955897084', name: '鸣潮' }),
    },
  })
  const r2 = await asDyn.engine.subscribe('3537117026191454')
  assert.equal(r2.ok, true)
  assert.equal(asDyn.state.cfg.bili.subs[0].mid, '1955897084')

  // ③ 两边都查不到：说清楚
  reset()
  const neither = makeEngine({
    cfg: { bili: { enabled: true, subs: [] } },
    feed: async () => [item('100')],
    extraApi: {
      card: async () => { throw new Error('B 站返回 -404') },
      dynamicAuthor: async () => { throw new Error('B 站返回 -352') },
    },
  })
  const r3 = await neither.engine.subscribe('1234567890123456')
  assert.equal(r3.ok, false)
  assert.match(r3.message, /既查不到/)
  assert.equal(neither.state.cfg.bili.subs.length, 0)
})

test('订阅：反查作者被风控时，说清楚该怎么办，别乱写配置', async () => {
  reset()
  const { engine, state } = makeEngine({
    cfg: { bili: { enabled: true, subs: [] } },
    feed: async () => [item('100')],
    extraApi: { dynamicAuthor: async () => { throw new Error('B 站返回 -352') } },
  })
  const r = await engine.subscribe('https://t.bilibili.com/3537117026191454')
  assert.equal(r.ok, false)
  assert.match(r.message, /-352/)
  assert.match(r.message, /UID|名字/)
  assert.equal(state.cfg.bili.subs.length, 0, '没查出来就别写进配置')
})

test('订阅：说名字也能订上（取搜索结果第一条）', async () => {
  reset()
  const { engine, state } = makeEngine({
    cfg: { bili: { enabled: true, subs: [] } },
    feed: async () => [item('100')],
    extraApi: { searchUser: async (kw) => (kw === '鸣潮' ? [{ mid: '1955897084', name: '鸣潮', fans: 5000000 }] : []) },
  })
  const r = await engine.subscribe('鸣潮')
  assert.equal(r.ok, true)
  assert.equal(state.cfg.bili.subs[0].mid, '1955897084')
  const none = await engine.subscribe('查无此人')
  assert.equal(none.ok, false)
  assert.match(none.message, /没搜到/)
})

test('配置：订阅项去重、只留数字 UID、过滤词切成数组', () => {
  const c = normalize({ bili: { subs: [
    { mid: '161775300', name: ' 明日方舟 ', filters: 'lottery forward' },
    { mid: '161775300', name: '重复的' },
    { mid: 'abc' },
    { mid: 42 },
  ] } })
  assert.equal(c.bili.subs.length, 1)
  assert.equal(c.bili.subs[0].name, '明日方舟')
  assert.deepEqual(c.bili.subs[0].filters, ['lottery', 'forward'])
  assert.equal(c.bili.subIntervalMin, 15)
  assert.equal(c.bili.subForwardImages, true)
})

test('面板保存不会抹掉订阅（订阅只走「添加 / 取消」接口）', async () => {
  const { mergeFromPanel } = await import('../src/core/config.js')
  const cur = normalize({ bili: { subs: [{ mid: '161775300', name: '明日方舟' }] } })
  // 面板里那份草稿是加订阅之前的，保存时不能把新订阅覆盖掉
  const next = mergeFromPanel(cur, { bili: { subIntervalMin: 30, subs: [] } })
  assert.equal(next.bili.subIntervalMin, 30)
  assert.equal(next.bili.subs.length, 1, '草稿里的空数组不该生效')
  assert.equal(next.bili.subs[0].mid, '161775300')
})
