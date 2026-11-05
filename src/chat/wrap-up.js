// 收尾 / 等待：给「一段话聊到哪儿了」记一个会话状态。
//
// 借鉴 SurfCore 的 qq_wait_for_messages / qq_close_conversation，但这里不引入工具、MCP 和未读池：
// 模型只是在回复末尾多写一个标记，插件把标记摘掉，按「标记 + 定时器 + 会话状态」处理。
//
//   <wait>        这段先别散：对方在 waitSec（默认 5 分钟）内接着说，就立刻接着聊（不用重新起话头）；
//                 到点没人说话，记一句兜底摘要，下一轮告诉她「刚才等了一会儿，对方没接」。
//   <wait:30>     自己指定等多久（秒；也可以写 <wait:1m>、<wait:30秒>、<wait 30>）。上限 maxWaitSec。
//   <wait:0>      取消等待（她改主意了）。
//   <close>       这段收尾了：清掉等待，closeSec（默认 12 小时）内对方再来时，告诉她「这段你已经收过尾」，
//                 并把收尾前的摘要一起带上（resume）；超过 12 小时就当新的一段。
//
// 问句 / 求助保护：收尾那句如果是问句（问号 / 句尾的「吗、呢、嘛、没」），<close> 不生效，改成等一会儿——
// 对方回的是答案，不该被当成新的一段。对方最后一句在问问题 / 求她帮忙时，也不收尾。
//
// 括号写法（[等待] / [等30秒] / [收尾] / 【收尾】）也认：只有「整行就是标记」才算数，
// 句子里提到的词不误伤；出站时不管出现在哪一行，整行的括号标记都会剥掉。
//
// 只有末尾的尖括号标记才算意图（正文中间提到 <wait> 只是解释 / 举例，不改状态），
// 但正文里任何位置的标记都会从要发出去的话里剥掉。
//
// <close> 后面可以跟「摘要：…」「下次：…」两行：给 resume 用，不会发出去。
//
// 状态会落盘（hub 负责读写），重启后等待 / 收尾 / 摘要都还在；本文件只做解析和状态机
// （纯逻辑、可注入时钟），定时器和 QQ 侧的动作都在 hub 里。

const ANGLE = /<\s*(\/?)\s*(wait|close)\b([^<>]*)>/gi
const ANGLE_ANY = /<\s*\/?\s*(wait|close)\b[^<>]*>/i
const ANGLE_END = /<\s*(\/?)\s*(wait|close)\b([^<>]*)>\s*$/i
const DURATION = /^[:：]?\s*(\d+(?:\.\d+)?)\s*(秒|s|sec|secs|seconds?|分钟|分|m|min|mins|minutes?)?$/i
const BRACKET = /^[[【]\s*(等待|等|收尾|结束)\s*(\d+(?:\.\d+)?)?\s*(秒|s|分钟|分|m)?\s*[\]】]$/
// 整行就是一个括号标记（[等待] / [等30秒] / 【收尾】…）：句子里提到的词不动。
const BRACKET_LINE = /^[ \t]*[[【]\s*(等待|等|收尾|结束)\s*(\d+(?:\.\d+)?)?\s*(秒|s|分钟|分|m)?\s*[\]】][ \t]*$/i
const CLOSE_PAYLOAD = /^\s*(摘要|下次)\s*[:：]\s*(.*)$/
// 一整行就是收尾标记：`<close>` 或 `[收尾]` / `【结束】`（括号写法要整行才算）
const CLOSE_MARK_LINE = /^[ \t]*(?:<\s*\/?\s*close\b[^<>]*>|[[【]\s*(?:收尾|结束)\s*[\]】])[ \t]*$/i
// 行内出现 `<close>`（`晚安<close>` 这种）；`</close>` 不算
const CLOSE_TAG = /<\s*close\b[^<>]*>/i
// 行尾标记前面是「：」或者「比如 / 例如 / 写法 / 格式」，多半是在解释语法，不当意图
const EXAMPLE_TAIL = /[：:]\s*$|(?:比如|例如|写法|格式|这样)\s*$/

