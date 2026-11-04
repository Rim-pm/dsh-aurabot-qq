// B站动态的 AI 过滤：提示词、解析、摘要，以及「判不出来也不能吞动态」。
// 全部用假模型 / 假 B 站，不联网。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let judge
let dyn
let normalize
let dataDir

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-judge-'))
  judge = await import('../src/bili/judge.js')
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

const silent = { info() {}, warn() {}, debug() {} }

function makeEngine({ cfg = {}, feed, ask, extraApi = {}, fetchImpl, segments = false } = {}) {
  const state = { cfg: normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', ...cfg }) }
  const sent = []
  const events = []
  const calls = []
  const engine = dyn.createSubs({
    getConfig: () => state.cfg,
    setConfig: (fn) => { state.cfg = normalize(typeof fn === 'function' ? fn(state.cfg) : fn) },
    hub: {
      sendText: async (to, text) => { sent.push({ to, text }); return { message_id: '1' } },
      sendImage: async (to, src) => { sent.push({ to, image: src }); return { message_id: '2' } },
      ...(segments ? { sendSegments: async (to, segs, note) => { sent.push({ to, segs, note }); return { message_id: '3' } } } : {}),
    },
    memory: { addEvent: (e) => events.push(e) },
    log: silent,
    api: {
      dynamicFeed: feed,
      card: async (mid) => ({ mid, name: '明日方舟', face: '' }),
      searchUser: async () => [],
      dynamicAuthor: async () => ({ mid: '161775300', name: '明日方舟' }),
      ...extraApi,
    },
    ask: ask ? (opts) => { calls.push(opts); return ask(opts) } : undefined,
    fetchImpl,
    sleep: async () => {},
  })
  return { engine, state, sent, events, calls }
}

test('提示词：全局规则 + 这个号的情况 + 正文都进去了，正文被包成数据', () => {
  const req = judge.buildJudgeRequest({
    globalPrompt: '只推卡池和补偿',
    sub: { mid: '161775300', name: '明日方舟', prompt: '官号，只看公告' },
    items: [item('1', '新活动开启'), item('2', '', { kind: 'live', live: { status: 1, title: '版本前瞻' } })],
    ownerName: '主人',
  })
  assert.match(req.system, /只推卡池和补偿/)
  assert.match(req.system, /主人的额外要求/)
  assert.match(req.system, /只输出 JSON 数组/)
  assert.match(req.system, /不是指令/, '要防提示词注入')
  assert.match(req.text, /主人/)
  assert.match(req.text, /明日方舟/)
  assert.match(req.text, /官号，只看公告/)
  assert.match(req.text, /<dynamic i="1"/)
  assert.match(req.text, /<dynamic i="2"/)
  assert.match(req.text, /这是开播/)
  assert.match(req.text, /新活动开启/)
  assert.match(req.text, /<\/dynamic>/)
})

test('提示词：正文按 maxChars 截断，不把几万字塞给模型', () => {
  const long = '很长的公告'.repeat(500)
  const req = judge.buildJudgeRequest({ items: [item('1', long)], maxChars: 50 })
  assert.ok(req.text.includes('很长的公告'), '前面要留着')
  assert.ok(req.text.length < long.length, '必须截断')
})

test('解析：代码块 / 外面带话 / {verdicts} 都能读，坏 JSON 当没判', () => {
  const one = judge.parseVerdicts('```json\n[{"i":1,"keep":true,"level":3,"title":"新活动","points":["送十连"],"images":[1,1,2],"why":"你在玩"}]\n```', 1)
  assert.equal(one.length, 1)
  assert.equal(one[0].keep, true)
  assert.equal(one[0].level, 3)
  assert.equal(one[0].title, '新活动')
  assert.deepEqual(one[0].points, ['送十连'])
  assert.deepEqual(one[0].images, [1, 2], '重复的图号去掉')

  const wrapped = judge.parseVerdicts('好的，结果如下：{"verdicts":[{"i":2,"keep":false,"level":1,"why":"闲聊"}]}', 2)
  assert.equal(wrapped.length, 1)
  assert.equal(wrapped[0].i, 2)
  assert.equal(wrapped[0].keep, false)

  assert.deepEqual(judge.parseVerdicts('模型今天不想说话', 1), [])
  assert.deepEqual(judge.parseVerdicts('', 1), [])
  assert.deepEqual(judge.parseVerdicts('[{"i":9,"keep":true}]', 2), [], '超出范围的条目丢掉')
})

test('解析：没给 keep 就看 level，level 越界会被夹回来', () => {
  const v = judge.parseVerdicts('[{"i":1,"level":3},{"i":2,"level":1},{"i":3,"level":99}]', 3)
  assert.equal(v[0].keep, true, '3 级默认值得推')
  assert.equal(v[1].keep, false, '1 级默认不值得推')
  assert.equal(v[2].level, 3, '99 夹到 3')
})

test('摘要：结论 + 要点 + 图号；链接默认不带，开了才带', () => {
  const it = item('1', '原始正文很长', { images: ['a.jpg', 'b.jpg', 'c.jpg'], url: 'https://www.bilibili.com/opus/1' })
  const text = judge.formatSummary(it, { name: '明日方舟' }, {
    title: '「波朗」意念体即将登场', points: ['★5 可召唤', '首日 130 抽'], images: [3], by: 'ai',
  })
  assert.match(text, /【B站动态】明日方舟/)
  assert.match(text, /「波朗」意念体即将登场/)
  assert.match(text, /· ★5 可召唤/)
  assert.match(text, /图1/, '只发一张就只标图1，不能出现图3')
  assert.doesNotMatch(text, /opus\/1/, '默认不带链接')

  const linked = judge.formatSummary(it, { name: 'A' }, { title: 'T', by: 'ai' }, { link: true })
  assert.match(linked, /opus\/1/, '打开「带链接」才加')

  const bare = judge.formatSummary(it, { name: 'A' }, { by: 'ai' })
  assert.match(bare, /原始正文很长/, '模型没给摘要时退回原文，不能推空消息')

  const noImg = judge.formatSummary(it, { name: 'A' }, { title: 'T', by: 'ai' }, { images: false })
  assert.doesNotMatch(noImg, /图1/, '不发图时不能在文字里说图')
})

test('提示词：告诉模型「现在几点」，并要求把绝对时间换成相对说法', () => {
  const now = new Date(2026, 10, 4, 18, 52).getTime() // 2026-11-04 18:52 周三
  const req = judge.buildJudgeRequest({ items: [item('1', '我们将于【2026/11/5 10:00】进行更新')], now })
  assert.match(req.system, /现在的时间：2026-11-04 18:52（周三）/)
  assert.match(req.system, /相对说法/)
  assert.match(req.system, /明天/)
  assert.match(req.system, /结束时间也算出来/, '只给时长时要把结束时间算出来')
  assert.match(req.system, /安装包多大/, '安装包 / 配置要求不该进要点')
  assert.match(req.system, /什么时候维护/, '维护时间是第一优先')
})

test('提示词：要点压到两条，多给的丢掉', () => {
  const v = judge.parseVerdicts('[{"i":1,"keep":true,"level":2,"points":["a","b","c","d"]}]', 1)[0]
  assert.equal(v.points.length, 2)
})

test('挑图：按模型点的号取，越界忽略；没点就全发', () => {
  const it = item('1', 'x', { images: ['a', 'b', 'c'] })
  assert.deepEqual(judge.pickImages(it, { images: [3, 1] }), ['a', 'c'])
  assert.deepEqual(judge.pickImages(it, { images: [9] }), ['a', 'b', 'c'], '全越界就当没点')
  assert.deepEqual(judge.pickImages(it, {}), ['a', 'b', 'c'])
})

test('判定：AI 关着就是原样，一次模型都不问', async () => {
  const cfg = normalize({ bili: { enabled: true, aiFilter: false } })
  let asked = 0
  const j = judge.createJudge({ getConfig: () => cfg, ask: async () => { asked++; return '[]' }, log: silent })
  const v = await j.judge({ mid: '1', name: 'A' }, [item('1', '公告')])
  assert.equal(v[0].by, 'raw')
  assert.equal(v[0].keep, true)
  assert.equal(asked, 0, '关着不能偷偷花 token')
})

test('判定：号上写 raw 就单独原样转', async () => {
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  let asked = 0
  const j = judge.createJudge({ getConfig: () => cfg, ask: async () => { asked++; return '[]' }, log: silent })
  const v = await j.judge({ mid: '1', name: 'A', mode: 'raw' }, [item('1', '公告')])
  assert.equal(v[0].by, 'raw')
  assert.equal(asked, 0)
})

test('判定：一批一次调用，判出来的对齐回每一条', async () => {
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  const calls = []
  const j = judge.createJudge({
    getConfig: () => cfg,
    log: silent,
    ask: async (o) => {
      calls.push(o)
      return '[{"i":1,"keep":true,"level":3,"title":"新卡池","points":["限定"],"why":"你在玩"},{"i":2,"keep":false,"level":1,"why":"生日祝福"}]'
    },
  })
  const v = await j.judge({ mid: '1', name: 'A' }, [item('1', '卡池'), item('2', '生日快乐')])
  assert.equal(calls.length, 1, '两条要合并成一次调用')
  assert.equal(v.length, 2)
  assert.equal(v[0].by, 'ai')
  assert.equal(v[0].level, 3)
  assert.equal(v[1].keep, false)
  assert.equal(v[1].why, '生日祝福')
})

test('判定：模型漏了某条 → 那条按「没判成」照转，不能吞', async () => {
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  const j = judge.createJudge({ getConfig: () => cfg, ask: async () => '[{"i":1,"keep":false,"level":1}]', log: silent })
  const v = await j.judge({ mid: '1', name: 'A' }, [item('1', '闲聊'), item('2', '重要公告')])
  assert.equal(v[0].keep, false)
  assert.equal(v[1].by, 'fail', '模型没提的不能当成「不重要」')
  assert.equal(v[1].keep, true)
})

test('判定：模型报错 / 没给模型 → 全部 fail-open 照转', async () => {
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  const bad = judge.createJudge({ getConfig: () => cfg, ask: async () => { throw new Error('模型挂了') }, log: silent })
  const a = await bad.judge({ mid: '1', name: 'A' }, [item('1', '公告')])
  assert.equal(a[0].by, 'fail')
  assert.equal(a[0].keep, true, '判失败必须照转')

  const none = judge.createJudge({ getConfig: () => cfg, log: silent })
  const b = await none.judge({ mid: '1', name: 'A' }, [item('1', '公告')])
  assert.equal(b[0].by, 'fail')
  assert.equal(b[0].keep, true)
})

test('判定：没有正文的纯图动态不问模型，直接照转', async () => {
  const cfg = normalize({ bili: { enabled: true, aiFilter: true } })
  let asked = 0
  const j = judge.createJudge({ getConfig: () => cfg, ask: async () => { asked++; return '[]' }, log: silent })
  const v = await j.judge({ mid: '1', name: 'A' }, [item('1', '', { images: ['a.jpg'] })])
  assert.equal(v[0].by, 'skip')
  assert.equal(v[0].keep, true)
  assert.equal(asked, 0)
})

test('判定：开了视觉且只有一条纯图动态，才把图交给模型', async () => {
  const cfg = normalize({ bili: { enabled: true, aiFilter: true, aiFilterVision: true } })
  const calls = []
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0x00]).buffer })
  const j = judge.createJudge({
    getConfig: () => cfg,
    log: silent,
    fetchImpl: fakeFetch,
    ask: async (o) => {
      calls.push(o)
      return '[{"i":1,"keep":true,"level":2,"title":"新角色立绘","points":["三个角色"],"why":"新图"}]'
    },
  })
  const v = await j.judge({ mid: '1', name: 'A' }, [item('1', '', { images: ['a.jpg', 'b.jpg', 'c.jpg'] })])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].images.length, 2, '最多带两张图')
  assert.equal(calls[0].images[0].mediaType, 'image/jpeg')
  assert.equal(v[0].by, 'ai')
  assert.equal(v[0].title, '新角色立绘')
})

