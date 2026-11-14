// 读弹幕：deflate / zlib / 明文三种都解，实体还原，均匀采样，坏数据返回 []。
import './helpers/bili-lib.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { createBiliApi, decodeEntities, inflateDanmaku, parseDanmakuXml, pickDanmaku } from '../extensions/bili-observer/bili/api.js'

const xml = (items) => `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><chatid>9</chatid>${items.map((t) => `<d p="1.23,1,25,16777215,1700000000,0,abc,1">${t}</d>`).join('')}</i>`
// fetch 的 arrayBuffer() 给的是干净的 ArrayBuffer；Buffer 可能来自共享内存池，要按 byteOffset 切
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

test('解压：deflate raw、zlib、明文三种都能读', () => {
  const text = xml(['哈哈哈', '前方高能'])
  assert.match(parseDanmakuXml(deflateRawSync(Buffer.from(text))).join(','), /哈哈哈/)
  assert.match(parseDanmakuXml(deflateSync(Buffer.from(text))).join(','), /前方高能/)
  assert.match(parseDanmakuXml(Buffer.from(text)).join(','), /哈哈哈/)
  assert.equal(inflateDanmaku(Buffer.from('不是压缩数据')), '不是压缩数据', '坏数据退回原文')
})

test('解析：取出 <d> 里的正文，HTML 实体还原', () => {
  const list = parseDanmakuXml(Buffer.from(xml(['&amp;哈哈', '&#20320;&#x597D;', '&lt;3', 'a&nbsp;b'])))
  assert.deepEqual(list, ['&哈哈', '你好', '<3', 'a b'])
  assert.equal(decodeEntities('&unknown;'), '&unknown;', '不认识的实体原样保留')
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;', '越界的码点不硬转')
})

test('采样：过滤太短太长 / 纯数字 / 纯符号 / 重复，按时间均匀取而不是取最新', () => {
  const raw = [
    '好', '哈哈哈', '233333', '！！！', '前方高能', '前方高能',
    '这是一条特别特别特别特别特别特别特别特别长的弹幕超过三十个字了应该被丢掉',
    ...Array.from({ length: 100 }, (_, i) => `第${i}条弹幕`),
  ]
  const picked = pickDanmaku(raw, 10)
  assert.equal(picked.length, 10)
  assert.equal(picked.includes('好'), false, '太短')
  assert.equal(picked.includes('233333'), false, '纯数字')
  assert.equal(picked.includes('！！！'), false, '纯符号')
  assert.equal(new Set(picked).size, 10, '去重')
  assert.equal(picked[0], '哈哈哈', '从最前面开始采')
  assert.equal(picked.includes('第99条弹幕'), false, '不是只取最新几条')
  assert.ok(picked.some((t) => /^第8\d条弹幕$/.test(t)), '均匀铺到后面，不是截断前 10 条')
  assert.deepEqual(pickDanmaku(['a', 'bb'], 30), ['bb'], '不足 limit 就全给（a 太短被丢）')
  assert.equal(pickDanmaku([], 30).length, 0)
})

test('danmakuText：读到就返回文本，接口报错 / HTML 错误页 / 空 cid 都返回 []', async () => {
  const ok = createBiliApi({
    getCookie: () => '',
    log: { debug() {} },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => toArrayBuffer(deflateRawSync(Buffer.from(xml(['哈哈哈', '前方高能'])))) }),
  })
  assert.deepEqual(await ok.danmakuText(9), ['哈哈哈', '前方高能'])

  const html = createBiliApi({ getCookie: () => '', log: { debug() {} }, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => toArrayBuffer(Buffer.from('<html>412</html>')) }) })
  assert.deepEqual(await html.danmakuText(9), [])

  const broken = createBiliApi({ getCookie: () => '', log: { debug() {} }, fetchImpl: async () => { throw new Error('网络断了') } })
  assert.deepEqual(await broken.danmakuText(9), [])
  assert.deepEqual(await broken.danmakuText(0), [], '没有 cid 就不请求')
})
