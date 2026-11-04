// 订阅 UP 主动态：定时查一遍订阅列表，有新的就推到主人私聊。
//
// 两个坑是实测出来的（2026-11，见 CHANGELOG）：
//  · B 站对没登录的请求会「静默」返回空列表（code=0 但 items=[]），偶尔 -352。
//    所以游标只认「见过的最新动态 id」：拿不到数据时绝不推进游标，也不把 0 条当成「今天没发」。
//  · 同一个身份短时间内连读同一个号，会从「有数据」退化成「空列表」再退化成 -352。
//    所以号与号之间要歇一会儿（subGapSec），整轮间隔默认 15 分钟。
//
// 过滤词表和轮询节奏参考了 astrbot_plugin_bilibili（AGPL-3.0）；这里只借思路，代码是自己写的。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { createBiliApi, UA } from './api.js'

const FILE = () => dataDir('bili-subs.json')
const MAX_SUBS = 50
const IMG_MAX = 5 * 1024 * 1024

/** 过滤器：前 7 个是类型开关（词跟 astrbot_plugin_bilibili 一致，好记），别的当正则过滤正文。 */
export const FILTER_WORDS = ['forward', 'lottery', 'video', 'article', 'draw', 'live', 'live_end']

const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''))

/** 把配置里的字符串数组分成「类型集合」和「正则」。写错的正则直接忽略，别让整轮挂掉。 */
export function resolveFilters(list = []) {
  const kinds = new Set()
  const regex = []
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\s,，]+/)) {
    const s = String(raw || '').trim()
    if (!s) continue
    if (FILTER_WORDS.includes(s)) kinds.add(s)
    else {
      try { regex.push(new RegExp(s, 'i')) } catch (error) { /* 写错的正则当没写 */ }
    }
  }
  return { kinds, regex }
}

/** 这条动态要不要（true = 留）。filters 可以已经是 resolveFilters 的结果。 */
export function keepDynamic(item, filters) {
  const f = filters && filters.kinds ? filters : resolveFilters(filters)
  const { kinds, regex } = f
  if (kinds.has('forward') && item.forward) return false
  if (kinds.has('lottery') && item.lottery) return false
  if (kinds.has('video') && item.kind === 'video') return false
  if (kinds.has('article') && item.kind === 'article') return false
  if (kinds.has('draw') && item.kind === 'draw') return false
  if (kinds.has('live') && item.kind === 'live') return false
  // 只滤下播，开播照推
  if (kinds.has('live_end') && item.kind === 'live' && item.live?.status !== 1) return false
  for (const re of regex) if (re.test(item.text || '') || re.test(item.title || '')) return false
  return true
}

/** 动态 id 是十几位整数，字符串比较会错（'9' > '10'）；用 BigInt 比，坏值当最小。 */
export function compareId(a, b) {
  try {
    const x = BigInt(String(a || '0'))
    const y = BigInt(String(b || '0'))
    return x < y ? -1 : x > y ? 1 : 0
  } catch (error) {
    return String(a || '').length - String(b || '').length
  }
}

/**
 * 认订阅目标：UID / 主页链接 / 动态链接 / UP 主名字。
 * 注意：B 站新号的 UID 已经是 16 位（比如 3537117026191454），跟动态 id 位数完全重叠，
 * 所以光看数字长短分不开——一串裸数字先标成 ambiguous，订阅时再拿接口试（先当 UID 查，查不到再当动态 id 反查作者）。
 */
export function parseTarget(text) {
  const s = String(text || '').trim()
  if (!s) return {}
  const space = s.match(/space\.bilibili\.com\/(\d{3,})/i)
  if (space) return { mid: space[1] }
  const param = s.match(/(?:mid|uid)=(\d{3,})/i)
  if (param) return { mid: param[1] }
  const dyn = s.match(/(?:t\.bilibili\.com|bilibili\.com\/(?:opus|dynamic))\/(\d{10,})/i)
  if (dyn) return { dynId: dyn[1] }
  const bare = s.match(/^(\d{3,})$/)
  if (bare) return { ambiguous: bare[1] }
  return { name: s }
}

