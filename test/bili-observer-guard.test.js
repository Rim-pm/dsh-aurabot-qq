// 观察者写闸门：observer 下评论 / 改资料一个请求都不发；like / fav 放行；social 放行全部。
// 闸门在 api.js 里，和面板配置无关——配置填错了也不会真的发出去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBiliApi } from '../src/bili/api.js'
import { normalize } from '../src/core/config.js'

const log = { info() {}, warn() {}, debug() {} }

function recorder() {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body })
    return {
      ok: true,
      status: 200,
      headers: { get: () => '', getSetCookie: () => [] },
      json: async () => ({ code: 0, data: { rpid: 1 } }),
    }
  }
  return { calls, fetchImpl }
}

test('posture：默认 observer，脏值和老配置都落到 observer，评论 / 弹幕开关被强制关掉', () => {
  const c = normalize({})
  assert.equal(c.bili.posture, 'observer')
  assert.equal(c.bili.like, true, '点赞默认开')
  assert.equal(c.bili.maxLikesPerDay, 5)
  assert.equal(c.bili.maxFavsPerDay, 10)
  assert.equal(c.bili.favWorthFolderId, 0)
  assert.equal(c.bili.favOkFolderId, 0)
  assert.equal(c.bili.dailyDigest, true)
  assert.equal(c.bili.dailyDigestHour, 21)
  assert.equal(c.bili.transcribe, false)

  const old = normalize({ bili: { comment: true, reply: true, danmakuEnabled: true, autoDanmaku: true } })
  assert.equal(old.bili.posture, 'observer', '老配置没有 posture 也强制观察者')
  assert.equal(old.bili.comment, false)
  assert.equal(old.bili.reply, false)
  assert.equal(old.bili.danmakuEnabled, false)
  assert.equal(old.bili.autoDanmaku, false)

  assert.equal(normalize({ bili: { posture: '乱写' } }).bili.posture, 'observer', '非法值落到 observer')
  const social = normalize({ bili: { posture: 'social', comment: true, reply: true } })
  assert.equal(social.bili.posture, 'social')
  assert.equal(social.bili.comment, true, 'social 保留老开关')
  assert.equal(social.bili.reply, true)
})

test('observer 下评论 / 改资料：直接返回 blocked，fetch 调用数为 0', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createBiliApi({ getCookie: () => 'SESSDATA=a; bili_jct=tok', log, fetchImpl, allowWrite: (kind) => kind === 'like' || kind === 'fav' })

  assert.deepEqual(await api.postComment(1, '你好'), { ok: false, blocked: 'observer', kind: 'comment' })
  assert.deepEqual(await api.setSign('换个签名'), { ok: false, blocked: 'observer', kind: 'profile' })
  assert.deepEqual(await api.setFace('https://img.example/a.png'), { ok: false, blocked: 'observer', kind: 'profile' })
  assert.equal(calls.length, 0, '一个网络请求都不该发')

  // 发弹幕的方法已经随模块删掉，连入口都没有
  assert.equal(typeof api.postDanmaku, 'undefined')
})

test('observer 下点赞放行：只发一条 like 请求', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createBiliApi({ getCookie: () => 'SESSDATA=a; bili_jct=tok', log, fetchImpl, allowWrite: (kind) => kind === 'like' || kind === 'fav' })
  const r = await api.likeVideo(123)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.bilibili.com/x/web-interface/archive/like')
  assert.equal(new URLSearchParams(calls[0].body).get('aid'), '123')
})

test('social 下闸门放开：评论照常发出去', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createBiliApi({ getCookie: () => 'SESSDATA=a; bili_jct=tok', log, fetchImpl, allowWrite: () => true })
  const r = await api.postComment(1, '好看')
  assert.equal(r.rpid, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.bilibili.com/x/v2/reply/add')
})

test('没传 allowWrite 时保持老行为（默认全放行），不影响其他调用方', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createBiliApi({ getCookie: () => 'SESSDATA=a; bili_jct=tok', log, fetchImpl })
  await api.postComment(1, '好看')
  assert.equal(calls.length, 1)
})
