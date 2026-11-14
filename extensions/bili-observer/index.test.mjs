// B 站观察者扩展的纯逻辑测试：不联网、不碰 QQ、不启动定时器。
// vendored 的 bili/*.js 顶层会用 globalThis.aurabot.lib 取插件内部源码，
// 所以必须先 stub 好再动态 import。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod = null
let api = null
let dynamics = null
let judge = null
let examples = null
let seen = null
let report = null
let shots = null
let vision = null
let loginPause = null

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-observer-'))
  const base = new URL('../../src/', import.meta.url)
  const libs = {
    'core/store.js': await import(new URL('core/store.js', base)),
    'core/config.js': await import(new URL('core/config.js', base)),
    'core/llm.js': await import(new URL('core/llm.js', base)),
    'core/img.js': await import(new URL('core/img.js', base)),
    'core/net.js': await import(new URL('core/net.js', base)),
    'chat/reply.js': await import(new URL('chat/reply.js', base)),
    'tools/tools.js': await import(new URL('tools/tools.js', base)),
  }
  globalThis.aurabot = {
    lib: (key) => {
      if (!libs[key]) throw new Error(`没有 ${key} 这个内部文件`)
      return libs[key]
    },
  }
  const here = (name) => new URL(`./bili/${name}`, import.meta.url)
  api = await import(here('api.js'))
  dynamics = await import(here('dynamics.js'))
  judge = await import(here('judge.js'))
  examples = await import(here('examples.js'))
  seen = await import(here('seen.js'))
  report = await import(here('report.js'))
  shots = await import(here('shots.js'))
  vision = await import(here('vision.js'))
  loginPause = await import(here('login-pause.js'))
  mod = (await import('./index.mjs')).default
})

// ---------- 模块定义 ----------

test('模块定义：id / 名字 / 面板 / 没注册内置 tab', () => {
  assert.equal(mod.id, 'bili-observer')
  assert.equal(mod.name, 'B站观察者')
  assert.equal(mod.panel, 'panel.js')
  assert.equal(mod.tab, undefined, '走 hasUi 的扩展页，不占内置 tab')
  assert.equal(typeof mod.setup, 'function')
})

// ---------- 链接 / Cookie ----------

test('findVideoId：BV / av / b23 短链都能认出来', () => {
  assert.deepEqual(api.findVideoId('看这个 https://www.bilibili.com/video/BV1xx411c7mD 好看'), { bvid: 'BV1xx411c7mD' })
  assert.deepEqual(api.findVideoId('av12345'), { aid: '12345' })
  assert.deepEqual(api.findVideoId('https://b23.tv/abc123'), { short: 'https://b23.tv/abc123' })
  assert.equal(api.findVideoId('没有链接'), null)
})

test('parseCookie：只认 B 站要用的几个键', () => {
  const c = api.parseCookie('SESSDATA=abc; bili_jct=def; DedeUserID=42; other=zzz')
  assert.equal(c.SESSDATA, 'abc')
  assert.equal(c.bili_jct, 'def')
  assert.equal(c.DedeUserID, '42')
  assert.equal(c.other, undefined)
})

test('wbiSign：参数排序 + w_rid 稳定，wts 秒级', () => {
  const q = api.wbiSign({ b: 2, a: 1 }, 'img', 'sub', 1_700_000_000_000)
  assert.match(q, /^a=1&b=2&wts=1700000000&w_rid=[0-9a-f]{32}$/)
  assert.equal(q, api.wbiSign({ a: 1, b: 2 }, 'img', 'sub', 1_700_000_000_000), '参数顺序不影响')
})

// ---------- 动态 ----------

test('parseTarget：UID / 主页 / 动态链接 / 裸数字 / 名字', () => {
  assert.deepEqual(dynamics.parseTarget('https://space.bilibili.com/123456'), { mid: '123456' })
  assert.deepEqual(dynamics.parseTarget('https://t.bilibili.com/9876543210'), { dynId: '9876543210' })
  assert.deepEqual(dynamics.parseTarget('123456'), { ambiguous: '123456' })
  assert.deepEqual(dynamics.parseTarget('某个UP'), { name: '某个UP' })
  assert.deepEqual(dynamics.parseTarget(''), {})
  assert.equal(dynamics.findMid('space.bilibili.com/123456'), '123456')
})