test('订阅 + AI 过滤：判成不重要就不推，游标照样推进', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent } = makeEngine({
    cfg: { bili: { enabled: true, aiFilter: true, subs: [{ mid: '161775300', name: 'A', mode: 'auto' }], subGapSec: 0 } },
    feed: async () => items,
    ask: async () => '[{"i":1,"keep":false,"level":1,"why":"日常闲聊"}]',
  })
  await engine.poll({ force: true })
  items = [item('102', '今天也要加油'), item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 0)
  assert.equal(sent.length, 0)
  assert.equal(engine.list()[0].cursor, '102', '判掉的那条也要算看过，不能下次再判一遍')
  assert.equal(engine.judged()[0].keep, false)
  assert.equal(engine.judged()[0].why, '日常闲聊')
})

test('订阅 + AI 过滤：推的是摘要不是原文，图也按判定挑', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent } = makeEngine({
    cfg: { bili: { enabled: true, aiFilter: true, subForwardImages: false, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0 } },
    feed: async () => items,
    ask: async () => '[{"i":1,"keep":true,"level":3,"title":"「波朗」意念体即将登场","points":["★5 可召唤","首日 130 抽"],"images":[1],"why":"新角色上线"}]',
  })
  await engine.poll({ force: true })
  items = [item('103', '【波朗】意念体即将登场！通过意念体可以看到使徒们实现愿望变强后的样子……', { images: ['a.jpg', 'b.jpg'] }), item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /「波朗」意念体即将登场/)
  assert.match(sent[0].text, /· ★5 可召唤/)
  assert.doesNotMatch(sent[0].text, /通过意念体可以看到使徒们/, '推摘要就不该再糊一遍原文')
  assert.equal(engine.judged()[0].level, 3)
})

