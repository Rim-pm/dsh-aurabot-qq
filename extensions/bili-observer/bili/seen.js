const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
// 判重表 bili-seen.json：看过的视频、档位、理由、状态（seen / liked / faved）。
// 倒序存，最多 2000 条；老版本只在 bili.json 里存 bvid 数组，第一次读的时候迁移过来。

const { dataDir, readJson, writeJson } = __lib('core/store.js')

export const SEEN_LIMIT = 2000
export const TIERS = ['worth', 'ok', 'skip']
const STATUSES = ['seen', 'liked', 'faved']
const STATUS_RANK = { seen: 0, liked: 1, faved: 2 }

const text = (v, n) => String(v ?? '').trim().slice(0, n)
const isBvid = (v) => /^BV[0-9A-Za-z]{10}$/.test(v)

export function seenFile() {
  return dataDir('bili-seen.json')
}

/** 整理成 { version: 1, items }：丢掉没 bvid 的、按 bvid 去重（留最前面那条）、裁到上限。 */
export function normalizeSeen(raw, { limit = SEEN_LIMIT } = {}) {
  const list = Array.isArray(raw?.items) ? raw.items : []
  const out = []
  const seen = new Set()
  for (const it of list) {
    const bvid = text(it?.bvid, 20)
    if (!isBvid(bvid) || seen.has(bvid)) continue
    seen.add(bvid)
    out.push({
      bvid,
      title: text(it.title, 200),
      up: text(it.up ?? it.author, 80),
      tier: TIERS.includes(it.tier) ? it.tier : 'ok',
      why: text(it.why, 300),
      at: Number(it.at) || 0,
      status: STATUSES.includes(it.status) ? it.status : 'seen',
    })
    if (out.length >= limit) break
  }
  return { version: 1, items: out }
}

/** 老数据迁移：bili.json 里的 seen 数组（只有 bvid）→ 判重表条目。 */
export function migrateSeen(legacy, { now = Date.now() } = {}) {
  const list = Array.isArray(legacy) ? legacy : []
  return normalizeSeen({ items: list.map((bvid) => ({ bvid, tier: 'ok', why: '', at: now, status: 'seen' })) })
}

/** 新增 / 更新一条：同一 bvid 先删旧的再放最前面（倒序），超过上限裁尾。 */
export function pushSeen(state, entry, { limit = SEEN_LIMIT } = {}) {
  const base = normalizeSeen(state, { limit })
  const bvid = text(entry?.bvid, 20)
  if (!isBvid(bvid)) return base
  const [item] = normalizeSeen({ items: [{ ...entry, bvid }] }).items
  const rest = base.items.filter((x) => x.bvid !== bvid)
  return { version: 1, items: [item, ...rest].slice(0, limit) }
}

/** 改某条的状态（seen → liked / faved）；只升不降，找不到就原样返回。 */
export function markSeen(state, bvid, status, { limit = SEEN_LIMIT } = {}) {
  const base = normalizeSeen(state, { limit })
  if (!STATUSES.includes(status)) return base
  return {
    version: 1,
    items: base.items.map((it) => (it.bvid === bvid && STATUS_RANK[status] > STATUS_RANK[it.status] ? { ...it, status } : it)),
  }
}

export function seenSet(state) {
  return new Set((state?.items || []).map((it) => it.bvid))
}

export function loadSeen({ file = seenFile(), read = readJson } = {}) {
  return normalizeSeen(read(file, null))
}

export function saveSeen(state, { file = seenFile(), write = writeJson } = {}) {
  const clean = normalizeSeen(state)
  write(file, clean)
  return clean
}