/** 只要 UID 的老用法：认不出返回空串。 */
export function findMid(text) {
  return parseTarget(text).mid || ''
}

/** 一条动态变成推给主人的那段话。 */
export function formatDynamic(item, sub) {
  const who = (sub && sub.name) || item.author || 'UP主'
  const lines = [`【B站动态】${who}`]
  if (item.kind === 'video' && item.title) lines.push(`投稿了视频《${item.title}》`)
  else if (item.kind === 'live') lines.push(item.live?.status === 1 ? `开播了${item.live.title ? '：' + item.live.title : ''}` : `下播了${item.live?.title ? '：' + item.live.title : ''}`)
  const body = String(item.text || '').trim()
  if (body) lines.push(body)
  if (!body && item.kind !== 'video' && item.kind !== 'live') lines.push(item.title || '（这条没有正文）')
  if (item.images.length) lines.push(`（配图 ${item.images.length} 张）`)
  if (item.url) lines.push(item.url)
  return lines.filter(Boolean).join('\n')
}

/** B 站图片 CDN 要 Referer，交给 hub.sendImage 直接发可能 403，所以自己取回来再发。 */
async function grabImage(url, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    return buf.length && buf.length <= IMG_MAX ? buf : null
  } catch (error) {
    return null
  }
}

/**
 * @param {object} o
 * @param {Function} o.getConfig
 * @param {Function} o.setConfig  api.setConfig（改订阅列表用）
 * @param {object} o.hub          发消息
 * @param {object} [o.memory]     记经历
 * @param {object} o.log
 * @param {object} [o.api]        注入假的 B 站（测试用）
 * @param {Function} [o.sleep]
 */