export const DEFAULT_WAIT_SEC = 300 // 5 分钟
export const DEFAULT_MAX_WAIT_SEC = 1800 // 30 分钟
export const DEFAULT_CLOSE_SEC = 12 * 3600 // 12 小时
export const DEFAULT_NOTE_TTL_MS = 12 * 3600_000
export const DEFAULT_SUMMARY_MAX_CHARS = 240
export const DEFAULT_RESUME_MAX_CHARS = 160
export const DEFAULT_CLOSE_RESUME = '接着上次的话题，别装作没发生过'

/** 把 `<wait:30>` 里的「30」读成毫秒；读不出来（`<wait>`、`<wait/>`、写坏了）返回 null = 用默认值。 */
function durationOf(attrs) {
  const s = String(attrs || '').replace(/\/$/, '').trim()
  if (!s) return null
  const m = DURATION.exec(s)
  if (!m) return null
  const minutes = /^(分钟|分|m|min|mins|minutes?)$/i.test(String(m[2] || ''))
  return Math.round(Number(m[1]) * (minutes ? 60 : 1) * 1000)
}

/** 去掉行尾空白、把连续空行并成一个、首尾 trim。 */
function tidyLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function clipText(text, max) {
  const s = String(text ?? '').trim()
  const n = Math.max(0, Number(max) || 0)
  return n && s.length > n ? s.slice(0, n) : s
}

/** 一行末尾连续的一串标记：剥下来，返回 [剩下的正文, 标记列表]。 */
function splitTrailingTags(line) {
  const tags = []
  let head = line
  for (;;) {
    const m = ANGLE_END.exec(head)
    if (!m) break
    if (!m[1]) tags.unshift({ name: m[2], attrs: m[3] })
    head = head.slice(0, m.index)
  }
  return { head, tags }
}

/**
 * `<close>` 前后的「摘要：…」「下次：…」块：只认紧挨着标记（中间可以有空行）的那几行，
 * 夹了别的话就不往下吃了。返回去掉 payload 的正文。
 *
 * 两种情况都认，因为模型两种都写：payload 在标记后面（提示词教的写法），
 * 或者先写摘要再收尾（常见偏差）。**只要认出来了就一定从正文里摘掉**——
 * 摘要 / 下次是给插件看的，漏到 QQ 上比少一条摘要严重得多。
 */
function closePayloadOf(raw) {
  const text = String(raw ?? '')
  const lines = text.split('\n')
  // 从后往前找最后一条收尾标记（整行标记，或者行内 <close>）
  let idx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CLOSE_MARK_LINE.test(lines[i]) || CLOSE_TAG.test(lines[i])) { idx = i; break }
  }
  if (idx < 0) return { text, summary: '', resume: '' }

  const drop = new Set()
  let summary = ''
  let resume = ''
  // `<close>` 同一行后面直接跟「摘要：」也算
  const tag = CLOSE_TAG.exec(lines[idx])
  if (tag) {
    const inline = CLOSE_PAYLOAD.exec(lines[idx].slice(tag.index + tag[0].length))
    if (inline) {
      if (inline[1] === '摘要') summary = inline[2].trim()
      else resume = inline[2].trim()
      lines[idx] = lines[idx].slice(0, tag.index + tag[0].length)
    }
  }
  const eat = (i) => {
    const p = CLOSE_PAYLOAD.exec(lines[i])
    if (p[1] === '摘要') summary = summary || p[2].trim()
    else resume = resume || p[2].trim()
    drop.add(i)
  }
  // 标记前面紧挨着的那几行
  for (let i = idx - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue
    if (!CLOSE_PAYLOAD.test(lines[i])) break
    eat(i)
  }
  // 标记后面紧挨着的那几行（后面还接着正文也照样摘掉，不能让摘要漏出去）
  for (let i = idx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    if (!CLOSE_PAYLOAD.test(lines[i])) break
    eat(i)
  }
  if (!drop.size && !summary && !resume) return { text, summary: '', resume: '' }
  return { text: lines.filter((_, i) => !drop.has(i)).join('\n'), summary, resume }
}

