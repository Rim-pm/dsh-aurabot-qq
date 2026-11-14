// 推荐流：解析、非视频过滤、失败回退热门、推荐流模式不调 chooseKeywords。
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
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-recommend-'))
  api = await import('../extensions/bili-observer/bili/api.js')
  duty = await import('../extensions/bili-observer/bili/duty.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

function fakeFetch(payload) {
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(String(url))
    if (String(url).includes('/x/web-interface/nav')) {
      return { json: async () => ({ data: { wbi_img: { img_url: 'https://i.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sub_url: 'https://i.example/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' } } }) }
    }
    if (String(url).includes('/x/frontend/finger/spi')) return { json: async () => ({ code: 0, data: { b_3: 'buvid' } }) }
    return { json: async () => payload }
  }
  return { fetchImpl, requests }
}

const rcmdPayload = {
  code: 0,
  data: {
    item: [
      { goto: 'av', bvid: 'BV1aaaaaaaaa', id: 111, title: '<em class="keyword">猫猫</em>做饭', owner: { name: 'UP甲' }, stat: { view: 12345 }, pubdate: 1700000000, duration: 600, desc: '<b>简介</b>在这里' },
      { goto: 'live', bvid: '', id: 222, title: '直播' },
      { goto: 'av', bvid: 'BV1bbbbbbbbb', id: 333, title: '没有封面', owner: { name: 'UP乙' }, stat: {}, pubdate: 0 },
      { goto: 'av', id: 444, title: '没有 bvid' },
    ],
  },
}

test('recommend：只留 goto=av 且有 bvid 的，字段摊平、HTML 去掉', async () => {
  const { fetchImpl, requests } = fakeFetch(rcmdPayload)
  const client = api.createBiliApi({ getCookie: () => 'SESSDATA=a; bili_jct=b', log: { debug() {} }, fetchImpl })
  const list = await client.recommend({ ps: 30 })
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], {
    bvid: 'BV1aaaaaaaaa', aid: 111, title: '猫猫做饭', author: 'UP甲',
    play: 12345, pubdate: 1700000000 * 1000, duration: 600, desc: '简介在这里',
  })
  assert.equal(list[1].play, 0, '没有 stat 就是 0')
  const rcmd = requests.find((u) => u.includes('/feed/rcmd'))
  assert.ok(rcmd, '走的是推荐流接口')
  const q = new URL(rcmd).searchParams
  assert.equal(q.get('ps'), '30')
  assert.equal(q.get('web_location'), '1430654')
  assert.match(q.get('w_rid'), /^[a-f0-9]{32}$/, '推荐流要 WBI 签名')
})

function boot({ recommend, popular, hubCalls = [] } = {}) {
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, keywords: [], perRun: 3 } })
  const api = {
    nav: async () => ({ isLogin: true }),
    recommend: recommend || (async () => []),
    popular: popular || (async () => []),
    search: async () => { hubCalls.push('search'); return [] },
    view: async ({ bvid }) => ({ bvid, aid: 1, cid: 9, title: '视频 ' + bvid, author: 'UP', play: 1, desc: '' }),
    subtitle: async () => '',
    comments: async () => [],
    danmakuText: async () => [],
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => { hubCalls.push(prompt.includes('挑 3 个') ? 'chooseKeywords' : 'think'); return '[]' },
    sendText: async () => ({}),
  }
  const bili = duty.createBili({ getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} }, api })
  return { bili, cfg, hubCalls }
}

const video = (bvid) => ({ bvid, aid: 1, title: '视频 ' + bvid, author: 'UP', play: 1, pubdate: Date.now(), desc: '' })

test('关键词为空：走推荐流，且不调用 chooseKeywords', async () => {
  const calls = []
  const { bili } = boot({ recommend: async () => [video('BV1aaaaaaaaa')], hubCalls: calls })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 1)
  assert.equal(calls.includes('chooseKeywords'), false, '推荐流模式省掉一次模型调用')
})

test('推荐流抛错：回退热门，仍然能刷', async () => {
  const { bili } = boot({ recommend: async () => { throw new Error('412') }, popular: async () => [video('BV1bbbbbbbbb')] })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 1)
})

test('推荐流返回空：回退热门；热门也空就如实说没搜到', async () => {
  const hot = boot({ recommend: async () => [], popular: async () => [video('BV1ccccccccc')] })
  assert.equal((await hot.bili.run({ force: true })).watched, 1)
  const none = boot({ recommend: async () => [], popular: async () => [] })
  const r = await none.bili.run({ force: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /没搜到合适的视频/)
})

test('推荐流不过滤播放量和发布时间（老视频低播放也能进来）', async () => {
  const old = { ...video('BV1ddddddddd'), play: 0, pubdate: Date.now() - 400 * 86400_000 }
  const { bili } = boot({ recommend: async () => [old] })
  const r = await bili.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 1)
})
