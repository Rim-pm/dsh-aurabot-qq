// RimTTS：用 RimTTS 项目（GPT-SoVITS api_v2 + Rim 的微调权重）念她的话。
//
// 这个模型很大，所以默认**不常驻**：
//   要说话 → 服务没在跑就先拉起来 → 等就绪（可选预热）→ 合成 → 空闲 idleSeconds 秒后关掉，把内存/显存还回去。
// 实测（RTX 4060 Ti / turbo 配置）：冷启动约 37 秒，起来后占约 4.3 GB 内存 + 2.2 GB 显存，
// 第一次合成还要再等约 7 秒做 CUDA 预热，热着一句话约 2.3 秒。所以：
//   · 起服务这段时间可以和模型思考并行（hub 里「对方明确要语音」时就会先 prewarm）；
//   · 空闲关之前留一点缓冲，连着说几句不用反复冷启动；
//   · 关是整进程杀掉（api_v2 没有「卸载模型」的接口），实测 0.4 秒释放干净。
//
// 如果端口上已经有服务在跑（比如 RimTTS 自带的划词朗读 rimreader），就直接用那一份：
// 不抢端口，也绝不去关不是我们起的进程。

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../core/store.js'

const WIN = process.platform === 'win32'
const MIN_AUDIO_BYTES = 4000
const POLL_MS = 400

// 我们自己拉起来的那个 api_v2。不是我们起的就一直是 null。
let child = null
// 起进程时用的地址，关的时候照这个发 /control?command=exit（配置中途改了也不会关错）
let childBase = ''
let coldMs = 0
let lastError = ''
let lastUse = 0
let lastHealthyAt = 0
let idleTimer = null
let starting = null
// 正在关的进程：新的合成请求要等它关干净再起，否则会撞端口
let stopping = null
// 单卡单实例：合成请求排队，别让两个请求在 GPU 上互相等
let queue = Promise.resolve()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function base(cfg) {
  return `http://127.0.0.1:${Number(cfg.port) || 9880}`
}

function rootOf(cfg) {
  return String(cfg.root || '').trim().replace(/[\\/]+$/, '')
}

/** tools/GPT-SoVITS 目录（api_v2.py 和它的 venv 都在这里）。 */
function gsvOf(cfg) {
  return join(rootOf(cfg), 'tools', 'GPT-SoVITS')
}

function pyOf(cfg) {
  return WIN ? join(gsvOf(cfg), '.venv', 'Scripts', 'python.exe') : join(gsvOf(cfg), '.venv', 'bin', 'python')
}

/** 面板里填的目录能不能用：根目录、venv、配置文件三个都在才算。 */
export function installed(cfg = {}) {
  if (!rootOf(cfg)) return false
  if (!existsSync(pyOf(cfg))) return false
  return existsSync(join(gsvOf(cfg), String(cfg.configYaml || 'GPT_SoVITS/configs/tts_infer_rim_turbo.yaml')))
}

function logPath() {
  const p = join(dataDir('rimtts'), 'api.log')
  mkdirSync(dirname(p), { recursive: true })
  return p
}

/** 起不来的时候把服务日志最后几行带出来，比「超时」两个字有用得多。 */
function logTail(n = 8) {
  try {
    const p = logPath()
    if (!existsSync(p) || statSync(p).size === 0) return ''
    const buf = readFileSync(p)
    return buf.slice(Math.max(0, buf.length - 4000)).toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n).join('\n')
  } catch (error) {
    return ''
  }
}

