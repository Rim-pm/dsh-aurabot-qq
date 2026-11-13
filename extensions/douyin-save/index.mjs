// Aurabot 用户扩展：抖音 / B站链接 → 视频 / 图集，直接发回 QQ；主人要的时候还能读文字稿、读评论。
//
// 解析走本机的 DouYinDownload（dtk）MCP：http://127.0.0.1:8000/mcp/
// 它只负责「这个链接是什么、媒体地址在哪」；下载和发到 QQ 都在插件这边做，
// 因为 MCP 把文件存在服务端磁盘上，不会自己传过来。
//
// 转写和评论反过来：文字本来就是服务端算的（download_media → transcribe_video，
// list_comments），插件只把结果整理成聊天里能看的样子。
// 默认只发媒体；读稿 / 读评论要主人明说，或者敲 /dy 转写、/dy 评论。
// 支持抖音（含 v.douyin.com 短链）和 B站（含 b23.tv 短链）；TikTok 还没接。

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
// 抖音（含 v.douyin.com 短链）和 B站（含 b23.tv / bili2233.cn 短链）。TikTok 暂时不接。
const LINK_RE = /https?:\/\/(?:(?:[\w-]+\.)?(?:douyin\.com|iesdouyin\.com|bilibili\.com)|(?:b23\.tv|bili2233\.cn))\/[^\s"'<>，。、]+/i
/** 下载媒体时按平台带 Referer：抖音 CDN 要，B站 大多不校验但带了更稳。 */
const REFERER = { douyin: 'https://www.douyin.com/', bilibili: 'https://www.bilibili.com/' }
const WORKSPACE = join(homedir(), 'Aurabot', 'qq-chats')
/** 一条 QQ 消息最多带多少字；文字稿超过就分几条发。 */
const MSG_CHARS = 1500
/** 文字稿太长当文件发时，聊天里留的开头预览。 */
const PREVIEW_CHARS = 500
/** 自动转存过的链接记多久：这段时间里主人说「这个」，指的就是它。 */
const RECENT_MS = 30 * 60 * 1000
/** 同一条链接刚发过就不重复发（链接和「你看看这个」并成一条时，模型容易再调一次工具）。 */
const DEDUPE_MS = 2 * 60 * 1000
/** 主人明说要再发一遍时，上面的去重让路。 */
const RESEND_RE = /再发|重发|重新发|再来一遍|再发一次|再发一遍/

let seq = 0

/** 从一段话里挑出第一个抖音 / B站链接。 */
export function pickLink(text) {
  const m = String(text || '').match(LINK_RE)
  return m ? m[0].replace(/[),.;!?，。、！？）】]+$/, '') : ''
}

/** 这个链接属于哪个平台（下载时决定 Referer；作品数据里另有 platform 字段为准）。 */
export function platformOf(url) {
  return /bilibili\.com|b23\.tv|bili2233\.cn/i.test(String(url || '')) ? 'bilibili' : 'douyin'
}

/** MCP 地址（…/mcp/）→ 控制台根地址（/readyz、/api/v1/… 都挂在它下面）。 */
export function serviceBase(mcpUrl) {
  return String(mcpUrl || '').trim().replace(/\/+$/, '').replace(/\/mcp$/, '')
}

/** 服务在不在：和 dtk 自己判断「就绪」用的是同一个探针。 */
export async function serviceUp(settings, timeoutMs = 2500) {
  const base = serviceBase(settings?.mcpUrl)
  if (!base) return false
  try {
    const res = await fetch(base + '/readyz', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const json = await res.json().catch(() => null)
    return json?.status === 'ok'
  } catch (error) {
    return false
  }
}

/** 跑一条 dtk 子命令（start / stop），不占她的回复，不等它跑完。 */
function runDtk(args, log) {
  const exe = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DouYinDownload', 'dtk.exe') : ''
  const cmd = exe && existsSync(exe) ? exe : 'dtk'
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => log?.warn?.(`跑 dtk ${args[0]} 没成功：`, error.message))
    child.unref()
    return true
  } catch (error) {
    log?.warn?.(`跑 dtk ${args[0]} 没成功：`, error.message)
    return false
  }
}

