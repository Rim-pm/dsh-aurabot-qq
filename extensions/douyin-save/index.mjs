// Aurabot 用户扩展：抖音链接 → 视频 / 图集，直接发回 QQ。
//
// 解析走本机的 DouYinDownload（dtk）MCP：http://127.0.0.1:8000/mcp/
// 它只负责「这个链接是什么、媒体地址在哪」；下载和发到 QQ 都在插件这边做，
// 因为 MCP 把文件存在服务端磁盘上，不会自己传过来。

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const LINK_RE = /https?:\/\/(?:v\.douyin\.com|www\.douyin\.com|www\.iesdouyin\.com)\/[^\s"'<>，。、]+/i
const WORKSPACE = join(homedir(), 'Aurabot', 'qq-chats')

let seq = 0

/** 从一段话里挑出第一个抖音链接。 */
export function pickLink(text) {
  const m = String(text || '').match(LINK_RE)
  return m ? m[0].replace(/[),.;!?]+$/, '') : ''
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

async function grab(url, { timeoutMs = 60000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' },
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
  let sent = 0
  try {
    if (kind === 'image_album' || (Array.isArray(media.images) && media.images.length)) {
      const images = (media.images || []).slice(0, Math.max(1, Number(settings.maxImages) || 9))
      for (const [i, img] of images.entries()) {
        const url = (img.urls && img.urls[0]) || img.url
        if (!url) continue
        const got = await grab(url)
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
    if (!videoUrl) return { ok: false, message: '这个链接里没有能发的视频或图片' }
    const got = await grab(videoUrl, { timeoutMs: 180000 })
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
        return { ok: true, message: `视频发出去了${title ? `：《${title}》` : ''}（${(got.buf.length / 1024 / 1024).toFixed(1)} MB）` }
      } catch (error) {
        api.log.warn('视频消息发不出去，改当文件发：', error.message)
      }
    }
    await api.sendFile(chat.chatId, file, (title || 'douyin') + '.mp4')
    return { ok: true, message: `视频当文件发出去了${title ? `：《${title}》` : ''}（${(got.buf.length / 1024 / 1024).toFixed(1)} MB）` }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
  }
}

export default {
  id: 'douyin-save',
  name: '抖音链接转存',
  version: '0.1.0',
  api: 1,
  description: '主人发来抖音链接时，把视频 / 图集取下来直接发回 QQ（走本机 DouYinDownload 的 MCP 解析）',
  defaults: {
    mcpUrl: 'http://127.0.0.1:8000/mcp/',
    apiKey: '',
    accountFile: '',
    auto: false,
    videoMode: 'video',
    maxImages: 9,
    maxMB: 200,
    ffmpeg: 'ffmpeg',
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
  ],

  setup(api) {
    const settings = () => api.settings()

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

    const save = async (chat, text) => {
      const link = pickLink(text)
      if (!link) return { ok: false, message: '这段话里没有抖音链接' }
      const post = await parseUrl(link)
      const data = post.data || post
      if (!data || !data.kind) return { ok: false, message: '没解析出这个作品（可能是主页、直播或合集）' }
      return deliver(api, chat, data, settings())
    }

    api.tool(({ chat, level }) => {
      if (chat.kind === 'system' || level !== 'full') return []
      return api.defineTool({
        name: 'douyin_save',
        description: '把主人发来的抖音链接里的视频或图集取下来，直接发到这个聊天。主人发抖音链接并说「下载」「发我」「存一下」时用；链接里是视频就发视频，是图文就发图。',
        properties: { url: { type: 'string', description: '抖音链接，或者包含链接的整段分享文案' } },
        required: ['url'],
        execute: async ({ url }) => save(chat, url),
      })
    })

    api.command({
      name: 'dy',
      aliases: ['抖音'],
      desc: '抖音链接 → 视频 / 图集直接发回来',
      run: async (arg, msg) => {
        try {
          const r = await save(msg, arg)
          return r.message
        } catch (error) {
          return '没成：' + error.message
        }
      },
    })

    // 主人发链接就自动发（默认关）
    api.on('message', async (msg) => {
      if (!settings().auto) return false
      if (!msg || msg.chatId !== 'private:' + String(api.config().ownerQQ || '')) return false
      if (!pickLink(msg.text)) return false
      try {
        const r = await save(msg, msg.text)
        if (r.ok) api.log.info('抖音链接已自动转存：' + r.message)
        else api.log.info('抖音链接没转成：' + r.message)
      } catch (error) {
        api.log.warn('抖音链接自动转存失败：', error.message)
        return false
      }
      return true
    })

    api.rule((kind) => (kind === 'private'
      ? '你会把抖音链接里的东西发出来：主人发来抖音链接、说要下载或发给他时，用 douyin_save 把视频 / 图集直接发过去，别只贴链接。'
      : ''))
  },
}