test('resolveFilters / keepDynamic：类型词进 kinds，别的当正则', () => {
  const f = dynamics.resolveFilters('forward lottery 广告')
  assert.ok(f.kinds.has('forward'))
  assert.ok(f.kinds.has('lottery'))
  assert.equal(f.regex.length, 1)
  assert.equal(dynamics.keepDynamic({ kind: 'video', text: '' }, f), true)
  assert.equal(dynamics.keepDynamic({ forward: true }, f), false)
  assert.equal(dynamics.keepDynamic({ kind: 'word', text: '这是广告' }, f), false)
  assert.equal(dynamics.keepDynamic({ kind: 'live', live: { status: 0 } }, 'live_end'), false)
  assert.equal(dynamics.keepDynamic({ kind: 'live', live: { status: 1 } }, 'live_end'), true)
})

test('compareId：按 BigInt 比，不是字符串比', () => {
  assert.equal(dynamics.compareId('9', '10'), -1)
  assert.equal(dynamics.compareId('10', '9'), 1)
  assert.equal(dynamics.compareId('10', '10'), 0)
})

test('parseDynamic：摊平动态 JSON，认出类型 / 图 / 抽奖 / 链接', () => {
  const it = {
    id_str: '111',
    type: 'DYNAMIC_TYPE_DRAW',
    modules: {
      module_author: { name: 'UP', mid: 42, pub_ts: 100 },
      module_dynamic: {
        desc: { text: '正文 &amp; 内容' },
        major: { draw: { items: [{ src: 'https://i/1.jpg' }, { src: 'https://i/2.jpg' }] } },
        additional: { type: 'ADDITIONAL_TYPE_UPOWER_LOTTERY' },
      },
    },
  }
  const d = api.parseDynamic(it)
  assert.equal(d.id, '111')
  assert.equal(d.kind, 'draw')
  assert.equal(d.author, 'UP')
  assert.equal(d.mid, '42')
  assert.equal(d.pubTs, 100_000)
  assert.equal(d.text, '正文 & 内容')
  assert.deepEqual(d.images, ['https://i/1.jpg', 'https://i/2.jpg'])
  assert.equal(d.lottery, true)
  assert.equal(d.url, 'https://www.bilibili.com/opus/111')
})

test('formatDynamic：视频 / 直播 / 普通文字各说各的', () => {
  assert.match(dynamics.formatDynamic({ kind: 'video', title: '新视频', images: [], url: 'u' }, { name: 'UP' }), /投稿了视频《新视频》/)
  assert.match(dynamics.formatDynamic({ kind: 'live', live: { status: 1, title: '直播标题' }, images: [] }, { name: 'UP' }), /开播了：直播标题/)
  assert.match(dynamics.formatDynamic({ kind: 'live', live: { status: 0, title: '下播标题' }, images: [] }, { name: 'UP' }), /下播了：下播标题/)
  const plain = dynamics.formatDynamic({ kind: 'word', text: '一句话', images: [], url: '' }, { name: 'UP' })
  assert.match(plain, /^【B站动态】UP\n一句话$/)
})

// ---------- 判定 ----------

test('parseVerdicts：代码块 / {verdicts} 都能吃，越界条目丢掉', () => {
  const one = judge.parseVerdicts('```json\n[{"i":1,"keep":true,"level":3,"title":"新活动","points":["送十连"],"images":[1,1,2],"why":"有用"}]\n```', 1)
  assert.equal(one.length, 1)
  assert.equal(one[0].keep, true)
  assert.equal(one[0].level, 3)
  assert.equal(one[0].title, '新活动')
  assert.deepEqual(one[0].points, ['送十连'])
  assert.deepEqual(one[0].images, [1, 2], '重复的图号去掉')

  const wrapped = judge.parseVerdicts('好的，结果如下：{"verdicts":[{"i":2,"keep":false,"level":1,"why":"无关"}]}', 2)
  assert.equal(wrapped.length, 1)
  assert.equal(wrapped[0].i, 2)
  assert.equal(wrapped[0].keep, false)

  assert.deepEqual(judge.parseVerdicts('模型今天不想说话', 1), [])
  assert.deepEqual(judge.parseVerdicts('', 1), [])
  assert.deepEqual(judge.parseVerdicts('[{"i":9,"keep":true}]', 2), [], '超出题目数的条目丢掉')
})