/**
 * 摘掉回复里的等待 / 收尾标记，同时把它们的意图读出来。
 * 意图只认「末尾」：最后一行正文行尾跟着的标记，或者末尾单独占行的标记。
 * @param {string} text 模型这一轮的正文（已经过出站清洗）
 * @param {{waitSec?: number, maxWaitSec?: number, summaryMaxChars?: number, resumeMaxChars?: number}} [opts]
 * @returns {{text: string, waitMs: number|null, close: boolean, hadWait: boolean, hadClose: boolean, summary: string, resume: string}}
 *   waitMs：要等的毫秒数（0 = 取消等待；null = 没有这个标记）；close 为 true 时 waitMs 一律是 null（收尾优先）
 *   summary / resume：`<close>` 后面「摘要：/下次：」写的内容（给 resume 用，不发给对方）
 */
export function parseWrapUp(text, {
  waitSec = DEFAULT_WAIT_SEC,
  maxWaitSec = DEFAULT_MAX_WAIT_SEC,
  summaryMaxChars = DEFAULT_SUMMARY_MAX_CHARS,
  resumeMaxChars = DEFAULT_RESUME_MAX_CHARS,
} = {}) {
  const raw = String(text ?? '')
  const maxMs = Math.max(0, Number(maxWaitSec) || 0) * 1000
  const defMs = Math.max(0, Number(waitSec) || 0) * 1000
  let waitMs = null
  let close = false
  let sawWait = false
  let sawClose = false
  const take = (slash, name, attrs) => {
    if (slash) return // </wait> / </close>：只去标记
    if (String(name).toLowerCase() === 'close') { close = sawClose = true; return }
    const asked = durationOf(attrs)
    sawWait = true
    waitMs = Math.min(maxMs, Math.max(0, asked == null ? defMs : asked))
  }
  // <close> 后面「摘要 / 下次」先摘走：它们是给插件看的，不是正文
  const payload = closePayloadOf(raw)
  const lines = payload.text.split('\n')
  // 从后往前：跳过空行和「整行只有标记」的行，停在第一行有正文的地方；
  // 这一行只认行尾跟着的标记（「比如这样：<wait:30>」这种举例不算）。
  let lastBody = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    if (ANGLE_ANY.test(line) && !line.replace(ANGLE, '').trim()) {
      for (const m of line.matchAll(ANGLE)) take(m[1], m[2], m[3])
      lastBody = i - 1
      continue
    }
    lastBody = i
    const { head, tags } = splitTrailingTags(line)
    if (tags.length && head.trim() && !EXAMPLE_TAIL.test(head.trim())) {
      for (const t of tags) take('', t.name, t.attrs)
    }
    break
  }
  // 括号写法：只认整行、而且是最后一行正文
  if (lastBody >= 0) {
    const m = BRACKET.exec(String(lines[lastBody] ?? '').trim())
    if (m) {
      if (m[1] === '收尾' || m[1] === '结束') close = sawClose = true
      else {
        const asked = m[2] == null ? null : Math.round(Number(m[2]) * (/^(分钟|分|m)$/i.test(String(m[3] || '')) ? 60 : 1) * 1000)
        sawWait = true
        waitMs = Math.min(maxMs, Math.max(0, asked == null ? defMs : asked))
      }
    }
  }
  if (close) waitMs = null
  return {
    text: tidyLines(stripWrapMarkers(payload.text)),
    waitMs,
    close,
    hadWait: sawWait,
    hadClose: sawClose,
    summary: clipText(payload.summary, summaryMaxChars),
    resume: clipText(payload.resume, resumeMaxChars),
  }
}

/**
 * 只把标记去掉（不改动别的字）。出站兜底用：标记永远不该出现在 QQ 上。
 * 尖括号标记全文剥；括号标记只剥「整行就是它」的行（`我在[等待]你` 这种句子原样留着）。
 */