async function healthy(cfg, timeoutMs = 1500) {
  try {
    // RimTTS 自己的健康检查也是 HEAD /docs：GET 会去 CDN 拉 Swagger 静态资源，断网时会卡住
    const r = await fetch(`${base(cfg)}/docs`, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
    if (r.status < 500) {
      lastHealthyAt = Date.now()
      return true
    }
    return false
  } catch (error) {
    return false
  }
}

/** 参考音频：优先面板里填的，否则读 RimTTS 的 pipeline/refs_pool.json。
 *  只用第一条 —— RimTTS 实测轮换参考会让服务端每次重编码 prompt，同一句从 5 秒变 39 秒。 */
function refOf(cfg) {
  if (cfg.refAudio) {
    return { wav: String(cfg.refAudio), prompt_text: String(cfg.promptText || ''), lang: String(cfg.promptLang || 'ja') }
  }
  const root = rootOf(cfg)
  const poolPath = join(root, 'pipeline', 'refs_pool.json')
  if (!existsSync(poolPath)) throw new Error(`找不到参考音频池：${poolPath}`)
  const pool = JSON.parse(readFileSync(poolPath, 'utf8'))
  const list = pool[String(cfg.refGroup || 'narration')] || pool.narration || []
  for (const r of list) {
    const wav = isAbsolute(r.wav) ? r.wav : join(root, r.wav)
    if (existsSync(wav)) return { wav, prompt_text: String(r.prompt_text || ''), lang: String(r.lang || 'ja') }
  }
  throw new Error(`refs_pool.json 里没有可用的参考音频（分组：${cfg.refGroup || 'narration'}）`)
}

function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

/** 记一次「刚用过」，顺便把空闲关机的计时重新拨一遍。 */
function touch(cfg) {
  lastUse = Date.now()
  clearIdle()
  const seconds = Number(cfg.idleSeconds)
  if (!Number.isFinite(seconds) || seconds < 0) return
  if (seconds === 0) return // 0 = 念完立刻关，由调用方在 finally 里 stop
  idleTimer = setTimeout(() => {
    idleTimer = null
    stop().catch(() => {})
  }, seconds * 1000)
  idleTimer.unref?.() // 别因为这个计时器让 DSH 退不掉
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return
  try {
    if (WIN) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else proc.kill('SIGKILL')
  } catch (error) {}
}

/** 关掉我们自己起的服务。别人起的（child === null）不动。 */
export function stop() {
  if (stopping) return stopping
  stopping = (async () => {
    clearIdle()
    const proc = child
    child = null
    if (!proc) return
    // 先走 api_v2 自己的 /control?command=exit（它会给自己发 SIGTERM，干净退出）
    try {
      await fetch(`${childBase}/control?command=exit`, { signal: AbortSignal.timeout(3000) })
    } catch (error) {}
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && proc.exitCode === null) await sleep(100)
    killTree(proc)
    childBase = ''
  })()
  return stopping.finally(() => {
    stopping = null
  })
}

function spawnService(cfg) {
  const py = pyOf(cfg)
  const cwd = gsvOf(cfg)
  const yaml = String(cfg.configYaml || 'GPT_SoVITS/configs/tts_infer_rim_turbo.yaml')
  const port = Number(cfg.port) || 9880
  const log = logPath()
  // 日志只留最近的一段：模型加载会刷很多行，长期跑别让它涨到几百 MB
  try {
    if (existsSync(log) && statSync(log).size > 4 * 1024 * 1024) truncateSync(log, 0)
  } catch (error) {}
  const fd = openSync(log, 'a')
  let proc
  try {
    proc = spawn(py, ['api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', yaml], {
      cwd,
      windowsHide: true, // 不弹黑框（等同 Python 那边的 CREATE_NO_WINDOW）
      stdio: ['ignore', fd, fd],
    })
  } finally {
    closeSync(fd) // 子进程已经拿到自己的句柄，父进程这份可以关
  }
  proc.on('error', (error) => {
    lastError = `启动 api_v2 失败：${error.message}`
  })
  proc.on('exit', () => {
    if (child === proc) child = null
  })
  if (!proc.pid) {
    // spawn 失败（ENOENT 之类）不会 throw，只会发 error 事件；这里立刻报错，
    // 否则会傻等 maxWaitSeconds 那么久
    throw new Error(`起不来：执行不了 ${py}（GPT-SoVITS 的 venv 可能坏了）${lastError ? '：' + lastError : ''}`)
  }
  childBase = `http://127.0.0.1:${port}`
  child = proc
  return proc
}

async function waitReady(cfg, proc, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs
  const t0 = Date.now()
  while (Date.now() < deadline) {
    if (await healthy(cfg, 1200)) return Date.now() - t0
    if (proc.exitCode !== null) {
      throw new Error(`RimTTS 的 api_v2 起来就退了（退出码 ${proc.exitCode}）${logTail() ? '：\n' + logTail() : ''}`)
    }
    await sleep(POLL_MS)
  }
  throw new Error(`RimTTS 等了 ${Math.round(timeoutMs / 1000)} 秒还没就绪${logTail() ? '，服务日志最后几行：\n' + logTail() : ''}`)
}

