// B 站：签名、Cookie / 链接 / 分享卡片解析、刷一轮（分享、记忆）、看你发来的视频。用假的 B 站和假的模型测。
import './helpers/bili-lib.js'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let api
let duty
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-'))
  api = await import('../extensions/bili-observer/bili/api.js')
  duty = await import('../extensions/bili-observer/bili/duty.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

test('WBI 签名和文档里的例子一致', () => {
  const q = api.wbiSign({ foo: '114', bar: '514', zab: 1919810 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169 * 1000)
  assert.equal(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
})

test('playurl：WBI 签名一次要全格式，DASH 和 durl 都带出来', async () => {
  let request
  const client = api.createBiliApi({ getCookie: () => 'buvid3=test', fetchImpl: async (url) => {
    if (url.includes('/nav')) return { json: async () => ({ data: { wbi_img: {
      img_url: 'https://i.example/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png',
    } } }) }
    request = new URL(url)
    return { json: async () => ({ code: 0, data: {
      dash: {
        video: [{ base_url: 'https://cdn.example/1', codecs: 'avc1', height: 480 }, { baseUrl: 'https://cdn.example/2' }, {}],
        audio: [{ baseUrl: 'https://cdn.example/audio' }],
      },
      durl: [{ order: 1, url: 'https://cdn.example/p1.mp4', length: 60000, size: 123 }, { order: 2, url: '' }],
    } }) }
  } })
  const r = await client.playurl({ bvid: 'BV1aaaaaaaaa', cid: 9 })
  assert.equal(request.pathname, '/x/player/wbi/playurl')
  assert.equal(request.searchParams.get('fnval'), '4048', '要全格式，不然拿不到 DASH')
  assert.equal(request.searchParams.get('fourk'), '1')
  assert.equal(request.searchParams.get('cid'), '9')
  assert.equal(request.searchParams.get('bvid'), 'BV1aaaaaaaaa')
  assert.match(request.searchParams.get('w_rid'), /^[a-f0-9]{32}$/)
  assert.equal(r.video.length, 2)
  assert.equal(r.video[0].baseUrl, 'https://cdn.example/1')
  assert.equal(r.audio.length, 1)
  assert.deepEqual(r.durl, [{ order: 1, url: 'https://cdn.example/p1.mp4', length: 60000, size: 123 }], 'durl 作为没有 DASH 时的回退，空地址过滤掉')
})

test('解析：Cookie 只取有用的、认出视频号和短链、QQ 分享卡片', async () => {
  assert.deepEqual(api.parseCookie('SESSDATA=abc; bili_jct=x1; foo=bar; buvid3=b3'), { SESSDATA: 'abc', bili_jct: 'x1', buvid3: 'b3' })
  assert.deepEqual(api.findVideoId('看这个 https://www.bilibili.com/video/BV1GJ411x7h7/?p=1'), { bvid: 'BV1GJ411x7h7' })
  assert.deepEqual(api.findVideoId('av170001'), { aid: '170001' })
  assert.deepEqual(api.findVideoId('https://b23.tv/abc123 哈哈'), { short: 'https://b23.tv/abc123' })
  assert.equal(api.findVideoId('没有链接'), null)
  const { cardText } = await import('../src/chat/inbound.js')
  const card = JSON.stringify({ meta: { detail_1: { title: '哔哩哔哩', desc: '猫猫做饭', qqdocurl: 'https://b23.tv/xyz?share=1' } } })
  assert.equal(cardText(card), '[分享卡片（哔哩哔哩）：猫猫做饭 https://b23.tv/xyz]')
  assert.equal(cardText('不是 json'), '[卡片消息]')
})

test('过滤：播放量、发布时间、看过的', () => {
  const now = Date.now()
  const list = [
    { bvid: 'a', play: 100, pubdate: now },
    { bvid: 'b', play: 9000, pubdate: now - 100 * 86400_000 },
    { bvid: 'c', play: 9000, pubdate: now },
    { bvid: 'd', play: 9000, pubdate: now },
  ]
  assert.deepEqual(duty.filterVideos(list, { minViews: 5000, maxAgeDays: 60, seen: new Set(['d']), now }).map((v) => v.bvid), ['c'])
})

function fakes({ decisions, cfgOver = {} } = {}) {
  const sent = []
  const events = []
  const eventRecords = []
  const facts = []
  const fakeApi = {
    nav: async () => ({ isLogin: true, uname: '肥鱼小号' }),
    search: async (kw) => [{ bvid: 'BV1aaaaaaaaa', aid: 1, title: kw + ' 视频一', play: 20000, pubdate: Date.now() }, { bvid: 'BV1bbbbbbbbb', aid: 2, title: kw + ' 视频二', play: 30000, pubdate: Date.now() }],
    recommend: async () => [],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid: bvid || 'BV1ccccccccc', aid: bvid === 'BV1bbbbbbbbb' ? 2 : 1, cid: 9, title: bvid === 'BV1bbbbbbbbb' ? '猫猫做饭' : '米饭大赛', author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '大家好今天做饭',
    comments: async () => [{ name: '网友', text: '好香' }],
    danmakuText: async () => [],
    likeVideo: async () => ({ ok: true }),
    favVideo: async () => ({ ok: true }),
    resolveShort: async () => 'https://www.bilibili.com/video/BV1bbbbbbbbb',
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["米饭","猫咪"]'
      if (prompt.includes('看完说说你的想法')) return JSON.stringify(decisions)
      return ''
    },
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    logChat: () => {},
  }
  const memory = {
    list: () => [{ text: '主人喜欢猫', about: '10000001' }],
    recentEvents: () => [],
    addEvent: (e) => { eventRecords.push(e); events.push(e.text) },
    add: (m) => facts.push(m.text),
  }
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', perRun: 2, keywords: ['米饭'], ...cfgOver } })
  const b = duty.createBili({ getConfig: () => cfg, hub, memory, log: { info() {}, warn() {}, debug() {} }, api: fakeApi })
  return { b, sent, events, eventRecords, facts }
}

test('刷一轮：看视频、分享给主人、记成她的经历', async () => {
  const { b, sent, events, eventRecords, facts } = fakes({ decisions: [
    { i: 1, tier: 'ok', feeling: '米饭好香', share: '', remember: '有个米饭大赛很好玩' },
    { i: 2, tier: 'worth', feeling: '猫好可爱', share: '主人你看这只猫会做饭！', remember: '' },
  ] })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 2)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:10000001')
  assert.match(sent[0].text, /会做饭！\nhttps:\/\/www\.bilibili\.com\/video\/BV1/)
  const seen = eventRecords.filter((e) => e.kind === 'seen')
  assert.equal(seen.length, 2)
  assert.equal(seen[0].meta.title, '米饭大赛')
  assert.equal(seen[0].meta.platform, 'bili')
  assert.match(seen[0].meta.url, /bilibili\.com\/video\//)
  assert.match(seen[0].text, /米饭好香.*有个米饭大赛很好玩/)
  assert.deepEqual(facts, [], '看见的内容留在 seen 中，不另存成事实')
  assert.equal(b.state().comments, 0, '观察者不发评论')
  assert.ok(!events.some((e) => e.includes('下评论')))
  // 看过的不会再看
  const r2 = await b.run({ force: true })
  assert.equal(r2.ok, false)
})

test('看你发来的视频（短链也行）', async () => {
  const { b } = fakes({ decisions: [] })
  const w = await b.watch('https://b23.tv/abc123')
  assert.equal(w.ok, true)
  assert.match(w.message, /《猫猫做饭》/)
  assert.match(w.message, /字幕（节选）：大家好今天做饭/)
  assert.equal((await b.watch('没有链接')).ok, false)
})

test('B 站 Cookie 分两个框填：纯值、带前缀、整串都认；老配置自动拆开；面板只看得到结尾几位', async () => {
  const { splitBiliCookie, publicConfig, mergeFromPanel } = await import('../src/core/config.js')
  assert.equal(splitBiliCookie({ sessdata: 'aaa', biliJct: 'bbb' }).cookie, 'SESSDATA=aaa; bili_jct=bbb')
  assert.equal(splitBiliCookie({ sessdata: 'SESSDATA=aaa', biliJct: 'bili_jct=bbb' }).cookie, 'SESSDATA=aaa; bili_jct=bbb')
  assert.deepEqual(splitBiliCookie({ sessdata: 'buvid3=z; SESSDATA=a%2C1; bili_jct=b; x=1' }), { sessdata: 'a%2C1', biliJct: 'b', cookie: 'SESSDATA=a%2C1; bili_jct=b' })
  const cur = normalize({ bili: { cookie: 'SESSDATA=old1234; bili_jct=jct9876' } })
  assert.equal(cur.bili.sessdata, 'old1234')
  const pub = publicConfig(cur).bili
  assert.equal(pub.sessdataHint, '…1234')
  assert.equal(pub.sessdata + pub.biliJct + pub.cookie, '', '完整值不回传')
  const next = mergeFromPanel(cur, { bili: { sessdata: '', biliJct: 'new0000' } })
  assert.equal(next.bili.cookie, 'SESSDATA=old1234; bili_jct=new0000', '只改一个，另一个保留')
  const cleared = mergeFromPanel(next, { bili: { sessdata: null, biliJct: null, cookie: null } })
  assert.equal(cleared.bili.cookie, '')
})

test('评论里的 @昵称 按昵称查到 mid 一起发，查不到的留作文字', async () => {
  const { createBiliApi } = await import('../extensions/bili-observer/bili/api.js')
  const posts = []
  const json = (data) => ({ ok: true, status: 200, headers: { getSetCookie: () => [], get: () => '' }, json: async () => ({ code: 0, data }) })
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/x/web-interface/nav')) return json({ wbi_img: { img_url: 'https://i/a.png', sub_url: 'https://i/b.png' } })
    if (u.includes('/wbi/search/type')) {
      const kw = new URL(u).searchParams.get('keyword')
      return json({ result: kw === '大肥鱼' ? [{ uname: '<em class="keyword">大肥鱼</em>', mid: 123 }, { uname: '大肥鱼2', mid: 456 }] : [{ uname: kw + '2', mid: 789 }] })
    }
    if (u.includes('/reply/add')) { posts.push(new URLSearchParams(opts.body)); return json({ rpid: 9 }) }
    return json({ b_3: 'x', b_4: 'y' })
  }
  const api = createBiliApi({ getCookie: () => 'SESSDATA=a; bili_jct=b', log: { debug() {} }, fetchImpl })
  const r = await api.postComment(1, '＠大肥鱼 快看 @没这人 哈哈')
  assert.deepEqual(r, { rpid: 9, at: ['大肥鱼'], missed: ['没这人'] })
  assert.equal(posts[0].get('message'), '@大肥鱼 快看 @没这人 哈哈')
  assert.deepEqual(JSON.parse(posts[0].get('at_name_to_mid')), { '大肥鱼': 123 })

  await api.postComment(1, '没有艾特')
  assert.equal(posts[1].has('at_name_to_mid'), false)
})