test('parseVerdicts：没写 keep 就看 level，level 越界会被夹住', () => {
  const v = judge.parseVerdicts('[{"i":1,"level":3},{"i":2,"level":1},{"i":3,"level":99}]', 3)
  assert.equal(v[0].keep, true, '3 分默认值得说')
  assert.equal(v[1].keep, false, '1 分默认不值得说')
  assert.equal(v[2].level, 3, '99 夹到 3')
})

test('parseVerdicts：要点最多两条', () => {
  const v = judge.parseVerdicts('[{"i":1,"keep":true,"level":2,"points":["a","b","c","d"]}]', 1)[0]
  assert.equal(v.points.length, 2)
})

test('pickImages：模型指定图号就按图号，没有就全给', () => {
  const item = { images: ['a.jpg', 'b.jpg', 'c.jpg'] }
  assert.deepEqual(judge.pickImages(item, { images: [3, 1] }), ['a.jpg', 'c.jpg'])
  assert.deepEqual(judge.pickImages(item, { images: [9] }), ['a.jpg', 'b.jpg', 'c.jpg'], '越界就退回全部')
  assert.deepEqual(judge.pickImages(item, {}), ['a.jpg', 'b.jpg', 'c.jpg'])
})

test('formatSummary：标题 + 要点 + 图号；只有一张图不写图号', () => {
  const item = { text: '原始正文很长', images: ['a.jpg', 'b.jpg', 'c.jpg'], url: 'https://www.bilibili.com/opus/1' }
  const text = judge.formatSummary(item, { name: '测试发布' }, {
    title: '新活动：登录即送十连', points: ['送5次抽卡', '截止 130 抽'], images: [3], by: 'ai',
  })
  assert.match(text, /【B站动态】测试发布/)
  assert.match(text, /新活动：登录即送十连/)
  assert.match(text, /· 送5次抽卡/)
  assert.doesNotMatch(text, /图1/, '只有一张图不写图号')
  assert.doesNotMatch(text, /opus\/1/, '默认不带链接')

  const withLink = judge.formatSummary(item, {}, { title: 't', points: [], images: [1, 2] }, { link: true })
  assert.match(withLink, /图1 图2/)
  assert.match(withLink, /opus\/1/)
})

test('cleanExamples：去空白、丢空正文、默认 keep、裁到 5 条', () => {
  const list = examples.cleanExamples([
    { text: '  新活动，送十连  ', keep: true, why: '  官方福利 ' },
    { text: '   ', keep: false },
    { text: '角色生日祝福', keep: false },
    { text: 'x'.repeat(300) },
    { text: '第四条' },
    { text: '第五条' },
    { text: '第六条要被截掉' },
  ])
  assert.equal(list.length, 5)
  assert.deepEqual(list[0], { text: '新活动，送十连', keep: true, why: '官方福利' })
  assert.equal(list[1].keep, false)
  assert.equal(list[2].text.length, examples.EXAMPLE_TEXT_MAX + 1, '超长加省略号')
  assert.equal(list[3].keep, true, '没写 keep 就是要推')
  assert.deepEqual(examples.cleanExamples('不是数组'), [])
})

test('exampleLines：拼成提示词里的几行，没有例子就不占位', () => {
  assert.deepEqual(examples.exampleLines([]), [])
  const lines = examples.exampleLines([{ text: '福利', keep: true, why: '主人关心' }, { text: '抽奖', keep: false }])
  assert.equal(lines[0], '- 推：福利 —— 主人关心')
  assert.equal(lines[1], '- 不推：抽奖')
})

// ---------- 判重表 ----------

const bv = (n) => `BV${String(n).padStart(10, '0')}`

test('normalizeSeen：丢没 bvid 的、按 bvid 去重、档位兜底', () => {
  const state = seen.normalizeSeen({ items: [
    { bvid: bv(1), title: 'a', tier: 'worth' },
    { bvid: 'nope' },
    { bvid: bv(1), title: '重复' },
    { bvid: bv(2), tier: '怪档位' },
  ] })
  assert.equal(state.version, 1)
  assert.equal(state.items.length, 2)
  assert.equal(state.items[0].title, 'a', '留最前面那条')
  assert.equal(state.items[1].tier, 'ok', '不认识的档位落到 ok')
  assert.equal(state.items[1].status, 'seen')
})

