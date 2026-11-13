// 抖音转存扩展的纯逻辑测试：不联网、不碰 QQ。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '../../src/tools/tools.js'
import mod, {
  pickLink, platformOf, apiKeyOf, parseMcpResponse, mcpCall, settleTask,
  splitText, parseCommand, formatComments, transcriptText, wantsRead, chatIntent,
  serviceBase, serviceUp, cutText, lookResultBlocks,
} from './index.mjs'

test('pickLink：从分享文案里挑出链接', () => {
  assert.equal(pickLink('2.51 复制打开抖音 https://v.douyin.com/51etr3NbKwA/ bAT:/ 10/09'), 'https://v.douyin.com/51etr3NbKwA/')
  assert.equal(pickLink('看看这个 https://www.douyin.com/video/7700621592283368746'), 'https://www.douyin.com/video/7700621592283368746')
  assert.equal(pickLink('没有链接'), '')
  assert.equal(pickLink('https://www.tiktok.com/@x/video/123'), '')
})

test('pickLink：B站 各种链接都认（含短链和手机版）', () => {
  assert.equal(pickLink('看这个 https://www.bilibili.com/video/BV15taP6pES7'), 'https://www.bilibili.com/video/BV15taP6pES7')
  assert.equal(pickLink('https://www.bilibili.com/video/av170001'), 'https://www.bilibili.com/video/av170001')
  assert.equal(pickLink('【标题】 https://b23.tv/AbCdEf1 复制链接'), 'https://b23.tv/AbCdEf1')
  assert.equal(pickLink('https://m.bilibili.com/video/BV15taP6pES7?p=2'), 'https://m.bilibili.com/video/BV15taP6pES7?p=2')
  assert.equal(pickLink('https://bili2233.cn/xyz'), 'https://bili2233.cn/xyz')
  assert.equal(pickLink('https://space.bilibili.com/2'), 'https://space.bilibili.com/2')
})

test('pickLink：不会把冒名域名当成 B站', () => {
  assert.equal(pickLink('https://notbilibili.com/video/BV1'), '')
  assert.equal(pickLink('https://fake-b23.tv.example.com/x'), '')
})

test('platformOf：按链接认平台（下载时决定 Referer）', () => {
  assert.equal(platformOf('https://www.bilibili.com/video/BV1'), 'bilibili')
  assert.equal(platformOf('https://b23.tv/abc'), 'bilibili')
  assert.equal(platformOf('https://v.douyin.com/abc/'), 'douyin')
  assert.equal(platformOf('https://www.douyin.com/video/1'), 'douyin')
  assert.equal(platformOf(''), 'douyin')
})

test('pickLink：去掉链接末尾的标点', () => {
  assert.equal(pickLink('看这个 https://v.douyin.com/abc/。'), 'https://v.douyin.com/abc/')
  assert.equal(pickLink('看这个 https://b23.tv/abc），'), 'https://b23.tv/abc')
})

test('parseMcpResponse：SSE 和裸 JSON 都认', () => {
  assert.deepEqual(parseMcpResponse('event: message\ndata: {"jsonrpc":"2.0","result":{"ok":1}}'), { jsonrpc: '2.0', result: { ok: 1 } })
  assert.deepEqual(parseMcpResponse('{"jsonrpc":"2.0","result":{"ok":2}}'), { jsonrpc: '2.0', result: { ok: 2 } })
})

test('apiKeyOf：设置里填的直接用', () => {
  assert.equal(apiKeyOf({ apiKey: 'dtk_abc' }), 'dtk_abc')
})

test('apiKeyOf：从账号文件里读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-save-'))
  try {
    const file = join(dir, 'console-account.txt')
    writeFileSync(file, 'url: http://127.0.0.1:8000\napi-key (X-API-Key 头用): dtk_from_file\n')
    assert.equal(apiKeyOf({ accountFile: file }), 'dtk_from_file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mcpCall：解析 SSE 结果', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"data\\":{\\"kind\\":\\"video\\"}}"}]}}\n', { status: 200 })
  try {
    const r = await mcpCall({ mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'dtk_x' }, 'parse_url', { url: 'x' })
    assert.equal(r.data.kind, 'video')
  } finally {
    globalThis.fetch = original
  }
})

test('mcpCall：工具报错要抛出来', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"The short link could not be followed"}]}}', { status: 200 })
  try {
    await assert.rejects(() => mcpCall({ mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'dtk_x' }, 'parse_url', { url: 'x' }), /short link/)
  } finally {
    globalThis.fetch = original
  }
})