/** 服务里还有没有在跑的下载（有就先别关，等它下完）。 */
async function busyElsewhere(settings) {
  const base = serviceBase(settings?.mcpUrl)
  const key = apiKeyOf(settings)
  if (!base || !key) return false
  try {
    const res = await fetch(base + '/api/v1/downloads/storage', {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return false
    const json = await res.json().catch(() => null)
    const d = json?.data || {}
    const dl = d.downloader || {}
    return Number(d.in_flight || 0) > 0 || Number(dl.queued || 0) > 0 || Number(dl.running || 0) > 0
  } catch (error) {
    return false
  }
}

/** 压成一行、截断：评论和标题里常有换行，直接拼进消息会乱。 */
function oneLine(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, Math.max(1, Number(max) || 80))
}

/** 毫秒 → 3:05；没有时长就返回空串。 */
function mmss(ms) {
  const total = Math.round((Number(ms) || 0) / 1000)
  if (total <= 0) return ''
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 文件名里不能有的字符去掉，免得写盘失败。 */
function safeName(value) {
  return String(value || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
}

/** 从 dtk 自己的项目目录里找账号文件（`dtk where` 第一行就是）。 */
function keyFromDtkRoot() {
  try {
    const out = execFileSync('dtk', ['where'], { encoding: 'latin1', timeout: 8000, windowsHide: true })
    const root = (String(out).match(/[A-Za-z]:[\\/][^\r\n]+/) || [])[0]
    if (!root) return ''
    const file = join(root.trim(), 'console-account.txt')
    if (!existsSync(file)) return ''
    const m = readFileSync(file, 'utf8').match(/api-key[^:]*:\s*(dtk_\S+)/i)
    return m ? m[1] : ''
  } catch (error) {
    return ''
  }
}

let cachedKey = ''

/** MCP 的 key：设置里填了就用；没填先看账号文件，再问 dtk 的项目目录。 */
export function apiKeyOf(settings) {
  const own = String(settings?.apiKey || '').trim()
  if (own) return own
  const file = String(settings?.accountFile || '').trim()
  if (file && existsSync(file)) {
    try {
      const m = readFileSync(file, 'utf8').match(/api-key[^:]*:\s*(dtk_\S+)/i)
      if (m) return m[1]
    } catch (error) {}
  }
  if (!cachedKey) cachedKey = keyFromDtkRoot()
  return cachedKey
}

/** MCP 回的是 SSE（event: message / data: {...}）或者裸 JSON，两种都认。 */
export function parseMcpResponse(text) {
  const raw = String(text || '').trim()
  const payload = raw.startsWith('event:')
    ? raw.split(/\r?\n/).filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
    : raw
  return JSON.parse(payload)
}

/** 调一次 dtk 的 MCP 工具，返回它的 JSON 结果。 */
export async function mcpCall(settings, name, args, timeoutMs = 60000) {
  const url = String(settings?.mcpUrl || '').trim()
  const key = apiKeyOf(settings)
  if (!url) throw new Error('没配 MCP 地址')
  if (!key) throw new Error('没找到 dtk 的 API Key（面板里填一个，或改 accountFile 路径）')
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`连不上抖音下载服务（${url}）。先在终端跑 dtk start，看到「已就绪」再试`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`抖音下载服务回了 HTTP ${res.status}${body ? '：' + body.slice(0, 120) : ''}`)
  }
  let json
  try {
    json = parseMcpResponse(await res.text())
  } catch (error) {
    throw new Error('抖音下载服务回的内容看不懂')
  }
  if (json.error) throw new Error(json.error.message || 'MCP 调用失败')
  const out = json.result || {}
  const body = (out.content || []).map((c) => c.text || '').join('\n')
  if (out.isError) throw new Error(body.slice(0, 300) || 'MCP 工具报错')
  try {
    return JSON.parse(body)
  } catch (error) {
    return { raw: body }
  }
}

/**
 * 服务端一次工具调用最多等 api.mcp_tool_timeout（默认 60 秒），
 * 视频大一点、转写长一点就会回 status: "pending" 加一个 task_id。
 * 这里用 get_task_result 接着等，别让主人自己再喊一遍（那样会重复排队）。
 */
export async function settleTask(settings, out, { tries = 40, gapMs = 1500, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let cur = out
  for (let i = 0; cur && cur.status === 'pending' && cur.task_id && i < tries; i++) {
    await wait(gapMs)
    let next
    try {
      next = await mcpCall(settings, 'get_task_result', { task_id: cur.task_id }, 120000)
    } catch (error) {
      return { ...cur, status: 'error', message: error.message }
    }
    // 下载 / 转写的 id 在 pending 那次也带着，收结果时别弄丢
    cur = {
      ...cur,
      ...next,
      download_id: next.download_id || cur.download_id,
      transcription_id: next.transcription_id || cur.transcription_id,
    }
  }
  return cur
}

/** 把长文本按句子边界切开，尽量每段不超过 size 字。 */
export function splitText(text, size = MSG_CHARS) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!s) return []
  const limit = Math.max(200, Number(size) || MSG_CHARS)
  if (s.length <= limit) return [s]
  const out = []
  let rest = s
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
      window.lastIndexOf('\n'), window.lastIndexOf('；'), window.lastIndexOf('，'),
    )
    if (cut < limit * 0.5) cut = limit - 1 // 一句都断不开就硬切
    const part = rest.slice(0, cut + 1).trim()
    if (part) out.push(part)
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) out.push(rest)
  return out
}

