const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
// 记账：日报 bili-reports/YYYY-MM-DD.md（追加、90 天清理）和归档 bili-digest/YYYY-MM.md（一行一条）。
// 日报里的 `### BV` 行数 = 当天挑中的条数，面板和摘要都数这个来对账每日配额。

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { dataDir } = __lib('core/store.js')

export const REPORT_KEEP_DAYS = 90
export const TIER_LABEL = { worth: '值得看', ok: '可以看', skip: '跳过' }
const NO_SUB_LINE = /^因无字幕跳过 (\d+) 条$/m
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/

const pad = (n) => String(n).padStart(2, '0')
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
export const shortDate = (d = new Date()) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function reportsDir() {
  return dataDir('bili-reports')
}

export function digestDir() {
  return dataDir('bili-digest')
}

export function reportFile(date) {
  return join(reportsDir(), `${date}.md`)
}

export function digestFile(month) {
  return join(digestDir(), `${month}.md`)
}

/** 播放量：12.3 万，不够一万就原样。 */
export function formatPlay(n) {
  const v = Number(n) || 0
  return v >= 10000 ? `${(v / 10000).toFixed(1).replace(/\.0$/, '')} 万` : String(v)
}

/** 当天挑中的条数：数 `### BV` 开头的行。 */
export function countPicked(markdown) {
  return (String(markdown || '').match(/^### BV/gm) || []).length
}

/** 日报里已有的「因无字幕跳过 N 条」；没有就当 0。 */
export function lastNoSubtitle(markdown) {
  const m = NO_SUB_LINE.exec(String(markdown || ''))
  return m ? Number(m[1]) || 0 : 0
}

export function stripNoSubtitle(markdown) {
  return String(markdown || '').replace(/^\s*因无字幕跳过 \d+ 条\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 一条视频 → 日报里的一段（首行固定 `### BV号`）。 */
export function renderEntry(entry = {}) {
  const bvid = String(entry.bvid || '')
  return [
    `### ${bvid}`,
    `- ${entry.title || '（没标题）'} / ${entry.up || '?'} / 播放 ${formatPlay(entry.play)} / https://www.bilibili.com/video/${bvid}`,
    `- **档位**：${TIER_LABEL[entry.tier] || TIER_LABEL.ok}`,
    `- 为什么值得：${entry.why || '（没写）'}`,
    `- 她的一句话：${entry.feeling || '（没写）'}`,
  ].join('\n')
}

/** 追加式渲染：老内容原样留着，新条目接在后面，末尾固定一行「因无字幕跳过 N 条」。 */
export function appendReportMarkdown(markdown, entries = [], { noSubtitle = 0 } = {}) {
  const prev = stripNoSubtitle(markdown)
  const total = lastNoSubtitle(markdown) + (Number(noSubtitle) || 0)
  const blocks = [prev, ...entries.map(renderEntry)].filter((x) => String(x || '').trim())
  return `${blocks.join('\n\n')}\n\n因无字幕跳过 ${total} 条\n`
}

export function readReport(date = dateKey()) {
  try { return readFileSync(reportFile(date), 'utf8') } catch (error) { return '' }
}

/** 写当天日报：读旧的 → 追加 → 落盘 → 顺带清掉 90 天前的。 */
export function appendReport(date, entries = [], { noSubtitle = 0, dir = reportsDir() } = {}) {
  const md = appendReportMarkdown(readReport(date), entries, { noSubtitle })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${date}.md`), md, 'utf8')
  cleanupReports({ dir })
  return md
}

/** 日报 → [{ bvid, title, tier }]，摘要用。 */
export function parseReport(markdown) {
  const out = []
  for (const block of String(markdown || '').split(/^### /m).slice(1)) {
    const lines = block.split('\n')
    const bvid = String(lines[0] || '').trim()
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue
    const first = lines.find((l) => l.startsWith('- ')) || ''
    const title = first.replace(/^- /, '').split(' / ')[0].trim()
    const tierLine = lines.find((l) => l.startsWith('- **档位**：')) || ''
    const label = tierLine.replace('- **档位**：', '').trim()
    const tier = Object.keys(TIER_LABEL).find((k) => TIER_LABEL[k] === label) || 'ok'
    out.push({ bvid, title, tier })
  }
  return out
}

/** 日报摘要（每天 21:00 私聊一条）：最多列 5 条值得看，末尾带档位分布。 */
export function digestMessage({ items = [], skipped = 0, noSubtitle = 0 } = {}) {
  const worth = items.filter((x) => x.tier === 'worth')
  const ok = items.filter((x) => x.tier === 'ok')
  const head = worth.length
    ? `今天刷了 ${items.length} 条，${worth.length} 条值得看：`
    : `今天刷了 ${items.length} 条，没有特别值得看的：`
  const lines = worth.slice(0, 5).map((x) => `· 《${x.title || x.bvid}》 ${x.bvid}`)
  const tail = []
  if (skipped) tail.push(`跳过 ${skipped} 条`)
  if (ok.length) tail.push(`可以看 ${ok.length} 条`)
  if (noSubtitle) tail.push(`因无字幕跳过 ${noSubtitle} 条`)
  return [head, ...lines, tail.length ? tail.join('，') + '。' : ''].filter(Boolean).join('\n')
}

/** 归档一行：挑中的和跳过的都记。 */
export function archiveLine(entry = {}, date = dateKey()) {
  const label = TIER_LABEL[entry.tier] || TIER_LABEL.ok
  const why = entry.tier === 'skip' && entry.why ? `（${entry.why}）` : ''
  const [, m, d] = String(date).split('-')
  const day = m && d ? `${m}-${d}` : shortDate()
  return `${day} · ${entry.bvid} · ${entry.title || '（没标题）'} · ${entry.up || '?'} · ${label}${why} · https://www.bilibili.com/video/${entry.bvid}`
}

export function appendDigest(date, entries = [], { dir = digestDir() } = {}) {
  if (!entries.length) return ''
  const month = String(date).slice(0, 7)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${month}.md`)
  let prev = ''
  try { prev = readFileSync(file, 'utf8') } catch (error) {}
  const body = prev + entries.map((e) => archiveLine(e, date)).join('\n') + '\n'
  writeFileSync(file, body, 'utf8')
  return body
}

/** 清掉超过 90 天的日报（按文件名里的日期，不看修改时间）。 */
export function cleanupReports({ now = Date.now(), keepDays = REPORT_KEEP_DAYS, dir = reportsDir() } = {}) {
  const cutoff = dateKey(new Date(now - keepDays * 86400_000))
  const removed = []
  let names = []
  try { names = readdirSync(dir) } catch (error) { return removed }
  for (const name of names) {
    const m = DATE_FILE.exec(name)
    if (!m || m[1] >= cutoff) continue
    try { unlinkSync(join(dir, name)); removed.push(m[1]) } catch (error) {}
  }
  return removed
}

/** 有日报的日期，新的在前（面板切日期用）。 */
export function reportDates({ dir = reportsDir(), limit = 30 } = {}) {
  let names = []
  try { names = readdirSync(dir) } catch (error) { return [] }
  return names.map((n) => DATE_FILE.exec(n)?.[1]).filter(Boolean).sort().reverse().slice(0, limit)
}