test('mcpCall：服务连不上时给一句能看懂的话', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    await assert.rejects(() => mcpCall({ mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'dtk_x' }, 'parse_url', { url: 'x' }), /dtk start/)
  } finally {
    globalThis.fetch = original
  }
})

// ---------- 转写 / 评论：服务端排队（pending）要接着等，不能让她重喊一遍 ----------

/** 假的 MCP：按顺序吐准备好的几个 result.content[0].text。 */
function fakeMcp(replies) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.params.name)
    const text = replies[Math.min(calls.length - 1, replies.length - 1)]
    return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } }) + '\n', { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('settleTask：pending 就调 get_task_result 接着等，转写 id 不丢', async () => {
  const f = fakeMcp([
    JSON.stringify({ status: 'pending', task_id: 't1', transcription_id: 'tr1', message: 'still running' }),
    JSON.stringify({ status: 'ok', task_id: 't1', transcription_id: 'tr1', data: { state: 'done', text: '大家好，今天讲三件事。' } }),
  ])
  try {
    const out = await settleTask({ mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' },
      { status: 'pending', task_id: 't1', transcription_id: 'tr1' }, { sleep: async () => {} })
    assert.deepEqual(f.calls, ['get_task_result', 'get_task_result'], '第一次还在跑，接着等到出结果')
    assert.equal(out.status, 'ok')
    assert.equal(out.transcription_id, 'tr1')
    assert.equal(transcriptText(out), '大家好，今天讲三件事。')
  } finally {
    f.restore()
  }
})

test('settleTask：下载 pending 时 download_id 要留住（收结果那步服务端不一定再给）', async () => {
  const f = fakeMcp([
    JSON.stringify({ status: 'ok', task_id: 't2', data: { state: 'done', download_id: 'd9' } }),
  ])
  try {
    const out = await settleTask({ mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' },
      { status: 'pending', task_id: 't2', download_id: 'd9' }, { sleep: async () => {} })
    assert.equal(out.download_id, 'd9')
    assert.equal(out.data.download_id, 'd9')
  } finally {
    f.restore()
  }
})

test('settleTask：等不到就原样还回去（上层好说「还在跑」）', async () => {
  const f = fakeMcp([JSON.stringify({ status: 'pending', task_id: 't3' })])
  try {
    const out = await settleTask({ mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' },
      { status: 'pending', task_id: 't3' }, { tries: 2, sleep: async () => {} })
    assert.equal(out.status, 'pending')
    assert.equal(f.calls.length, 2)
  } finally {
    f.restore()
  }
})

test('settleTask：不是 pending 的直接返回，不白等', async () => {
  const f = fakeMcp([JSON.stringify({ status: 'ok' })])
  try {
    const out = await settleTask({ mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, { status: 'ok', data: { text: 'x' } }, { sleep: async () => {} })
    assert.equal(out.data.text, 'x')
    assert.deepEqual(f.calls, [])
  } finally {
    f.restore()
  }
})

// ---------- 文字稿怎么发 ----------

test('splitText：短的不切；长的按句子断，拼回来还是原文', () => {
  assert.deepEqual(splitText('一句话。'), ['一句话。'])
  const long = '第一句话讲的是开头。'.repeat(200)
  const parts = splitText(long, 500)
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= 500, `分段太长：${p.length}`)
  assert.equal(parts.join(''), long.replace(/\s+/g, ''))
})

test('splitText：一句都断不开也硬切，不会无限循环', () => {
  const parts = splitText('啊'.repeat(1200), 500)
  assert.equal(parts.length, 3)
  assert.equal(parts.join(''), '啊'.repeat(1200))
})

test('splitText：空文本返回空数组', () => {
  assert.deepEqual(splitText('   '), [])
  assert.deepEqual(splitText(null), [])
})

test('transcriptText：认 data.text，也认扁平的 text；没有就是空串', () => {
  assert.equal(transcriptText({ status: 'ok', data: { text: ' 正文 ' } }), '正文')
  assert.equal(transcriptText({ text: '扁平' }), '扁平')
  assert.equal(transcriptText({ status: 'pending' }), '')
  assert.equal(transcriptText(null), '')
})

test('formatComments：带昵称、点赞、回复数；只取前 N 条', () => {
  const payload = { status: 'ok', data: { items: [
    { text: '这个真有用\n第二行', author: { nickname: '知榆.' }, digg_count: 9, reply_count: 2 },
    { text: '学到了', author: { nickname: '木子李' }, digg_count: 0, reply_count: 0, is_pinned: true },
  ] } }
  const text = formatComments(payload, { max: 1, title: 'AI 知识库' })
  assert.match(text, /《AI 知识库》的评论（1 条）/)
  assert.match(text, /1\. 知榆\.：这个真有用 第二行（赞 9 · 2 条回复）/)
  assert.doesNotMatch(text, /木子李/)
})

test('formatComments：没评论返回空串，匿名也有兜底', () => {
  assert.equal(formatComments({ data: { items: [] } }), '')
  assert.equal(formatComments({}), '')
  assert.match(formatComments({ data: { items: [{ text: 'hi' }] } }), /匿名：hi/)
})

// ---------- 命令怎么分流 ----------

test('parseCommand：默认转存，前缀词换成功作', () => {
  assert.deepEqual(parseCommand('https://v.douyin.com/abc/'), { mode: 'save', text: 'https://v.douyin.com/abc/' })
  assert.deepEqual(parseCommand('转写 https://v.douyin.com/abc/'), { mode: 'transcript', text: 'https://v.douyin.com/abc/' })
  assert.deepEqual(parseCommand('转写：https://v.douyin.com/abc/'), { mode: 'transcript', text: 'https://v.douyin.com/abc/' })
  assert.deepEqual(parseCommand('评论 https://v.douyin.com/abc/'), { mode: 'comments', text: 'https://v.douyin.com/abc/' })
  assert.deepEqual(parseCommand('总结一下 https://v.douyin.com/abc/'), { mode: 'transcript', text: '一下 https://v.douyin.com/abc/' })
  assert.deepEqual(parseCommand(''), { mode: 'save', text: '' })
})

test('parseCommand：只给个动词、没链接，也要认成那个动作（好回一句「没链接」）', () => {
  assert.deepEqual(parseCommand('转写'), { mode: 'transcript', text: '' })
})

test('wantsRead：正常说话里要文字稿 / 评论也认得出', () => {
  assert.equal(wantsRead('帮我转写一下这个'), true)
  assert.equal(wantsRead('这条讲了什么'), true)
  assert.equal(wantsRead('看看评论区怎么说'), true)
  assert.equal(wantsRead('发我一份文字稿'), true)
  assert.equal(wantsRead('下载发我'), false)
  assert.equal(wantsRead('存一下'), false)
  assert.equal(wantsRead(''), false)
})

test('chatIntent：抖音分享文案自带的「看看」不算想聊天', () => {
  const share = '9.28 复制打开抖音，看看【从未有人善待我的图文作品】 https://v.douyin.com/VmHpd7y0p9E/ 10/19 fBg:/ :7pm t@E.UL'
  assert.equal(chatIntent(share), false)
  assert.equal(chatIntent('https://v.douyin.com/abc/'), false)
  assert.equal(chatIntent('下载发我'), false)
  assert.equal(chatIntent('你看看这个'), true)
  assert.equal(chatIntent('看看这个 https://v.douyin.com/abc/'), true)
  assert.equal(chatIntent('你觉得怎么样'), true)
  assert.equal(chatIntent('这条好看吗'), true)
  assert.equal(chatIntent(''), false)
})

test('「收到链接就自动发」开着时，要转写 / 评论的消息要让路（不能被吞掉）', async () => {
  const box = fakeApi({ settings: { auto: true } })
  const owner = (text) => ({ chatId: 'private:1', kind: 'private', userId: '1', text })
  assert.equal(await box.onMessage(owner('转写一下 https://v.douyin.com/abc/')), false, '要转写：交给她')
  assert.equal(await box.onMessage(owner('看看评论 https://v.douyin.com/abc/')), false, '要评论：交给她')
  assert.equal(await box.onMessage(owner('这个链接讲了什么 https://v.douyin.com/abc/')), false)
  assert.equal(await box.onMessage({ ...owner('转写 https://v.douyin.com/abc/'), chatId: 'private:2' }), false, '不是主人私聊')
  assert.equal(await box.onMessage(owner('转写一下，没链接')), false, '没链接本来也不接管')
})

test('auto 开着：转存失败要告诉主人，不能悄悄吞掉', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const box = fakeApi({ settings: { auto: true, autoStart: false, mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' } })
    const handled = await box.onMessage({ chatId: 'private:1', kind: 'private', userId: '1', text: 'https://v.douyin.com/abc/' })
    assert.equal(handled, true)
    assert.equal(box.sent.length, 1)
    assert.match(box.sent[0], /没转成/)
    assert.match(box.sent[0], /没在运行/)
  } finally {
    globalThis.fetch = original
  }
})

test('「收到链接就自动发」关着时一律不接管', async () => {
  const box = fakeApi({ settings: { auto: false } })
  assert.equal(await box.onMessage({ chatId: 'private:1', kind: 'private', userId: '1', text: 'https://v.douyin.com/abc/' }), false)
})

/** 假的一整套：/readyz 就绪、parse_url 给一条作品、媒体随便几个字节。 */
function fakeService({ title = '测试视频', kind = 'video', images = 0, transcript = '大家好，今天讲三件事。', comments = [], imageBytes = null } = {}) {
  const original = globalThis.fetch
  const calls = []
  const media = kind === 'image_album'
    ? { images: Array.from({ length: images }, (_, i) => ({ urls: [`http://127.0.0.1:1/image-${i + 1}.jpg`] })) }
    : { video: { urls: ['http://127.0.0.1:1/media.mp4'] } }
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/readyz')) return new Response('{"status":"ok"}', { status: 200 })
    if (u.includes('/mcp')) {
      const body = JSON.parse(init.body)
      const name = body.params.name
      calls.push(name)
      let payload = { status: 'ok' }
      if (name === 'parse_url') payload = { status: 'ok', data: { kind, platform: 'douyin', content_id: '1', title, duration_ms: 125000, media } }
      else if (name === 'download_media') payload = { status: 'ok', download_id: 'd1' }
      else if (name === 'transcribe_video') payload = { status: 'ok', data: { state: 'done', text: transcript } }
      else if (name === 'list_comments') payload = { status: 'ok', data: { items: comments } }
      return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\n', { status: 200 })
    }
    const image = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)
    const body = image && imageBytes ? imageBytes : new Uint8Array([1, 2, 3])
    return new Response(body, { status: 200, headers: { 'content-type': image ? 'image/jpeg' : 'video/mp4' } })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('auto 开着：链接 +「你看看这个」先转存，再把话交给她（上下文带这条）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-auto-'))
  const f = fakeService()
  try {
    const box = fakeApi({ settings: { auto: true, mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, config: { workspaceDir: dir } })
    const handled = await box.onMessage({ chatId: 'private:1', kind: 'private', userId: '1', text: '你看看这个 https://v.douyin.com/abc/' })
    assert.equal(handled, false, '想聊：交给她')
    assert.ok(f.calls.includes('parse_url'), '得先转存')
    const ctx = box.context({ chat: { chatId: 'private:1', kind: 'private' } })
    assert.match(ctx, /自动转存/)
    assert.match(ctx, /测试视频/)
    assert.match(ctx, /douyin_look/)
  } finally {
    f.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auto 开着：光发链接就自己转存完，不惊动模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-auto-'))
  const f = fakeService()
  try {
    const box = fakeApi({ settings: { auto: true, mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, config: { workspaceDir: dir } })
    const handled = await box.onMessage({ chatId: 'private:1', kind: 'private', userId: '1', text: 'https://v.douyin.com/abc/' })
    assert.equal(handled, true)
    assert.match(box.context({ chat: { chatId: 'private:1', kind: 'private' } }), /测试视频/)
    assert.equal(box.context({ chat: { chatId: 'private:2', kind: 'private' } }), '', '别的聊天不掺和')
  } finally {
    f.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auto 转存完，模型再调 douyin_save 不会重复发；说「再发一遍」才放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-auto-'))
  const f = fakeService()
  try {
    const box = fakeApi({ settings: { auto: true, mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, config: { workspaceDir: dir } })
    const chat = { chatId: 'private:1', kind: 'private' }
    await box.onMessage({ ...chat, userId: '1', text: 'https://v.douyin.com/abc/' })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[0]
    const again = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(again.ok, true)
    assert.match(again.message, /没重复发/)
    assert.equal(f.calls.filter((n) => n === 'parse_url').length, 1, '没有第二次解析 / 发送')

    const forced = await tool.execute({ url: 'https://v.douyin.com/abc/ 再发一遍' }, {})
    assert.match(forced.message, /视频发出去了/)
  } finally {
    f.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- quiet / douyin_look：读内容但不往聊天里刷屏 ----------

test('cutText：不超长原样返回；超长断在句子处并报还剩多少字', () => {
  assert.deepEqual(cutText('短句。', 100), { text: '短句。', more: 0 })
  const long = '这是一句话。'.repeat(100)
  const cut = cutText(long, 200)
  assert.ok(cut.text.length <= 200)
  assert.ok(cut.text.endsWith('。'))
  assert.equal(cut.text.length + cut.more, long.length)
})

test('douyin_transcript quiet：不发聊天，文字稿进返回值', async () => {
  const f = fakeService({ transcript: '第一句。第二句。' })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' } })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[1]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/', quiet: true }, {})
    assert.equal(r.ok, true)
    assert.match(r.message, /第一句。第二句。/)
    assert.equal(box.sent.length, 0, 'quiet 时一句话都不该发进聊天')
    assert.equal(box.files.length, 0)
  } finally {
    f.restore()
  }
})

test('douyin_transcript 默认（quiet 没给）还是发聊天', async () => {
  const f = fakeService({ transcript: '第一句。' })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' } })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[1]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, true)
    assert.match(box.sent.join('\n'), /第一句。/)
  } finally {
    f.restore()
  }
})

test('douyin_comments quiet：评论进返回值，不刷进聊天', async () => {
  const f = fakeService({ comments: [{ text: '好家伙', author: { nickname: '甲' }, digg_count: 3 }] })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' } })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[2]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/', quiet: true }, {})
    assert.equal(r.ok, true)
    assert.match(r.message, /好家伙/)
    assert.equal(box.sent.length, 0)
  } finally {
    f.restore()
  }
})

test('douyin_look 视频：一次给标题、时长、文字稿、热评，且不发聊天', async () => {
  const f = fakeService({ transcript: '讲了三件事。', comments: [{ text: '说到心坎里了', author: { nickname: '乙' }, digg_count: 8 }] })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' } })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/', comments: 5 }, {})
    assert.equal(r.ok, true)
    assert.match(r.message, /《测试视频》/)
    assert.match(r.message, /视频，2:05/)
    assert.match(r.message, /讲了三件事。/)
    assert.match(r.message, /说到心坎里了/)
    assert.equal(box.sent.length, 0, '看内容时不许往聊天里刷')
    assert.equal(box.files.length, 0)
  } finally {
    f.restore()
  }
})

