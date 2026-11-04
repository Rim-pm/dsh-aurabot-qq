// RimTTS 引擎：配置默认值、目录探测、没配置好时的行为。
// 真起模型的那部分（冷启动 / 空闲关）不在这里测——那要 30 秒和一块显卡，见 docs/RIM-TTS.md 的冒烟脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalize } from '../src/core/config.js'
import { installed, status, hot, rimttsSynth } from '../src/voice/rimtts.js'

test('RimTTS 配置：默认不接管语音，按需起、空闲 180 秒关、起不来改发文字', () => {
  const c = normalize({})
  assert.equal(c.voice.engine, 'auto', '默认还是 auto，不会悄悄换成大模型')
  assert.equal(c.voice.rimtts.root, '', '没填目录就不算配置好')
  assert.equal(c.voice.rimtts.port, 9880)
  assert.equal(c.voice.rimtts.idleSeconds, 180, '默认留 3 分钟，连着说几句不用反复冷启动')
  assert.equal(c.voice.rimtts.warmup, true)
  assert.equal(c.voice.rimtts.prewarm, true)
  assert.equal(c.voice.rimtts.noFallback, true, '起不来就改发文字，不要机械音')
})

test('RimTTS 配置：engine 认 rimtts，乱填的数值夹回范围', () => {
  const c = normalize({ voice: { engine: 'rimtts', rimtts: { idleSeconds: -5, port: 80, speed: 9, maxWaitSeconds: 5 } } })
  assert.equal(c.voice.engine, 'rimtts')
  assert.equal(c.voice.rimtts.idleSeconds, 0, '-5 夹成 0 = 念完立刻关')
  assert.equal(c.voice.rimtts.port, 1024)
  assert.equal(c.voice.rimtts.speed, 1.6)
  assert.equal(c.voice.rimtts.maxWaitSeconds, 30)
})

test('RimTTS：没填目录 / 目录不对，就当没装，也不会去起进程', () => {
  assert.equal(installed({ root: '' }), false)
  assert.equal(installed({ root: join(tmpdir(), 'definitely-not-a-rimtts-dir') }), false)
  const s = status({ root: '' })
  assert.equal(s.configured, false)
  assert.equal(s.running, false)
  assert.equal(hot(), false, '没在跑就是冷的：短回复别顺手变语音')
})

test('RimTTS：venv 和配置文件都在才算装好', () => {
  const root = join(tmpdir(), `rimtts-fake-${process.pid}`)
  const gsv = join(root, 'tools', 'GPT-SoVITS')
  mkdirSync(join(gsv, 'GPT_SoVITS', 'configs'), { recursive: true })
  try {
    assert.equal(installed({ root }), false, '没有 venv 不算')
    const py = process.platform === 'win32' ? join(gsv, '.venv', 'Scripts', 'python.exe') : join(gsv, '.venv', 'bin', 'python')
    mkdirSync(join(py, '..'), { recursive: true })
    writeFileSync(py, '')
    assert.equal(installed({ root }), false, '没有配置文件不算')
    writeFileSync(join(gsv, 'GPT_SoVITS', 'configs', 'tts_infer_rim_turbo.yaml'), 'custom: {}')
    assert.equal(installed({ root }), true)
    assert.equal(status({ root }).configured, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RimTTS：没配置好时合成直接报错，交给上层决定改发文字', async () => {
  await assert.rejects(() => rimttsSynth('你好呀', { root: '' }), /RimTTS 还没配置好/)
})
