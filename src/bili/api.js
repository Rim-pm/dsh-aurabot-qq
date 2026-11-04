// B 站网页端接口：搜视频、看视频信息 / 字幕 / 评论、发评论 / 弹幕、看别人的回复。
// 登录靠用户在面板里填的 Cookie（SESSDATA、bili_jct）；部分接口要 WBI 签名，buvid3 没有就自己申请一个。
// 登录凭证由配置提供，接口不刷新或保存账号。

import { createHash } from 'node:crypto'
import { cleanOutboundText } from '../chat/reply.js'
import { bangumiEpisode, videoPart, danmakuParams, danmakuResponse } from './danmaku.js'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

/** 把用户粘贴的 Cookie 解析成键值；只认 B 站用得到的几个。 */
export function parseCookie(raw) {
  const out = {}
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'DedeUserID__ckMd5', 'sid'].includes(k)) out[k] = part.slice(i + 1).trim()
  }
  return out
}

/** WBI 签名：按 mixin 表从两段 key 里取出 32 位，参数排序后连上它取 md5。 */
export function wbiSign(params, imgKey, subKey, now = Date.now()) {
  const raw = imgKey + subKey
  const mixin = MIXIN.map((i) => raw[i]).join('').slice(0, 32)
  const p = { ...params, wts: Math.round(now / 1000) }
  const query = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return query + '&w_rid=' + createHash('md5').update(query + mixin).digest('hex')
}

/** 从链接或文字里认出视频号：BV 号、av 号、b23.tv 短链（短链要先跳转）。 */
export function findVideoId(text) {
  const s = String(text || '')
  const bv = s.match(/\b(BV[0-9A-Za-z]{10})\b/)
  if (bv) return { bvid: bv[1] }
  const av = s.match(/\bav(\d{3,})\b/i)
  if (av) return { aid: av[1] }
  const short = s.match(/https?:\/\/b23\.tv\/[0-9A-Za-z]+/)
  if (short) return { short: short[0] }
  return null
}

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")

// 动态的类型码 → 订阅里用的短名。认不出的当纯文字。
const DYNAMIC_KIND = {
  DYNAMIC_TYPE_DRAW: 'draw',
  DYNAMIC_TYPE_WORD: 'word',
  DYNAMIC_TYPE_AV: 'video',
  DYNAMIC_TYPE_PGC: 'video',
  DYNAMIC_TYPE_UGC_SEASON: 'video',
  DYNAMIC_TYPE_ARTICLE: 'article',
  DYNAMIC_TYPE_FORWARD: 'forward',
  DYNAMIC_TYPE_LIVE: 'live',
  DYNAMIC_TYPE_LIVE_RCMD: 'live',
}

/**
 * 一条动态 → 订阅推送要用的样子。动态 JSON 的字段散在 modules 里好几层，这里一次摊平。
 * 拿不到就留空，别抛：一条动态结构怪不该让整轮订阅挂掉。
 */
export function parseDynamic(it = {}) {
  const m = it.modules || {}
  const author = m.module_author || {}
  const dyn = m.module_dynamic || {}
  const major = dyn.major || {}
  const opus = major.opus || {}
  const draw = major.draw || {}
  const archive = major.archive || {}
  const article = major.article || {}
  const live = major.live || {}
  const additional = dyn.additional || {}
  const id = String(it.id_str || '')
  const bvid = archive.bvid || ''
  const kind = DYNAMIC_KIND[it.type] || 'word'
  const text = stripHtml(dyn.desc?.text || opus.summary?.text || '').trim()
  return {
    id,
    kind,
    text,
    author: author.name || '',
    mid: String(author.mid || ''),
    pubTs: (Number(author.pub_ts) || 0) * 1000,
    title: stripHtml(archive.title || article.title || '').trim(),
    // opus 是新版图文，draw 是老版图片动态，两种都收
    images: [...(opus.pics || []).map((p) => p && p.url), ...(draw.items || []).map((p) => p && p.src)].filter((u) => typeof u === 'string' && u),
    bvid,
    live: kind === 'live' ? { title: stripHtml(live.title || '').trim(), status: Number(live.live_state) || 0 } : null,
    forward: kind === 'forward',
    lottery: additional.type === 'ADDITIONAL_TYPE_UPOWER_LOTTERY' || /抽奖/.test(text),
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : id ? `https://www.bilibili.com/opus/${id}` : '',
  }
}