test('douyin_look 视频：comments 默认 0 就不去读评论', async () => {
  const f = fakeService({ transcript: '只有口播。' })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' } })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, true)
    assert.ok(!f.calls.includes('list_comments'))
  } finally {
    f.restore()
  }
})

test('douyin_look 图集：能看图时返回 image 块，不调转写', async () => {
  const f = fakeService({ kind: 'image_album', images: 5 })
  try {
    const box = fakeApi({
      settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' },
      visual: true,
      imageLib: { imageToolBlock: async (_dsh, buf) => ({ type: 'image', attachment: 'a-' + buf.length, mediaType: 'image/jpeg' }) },
    })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, true)
    assert.equal(r.images.length, 3, '最多给三张，别把上下文塞满')
    assert.ok(!f.calls.includes('transcribe_video'), '图集没声音，不该去转写')
    const blocks = tool.output.render({}, r)
    assert.equal(blocks.filter((b) => b.type === 'image').length, 3)
    assert.match(blocks[0].text, /图集共 5 张/)
    assert.equal(box.sent.length, 0)
  } finally {
    f.restore()
  }
})

test('douyin_look 图集：模型看不了图就如实说，不硬塞图片块', async () => {
  const f = fakeService({ kind: 'image_album', images: 2 })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, visual: false })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, true)
    assert.deepEqual(r.images, [])
    assert.match(r.message, /看不了图/)
  } finally {
    f.restore()
  }
})