test('pushSeen / markSeen / seenSet：新的在前，状态只升不降', () => {
  let state = seen.pushSeen({ items: [] }, { bvid: bv(1), title: '第一条', tier: 'ok' })
  state = seen.pushSeen(state, { bvid: bv(2), title: '第二条', tier: 'worth' })
  assert.deepEqual(state.items.map((x) => x.bvid), [bv(2), bv(1)])
  state = seen.pushSeen(state, { bvid: bv(1), title: '第一条改名', tier: 'worth' })
  assert.deepEqual(state.items.map((x) => x.bvid), [bv(1), bv(2)], '同 bvid 挪到最前')
  assert.equal(state.items[0].title, '第一条改名')

  state = seen.markSeen(state, bv(2), 'liked')
  assert.equal(state.items[1].status, 'liked')
  state = seen.markSeen(state, bv(2), 'seen')
  assert.equal(state.items[1].status, 'liked', '只升不降')
  state = seen.markSeen(state, bv(2), 'faved')
  assert.equal(state.items[1].status, 'faved')

  assert.deepEqual([...seen.seenSet(state)].sort(), [bv(1), bv(2)])
})

test('pushSeen：超过上限裁尾', () => {
  let state = { items: [] }
  for (let i = 1; i <= 5; i++) state = seen.pushSeen(state, { bvid: bv(i) }, { limit: 3 })
  assert.deepEqual(state.items.map((x) => x.bvid), [bv(5), bv(4), bv(3)])
})

test('migrateSeen：老 bili.json 里的 bvid 数组能迁移', () => {
  const state = seen.migrateSeen([bv(1), 'bad', bv(2)], { now: 1000 })
  assert.deepEqual(state.items.map((x) => x.bvid), [bv(1), bv(2)])
  assert.equal(state.items[0].at, 1000)
  assert.equal(state.items[0].tier, 'ok')
})

test('loadSeen / saveSeen：可注入读写函数，落盘前也归一化', () => {
  let wrote = null
  const saved = seen.saveSeen({ items: [{ bvid: bv(1) }, { bvid: 'x' }] }, { file: 'x.json', write: (f, v) => { wrote = { f, v } } })
  assert.equal(wrote.f, 'x.json')
  assert.equal(wrote.v.items.length, 1)
  assert.equal(saved.items.length, 1)
  const loaded = seen.loadSeen({ file: 'x.json', read: () => ({ items: [{ bvid: bv(2) }] }) })
  assert.equal(loaded.items[0].bvid, bv(2))
})

// ---------- 弹幕 ----------

test('decodeEntities / parseDanmakuXml：HTML 实体还原，不认识的原样留着', () => {
  assert.equal(api.decodeEntities('&amp;你好&#20320;&#x597D;&lt;3&nbsp;b'), '&你好你好<3 b')
  assert.equal(api.decodeEntities('&unknown;'), '&unknown;')
  assert.equal(api.decodeEntities('&#x110000;'), '&#x110000;', '越界码点不硬转')
  const xml = '<?xml version="1.0"?><i><d p="1,1,25,0,0,0,x,1">前排放着</d><d p="2,1,25,0,0,0,x,1">a&amp;b</d></i>'
  assert.deepEqual(api.parseDanmakuXml(Buffer.from(xml)), ['前排放着', 'a&b'])
})

test('pickDanmaku：太长太短、纯符号、重复都筛掉，按时间顺序均匀取', () => {
  const raw = [
    '啊', '前排放着', '233333', '纯符号！！！', '前排放着',
    '这是一条特别特别特别特别特别特别特别特别特别特别长的弹幕超过三十个字应该被丢掉',
    ...Array.from({ length: 100 }, (_, i) => `第${i}条弹幕`),
  ]
  const picked = api.pickDanmaku(raw, 10)
  assert.equal(picked.length, 10)
  assert.equal(picked.includes('啊'), false, '太短')
  assert.equal(picked.includes('233333'), false, '纯数字')
  assert.equal(picked.includes('纯符号！！！'), false, '纯符号')
  assert.equal(new Set(picked).size, 10, '去重')
  assert.equal(picked[0], '前排放着')
  assert.equal(picked.includes('第99条弹幕'), false, '不是截前 10 条')
  assert.deepEqual(api.pickDanmaku(['a', 'bb'], 30), ['bb'])
  assert.equal(api.pickDanmaku([], 30).length, 0)
})