const MODE_WORDS = [
  { mode: 'comments', re: /^(评论|热评|留言)/ },
  { mode: 'transcript', re: /^(转写|转文字|文字稿|文字|字幕|总结|摘要|概括)/ },
]

/**
 * 这句话是不是在要文字稿 / 评论（不要求开头就是动词，正常说话也算）。
 * 「收到链接就自动发」开着时靠它让路：主人说要转写，就不能被自动转存吞掉。
 */
export function wantsRead(text) {
  return /转写|转文字|文字稿|字幕|讲了什么|讲了啥|说了什么|说啥|总结|摘要|概括|评论|热评|留言/.test(String(text || ''))
}

/**
 * 这句话是不是在跟主人聊那条视频（而不是单纯要文件）。
 * 抖音分享文案里自带「看看【…】」，所以不能拿裸「看看」当信号，得是「你看看」「看看这个」这种。
 */
export function chatIntent(text) {
  return /你看看|看看这个|看看那条|看下这个|看一下这个|你觉得|你怎么看|怎么样|好看吗|什么感觉|有意思吗|评价一下|说说这个|聊聊/.test(String(text || ''))
}

/** 解析 /dy 的参数：默认是转存，开头有「转写 / 评论」这类词就换成对应的活。 */
export function parseCommand(arg) {
  const raw = String(arg || '').trim()
  if (!raw) return { mode: 'save', text: '' }
  for (const { mode, re } of MODE_WORDS) {
    const m = raw.match(re)
    if (!m) continue
    // 「评论」后面得真跟了点东西才算；光一个词当作没链接，交回去报错更清楚
    return { mode, text: raw.slice(m[0].length).replace(/^[:：\s]+/, '') }
  }
  return { mode: 'save', text: raw }
}

/** 转写结果 → 文字稿正文（没成的时候是空串）。 */
export function transcriptText(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  return String(data?.text || '').trim()
}

/** 评论列表 → 聊天里能看的一段话（一条都没有就返回空串）。 */
export function formatComments(payload, { max = 10, title = '' } = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const items = (Array.isArray(data?.items) ? data.items : []).slice(0, Math.max(1, Number(max) || 10))
  if (!items.length) return ''
  const lines = items.map((c, i) => {
    const nick = oneLine(c?.author?.nickname, 20) || '匿名'
    const body = oneLine(c?.text, 120)
    const bits = []
    if (Number(c?.digg_count)) bits.push(`赞 ${Number(c.digg_count)}`)
    if (Number(c?.reply_count)) bits.push(`${Number(c.reply_count)} 条回复`)
    if (c?.is_pinned) bits.push('置顶')
    return `${i + 1}. ${nick}：${body}${bits.length ? `（${bits.join(' · ')}）` : ''}`
  })
  const head = title ? `《${oneLine(title, 30)}》的评论` : '评论'
  return `${head}（${items.length} 条）：\n${lines.join('\n')}`
}