test('douyin_look 图集：webp 先转成 jpeg 再交给模型（模型接口不认 webp）', async () => {
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 5, 6, 7, 8])
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9])
  const f = fakeService({ kind: 'image_album', images: 2, imageBytes: webp })
  try {
    const seen = []
    const box = fakeApi({
      settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' },
      visual: true,
      imageLib: {
        findFfmpeg: () => 'ffmpeg',
        shrinkImage: async (buf) => { seen.push('shrink'); return buf[0] === 0x52 ? jpeg : null },
        imageToolBlock: async (_dsh, buf) => { seen.push(buf[0] === 0xff ? 'jpeg' : 'raw'); return { type: 'image', attachment: 'a' + seen.length, mediaType: 'image/jpeg' } },
      },
    })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, true)
    assert.equal(r.images.length, 2)
    assert.deepEqual(seen, ['shrink', 'jpeg', 'shrink', 'jpeg'], '每张 webp 都要先转 jpeg 再登记')
  } finally {
    f.restore()
  }
})

test('douyin_look 图集：转不了 jpeg 时退回原图，别一张都不给', async () => {
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 5, 6, 7, 8])
  const f = fakeService({ kind: 'image_album', images: 1, imageBytes: webp })
  try {
    const box = fakeApi({
      settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' },
      visual: true,
      imageLib: {
        findFfmpeg: () => '',
        shrinkImage: async () => null,
        imageToolBlock: async (_dsh, buf) => ({ type: 'image', attachment: 'a-' + buf.length, mediaType: 'image/webp' }),
      },
    })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.images.length, 1)
  } finally {
    f.restore()
  }
})

