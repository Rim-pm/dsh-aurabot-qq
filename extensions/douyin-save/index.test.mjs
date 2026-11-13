// 抖音转存扩展的纯逻辑测试：不联网、不碰 QQ。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import mod, {
  pickLink, platformOf, apiKeyOf, parseMcpResponse, mcpCall, settleTask,
  splitText, parseCommand, formatComments, transcriptText, wantsRead, chatIntent,
  serviceBase, serviceUp,
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

/** 假的一整套：/readyz 就绪、parse_url 给一条视频、媒体随便几个字节。 */
function fakeService({ title = '测试视频', kind = 'video' } = {}) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/readyz')) return new Response('{"status":"ok"}', { status: 200 })
    if (u.includes('/mcp')) {
      const body = JSON.parse(init.body)
      calls.push(body.params.name)
      const text = body.params.name === 'parse_url'
        ? JSON.stringify({ status: 'ok', data: { kind, platform: 'douyin', content_id: '1', title, media: { video: { urls: ['http://127.0.0.1:1/media.mp4'] } } } })
        : JSON.stringify({ status: 'ok' })
      return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } }) + '\n', { status: 200 })
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp4' } })
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
    assert.match(ctx, /douyin_transcript/)
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

function fakeApi({ settings = {}, sent = [], files = [], config = {} } = {}) {
  const box = { factory: null, rule: null, command: null, onMessage: null, context: null, sent, files }
  box.api = {
    id: mod.id,
    config: () => ({ ownerQQ: '1', workspaceDir: '', ...config }),
    settings: () => ({ ...mod.defaults, ...settings }),
    defineTool: (d) => d,
    tool: (fn) => { box.factory = fn },
    command: (c) => { box.command = c },
    on: (event, fn) => { if (event === 'message') box.onMessage = fn },
    rule: (fn) => { box.rule = fn },
    context: (fn) => { box.context = fn },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    sendText: async (chatId, text) => { sent.push(text) },
    sendImage: async () => {},
    sendFile: async (chatId, file, name) => { files.push({ file, name }) },
    core: { onebot: { call: async () => ({}) } },
  }
  mod.setup(box.api)
  return box
}

const ownerChat = { chatId: 'private:1', kind: 'private' }

test('setup：群聊 / 系统会话没有工具，主人私聊有三个', () => {
  const box = fakeApi()
  assert.deepEqual(box.factory({ chat: { chatId: 'group:1', kind: 'group' }, level: 'social' }), [])
  assert.deepEqual(box.factory({ chat: { chatId: 'system', kind: 'system' }, level: 'full' }), [])
  const tools = box.factory({ chat: ownerChat, level: 'full' })
  assert.deepEqual(tools.map((t) => t.name), ['douyin_save', 'douyin_transcript', 'douyin_comments'])
  assert.equal(tools[1].slow, true, '转写要几十秒，得挂慢工具提示')
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
  assert.match(rule, /不要主动读稿/)
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
