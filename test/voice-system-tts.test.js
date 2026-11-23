// #255：系统自带语音兜底按平台选，自检不再写死 Windows 语音。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { systemVoiceEngine } from '../src/voice/tts.js'

test('系统语音兜底：Windows 用系统语音、macOS 用 say、其它平台没有', () => {
  assert.equal(systemVoiceEngine('win32'), 'windows')
  assert.equal(systemVoiceEngine('darwin'), 'say')
  assert.equal(systemVoiceEngine('linux'), '')
})

test('自检不再把引擎写死成 windows', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/modules/voice/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /textToSpeech\(text, \{ engine: 'windows' \}\)/)
  assert.match(src, /textToSpeech\(text\)/)
})