test('lookResultBlocks：没图只回文字；失败加 ✗', () => {
  assert.deepEqual(lookResultBlocks({}, { ok: true, message: '看到了' }), [{ type: 'text', text: '看到了' }])
  assert.match(lookResultBlocks({}, { ok: false, message: '没取到' })[0].text, /✗ 没取到/)
})

// ---------- 默认值设置项 ----------

test('设置项：看图 / 读稿 / 评论的默认值都有，且兜底值合理', () => {
  assert.equal(mod.defaults.lookComments, 0)
  assert.equal(mod.defaults.lookTranscript, true)
  assert.equal(mod.defaults.lookImages, 3)
  assert.equal(mod.defaults.quietRead, false)
  for (const key of ['lookComments', 'lookTranscript', 'lookImages', 'quietRead']) {
    assert.ok(mod.settings.some((s) => s.key === key), `设置面板要有 ${key}`)
  }
})

test('douyin_look 没给参数时按设置里的默认值走：读评论、限制图片张数', async () => {
  const f = fakeService({
    kind: 'image_album',
    images: 5,
    comments: [{ text: '沙发', digg_count: 9, author: { nickname: '甲' } }],
  })
  try {
    const box = fakeApi({
      settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k', lookComments: 2, lookImages: 2 },
      visual: true,
      imageLib: { imageToolBlock: async () => ({ type: 'image', attachment: 'a', mediaType: 'image/jpeg' }) },
    })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, true)
    assert.equal(r.images.length, 2, '按 lookImages 只给两张')
    assert.match(r.message, /热评/, 'lookComments=2 时默认读评论')
    assert.ok(f.calls.includes('list_comments'))
  } finally {
    f.restore()
  }
})

