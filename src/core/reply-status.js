// Display-only observations. No message, prompt, or delivery path reads this store.
// 落盘用同步 IO：这里每次最多写 2000 行、且只在回合结束时触发一次，
// 而异步写盘会和宿主退出 / 测试删目录赛跑（ENOTEMPTY）。同步写完就不会留半截。
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './store.js'

const sessionKey = id => String(id || '').replace(/^session-/, '')
const validKey = id => /^[a-zA-Z0-9_-]{1,100}$/.test(id)
const textOf = message => (message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
const MAX_RECORDS = 2000

export function createReplyStatus({ directory = dataDir('reply-status'), chatOfSession, log } = {}) {
  const active = new Map(), candidates = new Map(), files = new Map()
  let disposed = false
  const warn = () => { try { log?.debug?.('回复稿件标识保存失败，聊天照常。') } catch {} }
  function fileFor(key) {
    if (!files.has(key)) {
      let rows = []
      try {
        const saved = JSON.parse(readFileSync(join(directory, key + '.json'), 'utf8'))
        if (Array.isArray(saved.rows)) rows = saved.rows.slice(-MAX_RECORDS)
      } catch {}
      files.set(key, { rows })
    }
    return files.get(key)
  }
  function persist(key, row) {
    if (disposed) return
    const file = fileFor(key)
    file.rows = [...file.rows.filter(r => r.seq !== row.seq), row].slice(-MAX_RECORDS)
    try {
      mkdirSync(directory, { recursive: true })
      const path = join(directory, key + '.json'), tmp = path + '.tmp'
      writeFileSync(tmp, JSON.stringify({ version: 1, rows: file.rows }), 'utf8')
      renameSync(tmp, path)
    } catch { warn() }
  }
  function report(value) {
    if (disposed || !value || !validKey(sessionKey(value.sessionId))) return
    if (!['edited', 'original'].includes(value.state) || typeof value.text !== 'string') return
    const key = sessionKey(value.sessionId), current = active.get(key)
    if (current?.userId !== value.userMessageId) return
    candidates.set(key, value)
  }
  function onEvent(session, event) {
    if (disposed || !session?.id || !event) return
    const key = sessionKey(session.id)
    if (!validKey(key)) return
    if (event.type === 'turn/start') {
      active.delete(key); candidates.delete(key)
      return
    }
    if (event.type === 'user/message') {
      const message = event.data
      if (message?.source?.kind === 'aurabot' && /^(private|group):/.test(chatOfSession?.(session.id) || '')) {
        active.set(key, { userId: message.id })
      } else if (!['runtime-context', 'time-context'].includes(message?.source?.kind) && message?.source?.form !== 'notice') {
        active.delete(key)
      }
      candidates.delete(key)
      return
    }
    if (event.type === 'turn/end') {
      active.delete(key); candidates.delete(key)
      return
    }
    if (event.type !== 'assistant/message' || !active.has(key)) return
    const candidate = candidates.get(key)
    candidates.delete(key)
    const message = event.data?.message, text = textOf(message)
    if (!text || !Number.isSafeInteger(event.seq) || event.seq < 0 || message?.content?.some(b => ['tool-call', 'tool_use'].includes(b.type))) return
    const matched = candidate?.userMessageId === active.get(key).userId && candidate.text === text
    const row = {
      seq: event.seq, messageId: String(message.id || ''), state: matched ? candidate.state : 'original',
      reason: matched ? String(candidate.reason || '').slice(0, 60) : 'not-edited',
      before: matched && Number.isFinite(candidate.before) ? candidate.before : text.length,
      after: text.length,
      ...(matched && Number.isFinite(candidate.elapsedMs) ? { elapsedMs: candidate.elapsedMs } : {}),
    }
    persist(key, row)
  }
  async function read(sessionId, startSeq, endSeq) {
    const key = sessionKey(sessionId), start = Number(startSeq), end = Number(endSeq)
    if (!validKey(key) || startSeq == null || endSeq == null || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null
    return fileFor(key).rows.filter(row => row.seq >= start && row.seq <= end).at(-1) || null
  }
  async function dispose() {
    disposed = true; active.clear(); candidates.clear(); files.clear()
  }
  return { report, onEvent, read, dispose }
}
