// #255：系统自带语音兜底按平台选，自检不再写死 Windows 语音，拿到的 mp3 也能转成识别用的 WAV。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { systemVoiceEngine } from '../src/voice/tts.js'

test('系统语音兜底：Windows 用系统语音、macOS 用 say、其它平台没有', () => {
  assert.equal(systemVoiceEngine('win32'), 'windows')
  assert.equal(systemVoiceEngine('darwin'), 'say')
  assert.equal(systemVoiceEngine('linux'), '')
})

test('自检：有系统语音就先用系统语音，不再写死 windows', () => {
  const src = readFileSync(new URL('../src/modules/voice/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /textToSpeech\(text, \{ engine: 'windows' \}\)/)
  assert.match(src, /const system = systemVoiceEngine\(\)/)
  assert.match(src, /textToSpeech\(text, system \? \{ engine: system \} : \{\}\)/)
})

test('自检：非 WAV 音频先转 PCM16 WAV 再送识别', () => {
  const src = readFileSync(new URL('../src/modules/voice/index.js', import.meta.url), 'utf8')
  assert.match(src, /function asPcmWav \(file, buf, ffmpegPath = ''\)/)
  assert.match(src, /toMono16k\(asPcmWav\(file, readFileSync\(file\)/)
})

test('macOS say 调用把文本放在 -- 之后，避免正文被当成选项', () => {
  const src = readFileSync(new URL('../src/voice/tts.js', import.meta.url), 'utf8')
  assert.match(src, /'--data-format=LEI16@16000'[\s\S]{0,80}'--', text\]/)
})