export function createSubs({ getConfig, setConfig, hub, memory, log, api: injected, sleep }) {
  const api = injected || createBiliApi({ getCookie: () => getConfig().bili.cookie, log })
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const load = () => readJson(FILE(), () => ({ cursors: {}, lastPoll: 0 }))
  const save = (s) => writeJson(FILE(), s)
  let busy = false

  const cfg = () => getConfig().bili
  const subs = () => (Array.isArray(cfg().subs) ? cfg().subs : [])
  const ownerChat = () => (getConfig().ownerQQ ? `private:${getConfig().ownerQQ}` : '')
  const intervalMs = () => Math.max(1, Number(cfg().subIntervalMin) || 15) * 60_000

  /** 推一条：文字先走，图跟着走（发不出去不影响文字）。 */
  async function push(sub, item) {
    const g = getConfig()
    const to = ownerChat()
    if (!to) return false
    const text = formatDynamic(item, sub)
    if (g.dryRun) {
      log.info(`试运行：本来要推送 B 站动态（${sub.name || item.author || sub.mid}）${clip(item.text || item.title, 40)}`)
      return false
    }
    try {
      await hub.sendText(to, text)
    } catch (error) {
      log.warn('推送 B 站动态失败：', error.message)
      return false
    }
    if (g.bili.subForwardImages && (item.images || []).length) {
      for (const url of item.images.slice(0, 9)) {
        const buf = await grabImage(url)
        if (!buf) continue
        await hub.sendImage(to, 'base64://' + buf.toString('base64')).catch(() => null)
      }
    }
    memory?.addEvent?.({ text: `在B站看到${sub.name || item.author || 'UP主'}发了动态：${clip(item.text || item.title || '（无正文）', 60)}`, tags: ['B站', '动态'], importance: 0.4 })
    log.info(`推送了 B 站动态：${sub.name || item.author || sub.mid} ${item.id}`)
    return true
  }

  /**
   * 查一轮。force = 面板里手动点的，忽略间隔。
   * 单个号失败只记在它自己头上，不影响别的号。
   */
  async function poll({ force = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在查' }
    if (!getConfig().enabled || !c.enabled) return { ok: false, message: '插件或 B 站没打开' }
    if (!subs().length) return { ok: false, message: '还没有订阅的 UP 主' }
    busy = true
    const s = load()
    const gap = Math.max(0, Number(c.subGapSec) || 0) * 1000
    const limit = Math.max(1, Number(c.subMaxPerPoll) || 3)
    let pushed = 0
    let failed = 0
    let checked = 0
    try {
      for (const sub of subs()) {
        if (!sub || !sub.mid) continue
        if (!s.cursors[sub.mid]) s.cursors[sub.mid] = { cursor: '', fails: 0, lastPollAt: 0, lastError: '' }
        const st = s.cursors[sub.mid]
        if (!force && st.lastPollAt && Date.now() - st.lastPollAt < intervalMs()) continue
        // 号与号之间歇一会儿：连读同一个出口容易被降级
        if (checked && gap) await wait(gap)
        checked++
        st.lastPollAt = Date.now()
        let items
        try {
          items = await api.dynamicFeed(sub.mid)
        } catch (error) {
          st.fails = (st.fails || 0) + 1
          st.lastError = error.message
          failed++
          log.debug(`查 ${sub.name || sub.mid} 的动态失败：`, error.message)
          continue
        }
        // 空列表：第一次订阅当作「从现在开始」，之后就是可疑（B 站会静默降级，不能当没发）
        if (!items.length) {
          if (st.cursor) {
            st.fails = (st.fails || 0) + 1
            st.lastError = 'B 站返回空列表（可能是风控）'
          } else {
            st.fails = 0
            st.lastError = ''
          }
          continue
        }
        st.fails = 0
        st.lastError = ''
        // 游标推到「这次看到的最大 id」：被过滤掉的也算看过，不然会反复冒出来
        const top = items.reduce((a, b) => (compareId(b.id, a) > 0 ? b.id : a), st.cursor || '0')
        if (!st.cursor) { st.cursor = top; continue } // 冷启动：只记游标，不补发历史
        const filters = resolveFilters(sub.filters)
        const fresh = items
          .filter((it) => it.id && keepDynamic(it, filters) && compareId(it.id, st.cursor) > 0)
          .sort((a, b) => compareId(a.id, b.id))
        // 一次最多推几条，防止隔了几天没开就一次性刷屏
        for (const it of fresh.slice(-limit)) if (await push(sub, it)) pushed++
        st.cursor = top
      }
      s.lastPoll = Date.now()
      return {
        ok: true,
        message: `查了 ${checked} 个，推送 ${pushed} 条${failed ? `，${failed} 个失败` : ''}`,
        pushed, checked, failed,
      }
    } finally {
      save(s)
      busy = false
    }
  }

  /**
   * 订阅：认 UID / 主页链接 / 动态链接 / UP 主名字，认出来之后顺手把名字查回来。
   * 手里只有一条动态的链接时，反查它的作者——用户手里最常有的就是这个。
   */
  async function subscribe(input, filters = []) {
    const target = parseTarget(input)
    let mid = target.mid || ''
    let name = ''
    if (!mid && target.ambiguous) {
      // 裸数字：先当 UID 查（B 站新号 mid 就是 16 位，跟动态 id 一样长），查不到再当动态 id 反查作者
      const n = target.ambiguous
      try {
        const c = await api.card(n)
        if (c && c.name) { mid = c.mid; name = c.name }
      } catch (error) { log.debug(`按 UID ${n} 查不到：`, error.message) }
      if (!mid) {
        try {
          const who = await api.dynamicAuthor(n)
          mid = who.mid
          name = who.name
        } catch (error) {
          return { ok: false, message: `这串数字既查不到 UP 主，也查不到动态（${error.message}）` }
        }
      }
    }
    if (!mid && target.dynId) {
      try {
        const who = await api.dynamicAuthor(target.dynId)
        mid = who.mid
        name = who.name
      } catch (error) {
        return { ok: false, message: `这条动态查不到作者（${error.message}）。填 UP 主的 UID，或者直接说 UP 主的名字` }
      }
    }
    if (!mid && target.name) {
      try {
        const hits = await api.searchUser(target.name)
        if (!hits.length) return { ok: false, message: `没搜到叫「${target.name}」的 UP 主` }
        mid = hits[0].mid
        name = hits[0].name
      } catch (error) {
        return { ok: false, message: `搜「${target.name}」失败（${error.message}），可以填 UID 试试` }
      }
    }
    if (!mid) return { ok: false, message: '没认出要订阅谁：填 UID、主页链接、动态链接，或者 UP 主的名字' }
    if (subs().some((x) => String(x.mid) === mid)) return { ok: false, message: `已经订阅过 ${name || mid} 了` }
    if (subs().length >= MAX_SUBS) return { ok: false, message: `最多订阅 ${MAX_SUBS} 个` }
    if (!name) {
      try { name = (await api.card(mid)).name } catch (error) { log.debug('查 UP 主名字失败：', error.message) }
    }
    const wanted = (Array.isArray(filters) ? filters : String(filters || '').split(/[\s,，]+/))
      .map((f) => String(f).trim()).filter(Boolean)
    const next = { mid, name, filters: wanted }
    setConfig((cur) => ({ ...cur, bili: { ...cur.bili, subs: [...(cur.bili.subs || []), next] } }))
    // 冷启动：先把当前最新一条记成游标，免得第一次轮询把历史全推一遍
    try {
      const items = await api.dynamicFeed(mid)
      const top = items.reduce((a, b) => (compareId(b.id, a) > 0 ? b.id : a), '0')
      const s = load()
      s.cursors[mid] = { cursor: top === '0' ? '' : top, fails: 0, lastPollAt: Date.now(), lastError: '' }
      save(s)
    } catch (error) {
      log.debug('记订阅游标失败（下次轮询再记）：', error.message)
    }
    return { ok: true, message: `订阅了 ${name || mid}${name ? '（' + mid + '）' : ''}，它发动态时会私聊告诉你`, mid, name }
  }

  /** 取消订阅：配置和游标一起清。 */
  function unsubscribe(input) {
    const raw = String(input || '').trim()
    const mid = findMid(raw) || raw
    const hit = subs().find((x) => String(x.mid) === mid || (x.name && x.name === raw))
    if (!hit) return { ok: false, message: `没订阅 ${raw}` }
    setConfig((cur) => ({ ...cur, bili: { ...cur.bili, subs: (cur.bili.subs || []).filter((x) => String(x.mid) !== String(hit.mid)) } }))
    const s = load()
    delete s.cursors[hit.mid]
    save(s)
    return { ok: true, message: `取消订阅了 ${hit.name || hit.mid}` }
  }

  /** 面板 / 工具用：订阅列表 + 每个号的健康情况。 */
  function list() {
    const s = load()
    return subs().map((sub) => {
      const st = s.cursors[sub.mid] || {}
      return {
        mid: sub.mid,
        name: sub.name || '',
        filters: Array.isArray(sub.filters) ? sub.filters : [],
        cursor: st.cursor || '',
        fails: st.fails || 0,
        lastError: st.lastError || '',
        lastPollAt: st.lastPollAt || 0,
      }
    })
  }

  /** 每分钟调一次：醒着的时候按间隔查。 */
  async function tick() {
    const g = getConfig()
    if (!g.enabled || !g.bili.enabled || !subs().length) return
    const h = new Date().getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    if (Date.now() - (load().lastPoll || 0) < intervalMs()) return
    try {
      await poll()
    } catch (error) {
      log.warn('查 B 站动态出错：', error.message)
    }
  }

  return {
    poll, subscribe, unsubscribe, list, tick,
    state: () => ({ count: subs().length, lastPoll: load().lastPoll || 0 }),
  }
}