test('douyin_look：设置里关了读稿，默认就不转写；显式 transcript:true 还是读', async () => {
  const f = fakeService({ transcript: '不该出现。' })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k', lookTranscript: false } })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[3]
    const off = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.doesNotMatch(off.message, /不该出现/)
    assert.ok(!f.calls.includes('transcribe_video'))

    const on = await tool.execute({ url: 'https://v.douyin.com/abc/', transcript: true }, {})
    assert.match(on.message, /不该出现/)
    assert.ok(f.calls.includes('transcribe_video'))
  } finally {
    f.restore()
  }
})

test('quietRead 开着：douyin_transcript 默认不发聊天，显式 quiet:false 才发', async () => {
  const f = fakeService({ transcript: '安静地读完。' })
  try {
    const quietBox = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k', quietRead: true }, config: { workspaceDir: tmpdir() } })
    const quietTool = quietBox.factory({ chat: ownerChat, level: 'full' })[1]
    const r = await quietTool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, true)
    assert.match(r.message, /安静地读完/)
    assert.deepEqual(quietBox.sent, [], 'quietRead 默认就不刷聊天')

    const loudBox = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k', quietRead: true }, config: { workspaceDir: tmpdir() } })
    const loudTool = loudBox.factory({ chat: ownerChat, level: 'full' })[1]
    await loudTool.execute({ url: 'https://v.douyin.com/abc/', quiet: false }, {})
    assert.ok(loudBox.sent.length, '显式 quiet:false 要照旧发到聊天')
  } finally {
    f.restore()
  }
})

// ---------- 面板 ----------

test('模块声明了 panel.js，且文件真的存在（install 会一起拷过去）', () => {
  assert.equal(mod.panel, 'panel.js')
  assert.ok(existsSync(new URL('./panel.js', import.meta.url)), 'panel.js 要跟 index.mjs 放一起')
})

test('面板 /look：贴链接就返回标题和文字稿，不发聊天', async () => {
  const f = fakeService({ title: '试看标题', transcript: '面板里看到的稿子。' })
  try {
    const box = fakeApi({ settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, config: { workspaceDir: tmpdir() } })
    const r = await box.routes['/look']({ body: { url: 'https://v.douyin.com/abc/' } })
    assert.equal(r.ok, true)
    assert.equal(r.title, '试看标题')
    assert.match(r.transcript, /面板里看到的稿子/)
    assert.deepEqual(box.sent, [], '预览不能往聊天里发东西')
  } finally {
    f.restore()
  }
})

test('面板 /look：没链接就回一句人话', async () => {
  const box = fakeApi()
  const r = await box.routes['/look']({ body: { url: '随便说说' } })
  assert.equal(r.ok, false)
  assert.match(r.message, /没有抖音 \/ B站链接/)
})

