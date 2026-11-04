// 抖音转存扩展的纯逻辑测试：不联网、不碰 QQ。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import mod, { pickLink, apiKeyOf, parseMcpResponse, mcpCall } from './index.mjs'

test('pickLink：从分享文案里挑出链接', () => {
  assert.equal(pickLink('2.51 复制打开抖音 https://v.douyin.com/51etr3NbKwA/ bAT:/ 10/09'), 'https://v.douyin.com/51etr3NbKwA/')
  assert.equal(pickLink('看看这个 https://www.douyin.com/video/7700621592283368746'), 'https://www.douyin.com/video/7700621592283368746')
  assert.equal(pickLink('没有链接'), '')
  assert.equal(pickLink('https://www.bilibili.com/video/BV1xx'), '')
})

test('pickLink：去掉链接末尾的标点', () => {
  assert.equal(pickLink('看这个 https://v.douyin.com/abc/。'), 'https://v.douyin.com/abc/')
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

test('setup：群聊没有工具，主人私聊有；规则只进私聊', () => {
  let factory = null
  let rule = null
  const api = {
    id: mod.id,
    config: () => ({ ownerQQ: '1', workspaceDir: '' }),
    settings: () => ({ ...mod.defaults }),
    defineTool: (d) => d,
    tool: (fn) => { factory = fn },
    command: () => {},
    on: () => {},
    rule: (fn) => { rule = fn },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    sendImage: async () => {},
    sendFile: async () => {},
    core: { onebot: { call: async () => ({}) } },
  }
  mod.setup(api)
  assert.deepEqual(factory({ chat: { chatId: 'group:1', kind: 'group' }, level: 'social' }), [])
  assert.deepEqual(factory({ chat: { chatId: 'system', kind: 'system' }, level: 'full' }), [])
  const tools = factory({ chat: { chatId: 'private:1', kind: 'private' }, level: 'full' })
  assert.equal(tools.name, 'douyin_save')
  assert.match(rule('private'), /douyin_save/)
  assert.equal(rule('social'), '')
})

test('模块定义符合扩展接口', () => {
  assert.equal(mod.id, 'douyin-save')
  assert.equal(mod.api, 1)
  assert.equal(typeof mod.setup, 'function')
  assert.equal(mod.defaults.auto, false)
  assert.ok(mod.settings.some((s) => s.key === 'videoMode'))
})