// ---------- 日报 ----------

test('dateKey / monthKey / shortDate 补零', () => {
  const d = new Date(2026, 0, 5)
  assert.equal(report.dateKey(d), '2026-01-05')
  assert.equal(report.monthKey(d), '2026-01')
  assert.equal(report.shortDate(d), '01-05')
})

test('formatPlay：过万显示 x.x 万', () => {
  assert.equal(report.formatPlay(9999), '9999')
  assert.equal(report.formatPlay(12345), '1.2 万')
  assert.equal(report.formatPlay(100000), '10 万')
  assert.equal(report.formatPlay(null), '0')
})

test('renderEntry / parseReport：日报条目能写能读', () => {
  const md = report.renderEntry({ bvid: bv(1), title: '标题', up: 'UP', play: 12345, tier: 'worth', why: '理由', feeling: '感想' })
  assert.match(md, /^### BV0000000001/)
  assert.match(md, /标题 \/ UP \/ 播放 1\.2 万/)
  assert.match(md, /\*\*档位\*\*：值得看/)
  const parsed = report.parseReport(md)
  assert.deepEqual(parsed, [{ bvid: bv(1), title: '标题', tier: 'worth' }])
})

test('appendReportMarkdown：追加不清旧内容，无字幕计数累加', () => {
  const first = report.appendReportMarkdown('', [{ bvid: bv(1), title: 'a', tier: 'ok' }], { noSubtitle: 2 })
  assert.match(first, /因无字幕跳过 2 条/)
  const second = report.appendReportMarkdown(first, [{ bvid: bv(2), title: 'b', tier: 'worth' }], { noSubtitle: 1 })
  assert.equal(report.countPicked(second), 2)
  assert.equal(report.lastNoSubtitle(second), 3)
  assert.equal(report.countPicked(first), 1, '旧内容还在')
})

test('stripNoSubtitle / digestMessage：摘要口吻和计数', () => {
  assert.equal(report.stripNoSubtitle('a\n\n\n因无字幕跳过 3 条\n'), 'a')
  const worth = report.digestMessage({ items: [{ title: 'a', bvid: bv(1), tier: 'worth' }, { bvid: bv(2), tier: 'ok' }], skipped: 2, noSubtitle: 1 })
  assert.match(worth, /今天刷了 2 条，1 条值得看/)
  assert.match(worth, /跳过 2 条/)
  assert.match(worth, /可以看 1 条/)
  assert.match(worth, /因无字幕跳过 1 条/)
  assert.match(report.digestMessage({ items: [] }), /没有特别值得看的/)
})

// ---------- 截图 ----------

test('clockOf / pickShot：mm:ss 和关键词挑选', () => {
  assert.equal(shots.clockOf(0), '0:00')
  assert.equal(shots.clockOf(75), '1:15')
  assert.equal(shots.clockOf(null), '0:00')

  const items = [
    { title: '原神版本前瞻', note: '抽卡' },
    { title: '星穹铁道', note: '剧情' },
  ]
  assert.equal(shots.pickShot(items, ''), items[0], '不填就最近一张')
  assert.equal(shots.pickShot(items, '星穹'), items[1])
  assert.equal(shots.pickShot(items, '完全不相关'), null)
  assert.equal(shots.pickShot([], 'x'), null)
})

// ---------- 画面 ----------

test('frameTimes：跳过首尾 5%，去重，最多 12 帧', () => {
  assert.deepEqual(vision.frameTimes(0, 6), [])
  assert.deepEqual(vision.frameTimes(100, 1), [50], '一帧就取中间')
  const many = vision.frameTimes(10, 30)
  assert.ok(many.length <= 10, '10 秒最多 10 个不同的整秒')
  assert.ok(many[0] >= 0)
  assert.equal(vision.frameTimes(100, 6).length, 6)
})

test('pickVideoStream：优先 H.264、短边 >= 480、带宽最低', () => {
  assert.equal(vision.pickVideoStream([]), null)
  const picked = vision.pickVideoStream([
    { baseUrl: 'a', codecs: 'hev1', width: 1920, height: 1080, bandwidth: 100 },
    { baseUrl: 'b', codecs: 'avc1', width: 1280, height: 720, bandwidth: 300 },
    { baseUrl: 'c', codecs: 'avc1', width: 640, height: 360, bandwidth: 50 },
    { baseUrl: 'd', codecs: 'avc1', width: 1920, height: 1080, bandwidth: 900 },
  ])
  assert.equal(picked.baseUrl, 'b', 'avc 里短边够 480 的取带宽最低')
})

test('progressiveWindows / windowAt：durl 分段定位', () => {
  const w = vision.progressiveWindows([{ url: 'a', length: 1000 }, { url: 'b', length: 2000 }, { url: 'c' }])
  assert.equal(w.length, 3)
  assert.deepEqual(w[0], { url: 'a', startMs: 0, endMs: 1000 })
  assert.equal(vision.windowAt(w, 0.5).url, 'a')
  assert.equal(vision.windowAt(w, 1.5).url, 'b')
  assert.equal(vision.windowAt(w, 99).url, 'c')
  assert.equal(vision.windowAt([], 1), null)
})

test('hasProxy / withoutProxy：只摘代理相关的环境变量', () => {
  const env = { HTTPS_PROXY: 'http://p', NO_PROXY: 'localhost', PATH: '/bin' }
  assert.equal(vision.hasProxy(env), true)
  assert.equal(vision.hasProxy({ PATH: '/bin' }), false)
  assert.deepEqual(vision.withoutProxy(env), { PATH: '/bin' })
})

test('sniffImageType：按文件头认 png / jpeg / gif / webp', () => {
  assert.equal(api.sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'image/png')
  assert.equal(api.sniffImageType(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg')
  assert.equal(api.sniffImageType(Buffer.from('GIF89a')), 'image/gif')
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  assert.equal(api.sniffImageType(webp), 'image/webp')
  assert.equal(api.sniffImageType(Buffer.from('nope')), '')
})

// ---------- 登录暂停 ----------

test('loginSessionKey：两个凭证都在才有 key，换一个就是新 key', () => {
  assert.equal(loginPause.loginSessionKey('SESSDATA=a'), '')
  assert.equal(loginPause.loginSessionKey('bili_jct=b'), '')
  const k1 = loginPause.loginSessionKey('SESSDATA=a; bili_jct=b')
  assert.equal(k1.length, 64)
  assert.equal(loginPause.loginSessionKey('bili_jct=b; SESSDATA=a'), k1, '顺序无关')
  assert.notEqual(loginPause.loginSessionKey('SESSDATA=a2; bili_jct=b'), k1)
})

test('recoverLoginPause：只恢复登录失败造成的暂停，同一凭证不重复恢复', () => {
  const reason = 'B 站没登录或 Cookie 过期了'
  const state = { pauseDay: '2026-01-05', pauseReason: reason }
  assert.equal(loginPause.recoverLoginPause(state, { isLogin: false, sessionKey: 'k', day: '2026-01-05' }), false, '没登录不恢复')
  assert.equal(loginPause.recoverLoginPause({ pauseDay: '2026-01-05', pauseReason: '别的原因' }, { isLogin: true, sessionKey: 'k', day: '2026-01-05' }), false, '不是登录暂停')
  assert.equal(loginPause.recoverLoginPause({ pauseDay: '2026-01-04', pauseReason: reason }, { isLogin: true, sessionKey: 'k', day: '2026-01-05' }), false, '不是今天暂停的')
  assert.equal(loginPause.recoverLoginPause(state, { isLogin: true, sessionKey: 'k', day: '2026-01-05' }), true)
  assert.equal(state.pauseDay, undefined)
  assert.equal(state.pauseReason, undefined)
  assert.equal(state.loginPauseRecovery.sessionKey, 'k')
  const again = { pauseDay: '2026-01-05', pauseReason: reason, loginPauseRecovery: { sessionKey: 'k' } }
  assert.equal(loginPause.recoverLoginPause(again, { isLogin: true, sessionKey: 'k', day: '2026-01-05' }), false, '同一凭证只恢复一次')
})
