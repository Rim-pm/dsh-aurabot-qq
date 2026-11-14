// 日报与归档：追加不覆盖、`### BV` 计数、因无字幕行、90 天清理、归档挑中的和跳过的都有。
import './helpers/bili-lib.js'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDigest, appendReport, appendReportMarkdown, archiveLine, cleanupReports,
  countPicked, dateKey, digestMessage, lastNoSubtitle, parseReport, reportDates, reportsDir,
} from '../extensions/bili-observer/bili/report.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-bili-report-'))
process.env.AURABOT_DATA_DIR = root
const fresh = () => rmSync(join(root, 'bili-reports'), { recursive: true, force: true })

before(() => { process.env.AURABOT_DATA_DIR = root })

const worth = { bvid: 'BV1aaaaaaaaa', title: '米饭的三种做法', up: '小井', play: 123000, tier: 'worth', why: '第 3 分钟的演示很具体', feeling: '这个我服' }
const ok = { bvid: 'BV1bbbbbbbbb', title: '随便看看', up: '路人', play: 800, tier: 'ok', why: '有信息', feeling: '还行' }
const skip = { bvid: 'BV1ccccccccc', title: '标题党', up: '营销号', play: 99999, tier: 'skip', why: '标题党', feeling: '没意思' }

test('日报：一条一段，首行固定 ### BV，播放量按万显示，末尾固定「因无字幕跳过 N 条」', () => {
  const md = appendReportMarkdown('', [worth], { noSubtitle: 1 })
  assert.match(md, /^### BV1aaaaaaaaa$/m)
  assert.match(md, /- 米饭的三种做法 \/ 小井 \/ 播放 12\.3 万 \/ https:\/\/www\.bilibili\.com\/video\/BV1aaaaaaaaa/)
  assert.match(md, /- \*\*档位\*\*：值得看/)
  assert.match(md, /- 为什么值得：第 3 分钟的演示很具体/)
  assert.match(md, /- 她的一句话：这个我服/)
  assert.match(md, /因无字幕跳过 1 条\s*$/)
  assert.equal(countPicked(md), 1)
})

test('日报：追加不覆盖，### 行数 = 挑中的条数，无字幕数累加', () => {
  let md = appendReportMarkdown('', [worth], { noSubtitle: 1 })
  md = appendReportMarkdown(md, [ok], { noSubtitle: 2 })
  assert.equal(countPicked(md), 2, '两次写的都在')
  assert.ok(md.indexOf('### BV1aaaaaaaaa') < md.indexOf('### BV1bbbbbbbbb'), '新的接在后面')
  assert.equal(lastNoSubtitle(md), 3, '当天的无字幕数累加')
  assert.equal((md.match(/因无字幕跳过/g) || []).length, 1, '末尾只有一行')
  // 当天一条都没挑中也要写这一行
  const empty = appendReportMarkdown('', [], { noSubtitle: 4 })
  assert.equal(countPicked(empty), 0)
  assert.match(empty, /因无字幕跳过 4 条/)
})

test('日报落盘：文件不存在就新建，存在就追加；同一天两轮都留着', () => {
  fresh()
  appendReport('2026-11-06', [worth], { noSubtitle: 1 })
  appendReport('2026-11-06', [ok], { noSubtitle: 0 })
  const md = readFileSync(join(reportsDir(), '2026-11-06.md'), 'utf8')
  assert.equal(countPicked(md), 2)
  assert.match(md, /因无字幕跳过 1 条/)
  assert.deepEqual(reportDates(), ['2026-11-06'])
  assert.deepEqual(parseReport(md).map((x) => [x.bvid, x.tier]), [['BV1aaaaaaaaa', 'worth'], ['BV1bbbbbbbbb', 'ok']])
})

test('日报清理：90 天前的删掉，边界内和别的文件不动', () => {
  fresh()
  const dir = reportsDir()
  mkdirSync(dir, { recursive: true })
  for (const name of ['2026-01-01.md', '2026-08-10.md', '2026-11-05.md', 'note.txt']) writeFileSync(join(dir, name), 'x')
  const removed = cleanupReports({ now: Date.parse('2026-11-06T12:00:00+08:00') })
  assert.deepEqual(removed, ['2026-01-01'])
  assert.equal(existsSync(join(dir, '2026-01-01.md')), false)
  assert.equal(existsSync(join(dir, '2026-08-10.md')), true, '刚好在 90 天内')
  assert.equal(existsSync(join(dir, '2026-11-05.md')), true)
  assert.equal(existsSync(join(dir, 'note.txt')), true, '不是日期文件就不动')
})

test('归档：一行一条，挑中的和跳过的都记，跳过带理由', () => {
  assert.equal(archiveLine(worth, '2026-11-06'), '11-06 · BV1aaaaaaaaa · 米饭的三种做法 · 小井 · 值得看 · https://www.bilibili.com/video/BV1aaaaaaaaa')
  assert.match(archiveLine(skip, '2026-11-06'), /· 跳过（标题党） · /)
  const body = appendDigest('2026-11-06', [worth, skip], { dir: join(root, 'digest-test') })
  const lines = body.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /值得看/)
  assert.match(lines[1], /跳过（标题党）/)
  assert.match(readFileSync(join(root, 'digest-test', '2026-11.md'), 'utf8'), /BV1ccccccccc/)
})

test('摘要文案：今天刷了几条、值得看几条、最多列 5 条，末尾带档位分布', () => {
  const items = [worth, ok, { ...ok, bvid: 'BV1ddddddddd', title: 'D' }]
  const text = digestMessage({ items, skipped: 2, noSubtitle: 1 })
  assert.match(text, /^今天刷了 3 条，1 条值得看：/)
  assert.match(text, /· 《米饭的三种做法》 BV1aaaaaaaaa/)
  assert.match(text, /跳过 2 条，可以看 2 条，因无字幕跳过 1 条。/)
  assert.equal((text.match(/· 《/g) || []).length, 1, '只列值得看')
  const many = Array.from({ length: 8 }, (_, i) => ({ ...worth, bvid: 'BV1' + String(i).padStart(9, '0') }))
  assert.equal((digestMessage({ items: many }).match(/· 《/g) || []).length, 5, '最多 5 条')
})

test('dateKey：本地日期 YYYY-MM-DD', () => {
  assert.match(dateKey(new Date(2026, 10, 6)), /^2026-11-06$/)
})

test('日报摘要：到点推一次，当天 0 条不发，重启不重推', async () => {
  fresh()
  const { normalize } = await import('../src/core/config.js')
  const { createBili } = await import('../extensions/bili-observer/bili/duty.js')
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001',
    speakUp: { awakeFrom: 0, awakeTo: 24 },
    bili: { enabled: true, autoBrowse: false, dailyDigest: true, dailyDigestHour: 0 },
  })
  const sent = []
  const make = () => createBili({
    getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    hub: { sendText: async (chatId, text) => sent.push({ chatId, text }) },
    api: {},
  })
  await make().tick()
  assert.equal(sent.length, 0, '当天没刷就不发，避免刷屏')

  appendReport(dateKey(), [worth], { noSubtitle: 0 })
  const b1 = make()
  await b1.tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:10000001')
  assert.match(sent[0].text, /今天刷了 1 条，1 条值得看/)
  assert.match(sent[0].text, /· 《米饭的三种做法》 BV1aaaaaaaaa/)

  await b1.tick()
  await make().tick()
  assert.equal(sent.length, 1, '同一实例和重启后的新实例都不重推')
})