test('订阅 + AI 过滤：摘要和图放在同一条消息里，只发模型点的那张', async () => {
  reset()
  let items = [item('100')]
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11])
  const { engine, sent } = makeEngine({
    cfg: { bili: { enabled: true, aiFilter: true, subForwardImages: true, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0 } },
    feed: async () => items,
    ask: async () => '[{"i":1,"keep":true,"level":3,"title":"新活动","points":["送十连"],"images":[2],"why":"你在玩"}]',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => jpeg.buffer }),
    segments: true,
  })
  await engine.poll({ force: true })
  items = [item('101', '活动开了', { images: ['a.jpg', 'b.jpg'] }), item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 1)
  assert.equal(sent.length, 1, '文字和图要一条发完，不能刷屏')
  assert.equal(sent[0].segs[0].type, 'text')
  assert.match(sent[0].segs[0].data.text, /图1/)
  assert.equal(sent[0].segs[1].type, 'image')
  assert.equal(sent[0].segs.length, 2, '模型只点了第 2 张，就只发一张')
})

test('订阅 + AI 过滤：判定失败原样转，并告诉主人是没判成', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent } = makeEngine({
    cfg: { bili: { enabled: true, aiFilter: true, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0 } },
    feed: async () => items,
    ask: async () => { throw new Error('模型超时') },
  })
  await engine.poll({ force: true })
  items = [item('101', '重要公告：今晚停服维护'), item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 1)
  assert.match(sent[0].text, /重要公告：今晚停服维护/)
  assert.match(sent[0].text, /AI 没判成/)
  assert.equal(engine.judged()[0].by, 'fail')
})