/** 让服务可用（已经在跑就直接返回）。并发调用只会真的启动一次。 */
async function ensure(cfg, log) {
  if (stopping) await stopping.catch(() => {}) // 上一轮的空闲关机还没完，等它让出端口
  if (await healthy(cfg)) {
    touch(cfg)
    return true
  }
  if (!installed(cfg)) throw new Error('RimTTS 还没配置好：面板「语音」页填一下 RimTTS 项目目录（里面有 tools/GPT-SoVITS）')
  if (starting) return starting
  starting = (async () => {
    const timeoutMs = Math.max(30, Number(cfg.maxWaitSeconds) || 180) * 1000
    const t0 = Date.now()
    log?.info?.(`RimTTS 不在跑，启动推理服务（冷启动通常 30-40 秒）…`)
    const proc = spawnService(cfg)
    try {
      await waitReady(cfg, proc, timeoutMs, log)
    } catch (error) {
      lastError = error.message
      killTree(proc)
      if (child === proc) child = null
      throw error
    }
    coldMs = Date.now() - t0
    log?.info?.(`RimTTS 就绪，用时 ${(coldMs / 1000).toFixed(1)} 秒`)
    if (cfg.warmup) {
      // 起来后第一句要额外付一次 CUDA 预热（实测约 7 秒 vs 2.3 秒）。趁还没人说话先做掉。
      try {
        await requestTts(cfg, 'こんにちは、準備できました。', refOf(cfg), 'ja')
      } catch (error) {
        log?.warn?.(`RimTTS 预热失败（不影响后面用）：${error.message}`)
      }
    }
    touch(cfg)
    return true
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

async function requestTts(cfg, text, ref, lang) {
  const body = {
    text,
    text_lang: lang,
    ref_audio_path: ref.wav,
    prompt_text: ref.prompt_text,
    prompt_lang: ref.lang,
    text_split_method: 'cut5',
    speed_factor: Number(cfg.speed) || 1,
    top_k: 10,
    top_p: 1,
    temperature: 0.9,
    repetition_penalty: 1.35,
    media_type: 'wav',
    streaming_mode: false,
  }
  const r = await fetch(`${base(cfg)}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (!r.ok) throw new Error(`RimTTS 返回 HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 200)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < MIN_AUDIO_BYTES) throw new Error(`RimTTS 返回的音频太短：${buf.length} 字节`)
  return buf
}

/** 服务现在热着吗（同步判断，给「冷了就改发文字」用）。 */
export function hot() {
  if (child && child.exitCode === null) return true
  // 不是我们起的服务（比如划词朗读在跑）：刚确认过健康就算热
  return Date.now() - lastHealthyAt < 60_000
}

/** 提前把服务叫起来，和模型思考并行。失败了不吵，等真要说话时再报错。 */
export function prewarm(cfg = {}, log) {
  if (!cfg.prewarm || !installed(cfg)) return
  if (child && child.exitCode === null) return // 已经在跑（或正在起）
  ensure(cfg, log).catch((error) => log?.warn?.(`RimTTS 预启动没成功：${error.message}`))
}

/**
 * 合成一句话，返回音频文件路径。
 * @param {string} text
 * @param {object} cfg  voice.rimtts 那一段
 * @returns {Promise<string>}
 */
export function rimttsSynth(text, cfg = {}, log) {
  const run = async () => {
    if (!installed(cfg)) throw new Error('RimTTS 还没配置好：面板「语音」页填一下 RimTTS 项目目录（里面有 tools/GPT-SoVITS）')
    await ensure(cfg, log)
    const ref = refOf(cfg)
    let buf
    try {
      buf = await requestTts(cfg, text, ref, 'zh')
    } catch (error) {
      // 卡死 / 超时的话留着这个进程只会更糟：关掉，下次重新起
      if (/aborted|timeout/i.test(error.message)) await stop().catch(() => {})
      lastError = error.message
      throw error
    }
    const dir = dataDir('voice-cache')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${randomUUID()}.wav`)
    writeFileSync(file, buf)
    touch(cfg)
    if (Number(cfg.idleSeconds) === 0) await stop().catch(() => {})
    return file
  }
  // 排队：单卡上两个合成请求同时进来会互相等，还不如老老实实一个接一个
  const p = queue.then(run, run)
  queue = p.catch(() => {})
  return p
}

/** 面板「语音」页看状态用。 */
export function status(cfg = {}) {
  return {
    configured: installed(cfg),
    running: Boolean(child && child.exitCode === null),
    own: Boolean(child),
    pid: child?.pid || 0,
    coldMs,
    idleSeconds: Number(cfg.idleSeconds),
    idleMs: lastUse ? Date.now() - lastUse : 0,
    lastError,
  }
}

// DSH 被关掉时别把模型进程留在后台占内存。exit 里只能同步做，用 taskkill。
process.once('exit', () => {
  if (child && child.exitCode === null) killTree(child)
})