test('面板 /look：图集给缩略图 data URL，不给附件块', async () => {
  const f = fakeService({ kind: 'image_album', images: 2, imageBytes: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) })
  try {
    const box = fakeApi({
      settings: { mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' },
      imageLib: {
        findFfmpeg: () => 'ffmpeg',
        shrinkImage: async (buf) => buf,
        imageToolBlock: async () => null,
      },
    })
    const r = await box.routes['/look']({ body: { url: 'https://v.douyin.com/abc/' } })
    assert.equal(r.ok, true)
    assert.equal(r.thumbs.length, 2)
    assert.match(r.thumbs[0], /^data:image\//)
  } finally {
    f.restore()
  }
})

// ---------- 自动钩子：同一条链接别重复发 ----------

test('auto 开着：同一条链接连着发两次，只转存一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-auto-'))
  const f = fakeService()
  try {
    const box = fakeApi({ settings: { auto: true, mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, config: { workspaceDir: dir } })
    const owner = (text) => ({ chatId: 'private:1', kind: 'private', userId: '1', text })
    assert.equal(await box.onMessage(owner('https://v.douyin.com/abc/')), true)
    assert.equal(await box.onMessage(owner('https://v.douyin.com/abc/')), true, '重复的链接也照样不惊动模型')
    assert.equal(f.calls.filter((n) => n === 'parse_url').length, 1, '第二次不该再解析 / 再发一遍')

    const talk = await box.onMessage(owner('你看看这个 https://v.douyin.com/abc/'))
    assert.equal(talk, false, '想聊的时候交给她')
    assert.equal(f.calls.filter((n) => n === 'parse_url').length, 1, '想聊也别重发媒体')
  } finally {
    f.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auto 开着：明说「再发一遍」就去重让路', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-auto-'))
  const f = fakeService()
  try {
    const box = fakeApi({ settings: { auto: true, mcpUrl: 'http://127.0.0.1:1/mcp/', apiKey: 'k' }, config: { workspaceDir: dir } })
    const owner = (text) => ({ chatId: 'private:1', kind: 'private', userId: '1', text })
    await box.onMessage(owner('https://v.douyin.com/abc/'))
    await box.onMessage(owner('再发一遍 https://v.douyin.com/abc/'))
    assert.equal(f.calls.filter((n) => n === 'parse_url').length, 2)
  } finally {
    f.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 按需启停 ----------
test('serviceBase：从 MCP 地址推到控制台根地址', () => {
  assert.equal(serviceBase('http://127.0.0.1:8000/mcp/'), 'http://127.0.0.1:8000')
  assert.equal(serviceBase('http://127.0.0.1:8000/mcp'), 'http://127.0.0.1:8000')
  assert.equal(serviceBase('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
  assert.equal(serviceBase(''), '')
})

test('serviceUp：只认 /readyz 的 status=ok', async () => {
  const original = globalThis.fetch
  const urls = []
  try {
    globalThis.fetch = async (url) => { urls.push(String(url)); return new Response('{"status":"ok"}', { status: 200 }) }
    assert.equal(await serviceUp({ mcpUrl: 'http://127.0.0.1:8000/mcp/' }), true)
    assert.equal(urls[0], 'http://127.0.0.1:8000/readyz')

    globalThis.fetch = async () => new Response('{"status":"degraded"}', { status: 200 })
    assert.equal(await serviceUp({ mcpUrl: 'http://127.0.0.1:8000/mcp/' }), false, 'degraded 不算就绪')

    globalThis.fetch = async () => new Response('nope', { status: 503 })
    assert.equal(await serviceUp({ mcpUrl: 'http://127.0.0.1:8000/mcp/' }), false)

    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    assert.equal(await serviceUp({ mcpUrl: 'http://127.0.0.1:8000/mcp/' }), false, '连不上就当没开')
  } finally {
    globalThis.fetch = original
  }
})

test('服务没开、又关了自动启动：给一句人话，不去拉 dtk', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const box = fakeApi({ settings: { autoStart: false, mcpUrl: 'http://127.0.0.1:1/mcp/' } })
    const tool = box.factory({ chat: ownerChat, level: 'full' })[0]
    const r = await tool.execute({ url: 'https://v.douyin.com/abc/' }, {})
    assert.equal(r.ok, false)
    assert.match(r.message, /没在运行/)
    assert.match(r.message, /dtk start/)
  } finally {
    globalThis.fetch = original
  }
})

test('按需启停的默认值：自动启动开、空闲 30 分钟关', () => {
  assert.equal(mod.defaults.autoStart, true)
  assert.equal(mod.defaults.idleMinutes, 30)
  assert.ok(mod.settings.some((s) => s.key === 'autoStart'))
  assert.ok(mod.settings.some((s) => s.key === 'idleMinutes'))
})

// ---------- 挂载与设置 ----------

function fakeApi({ settings = {}, sent = [], files = [], config = {}, visual = false, imageLib = null } = {}) {
  const box = { factory: null, rule: null, command: null, onMessage: null, context: null, sent, files, routes: {} }
  box.api = {
    id: mod.id,
    config: () => ({ ownerQQ: '1', workspaceDir: '', ...config }),
    settings: () => ({ ...mod.defaults, ...settings }),
    defineTool,
    tool: (fn) => { box.factory = fn },
    route: (path, handler) => { box.routes[path] = handler },
    command: (c) => { box.command = c },
    on: (event, fn) => { if (event === 'message') box.onMessage = fn },
    rule: (fn) => { box.rule = fn },
    context: (fn) => { box.context = fn },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    sendText: async (chatId, text) => { sent.push(text) },
    sendImage: async () => {},
    sendFile: async (chatId, file, name) => { files.push({ file, name }) },
    dsh: {},
    lib: (key) => {
      if (key !== 'core/img.js') throw new Error('没有这个内部文件')
      return imageLib || { imageToolBlock: async () => null }
    },
    core: {
      onebot: { call: async () => ({}) },
      hub: { canSeeImages: async () => visual },
      http: { body: async (req) => req?.body || {} },
    },
  }
  mod.setup(box.api)
  return box
}

const ownerChat = { chatId: 'private:1', kind: 'private' }

test('setup：群聊 / 系统会话没有工具，主人私聊有四个', () => {
  const box = fakeApi()
  assert.deepEqual(box.factory({ chat: { chatId: 'group:1', kind: 'group' }, level: 'social' }), [])
  assert.deepEqual(box.factory({ chat: { chatId: 'system', kind: 'system' }, level: 'full' }), [])
  const tools = box.factory({ chat: ownerChat, level: 'full' })
  assert.deepEqual(tools.map((t) => t.name), ['douyin_save', 'douyin_transcript', 'douyin_comments', 'douyin_look'])
  assert.equal(tools[1].slow, true, '转写要几十秒，得挂慢工具提示')
  assert.ok(tools[3].slow, '看图也要几十秒，得挂慢工具提示')
  assert.equal(typeof tools[3].output.render, 'function', 'douyin_look 要能往结果里带图')
})

test('setup：readAuto 关着时，工具描述只认「主人明说」', () => {
  const off = fakeApi({ settings: { readAuto: false } })
  const on = fakeApi({ settings: { readAuto: true } })
  const offTools = off.factory({ chat: ownerChat, level: 'full' })
  const onTools = on.factory({ chat: ownerChat, level: 'full' })
  assert.match(offTools[1].description, /只有主人明确说要/)
  assert.match(offTools[2].description, /只有主人明确说要/)
  assert.match(onTools[1].description, /可以自己判断|主人问起/)
  assert.doesNotMatch(onTools[1].description, /绝对不要用/)
})

test('setup：默认只发媒体（readAuto 默认关）', () => {
  assert.equal(mod.defaults.readAuto, false)
  assert.equal(mod.defaults.transcriptChars, 6000)
  assert.equal(mod.defaults.commentCount, 10)
})

test('setup：规则只进私聊，且点明读稿 / 读评论要主人明说', () => {
  const box = fakeApi()
  assert.equal(box.rule('social'), '')
  const rule = box.rule('private')
  assert.match(rule, /douyin_save/)
  assert.match(rule, /douyin_transcript/)
  assert.match(rule, /douyin_comments/)
  assert.match(rule, /douyin_look/)
  assert.match(rule, /不要主动读稿/)
  assert.match(rule, /别提工具名/, '别让她在聊天里报工具名 / 失败原因')
})

test('setup：/dy 默认走转存；没链接时说清楚', async () => {
  const box = fakeApi()
  assert.match(await box.command.run('', { chatId: 'private:1', kind: 'private' }), /没有抖音 \/ B站链接/)
  assert.match(await box.command.run('随便说点什么', { chatId: 'private:1', kind: 'private' }), /没有抖音 \/ B站链接/)
})

test('模块定义符合扩展接口', () => {
  assert.equal(mod.id, 'douyin-save')
  assert.equal(mod.api, 1)
  assert.equal(typeof mod.setup, 'function')
  assert.equal(mod.defaults.auto, false)
  assert.ok(mod.settings.some((s) => s.key === 'videoMode'))
  assert.ok(mod.settings.some((s) => s.key === 'readAuto'))
})