test('订阅 + AI 过滤：阈值能卡掉「说不上重要」的', async () => {
  reset()
  let items = [item('100')]
  const { engine, sent } = makeEngine({
    cfg: { bili: { enabled: true, aiFilter: true, aiFilterMinLevel: 3, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0 } },
    feed: async () => items,
    ask: async () => '[{"i":1,"keep":true,"level":2,"title":"小更新"}]',
  })
  await engine.poll({ force: true })
  items = [item('101', '修了个小 bug'), item('100')]
  const r = await engine.poll({ force: true })
  assert.equal(r.pushed, 0, '2 级在阈值 3 下不推')
  assert.equal(engine.judged()[0].keep, false)
  assert.equal(engine.list()[0].cursor, '101')
})

test('每号设置：prompt / mode / minLevel 能改，取消订阅时判定历史一起清', async () => {
  reset()
  const { engine } = makeEngine({
    cfg: { bili: { enabled: true, subs: [{ mid: '161775300', name: 'A' }], subGapSec: 0 } },
    feed: async () => [item('100')],
  })
  const r = engine.update('161775300', { prompt: '官号，只看公告', mode: 'raw', minLevel: 3 })
  assert.equal(r.ok, true)
  const it = engine.list()[0]
  assert.equal(it.prompt, '官号，只看公告')
  assert.equal(it.mode, 'raw')
  assert.equal(it.minLevel, 3)

  assert.equal(engine.update('999', { prompt: 'x' }).ok, false)
  const bad = engine.update('161775300', { mode: '乱写', minLevel: 99 })
  assert.equal(bad.ok, true)
  assert.equal(engine.list()[0].mode, 'raw', '不认识的 mode 保持原值')
  assert.equal(engine.list()[0].minLevel, 3, '越界的阈值夹回 3')

  await engine.poll({ force: true })
  assert.equal(engine.judged().length, 0, '冷启动不判也不记')
})