const FACE_MAX = 2 * 1024 * 1024

/** 有的图床（含 QQ multimedia.nt.qq.com）Content-Type 会给 application/octet-stream，按文件头认一下。 */
export function sniffImageType(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || [])
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return ''
}

export function createBiliApi({ getCookie, log, fetchImpl = fetch }) {
  let wbi = null // { img, sub, at }
  let buvid = ''

  function cookieHeader() {
    const c = parseCookie(getCookie())
    if (!c.buvid3 && buvid) c.buvid3 = buvid
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async function req(url, { method = 'GET', form, multipart, timeoutMs = 20000, signal, envelope = false } = {}) {
    const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', cookie: cookieHeader() }
    let body
    if (multipart) {
      body = multipart // FormData：content-type 带 boundary 由 fetch 自己填
    } else if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(form).toString()
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    const r = await fetchImpl(url, { method, headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    const j = await r.json().catch(() => ({ code: r.status, message: 'HTTP ' + r.status }))
    if (envelope) return j
    if (j.code !== 0) {
      const e = new Error(`B 站返回 ${j.code}${j.message ? '：' + j.message : ''}`)
      e.code = j.code
      throw e
    }
    return j.data
  }

  /** 没有 buvid3 时申请一个（搜索等接口没有它会被风控）。 */
  async function ensureBuvid() {
    if (buvid || parseCookie(getCookie()).buvid3) return
    try {
      const d = await req('https://api.bilibili.com/x/frontend/finger/spi')
      buvid = d.b_3 || ''
    } catch (error) {
      log?.debug('申请 buvid 失败：', error.message)
    }
  }

  /** 登录状态 + WBI 签名用的 key（没登录也能拿到 key）。 */
  async function nav() {
    const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader() }
    const r = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', { headers, signal: AbortSignal.timeout(15000) })
    const j = await r.json()
    const d = j.data || {}
    const key = (u) => String(u || '').split('/').pop().split('.')[0]
    if (d.wbi_img) wbi = { img: key(d.wbi_img.img_url), sub: key(d.wbi_img.sub_url), at: Date.now() }
    return { isLogin: Boolean(d.isLogin), uname: d.uname || '', mid: d.mid || 0 }
  }

  async function signed(base, params) {
    if (!wbi || Date.now() - wbi.at > 6 * 3600_000) await nav()
    if (!wbi) throw new Error('拿不到 B 站的签名 key')
    return base + '?' + wbiSign(params, wbi.img, wbi.sub)
  }

  /** 搜视频：[{bvid, aid, title, author, play, pubdate, duration, desc}] */
  async function search(keyword, { page = 1 } = {}) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'video', keyword, page }))
    return (d.result || []).map((v) => ({
      bvid: v.bvid, aid: v.aid, title: stripHtml(v.title), author: v.author, play: Number(v.play) || 0, pubdate: (v.pubdate || 0) * 1000, duration: v.duration, desc: stripHtml(v.description).slice(0, 200),
    }))
  }

  /** 热门视频。 */
  async function popular({ ps = 20 } = {}) {
    await ensureBuvid()
    const d = await req(`https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=1`)
    return (d.list || []).map((v) => ({ bvid: v.bvid, aid: v.aid, title: v.title, author: v.owner?.name, play: v.stat?.view || 0, pubdate: (v.pubdate || 0) * 1000, desc: String(v.desc || '').slice(0, 200) }))
  }

  /** 视频信息。 */
  async function view({ bvid, aid }) {
    await ensureBuvid()
    // 不签名的旧接口经常被风控（412），用 WBI 签名的那个
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/view', bvid ? { bvid } : { aid }))
    return {
      bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title, desc: String(d.desc || '').slice(0, 600), author: d.owner?.name, authorMid: d.owner?.mid,
      play: d.stat?.view || 0, like: d.stat?.like || 0, reply: d.stat?.reply || 0, pubdate: (d.pubdate || 0) * 1000, duration: d.duration, tname: d.tname,
    }
  }

  /** DASH / 渐进式音视频流地址，视频流供 ffmpeg 定位抽帧。 */
  async function playurl({ bvid, aid, cid, qn = 64 }) {
    await ensureBuvid()
    // fnval 4048 = DASH + HDR + 4K + 杜比等全要；很多账号 / 视频现在只回 durl（渐进式 MP4），所以两种都带出去。
    const d = await req(await signed('https://api.bilibili.com/x/player/wbi/playurl', {
      ...(bvid ? { bvid } : { aid }), cid, qn, fnval: 4048, fnver: 0, fourk: 1,
    }))
    const one = (x) => (x ? { id: x.id, width: x.width, height: x.height, codecs: x.codecs || '', bandwidth: x.bandwidth || 0, baseUrl: x.baseUrl || x.base_url || '' } : null)
    // 没有 DASH 时退回 durl：每段是渐进式 MP4，length 是这一段的毫秒数（按顺序拼起来是全片）。
    const durl = (d.durl || [])
      .map((x) => ({ order: Number(x.order) || 0, url: x.url || '', length: Number(x.length) || 0, size: Number(x.size) || 0 }))
      .filter((x) => x.url)
    return {
      video: (d.dash?.video || []).map(one).filter((v) => v && v.baseUrl),
      audio: (d.dash?.audio || []).map(one).filter((v) => v && v.baseUrl),
      durl,
    }
  }

  /** 字幕全文（优先中文；AI 字幕要登录才有）。拿不到返回 ''。 */
  async function subtitle({ bvid, aid, cid }) {
    try {
      const d = await req(await signed('https://api.bilibili.com/x/player/wbi/v2', { ...(bvid ? { bvid } : { aid }), cid }))
      const list = d.subtitle?.subtitles || []
      const pick = list.find((s) => /zh|中文/.test(s.lan + s.lan_doc)) || list[0]
      if (!pick?.subtitle_url) return ''
      const url = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url
      const r = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) })
      const j = await r.json()
      return (j.body || []).map((x) => x.content).join(' ')
    } catch (error) {
      log?.debug('拿字幕失败：', error.message)
      return ''
    }
  }

  /** 热门评论：[{rpid, name, mid, text, like, replies}] */
  async function comments(aid, { limit = 12 } = {}) {
    const d = await req(await signed('https://api.bilibili.com/x/v2/reply/wbi/main', { type: 1, oid: aid, mode: 3, plat: 1, web_location: 1315875 }))
    return (d.replies || []).slice(0, limit).map((r) => ({ rpid: r.rpid, name: r.member?.uname, mid: r.mid, text: String(r.content?.message || '').slice(0, 200), like: r.like, replies: r.rcount || 0 }))
  }

  /** 按昵称精确找用户，找不到返回 0。 */
  async function findUser(name) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: name }))
    return (d.result || []).find((u) => stripHtml(u.uname) === name)?.mid || 0
  }

  /** 把文字里的 @昵称 换成接口要的 { 昵称: mid }；光写文字 B 站不算 @。查不到的留作普通文字。 */
  async function resolveAts(message) {
    const names = [...new Set([...message.matchAll(/@([^\s@:：,，。!！?？]+)/g)].map((m) => m[1]))]
    const map = {}
    for (const name of names) {
      try {
        const mid = await findUser(name)
        if (mid) map[name] = mid
      } catch (error) { log?.debug?.(`查 B 站用户「${name}」失败：`, error.message) }
    }
    return { map, missed: names.filter((n) => !map[n]) }
  }

  /** 发评论；root/parent 不传就是一级评论。要登录。 */
  async function postComment(aid, rawMessage, { root, parent } = {}) {
    const message = cleanOutboundText(rawMessage, { warn: (message) => log?.warn?.(`B 站评论：${message}`) }).replace(/＠/g, '@')
    if (!message.trim()) return { silent: true, rpid: '', at: [], missed: [] }
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
    const { map, missed } = await resolveAts(message)
    const at = Object.keys(map)
    const d = await req('https://api.bilibili.com/x/v2/reply/add', { method: 'POST', form: { type: 1, oid: aid, message, plat: 1, csrf, ...(root ? { root, parent: parent || root } : {}), ...(at.length ? { at_name_to_mid: JSON.stringify(map) } : {}) } })
    return { rpid: d.rpid, at, missed }
  }

  /** 点赞视频。要登录。 */
  async function likeVideo(aid) {
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站')
    await req('https://api.bilibili.com/x/web-interface/archive/like', { method: 'POST', form: { aid, like: 1, csrf } })
  }

  /** 改自己的个性签名（B 站上限 70 字）。要登录。 */
  async function setSign(sign) {
    sign = cleanOutboundText(sign, { warn: (message) => log?.warn?.(`B 站签名：${message}`) })
    if (!sign.trim()) return
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
    await req('https://api.bilibili.com/x/member/web/sign/update', { method: 'POST', form: { user_sign: sign, csrf } })
  }

  /** 换头像：先把图片下载下来（≤2MB，只收图片），再按网页端的方式 multipart 上传。要登录。 */
  async function setFace(imageUrl) {
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
    const r = await fetchImpl(imageUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) })
    if (r.ok === false || (typeof r.status === 'number' && (r.status < 200 || r.status >= 300))) throw new Error('图片下载失败：HTTP ' + r.status)
    let type = String(r.headers?.get?.('content-type') || '').split(';')[0].trim()
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) throw new Error('图片是空的')
    if (buf.length > FACE_MAX) throw new Error('图片超过 2MB，B 站不收')
    if (!/^image\//i.test(type)) type = sniffImageType(buf)
    if (!type) throw new Error('这个网址不是图片')
    const fd = new FormData()
    fd.append('dopost', 'save')
    fd.append('DisplayRank', '10000')
    fd.append('face', new Blob([buf], { type }), 'face.' + (type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, ''))
    await req(`https://api.bilibili.com/x/member/web/face/update?csrf=${encodeURIComponent(csrf)}`, { method: 'POST', multipart: fd, timeoutMs: 30000 })
  }

  /** 别人回复她的消息：[{id, time, name, mid, text, myText, oid, root, parent, title, uri}] */
  async function replyFeed() {
    const d = await req('https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web')
    return (d.items || []).map((x) => ({
      id: String(x.id), time: (x.reply_time || 0) * 1000, name: x.user?.nickname, mid: x.user?.mid,
      text: String(x.item?.source_content || '').slice(0, 300), myText: String(x.item?.target_reply_content || x.item?.root_reply_content || '').slice(0, 300),
      oid: x.item?.subject_id, root: x.item?.root_id || x.item?.source_id, parent: x.item?.source_id, title: x.item?.title || '', uri: x.item?.uri || '', type: x.item?.business_id,
    }))
  }

  /**
   * 某个 UP 主的动态列表（网页端 feed/space）。游客身份（只有 buvid3）也能读，
   * 但 B 站会随机给空列表或 -352，所以这里只如实返回，是不是「真的没发」交给上面判断。
   */
  async function dynamicFeed(hostMid, { offset = '' } = {}) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space', {
      host_mid: String(hostMid),
      offset,
      timezone_offset: -480,
      // 网页端现在带的就是这几个；少一个就容易只回老格式或者直接空
      features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote',
    }))
    return (d.items || []).map(parseDynamic)
  }

  /** UP 主名片（订阅列表里显示是谁）。没登录也能查。 */
  async function card(mid) {
    const d = await req(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(String(mid))}`)
    return { mid: String(d.card?.mid || mid), name: String(d.card?.name || ''), face: String(d.card?.face || '') }
  }

  /** 按名字搜 UP 主（订阅时懒得找 UID 用）。搜不到返回空数组。 */
  async function searchUser(keyword, { limit = 5 } = {}) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: String(keyword), page: 1 }))
    return (d.result || []).slice(0, limit).map((u) => ({
      mid: String(u.mid), name: stripHtml(u.uname), fans: Number(u.fans) || 0, sign: stripHtml(u.usign || '').slice(0, 60),
    }))
  }

  /** 一条动态的作者（手里只有动态链接时反查 UP 主）。 */
  async function dynamicAuthor(dynId) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail', {
      id: String(dynId), features: 'itemOpusStyle,opusBigCover',
    }))
    const a = d.item?.modules?.module_author || {}
    if (!a.mid) throw new Error('这条动态里没读到作者')
    return { mid: String(a.mid), name: String(a.name || '') }
  }

  /** b23.tv 短链跳一下拿到真实地址。 */
  async function resolveShort(url) {
    const r = await fetchImpl(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) })
    return r.headers.get('location') || ''
  }

  /** 只读检查弹幕目标；番剧接口返回 result，普通视频按 pages 选出当前 CID。 */
  async function danmakuInfo(video, part, { signal } = {}) {
    if (/^(ep|ss)/.test(video)) {
      const param = video.startsWith('ep') ? 'ep_id' : 'season_id'
      const body = await req(`https://api.bilibili.com/pgc/view/web/season?${param}=${video.slice(2)}`, { envelope: true, signal })
      return bangumiEpisode(body, video, part)
    }
    await ensureBuvid()
    const params = video.startsWith('av') ? { aid: video.slice(2) } : { bvid: video }
    const data = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/view', params), { signal })
    return videoPart(data, part)
  }

  let dmSequence = Date.now()
  async function postDanmaku(info, text, progress, mode, { beforePost, signal } = {}) {
    text = cleanOutboundText(text, { warn: (message) => log?.warn?.(`B 站弹幕：${message}`) })
    if (!text.trim()) return { silent: true }
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw Object.assign(new Error('Cookie 里缺少 bili_jct'), { code: -111 })
    const url = await signed('https://api.bilibili.com/x/v2/dm/post', {
      web_location: 1315873, csrf, ...danmakuParams(),
    })
    signal?.throwIfAborted()
    // 签名可能等待网络；在最后一次 await 后再检查开关、登录态和配额。
    beforePost?.()
    const body = await req(url, { method: 'POST', signal, envelope: true, form: {
      color: 16777215, fontsize: 25, pool: 0, mode, type: 1,
      oid: info.cid, aid: info.aid, msg: text, progress, rnd: ++dmSequence,
      plat: 1, checkbox_type: 0, colorful: '', gaiasource: 'main_web',
      polaris_app_id: 100, polaris_platform: 5, spmid: '333.788.0.0', from_spmid: '333.788.0.0',
      statistics: JSON.stringify({ appId: 100, platform: 5, abtest: '', version: '' }), csrf,
    } })
    const response = danmakuResponse(body)
    if (body.code !== 0) throw Object.assign(new Error(`B 站返回 ${body.code}`), { code: body.code, platformResponse: response })
    return { ...response.data, platformResponse: response }
  }

  return { nav, search, popular, view, playurl, subtitle, comments, postComment, likeVideo, setSign, setFace, replyFeed, dynamicFeed, card, searchUser, dynamicAuthor, resolveShort, danmakuInfo, postDanmaku }
}

/** 固定本次登录凭证；实际提交前由调用者核验它是否仍是当前凭证。 */
export async function prepareDanmaku({ cookie, video, part, signal, beforePost }) {
  const client = createBiliApi({ getCookie: () => cookie })
  const info = await client.danmakuInfo(video, part, { signal })
  return { info, post: (text, progress, mode) => client.postDanmaku(info, text, progress, mode, { signal, beforePost }) }
}