export function stripWrapMarkers(text) {
  const s = String(text ?? '')
  if (!/[<【[]/.test(s)) return s
  const lines = s.split('\n')
  const kept = []
  for (const line of lines) {
    if (BRACKET_LINE.test(line)) continue
    const clean = line.replace(ANGLE, '')
    // 整行只有标记（剥完是空的）：整行去掉，别在正文里留一行空白
    if (clean !== line && !clean.trim()) continue
    kept.push(clean)
  }
  if (kept.length === lines.length && kept.every((line, i) => line === lines[i])) return s
  return tidyLines(kept.join('\n'))
}

/**
 * 这句是不是在问对方（收尾保护用）。
 * 只认能读出来的问句：问号，或者句尾的「吗 / 呢 / 嘛 / 没 / 么」。
 * 宁可漏判也别误判——误判会让她该收尾时不收尾，一直挂着。
 */
export function looksLikeQuestion(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  const last = s.split('\n').map((x) => x.trim()).filter(Boolean).at(-1) || ''
  if (!last) return false
  // 去掉句尾的表情 / 语气符号再判断（「晚安呀～」「在吗？」都算）
  const core = last.replace(/[\s~～…。.、，,！!；;：:）)」”"']+$/u, '').trim()
  if (!core) return false
  if (/[？?]/.test(core)) return true
  return /(吗|呢|嘛|没|么)$/.test(core)
}

/**
 * 这句是不是在求她做事 / 找她帮忙（收尾保护用）。
 * 「帮我看看这个文件」「请问怎么弄」「能不能看一下」都算——对方在等她动手，这时候收尾就把人晾着了。
 */
export function looksLikeHelpRequest(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  return /帮我|帮忙|请问|看一下|查一下|看下|查下|能不能|可不可以|行不行|好不好|怎么|为什么|在哪|哪个|多少/.test(s)
}

/**
 * 每个聊天一份的等待 / 收尾状态（会落盘：snapshot / restore 由 hub 调用）。
 * 等待是「一次性」的：对方一开口就消费掉，她要继续等就在下一轮再写一次标记。
 * @param {{now?: () => number, noteTtlMs?: number}} [opts] now 可注入，方便测试
 */
export function createWrapUpState({ now = () => Date.now(), noteTtlMs = DEFAULT_NOTE_TTL_MS } = {}) {
  const chats = new Map() // chatId → { waitUntil, plannedMs, waitAt, waitReason, closeUntil, closeAt, closeSummary, closeResume, notes }
  const NOTE_MAX = 5

  const slot = (chatId) => {
    const key = String(chatId ?? '')
    let s = chats.get(key)
    if (!s) { s = {}; chats.set(key, s) }
    return s
  }
  const live = (s, at, atNow) => Boolean(s) && Number(s[at]) > 0 && atNow < Number(s[at])

  function dropWait(s) {
    delete s.waitUntil
    delete s.plannedMs
    delete s.waitAt
    delete s.waitReason
  }
  function dropClose(s) {
    delete s.closeUntil
    delete s.closeAt
    delete s.closeSummary
    delete s.closeResume
  }
  /** 还没过期的「下一轮要告诉她」的话。 */
  function freshNotes(s) {
    const at = now()
    return (Array.isArray(s.notes) ? s.notes : []).filter((n) => n && typeof n.text === 'string' && n.text && at - Number(n.at || 0) < noteTtlMs)
  }
  function sweep(s) {
    const at = now()
    if (!live(s, 'waitUntil', at)) dropWait(s)
    if (!live(s, 'closeUntil', at)) dropClose(s)
    const notes = freshNotes(s)
    if (notes.length) s.notes = notes
    else delete s.notes
    return s
  }

  /** 清掉两边都过期的空壳，返回剩下的条数。 */
  function prune() {
    const at = now()
    for (const [key, s] of chats) {
      sweep(s)
      if (!live(s, 'waitUntil', at) && !live(s, 'closeUntil', at) && !freshNotes(s).length) chats.delete(key)
    }
    return chats.size
  }

  return {
    /** 记下「等到什么时候」。ms <= 0 表示取消等待。reason: wait | question（问句保护改成的等）。 */
    markWait(chatId, ms, { reason = 'wait' } = {}) {
      const s = slot(chatId)
      const at = now()
      const plan = Math.max(0, Number(ms) || 0)
      dropClose(s) // 又决定等了：收尾状态作废
      if (!plan) { dropWait(s); return null }
      s.waitAt = at
      s.plannedMs = plan
      s.waitUntil = at + plan
      s.waitReason = reason === 'question' ? 'question' : 'wait'
      return { plannedMs: plan, waitUntil: s.waitUntil, reason: s.waitReason }
    },
    /** 记下「这段收尾了」。等待状态一并清掉；summary / resume 是收尾时留给下次的（resume 时带给她）。 */
    markClose(chatId, ms, { summary = '', resume = '' } = {}) {
      const s = slot(chatId)
      const at = now()
      dropWait(s)
      s.closeAt = at
      s.closeUntil = at + Math.max(0, Number(ms) || 0)
      s.closeSummary = String(summary || '').slice(0, 2000)
      s.closeResume = String(resume || '').slice(0, 1000)
      return { closeUntil: s.closeUntil, summary: s.closeSummary, resume: s.closeResume }
    },
    /** 现在是不是在等 / 已经收尾（只读，不改状态）。 */
    peek(chatId) {
      const s = chats.get(String(chatId ?? ''))
      if (!s) return { waiting: false, plannedMs: 0, waitLeftMs: 0, waitReason: '', closed: false, closeLeftMs: 0, summary: '', resume: '' }
      const at = now()
      const waiting = live(s, 'waitUntil', at)
      const closed = live(s, 'closeUntil', at)
      return {
        waiting,
        plannedMs: waiting ? Number(s.plannedMs) || 0 : 0,
        waitLeftMs: waiting ? Math.max(0, Number(s.waitUntil) - at) : 0,
        waitReason: waiting ? String(s.waitReason || 'wait') : '',
        closed,
        closeLeftMs: closed ? Math.max(0, Number(s.closeUntil) - at) : 0,
        summary: closed ? String(s.closeSummary || '') : '',
        resume: closed ? String(s.closeResume || '') : '',
      }
    },
    /** 对方开口了：消费掉等待状态，返回「等了多久、为什么等」。没在等 / 已经过期都返回 null。 */
    takeWait(chatId) {
      const s = chats.get(String(chatId ?? ''))
      if (!s || !live(s, 'waitUntil', now())) {
        if (s) { dropWait(s); sweep(s) }
        return null
      }
      const waitedMs = now() - (Number(s.waitAt) || 0)
      const plannedMs = Number(s.plannedMs) || 0
      const reason = String(s.waitReason || 'wait')
      dropWait(s)
      sweep(s)
      return { waitedMs: Math.max(0, waitedMs), plannedMs, reason }
    },
    /** 收尾之后再收到消息：消费掉收尾状态，返回「过了多久、收尾前的摘要、下次怎么接」。 */
    takeClose(chatId) {
      const s = chats.get(String(chatId ?? ''))
      if (!s || !live(s, 'closeUntil', now())) {
        if (s) { dropClose(s); sweep(s) }
        return null
      }
      const closedMs = now() - (Number(s.closeAt) || 0)
      const summary = String(s.closeSummary || '')
      const resume = String(s.closeResume || '')
      dropClose(s)
      sweep(s)
      return { closedMs: Math.max(0, closedMs), summary, resume }
    },
    /** 定时器到点：等待窗口真的过了才返回（对方中途开口就什么都不做）。 */
    expire(chatId) {
      const s = chats.get(String(chatId ?? ''))
      if (!s || !Number(s.waitUntil)) return null
      if (now() < Number(s.waitUntil)) return null
      const plannedMs = Number(s.plannedMs) || 0
      const reason = String(s.waitReason || 'wait')
      dropWait(s)
      sweep(s)
      return { plannedMs, reason }
    },
    /** 记一句「下一轮要告诉她」的话（兜底摘要 / 等待被接上 / 收尾后 resume）。 */
    pushNote(chatId, text) {
      const s = slot(chatId)
      const t = String(text ?? '').trim()
      if (!t) return false
      s.notes = [...freshNotes(s), { at: now(), text: t.slice(0, 500) }].slice(-NOTE_MAX)
      return true
    },
    /** 取走还没过期的提示（取完就删，包括已经过期的）。 */
    takeNotes(chatId) {
      const s = chats.get(String(chatId ?? ''))
      if (!s || !s.notes) return []
      const fresh = freshNotes(s)
      delete s.notes
      sweep(s)
      return fresh.map((n) => n.text)
    },
    clear(chatId) {
      chats.delete(String(chatId ?? ''))
    },
    /** 还在等的那几个（重启后要重新挂定时器）。 */
    liveWaits() {
      const at = now()
      const out = []
      for (const [chatId, s] of chats) {
        if (!live(s, 'waitUntil', at)) continue
        out.push({ chatId, plannedMs: Number(s.plannedMs) || 0, waitLeftMs: Math.max(0, Number(s.waitUntil) - at), reason: String(s.waitReason || 'wait') })
      }
      return out
    },
    prune,
    /** 落盘用：只留还有效的字段（过期的等待 / 收尾和旧提示都丢掉）。 */
    snapshot() {
      prune()
      const at = now()
      const out = {}
      for (const [chatId, s] of chats) {
        const v = {}
        if (live(s, 'waitUntil', at)) {
          v.waitUntil = Number(s.waitUntil)
          v.plannedMs = Number(s.plannedMs) || 0
          v.waitAt = Number(s.waitAt) || at
          v.waitReason = s.waitReason === 'question' ? 'question' : 'wait'
        }
        if (live(s, 'closeUntil', at)) {
          v.closeUntil = Number(s.closeUntil)
          v.closeAt = Number(s.closeAt) || at
          v.closeSummary = String(s.closeSummary || '').slice(0, 2000)
          v.closeResume = String(s.closeResume || '').slice(0, 1000)
        }
        const notes = freshNotes(s)
        if (notes.length) v.notes = notes.map((n) => ({ at: Number(n.at) || at, text: String(n.text).slice(0, 500) }))
        if (Object.keys(v).length) out[chatId] = v
      }
      return { v: 1, chats: out }
    },
    /**
     * 从 snapshot() 恢复。返回 { loaded, expiredWaits }：
     *   expiredWaits 是「重启前就已经等满、但还没来得及记摘要」的那些（hub 按 recap 设置补一句）。
     */
    restore(raw) {
      const out = { loaded: 0, expiredWaits: [] }
      if (!raw || typeof raw !== 'object' || !raw.chats || typeof raw.chats !== 'object') return out
      const at = now()
      for (const [chatId, v] of Object.entries(raw.chats)) {
        if (!v || typeof v !== 'object') continue
        const s = {}
        const waitUntil = Number(v.waitUntil)
        const plannedMs = Number(v.plannedMs)
        if (Number.isFinite(waitUntil) && waitUntil > 0 && Number.isFinite(plannedMs) && plannedMs > 0) {
          if (at < waitUntil) {
            s.waitUntil = waitUntil
            s.plannedMs = plannedMs
            s.waitAt = Number(v.waitAt) || waitUntil - plannedMs
            s.waitReason = v.waitReason === 'question' ? 'question' : 'wait'
          } else if (at - waitUntil <= noteTtlMs) {
            out.expiredWaits.push({ chatId, plannedMs, reason: v.waitReason === 'question' ? 'question' : 'wait' })
          }
        }
        const closeUntil = Number(v.closeUntil)
        if (Number.isFinite(closeUntil) && closeUntil > at) {
          s.closeUntil = closeUntil
          s.closeAt = Number(v.closeAt) || at
          s.closeSummary = typeof v.closeSummary === 'string' ? v.closeSummary.slice(0, 2000) : ''
          s.closeResume = typeof v.closeResume === 'string' ? v.closeResume.slice(0, 1000) : ''
        }
        const notes = Array.isArray(v.notes)
          ? v.notes.filter((n) => n && typeof n.text === 'string' && n.text && at - Number(n.at || 0) < noteTtlMs).slice(-NOTE_MAX)
          : []
        if (notes.length) s.notes = notes.map((n) => ({ at: Number(n.at) || at, text: String(n.text).slice(0, 500) }))
        if (Object.keys(s).length) { chats.set(String(chatId), s); out.loaded++ }
      }
      return out
    },
    clearAll() {
      chats.clear()
    },
    size() {
      return chats.size
    },
  }
}