async function grab(url, { referer = REFERER.douyin, timeoutMs = 60000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`下载媒体失败：HTTP ${res.status}`)
  return { buf: Buffer.from(await res.arrayBuffer()), type: String(res.headers.get('content-type') || '') }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 图集里的图多半是 webp，QQ 那边不一定认，转成 jpg 再发。 */
async function toJpeg(file, out, ffmpeg) {
  try {
    await run(ffmpeg || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-q:v', '3', out], { timeout: 30000 })
    return true
  } catch (error) {
    return false
  }
}

/** 把作品里的媒体发到聊天里，返回一句给模型看的结果。 */
async function deliver(api, chat, data, settings) {
  const dir = join(String(api.config()?.workspaceDir || '').trim() || WORKSPACE, '_douyin_tmp', stamp())
  mkdirSync(dir, { recursive: true })
  const title = String(data.title || '').replace(/\s+/g, ' ').slice(0, 60)
  const kind = String(data.kind || '')
  const media = data.media || {}
  const referer = REFERER[String(data.platform || '')] || REFERER.douyin
  const partNote = Array.isArray(data.parts) && data.parts.length > 1 ? `（多 P 视频，共 ${data.parts.length} P）` : ''
  let sent = 0
  try {
    if (kind === 'image_album' || (Array.isArray(media.images) && media.images.length)) {
      const images = (media.images || []).slice(0, Math.max(1, Number(settings.maxImages) || 9))
      for (const [i, img] of images.entries()) {
        const url = (img.urls && img.urls[0]) || img.url
        if (!url) continue
        const got = await grab(url, { referer })
        const webp = /webp/i.test(got.type) || /\.webp(\?|$)/i.test(url)
        const raw = join(dir, `image-${String(i + 1).padStart(2, '0')}.${webp ? 'webp' : 'jpg'}`)
        writeFileSync(raw, got.buf)
        let file = raw
        if (webp) {
          const jpg = raw.replace(/\.webp$/, '.jpg')
          if (await toJpeg(raw, jpg, settings.ffmpeg)) file = jpg
        }
        await api.sendImage(chat.chatId, file)
        sent += 1
      }
      if (!sent) return { ok: false, message: '这个图集没取到图片' }
      return { ok: true, message: `发了 ${sent} 张图${title ? `：《${title}》` : ''}` }
    }

    const videoUrl = (media.video && ((media.video.urls && media.video.urls[0]) || media.video.url)) || ''
    if (!videoUrl) {
      return {
        ok: false,
        message: data.platform === 'bilibili'
          ? '没取到 B 站的播放地址（老视频、充电专属或者要登录才能看的拿不到）'
          : '这个链接里没有能发的视频或图片',
      }
    }
    const got = await grab(videoUrl, { referer, timeoutMs: 180000 })
    const cap = Math.max(1, Number(settings.maxMB) || 200) * 1024 * 1024
    if (got.buf.length > cap) return { ok: false, message: `视频太大（${(got.buf.length / 1024 / 1024).toFixed(0)} MB）` }
    const file = join(dir, 'video.mp4')
    writeFileSync(file, got.buf)

    if (String(settings.videoMode || 'video') === 'video') {
      const isGroup = chat.kind === 'group'
      const uri = 'file:///' + file.replace(/\\/g, '/')
      const params = isGroup
        ? { group_id: Number(chat.groupId), message: [{ type: 'video', data: { file: uri } }] }
        : { user_id: Number(chat.userId), message: [{ type: 'video', data: { file: uri } }] }
      try {
        await api.core.onebot.call(isGroup ? 'send_group_msg' : 'send_private_msg', params, { timeoutMs: 180000 })
        return { ok: true, message: `视频发出去了${title ? `：《${title}》` : ''}（${(got.buf.length / 1024 / 1024).toFixed(1)} MB）${partNote}` }
      } catch (error) {
        api.log.warn('视频消息发不出去，改当文件发：', error.message)
      }
    }
    await api.sendFile(chat.chatId, file, (title || 'video') + '.mp4')
    return { ok: true, message: `视频当文件发出去了${title ? `：《${title}》` : ''}（${(got.buf.length / 1024 / 1024).toFixed(1)} MB）${partNote}` }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
  }
}

/** 一条消息装不下就分几条发，别被网关截断。 */
async function sendLong(api, chat, text) {
  const parts = splitText(text, MSG_CHARS)
  for (const part of parts) await api.sendText(chat.chatId, part)
  return parts.length
}

/**
 * 文字稿发到聊天：短的直接分条发；长的当 txt 文件发，聊天里留一段开头。
 * 口播 30 分钟能有一万多字，糊一屏没法看。
 */
async function deliverTranscript(api, chat, text, meta, settings) {
  const cap = Math.max(500, Number(settings.transcriptChars) || 6000)
  const head = `${meta.title ? `《${oneLine(meta.title, 30)}》` : '这个视频'}的文字稿${meta.dur ? `（${meta.dur}）` : ''}，共 ${text.length} 字`
  if (text.length <= cap) {
    await sendLong(api, chat, `${head}\n\n${text}`)
    return { via: 'chat' }
  }
  const name = `文字稿-${safeName(meta.title) || stamp()}.txt`
  const dir = join(String(api.config()?.workspaceDir || '').trim() || WORKSPACE, '_douyin_tmp', stamp())
  mkdirSync(dir, { recursive: true })
  try {
    const file = join(dir, name)
    writeFileSync(file, `${head}\n\n${text}\n`, 'utf8')
    await api.sendFile(chat.chatId, file, name)
    await api.sendText(chat.chatId, `${head}，一条发不完，全文当文件发你了。开头是这样：\n\n${text.slice(0, PREVIEW_CHARS)}…`)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
  }
  return { via: 'file' }
}

export default {
  id: 'douyin-save',
  name: '抖音 / B站链接转存',
  version: '0.5.0',
  api: 1,
  description: '主人发来抖音 / B站链接时，把视频 / 图集取下来直接发回 QQ；明确要的时候还能读文字稿、读评论。下载服务按需启动、空闲自动关闭（走本机 DouYinDownload 的 MCP）',
  defaults: {
    mcpUrl: 'http://127.0.0.1:8000/mcp/',
    apiKey: '',
    accountFile: '',
    auto: false,
    videoMode: 'video',
    maxImages: 9,
    maxMB: 200,
    ffmpeg: 'ffmpeg',
    readAuto: false,
    transcriptChars: 6000,
    commentCount: 10,
    autoStart: true,
    idleMinutes: 30,
  },
  settings: [
    { key: 'mcpUrl', label: 'MCP 地址', type: 'text', hint: 'DouYinDownload 的 MCP 接入点，末尾斜杠要保留', placeholder: 'http://127.0.0.1:8000/mcp/' },
    { key: 'apiKey', label: 'API Key', type: 'password', hint: '留空 = 从下面的账号文件里读' },
    { key: 'accountFile', label: '账号文件', type: 'text', hint: '留空 = 自动用 dtk 项目目录里的 console-account.txt' },
    { key: 'auto', label: '收到链接就自动发', type: 'switch', hint: '关着时只有主人明确让她「下载发我」才会做' },
    { key: 'videoMode', label: '视频怎么发', type: 'select', options: [{ value: 'video', label: '视频消息（发不了自动改文件）' }, { value: 'file', label: '当文件发' }] },
    { key: 'maxImages', label: '图集最多发几张', type: 'number', min: 1, max: 30, step: 1 },
    { key: 'maxMB', label: '视频大小上限（MB）', type: 'number', min: 1, max: 500, step: 1 },
    { key: 'ffmpeg', label: 'ffmpeg 路径', type: 'text', hint: '留空用 PATH 里的；图集的 webp 靠它转 jpg' },
    { key: 'readAuto', label: '允许她自己判断读稿 / 读评论', type: 'switch', hint: '关着（默认）时只有主人明说要转写、要看评论，或者敲 /dy 转写，她才会做；只发链接永远只发媒体' },
    { key: 'transcriptChars', label: '文字稿多少字以内直接发', type: 'number', min: 500, max: 20000, step: 500, hint: '超过就当 txt 文件发，聊天里留一段开头' },
    { key: 'commentCount', label: '读几条评论', type: 'number', min: 1, max: 30, step: 1 },
    { key: 'autoStart', label: '服务没开就自动启动', type: 'switch', hint: '关掉后服务没运行时会直接告诉你「先跑 dtk start」' },
    { key: 'idleMinutes', label: '空闲多久自动关闭服务', type: 'number', min: 0, max: 1440, step: 5, hint: '分钟；0 = 一直开着。关掉能省下 WSL 那 2~3 GB，下次用会自己再起来' },
  ],

  setup(api) {
    const settings = () => api.settings()

    // ---------- 按需启停：不用的时候 WSL + 6 个容器一直占着 2~3 GB，太亏 ----------
    let starting = null // 正在启动时共用一个 Promise，别并发拉两次 dtk start
    let idleTimer = null
    let busy = 0 // 正在处理的请求数：干活的时候绝不关服务

    // 最近自动转存过的链接（按 chatId）：主人紧接着说「你看看这个」时，得让她知道指的是哪条
    const recent = new Map()
    const remember = (chatId, data, link) => {
      recent.set(String(chatId), {
        link,
        title: oneLine(data.title, 60),
        platform: String(data.platform || ''),
        kind: String(data.kind || ''),
        at: Date.now(),
      })
    }
    const recentOf = (chatId) => {
      const r = recent.get(String(chatId))
      if (!r) return null
      if (Date.now() - r.at > RECENT_MS) { recent.delete(String(chatId)); return null }
      return r
    }

    const idleMs = () => Math.max(0, Number(settings().idleMinutes) || 0) * 60000

    /** 每次用完重置空闲计时；到点还没人用就把整栈关掉。 */
    const scheduleIdle = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      const ms = idleMs()
      if (ms <= 0) return
      idleTimer = setTimeout(() => { idleTimer = null; idleStop().catch(() => {}) }, ms)
      idleTimer.unref?.()
    }

    const idleStop = async () => {
      if (busy > 0) return scheduleIdle() // 还有活没干完，往后挪
      if (await busyElsewhere(settings())) return scheduleIdle() // 控制台/终端里还有下载在跑
      if (!(await serviceUp(settings()))) return // 本来就没开
      const mins = idleMs() / 60000
      const howLong = mins >= 1 ? `${Math.round(mins)} 分钟` : `${Math.max(1, Math.round(mins * 60))} 秒`
      api.log.info(`抖音下载服务空闲 ${howLong}，关掉回收内存（下次用会自动再起）`)
      runDtk(['stop'], api.log)
    }

    /** 服务没开就拉起来；没开自动启动的话返回 false，让调用方给一句人话。 */
    const ensureUp = async () => {
      const s = settings()
      if (await serviceUp(s)) return true
      if (!s.autoStart) return false
      if (!starting) {
        api.log.info('抖音下载服务没在运行，正在启动（第一次要等 WSL 和容器起来）…')
        starting = (async () => {
          if (!runDtk(['start'], api.log)) return false
          const deadline = Date.now() + 240000
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
            if (await serviceUp(settings())) {
              api.log.info('抖音下载服务已就绪')
              return true
            }
          }
          api.log.warn('抖音下载服务 4 分钟内没起来，看看终端里 dtk start 的输出')
          return false
        })().finally(() => { starting = null })
      }
      return starting
    }

    /** 把一次操作包起来：保证服务在跑，干完顺手重置空闲计时。 */
    const withService = async (fn) => {
      busy += 1
      try {
        if (!(await ensureUp())) {
          return {
            ok: false,
            message: '抖音下载服务没在运行，自动启动也没起来。终端里跑一下 dtk start 看看报什么错。',
          }
        }
        return await fn()
      } finally {
        busy -= 1
        scheduleIdle()
      }
    }

    /** 短链展开偶尔会失败（服务端说 retryable），隔一秒再试一次，别让她自己重来。 */
    const parseUrl = async (link) => {
      let last
      for (let i = 0; i < 2; i++) {
        try {
          return await mcpCall(settings(), 'parse_url', { url: link })
        } catch (error) {
          last = error
          if (!/retryable|INTERNAL|short link/i.test(error.message)) throw error
          if (i === 0) await new Promise((resolve) => setTimeout(resolve, 1200))
        }
      }
      throw last
    }

    /** 调一次工具并等它真的出结果（服务端排队时会回 pending）。 */
    const call = async (name, args, timeoutMs) => settleTask(settings(), await mcpCall(settings(), name, args, timeoutMs))

    /** 链接 → 作品数据。不是单个作品（主页 / 直播 / 合集）就抛一句能看懂的话。 */
    const resolve = async (text) => {
      const link = pickLink(text)
      if (!link) throw new Error('这段话里没有抖音 / B站链接')
      const post = await parseUrl(link)
      const data = post.data || post
      if (!data || !data.kind) {
        throw new Error(data?.sec_uid ? '这是作者主页，不是单个作品，点进具体那条再复制链接' : '没解析出这个作品（可能是直播或合集）')
      }
      return { data, link }
    }

    const saveNow = async (chat, text) => {
      const link = pickLink(text)
      const post = await parseUrl(link)
      const data = post.data || post
      if (!data || !data.kind) {
        return { ok: false, message: data?.sec_uid ? '这是作者主页，不是单个作品' : '没解析出这个作品（可能是主页、直播或合集）' }
      }
      const out = await deliver(api, chat, data, settings())
      if (out.ok) remember(chat.chatId, data, link)
      return { ...out, link, title: oneLine(data.title, 60), platform: String(data.platform || ''), kind: String(data.kind || '') }
    }

    /**
     * 刚自动转存过的同一条链接，模型再调 douyin_save 就别重发了：
     * 链接和「你看看这个」并成一条时，它很容易照着规则再发一遍。
     */
    const alreadySent = (chat, text) => {
      const prev = recentOf(chat.chatId)
      if (!prev || prev.link !== pickLink(text)) return null
      if (Date.now() - prev.at >= DEDUPE_MS || RESEND_RE.test(String(text || ''))) return null
      return { ok: true, message: `刚才已经发过《${prev.title || '这条'}》了，没重复发`, link: prev.link, title: prev.title, platform: prev.platform, kind: prev.kind }
    }

    /** 转存：先确认链接存在，再确保服务在跑（没开就自动起）。 */
    const save = async (chat, text) => {
      if (!pickLink(text)) return { ok: false, message: '这段话里没有抖音 / B站链接' }
      return withService(() => saveNow(chat, text))
    }

    /**
     * 读文字稿：先让服务端把视频存一份（同一个作品第二次是复用的），
     * 再调本地 ASR 转写，最后按长短决定直接发还是当文件发。
     */
    const transcriptNow = async (chat, text) => {
      const s = settings()
      const { data } = await resolve(text)
      if (String(data.kind) === 'image_album') return { ok: false, message: '这是图集，没有声音可以转' }
      const hasVideo = Boolean((data.media?.video?.urls || []).length || data.media?.video?.url)
      if (!hasVideo) return { ok: false, message: '没取到播放地址（可能要登录才能看，或者这条已经失效）' }

      const dl = await call('download_media', { platform: data.platform, content_id: data.content_id, skip_existing: true }, 120000)
      const downloadId = String(dl.download_id || dl.data?.download_id || '')
      if (!downloadId) return { ok: false, message: '服务端没存下这个视频：' + (dl.message || '没给 download_id') }
      if (dl.status === 'error') return { ok: false, message: '视频没存到服务端：' + (dl.message || '未知原因') }
      // 还在存就别往下走：转写要读那个文件，现在读只会报「没存过」
      if (dl.status === 'pending') return { ok: false, message: '视频还在往服务端存（有点大），过一会儿再让我看看' }

      const tr = await call('transcribe_video', { download_id: downloadId }, 180000)
      if (tr.status === 'pending') return { ok: false, message: '转写还在跑（视频有点长），过一会儿再让我看看' }
      if (tr.status === 'error') return { ok: false, message: '转写没成：' + (tr.message || '未知原因') }
      if (tr.data?.state === 'failed') return { ok: false, message: '转写没成：' + oneLine(tr.data.error, 120) }

      const body = transcriptText(tr)
      if (!body) return { ok: false, message: '这个视频里没识别出人声（可能只有 BGM）' }

      const meta = {
        title: data.title,
        dur: mmss(Number(data.duration_ms) || Number(tr.data?.duration_ms) || 0),
      }
      const sent = await deliverTranscript(api, chat, body, meta, s)
      const title = meta.title ? `：《${oneLine(meta.title, 30)}》` : ''
      return { ok: true, message: `文字稿发过去了${title}（${body.length} 字${meta.dur ? '，' + meta.dur : ''}${sent.via === 'file' ? '，全文在 txt 里' : ''}）` }
    }

    /** 转写：同样先确认链接，再确保服务在跑。 */
    const transcript = async (chat, text) => {
      if (!pickLink(text)) return { ok: false, message: '这段话里没有抖音 / B站链接' }
      return withService(() => transcriptNow(chat, text))
    }

    /** 读评论：默认热度最高的那几条，带点赞数。 */
    const commentsNow = async (chat, text) => {
      const s = settings()
      const { data } = await resolve(text)
      const n = Math.max(1, Math.min(30, Number(s.commentCount) || 10))
      const out = await call('list_comments', { platform: data.platform, content_id: data.content_id, count: n }, 90000)
      if (out.status === 'pending') return { ok: false, message: '评论还在取，过一会儿再让我看看' }
      if (out.status === 'error') return { ok: false, message: '评论没取到：' + (out.message || '未知原因') }
      const body = formatComments(out, { max: n, title: String(data.title || '') })
      if (!body) return { ok: false, message: '这条还没人评论' }
      await sendLong(api, chat, body)
      return { ok: true, message: `评论发过去了（${(out.data?.items || []).length} 条）` }
    }

    const comments = async (chat, text) => {
      if (!pickLink(text)) return { ok: false, message: '这段话里没有抖音 / B站链接' }
      return withService(() => commentsNow(chat, text))
    }

    api.tool(({ chat, level }) => {
      if (chat.kind === 'system' || level !== 'full') return []
      const s = settings()
      // 默认（readAuto 关）只认「主人明说」；开了才允许她自己判断值不值得读。
      const readHint = s.readAuto
        ? '主人问起视频讲了什么、或者想知道评论区怎么样时可以用；主人只发链接说要下载时不要用。'
        : '只有主人明确说要「转写」「文字稿」「字幕」「总结」，问「这条讲了什么」，或者拿着刚发来的链接说「你看看这个」「你觉得怎么样」时，才用；主人只发链接、说要下载时绝对不要用。'
      return [
        api.defineTool({
          name: 'douyin_save',
          description: '把主人发来的抖音或 B站链接里的视频 / 图集取下来，直接发到这个聊天。主人发链接并说「下载」「发我」「存一下」时用；链接里是视频就发视频，是图文就发图。刚自动转存过同一条链接时不用再调，会直接告诉你不重复发。',
          properties: { url: { type: 'string', description: '抖音或 B站链接（含 v.douyin.com / b23.tv 短链），或者包含链接的整段分享文案' } },
          required: ['url'],
          execute: async ({ url }) => alreadySent(chat, url) || save(chat, url),
        }),
        api.defineTool({
          name: 'douyin_transcript',
          description: '把主人发来的抖音或 B站链接里的视频转成文字，直接把文字稿发到这个聊天。转写要先把视频存到本机服务、再跑语音识别，通常几十秒，长视频更久。' + readHint,
          properties: { url: { type: 'string', description: '抖音或 B站链接（含 v.douyin.com / b23.tv 短链），或者包含链接的整段分享文案' } },
          required: ['url'],
          slow: true,
          execute: async ({ url }) => transcript(chat, url),
        }),
        api.defineTool({
          name: 'douyin_comments',
          description: '把主人发来的抖音或 B站视频下面的评论读出来，发到这个聊天（带点赞数）。' + readHint,
          properties: { url: { type: 'string', description: '抖音或 B站链接（含 v.douyin.com / b23.tv 短链），或者包含链接的整段分享文案' } },
          required: ['url'],
          execute: async ({ url }) => comments(chat, url),
        }),
      ]
    })

    api.command({
      name: 'dy',
      aliases: ['抖音'],
      desc: '抖音 / B站链接 → 视频 / 图集；也可以「/dy 转写 <链接>」「/dy 评论 <链接>」',
      run: async (arg, msg) => {
        try {
          const { mode, text } = parseCommand(arg)
          const r = mode === 'transcript' ? await transcript(msg, text)
            : mode === 'comments' ? await comments(msg, text)
              : await save(msg, text)
          return r.message
        } catch (error) {
          return '没成：' + error.message
        }
      },
    })

    // 主人发链接就自动发（默认关；只发媒体，不读稿不读评论）
    api.on('message', async (msg) => {
      if (!settings().auto) return false
      if (!msg || msg.chatId !== 'private:' + String(api.config().ownerQQ || '')) return false
      if (!pickLink(msg.text)) return false
      // 这条是在要文字稿 / 评论：别接管，交给她自己按工具描述去做
      if (wantsRead(msg.text)) return false
      // 链接 + 「你看看这个」：先转存，再交给她接话（上下文里会带上这条）
      const talk = chatIntent(msg.text)
      try {
        const r = await save(msg, msg.text)
        if (r.ok) api.log.info('链接已自动转存：' + r.message)
        else api.log.info('链接没转成：' + r.message)
        if (!r.ok && !talk) {
          await api.sendText(msg.chatId, `这个链接没转成：${r.message}`).catch(() => {})
          return true
        }
      } catch (error) {
        api.log.warn('链接自动转存失败：', error.message)
        return false
      }
      return !talk
    })

    // 自动转存完，主人接着说「你看看这个」：把刚才那条塞进上下文，她才知道在说哪条
    api.context(({ chat }) => {
      if (!chat || chat.kind !== 'private') return ''
      if (chat.chatId !== 'private:' + String(api.config().ownerQQ || '')) return ''
      const r = recentOf(chat.chatId)
      if (!r) return ''
      const what = r.kind === 'image_album' ? '图集' : '视频'
      const name = r.platform === 'bilibili' ? 'B站' : '抖音'
      return `刚才主人发的那条${name}${what}已经自动转存、发到这个聊天里了${r.title ? `：《${r.title}》` : ''}（${r.link}）。`
        + '如果主人这会儿说「这个」「你看看这个」「你觉得怎么样」，指的就是它：'
        + '可以直接用 douyin_transcript 读文字稿、douyin_comments 看评论，看完用自己的话说说感受，别只把文字稿贴一遍。'
        + '媒体已经发过了，别再调 douyin_save 重复发一遍。'
    })

    api.rule((kind) => (kind === 'private'
      ? '你会把抖音 / B站链接里的东西发出来：主人发来链接、说要下载或发给他时，用 douyin_save 把视频 / 图集直接发过去，别只贴链接。'
        + '如果上下文里说这条链接已经自动转存过了，就别再调 douyin_save 重发。'
        + '主人明确说要文字稿、或者问这条讲了什么，才用 douyin_transcript；明确说想看评论、热评，才用 douyin_comments。'
        + '主人说「你看看这个」「你觉得怎么样」时，是想听你的看法：可以用 douyin_transcript / douyin_comments 看看内容，再用你自己的口吻聊两句，别只复述文字稿。'
        + '主人只发链接时，不要主动读稿、不要主动读评论。'
      : ''))
  },
}
