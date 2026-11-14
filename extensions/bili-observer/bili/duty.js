const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
// 刷 B 站（观察者）：定时挑她和你感兴趣的方向看视频，读简介、字幕、热评、弹幕，再按她的人格判断值不值得看；
// 只点赞和收藏，不评论、不发弹幕、不改资料。你在 QQ 里发链接，她也能点进去看完再聊。
// 看过的都记成她的经历，每天写一份日报，晚上推一条摘要给主人。

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
const { dataDir, readJson, writeJson } = __lib('core/store.js')
import { createBiliApi, findVideoId, parseCookie, UA } from './api.js'
import { loadSeen, migrateSeen, pushSeen, markSeen, seenSet, saveSeen, seenFile, TIERS } from './seen.js'
import { appendDigest, appendReport, dateKey, digestMessage, parseReport, readReport, reportDates, countPicked, lastNoSubtitle } from './report.js'
import { loginSessionKey, recoverLoginPause } from './login-pause.js'
import { lookWithVision, visionState, findFfmpeg } from './vision.js'
import { createShotStore, shotPath, clockOf } from './shots.js'
const { isSilence, cleanOutboundText } = __lib('chat/reply.js')

// 这些错误说明今天先别写了：没登录 / Cookie 过期、csrf 不对、风控、要验证码、太频繁
const PAUSE_CODES = { '-101': 'B 站没登录或 Cookie 过期了', '-111': 'Cookie 里的 bili_jct 不对', '-352': '被 B 站风控了', '-509': '写得太频繁', '12015': 'B 站要求验证码' }

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const link = (bvid) => `https://www.bilibili.com/video/${bvid}`

/** 从模型输出里取 JSON（对象或数组），取不到返回 fallback。 */
export function pickJson(out, fallback) {
  const s = String(out || '')
  const m = s.match(/\[[\s\S]*\]/) || s.match(/\{[\s\S]*\}/)
  if (!m) return fallback
  try { return JSON.parse(m[0]) } catch (error) { return fallback }
}

/** 搜到的视频按门槛过滤：播放量够、不太老、没看过。推荐流不走这个（老新混合本来就是推荐的样子）。 */
export function filterVideos(list, { minViews = 0, maxAgeDays = 0, seen = new Set(), now = Date.now() } = {}) {
  return (list || []).filter((v) => v.bvid && !seen.has(v.bvid) && (v.play || 0) >= minViews && (!maxAgeDays || !v.pubdate || now - v.pubdate <= maxAgeDays * 86400_000))
}

/** 一个视频交给她看的样子（标题、UP 主、简介、字幕节选、弹幕节选、画面描述、热评）。 */
export function digestOf(v, { subtitle = '', comments = [], vision = '', danmaku = [] } = {}) {
  return [
    `《${v.title}》 UP主：${v.author || '?'}  播放 ${v.play || 0}${v.tname ? '  分区：' + v.tname : ''}  ${v.bvid}`,
    v.desc ? `简介：${v.desc.slice(0, 300)}` : '',
    subtitle
      ? `字幕（节选）：${subtitle.slice(0, 2500)}`
      : `（没有字幕${vision ? '，只看了画面' : '，只能看标题、简介和评论'}）`,
    danmaku.length ? `弹幕（节选）：${danmaku.slice(0, 30).join(' / ')}` : '',
    vision ? `画面（抽帧）：${vision.slice(0, 900)}` : '',
    comments.length ? '热评：\n' + comments.slice(0, 8).map((c) => `  ${c.name}：${c.text}`).join('\n') : '',
  ].filter(Boolean).join('\n')
}

/**
 * 档位兜底（不信任模型）：非法值一律当 ok；worth 必须有字幕或画面证据，
 * 手里只有标题 / 时长 / 简介这类表层信息时最多给 ok。
 */
export function tierOf(decision, hasEvidence = false) {
  const tier = TIERS.includes(decision?.tier) ? decision.tier : 'ok'
  return tier === 'worth' && !hasEvidence ? 'ok' : tier
}

/** ffmpeg 把音频流抽成 16k 单声道 wav。成功 true，失败 false（不抛、不留半截文件）。 */
export function extractAudio(ffmpeg, url, file, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let done = false
    let proc
    let timer
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v) }
    timer = setTimeout(() => { try { proc?.kill() } catch (error) {} finish(false) }, timeoutMs)
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        // B 站 CDN 要 Referer，否则 403
        '-headers', `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`,
        '-i', url, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', file,
      ], { windowsHide: true })
    } catch (error) {
      return finish(false)
    }
    proc.on('error', () => finish(false))
    proc.on('close', (code) => finish(code === 0))
  })
}

export function createBili({ getConfig, hub, memory, log, dsh, api: injected, vision: see = lookWithVision, local }) {
  const cfg = () => getConfig().bili
  // 写闸门：observer 下只有点赞和收藏放行；social 全放行（工具和路由已经删掉，这里是兜底）
  const allowWrite = (kind) => cfg().posture === 'social' || kind === 'like' || kind === 'fav'
  const api = injected || createBiliApi({ getCookie: () => cfg().cookie, log, allowWrite })
  const shots = createShotStore({ max: () => getConfig().bili.shotLibrary })
  const file = () => dataDir('bili.json')
  const load = () => readJson(file(), () => ({ day: '', runs: 0, comments: 0, replies: 0, likes: 0, favs: 0, skipped: 0, noSubtitle: 0, lastRun: 0, seen: [], history: [] }))
  const save = (s) => writeJson(file(), s)
  const today = (s) => { if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), runs: 0, comments: 0, replies: 0, likes: 0, favs: 0, skipped: 0, noSubtitle: 0 }) ; return s }
  let busy = false
  let stopped = false
  let login = { at: 0, key: '', value: { isLogin: false, uname: '' } }

  const owner = () => getConfig().ownerName || '主人'
  // 登录态能写吗：Cookie 里要有 bili_jct，今天也没因为风控之类暂停（点赞和收藏同样会撞 -101）
  const canPost = (s) => Boolean(parseCookie(cfg().cookie).bili_jct) && s.pauseDay !== dayKey()
  const pauseIf = (s, error) => {
    const why = PAUSE_CODES[String(error.code)]
    if (!why) return
    s.pauseDay = dayKey()
    s.pauseReason = why
    log.warn(`今天先不在 B 站点赞 / 收藏了：${why}`)
  }
  const record = (s, item) => { s.history.unshift({ at: Date.now(), ...item }); s.history = s.history.slice(0, 40) }

  /** 判重表：文件不在就用 bili.json 里的老 seen 数组迁移一次，之后都读 bili-seen.json。 */
  function ensureSeen(s) {
    const file = seenFile()
    if (existsSync(file)) return loadSeen()
    const state = migrateSeen(s.seen)
    try { saveSeen(state) } catch (error) { log.debug('判重表写入失败：', error.message) }
    return state
  }

  /** 点赞：只给「值得看」，每天最多 maxLikesPerDay 条；到上限就不再发请求。 */
  async function likeOne(v, s) {
    const c = cfg()
    if (!c.like || !(Number(c.maxLikesPerDay) > 0) || (s.likes || 0) >= Number(c.maxLikesPerDay)) return false
    if (!canPost(s)) return false
    if (getConfig().dryRun) { log.info(`试运行：本来要给《${v.title}》点赞`); return false }
    try {
      const r = await api.likeVideo(v.aid)
      if (r && r.blocked) return false
      s.likes = (s.likes || 0) + 1
      record(s, { kind: 'like', title: v.title, bvid: v.bvid, text: '' })
      return true
    } catch (error) {
      log.debug(`点赞《${v.title}》失败：`, error.message)
      pauseIf(s, error)
      return false
    }
  }

  /** 收藏：worth → 夹 A，ok → 夹 B；没配夹子 / 没有 bili_jct / 到上限都跳过，不阻塞整轮。 */
  async function favOne(v, tier, s) {
    const c = cfg()
    const folderId = tier === 'worth' ? Number(c.favWorthFolderId) || 0 : tier === 'ok' ? Number(c.favOkFolderId) || 0 : 0
    if (!folderId) return false
    if ((s.favs || 0) >= (Number(c.maxFavsPerDay) || 0)) return false
    if (!canPost(s)) { log.debug('没有 bili_jct，跳过收藏'); return false }
    if (getConfig().dryRun) { log.info(`试运行：本来要把《${v.title}》收藏到夹 ${folderId}`); return false }
    try {
      const r = await api.favVideo(v.aid, folderId)
      if (r && r.blocked) return false
      s.favs = (s.favs || 0) + 1
      record(s, { kind: 'fav', title: v.title, bvid: v.bvid, text: tier === 'worth' ? '值得看' : '可以看' })
      return true
    } catch (error) {
      log.debug(`收藏《${v.title}》失败：`, error.message)
      pauseIf(s, error)
      return false
    }
  }

  /** 每天到点推一条日报摘要：当天 0 条不发，推过就不再推（重启也不重推）。 */
  async function maybeDigest(s) {
    const c = cfg()
    if (!c.dailyDigest) return false
    if (s.digestDay === dayKey()) return false
    if (new Date().getHours() < Number(c.dailyDigestHour)) return false
    const md = readReport(dayKey())
    const items = parseReport(md)
    if (!items.length) return false
    const ownerQQ = getConfig().ownerQQ
    if (!ownerQQ) return false
    const text = digestMessage({ items, skipped: s.skipped || 0, noSubtitle: lastNoSubtitle(md) || s.noSubtitle || 0 })
    s.digestDay = dayKey()
    if (getConfig().dryRun) {
      log.info(`试运行：本来要推今天的 B 站日报摘要：\n${text}`)
      save(s)
      return true
    }
    try {
      await hub.sendText(`private:${ownerQQ}`, text)
      record(s, { kind: 'digest', title: '日报摘要', text: `${countPicked(md)} 条` })
      log.info(`推了今天的 B 站日报摘要：${countPicked(md)} 条`)
      save(s)
      return true
    } catch (error) {
      s.digestDay = '' // 没发出去，下一分钟再试
      log.warn('日报摘要没发出去：', error.message)
      return false
    }
  }

  async function account(force = false) {
    const key = loginSessionKey(cfg().cookie)
    if (!force && key === login.key && Date.now() - login.at < 10 * 60_000) return login.value
    try {
      const value = await api.nav()
      if (stopped || key !== loginSessionKey(cfg().cookie)) return { isLogin: false, uname: '', error: '登录态已变化，请重新检查' }
      login = { at: Date.now(), key, value }
      const s = load()
      if (recoverLoginPause(s, { isLogin: value.isLogin, sessionKey: key, day: dayKey() })) {
        save(s)
        log.info('B 站登录核验通过，已解除登录失效导致的写入暂停')
      }
    } catch (error) {
      login = { at: Date.now(), key, value: { isLogin: false, uname: '', error: error.message } }
    }
    return login.value
  }

  async function think(prompt) {
    return hub.runSystemTurn('bili', 'QQ · 刷B站', `【刷 B 站，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 })
  }

  /** 刷视频这条线单独选的模型；没选就是 null（跟随聊天模型）。看画面时也要用它，不然抽帧和写想法不是同一个模型。 */
  function browseModel() {
    const m = cfg().browseModel || {}
    const provider = String(m.provider || '').trim()
    const model = String(m.model || '').trim()
    return provider && model ? { provider, model } : null
  }

  /** 这一轮搜什么：她自己的兴趣 + 记忆里你喜欢的东西 + 面板里填的关键词，让她挑 3 个。 */
  async function chooseKeywords() {
    const c = cfg()
    const interests = [...(c.keywords || []), ...(getConfig().group.interests || [])]
    const about = (memory?.list?.('') || []).filter((m) => String(m.about) === String(getConfig().ownerQQ) || /喜欢|爱|想|在玩|在看|追/.test(m.text)).slice(0, 12).map((m) => m.text)
    const recent = (memory?.recentEvents?.(72, 6) || []).filter((m) => (m.tags || []).includes('B站')).map((m) => m.text)
    try {
      const out = await think(`你想去 B 站刷点视频。你感兴趣的：${interests.join('、') || '随便看看'}。\n你记得的关于${owner()}和大家的事：\n${about.map((t) => '- ' + t).join('\n') || '（暂无）'}\n最近刷过的：\n${recent.map((t) => '- ' + t).join('\n') || '（暂无）'}\n\n挑 3 个这次想搜的关键词（可以是你自己想看的，也可以是${owner()}可能喜欢、你想分享给${owner()}的），别和最近刷过的重复。只输出 JSON 数组，例如 ["白米饭 做法","猫咪 搞笑"]。`)
      const arr = pickJson(out, []).map((k) => String(k).trim()).filter(Boolean)
      if (arr.length) return arr.slice(0, 3)
    } catch (error) {
      log.debug('挑关键词失败：', error.message)
    }
    return interests.sort(() => Math.random() - 0.5).slice(0, 3)
  }

  /**
   * 转写兜底（可选）：没有字幕、开着 transcribe、本机有 ffmpeg、local.asr 也开着时才走。
   * 任何一步失败都静默跳过（返回 ''），不影响这一轮；日报会记「因无字幕跳过 N 条」。
   */
  async function transcribeAudio(info) {
    const c = cfg()
    if (!c.transcribe || !local || typeof local.call !== 'function' || typeof api.playurl !== 'function') return ''
    // 先查本地 ASR 开关：没开就别抽音轨了，白下一遍音频
    if (typeof local.active !== 'function' || !local.active('asr')) return ''
    const ffmpeg = findFfmpeg(c.ffmpegPath)
    if (!ffmpeg) return ''
    let file = ''
    try {
      const stream = await api.playurl({ bvid: info.bvid, aid: info.aid, cid: info.cid })
      const url = stream?.audio?.[0]?.baseUrl || stream?.durl?.[0]?.url || ''
      if (!url) return ''
      file = dataDir('bili-audio', `${info.bvid || 'video'}-${Date.now()}.wav`)
      mkdirSync(dirname(file), { recursive: true })
      if (!(await extractAudio(ffmpeg, url, file))) return ''
      const r = await local.call('asr', { file })
      const text = String(typeof r === 'string' ? r : r?.text || '').trim()
      if (text) log.debug(`《${info.title}》没有字幕，转写到了 ${text.length} 字`)
      return text
    } catch (error) {
      log.debug(`转写《${info.title}》失败：`, error.message)
      return ''
    } finally {
      if (file) { try { rmSync(file, { force: true }) } catch (error) {} }
    }
  }

  async function lookAt(v, model = null) {
    const rawInfo = await api.view({ bvid: v.bvid })
    const info = {
      ...rawInfo,
      title: cleanOutboundText(rawInfo.title, { warn: (message) => log.warn(`B 站标题：${message}`) }).trim(),
      author: cleanOutboundText(rawInfo.author, { warn: (message) => log.warn(`B 站作者：${message}`) }).trim(),
    }
    const c = cfg()
    const readDanmaku = typeof api.danmakuText === 'function' ? api.danmakuText(info.cid).catch(() => []) : Promise.resolve([])
    const [rawSubtitle, comments, danmaku] = await Promise.all([api.subtitle(info).catch(() => ''), api.comments(info.aid).catch(() => []), readDanmaku])
    // 没有字幕时可选走本地 ASR 转写；失败就空着，不影响后面
    const subtitle = rawSubtitle || (c.transcribe ? await transcribeAudio(info) : '')
    // 开着「看画面」才抽帧：失败一律只记 debug，退回纯文本，不影响这一轮
    let vision = ''
    let shotIds = []
    if (c.vision) {
      try {
        const r = await see({ dsh, api, info, getConfig, log, model })
        vision = r.text || ''
        if (vision) log.debug(`看了《${info.title}》的画面：${vision.slice(0, 40)}…`)
        // 抽到的帧顺手存进截图库：之后她自己发、或主人让她挑一张发
        for (const f of r.frames || []) {
          const it = shots.put(f.buf, { bvid: info.bvid, title: info.title, sec: f.sec, note: vision.slice(0, 120) })
          if (it) shotIds.push(it.file)
        }
      } catch (error) {
        log.debug(`看画面失败（${info.bvid}）：`, error.message)
      }
    }
    return { info, subtitle, comments, danmaku, vision, shotIds, digest: digestOf(info, { subtitle, comments, vision, danmaku }) }
  }

  /** 挑一张存下来的截图发到指定会话（主人让她发 / 她刷完顺手发）。 */
  async function sendShot({ chatId, query = '' } = {}) {
    const g = getConfig()
    if (!g.enabled || !g.bili.enabled) return { ok: false, sent: false, message: '插件或 B 站没打开' }
    if (!/^(private|group):\d+$/.test(String(chatId || ''))) return { ok: false, sent: false, message: '没有可发送的 QQ 会话' }
    const it = shots.pick(query)
    if (!it) {
      return {
        ok: false,
        message: query ? `没有和「${query}」对得上的截图（不带条件再挑就是最近的一张）` : '我还没截过图（刷 B 站看画面的时候才会截）',
      }
    }
    if (!shots.exists(it)) return { ok: false, message: '那张截图的文件已经没有了' }
    if (g.dryRun) return { ok: true, sent: false, simulated: true, message: `试运行：准备发送《${it.title}》${clockOf(it.sec)} 的截图，未实际发送` }
    let r
    try { r = await hub.sendImage(chatId, shotPath(it)) } catch (error) {
      return { ok: false, sent: false, message: '图没发出去：' + error.message }
    }
    if (String(r?.message_id || '').startsWith('sim-')) return { ok: true, sent: false, simulated: true, message: '模拟发送：未实际发到 QQ' }
    if (r?.message_id === undefined) return { ok: false, sent: false, message: '图没发出去或未收到消息回执，看日志' }
    const st = load()
    record(st, { kind: 'shot', title: it.title, bvid: it.bvid, text: `第 ${clockOf(it.sec)} 的截图` })
    save(st)
    log.info(`发了一张截图《${it.title}》${clockOf(it.sec)} → ${chatId}`)
    return { ok: true, sent: true, message: `发了《${it.title}》${clockOf(it.sec)} 那一帧`, shot: { title: it.title, bvid: it.bvid, sec: it.sec } }
  }

  /** 让她自己看看手上有哪些截图（挑之前先看）。 */
  function listShots(query = '') {
    const list = shots.list(query).slice(0, 20).map((i) => ({ title: i.title, bvid: i.bvid, sec: i.sec, clock: clockOf(i.sec), note: i.note }))
    return list.length
      ? { ok: true, list, message: `手上有 ${shots.count()} 张截图，这是${query ? `和「${query}」有关的 ` : '最近的 '}${list.length} 张` }
      : { ok: false, list: [], message: query ? `没有和「${query}」对得上的截图` : '还没有截图' }
  }

  /** 面板用：截图库全量列表（按当前上限先裁一遍）。 */
  function libraryShots() {
    return { ok: true, items: shots.panel() }
  }

  /** 面板用：某张截图在本机的绝对路径；文件不在就返回 ''。 */
  function shotFileOf(name) {
    const it = shots.list('').find((i) => i.file === String(name || ''))
    if (!it || !shots.exists(it)) return ''
    return shotPath(it)
  }

  /** 面板用：手动删掉库里的一张。 */
  function deleteShot(name) {
    const r = shots.remove(name)
    if (r.ok) log.info(r.message)
    return r
  }

  /** 刷一轮。force = 面板里手动点的（不占每天的次数）。 */
  async function run({ force = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (c.subsOnly) return { ok: false, message: '开着「只要订阅」，不刷视频' }
    if (!c.enabled && !force) return { ok: false, message: 'B 站没打开' }
    busy = true
    const s = today(load())
    try {
      let seenState = ensureSeen(s)
      const seen = seenSet(seenState)
      const kws = (c.keywords || []).filter(Boolean)
      let pool = []
      if (!kws.length) {
        // 关键词留空 = 刷账号推荐流；推荐流本来就是老新混合，不过滤播放量和发布时间
        try {
          pool = filterVideos(await api.recommend({ ps: 30 }), { seen }).map((v) => ({ ...v, kw: '推荐' }))
        } catch (error) {
          log.debug('推荐流失败：', error.message)
        }
        if (!pool.length) {
          try { pool = filterVideos(await api.popular({ ps: 20 }), { seen }).map((v) => ({ ...v, kw: '热门' })) } catch (error) { log.debug('热门兜底失败：', error.message) }
        }
      } else {
        for (const kw of await chooseKeywords()) {
          try { pool.push(...filterVideos(await api.search(kw), { minViews: c.minViews, maxAgeDays: c.maxAgeDays, seen }).slice(0, 4).map((v) => ({ ...v, kw }))) } catch (error) { log.debug(`搜「${kw}」失败：`, error.message) }
        }
        if (pool.length < c.perRun) {
          try { pool.push(...filterVideos(await api.popular({ ps: 20 }), { seen }).slice(0, c.perRun).map((v) => ({ ...v, kw: '热门' }))) } catch (error) {}
        }
      }
      // 每个来源轮着取，避免一轮全是同一类
      const picked = []
      const byKw = new Map()
      for (const v of pool) { if (!byKw.has(v.kw)) byKw.set(v.kw, []); byKw.get(v.kw).push(v) }
      while (picked.length < c.perRun && [...byKw.values()].some((l) => l.length)) for (const l of byKw.values()) if (l.length && picked.length < c.perRun) { const v = l.shift(); if (!picked.some((p) => p.bvid === v.bvid)) picked.push(v) }
      if (!picked.length) return { ok: false, message: '这次没搜到合适的视频' }
      const looked = []
      const model = browseModel()
      for (const v of picked) {
        try { looked.push(await lookAt(v, model)) } catch (error) { log.debug(`看 ${v.bvid} 失败：`, error.message) }
        seen.add(v.bvid)
      }
      if (!looked.length) return { ok: false, message: '视频都打不开' }
      const out = await think(`你在 B 站刷到了这几个视频：\n\n${looked.map((x, i) => `【${i + 1}】${x.digest}`).join('\n\n')}\n\n` +
        `看完说说你的想法。对每个视频给一个对象：{"i":序号, "tier":"worth|ok|skip", "why":"为什么值得（两三句，具体到内容，别说套话）", "feeling":"一句你的真实感受", "share":"想私聊分享给${owner()}的话（觉得${owner()}会喜欢才写，不然空字符串）", "remember":"值得记住的一件事（没有就空字符串）"}。\n` +
        `档位判据：\n` +
        `- worth = 你真心希望他花这十几分钟；必须读过字幕或看过画面才能给\n` +
        `- ok = 有信息，但不看也不亏\n` +
        `- skip = 标题党 / 复读 / 水分大；不进日报\n` +
        `手里只有标题、时长、简介这类表层信息时，最多给 ok。\n只输出 JSON 数组。`)
      const decisions = pickJson(out, [])
      let shared = 0
      let skipped = 0
      let liked = 0
      let faved = 0
      const felt = new Map() // bvid → 她自己的一句感受，发截图时配着用
      const pickedEntries = [] // 进日报（worth / ok）
      const archiveEntries = [] // 进归档（挑中的和跳过的都记）
      const done = new Set() // 模型偶尔会把同一个视频写两遍，别让日报多算一条
      for (const d of Array.isArray(decisions) ? decisions : []) {
        const x = looked[(Number(d.i) || 0) - 1]
        if (!x) continue
        const v = x.info
        if (done.has(v.bvid)) continue
        done.add(v.bvid)
        const feeling = cleanOutboundText(d.feeling, { warn: (message) => log.warn(`B 站感受：${message}`) }).trim()
        const remember = cleanOutboundText(d.remember, { warn: (message) => log.warn(`B 站见闻：${message}`) }).trim()
        const why = cleanOutboundText(d.why, { warn: (message) => log.warn(`B 站理由：${message}`) }).trim()
        const hasEvidence = Boolean(x.subtitle) || Boolean(x.vision)
        const tier = tierOf(d, hasEvidence)
        if (feeling) felt.set(v.bvid, feeling)
        memory?.addEvent?.({ kind: 'seen', meta: { title: v.title, author: v.author, url: link(v.bvid), platform: 'bili', id: v.bvid }, text: [feeling, !isSilence(remember) ? remember : ''].filter(Boolean).join('；') || v.title, tags: ['B站'], importance: 0.4 })
        // 判重表：skip 也要记，只是不进日报、不点赞、不收藏
        const entry = { bvid: v.bvid, title: v.title, up: v.author, play: v.play, tier, why, feeling, at: Date.now() }
        seenState = pushSeen(seenState, { ...entry, status: 'seen' })
        archiveEntries.push(entry)
        if (tier === 'skip') {
          skipped++
          record(s, { kind: 'skip', title: v.title, bvid: v.bvid, text: why || feeling })
          continue
        }
        pickedEntries.push(entry)
        if (tier === 'worth') {
          if (await likeOne(v, s)) { liked++; seenState = markSeen(seenState, v.bvid, 'liked') }
        }
        if (await favOne(v, tier, s)) { faved++; seenState = markSeen(seenState, v.bvid, 'faved') }
        const share = cleanOutboundText(d.share, { warn: (message) => log.warn(`B 站分享：${message}`) }).trim()
        if (tier === 'worth' && share && !isSilence(share) && c.shareToOwner && getConfig().ownerQQ) {
          await hub.sendText(`private:${getConfig().ownerQQ}`, `${share}\n${link(v.bvid)}`)
          shared++
          record(s, { kind: 'share', title: v.title, bvid: v.bvid, text: share })
        }
        record(s, { kind: 'watch', title: v.title, bvid: v.bvid, text: feeling })
      }
      try { saveSeen(seenState) } catch (error) { log.debug('判重表写入失败：', error.message) }
      // 记账：日报只写挑中的；归档挑中的和跳过的都写。因无字幕跳过按「没有任何深读证据」算。
      const noSubtitle = looked.filter((x) => !x.subtitle && !x.vision).length
      if (pickedEntries.length || noSubtitle) {
        try { appendReport(dayKey(), pickedEntries, { noSubtitle }) } catch (error) { log.debug('日报写入失败：', error.message) }
      }
      try { appendDigest(dayKey(), archiveEntries) } catch (error) { log.debug('归档写入失败：', error.message) }
      s.skipped = (s.skipped || 0) + skipped
      s.noSubtitle = (s.noSubtitle || 0) + noSubtitle
      // 刷完按概率顺手甩一张截图给主人：默认概率和发一张表情包一样，0 = 从不
      let shotSent = 0
      const shotTo = getConfig().ownerQQ ? `private:${getConfig().ownerQQ}` : ''
      if (shotTo && c.enabled && getConfig().enabled && !getConfig().dryRun && Number(c.shotChance) > 0) {
        const pool = looked.filter((x) => x.shotIds && x.shotIds.length)
        if (pool.length && Math.random() < Number(c.shotChance)) {
          const x = pool[Math.floor(Math.random() * pool.length)]
          const file = x.shotIds[Math.floor(Math.random() * x.shotIds.length)]
          try {
            const line = felt.get(x.info.bvid) || ''
            const r = await hub.sendImage(shotTo, shotPath({ file }))
            if (r?.message_id !== undefined && !String(r.message_id).startsWith('sim-')) {
              shotSent = 1
              record(s, { kind: 'shot', title: x.info.title, bvid: x.info.bvid, text: line })
              log.info(`刷完顺手发了张截图《${x.info.title}》`)
              if (line) await hub.sendText(shotTo, line)
            }
          } catch (error) {
            log.warn('顺手发截图失败：', error.message)
          }
        }
      }
      if (!force) s.runs++
      s.lastRun = Date.now()
      log.info(`刷了一轮 B 站：看了 ${looked.length} 个，点赞 ${liked} 条，收藏 ${faved} 条，分享 ${shared} 个，截图 ${shotSent} 张`)
      return { ok: true, message: `看了 ${looked.length} 个视频，点赞 ${liked} 条、收藏 ${faved} 条，分享给你 ${shared} 个${shotSent ? '，还发了张截图' : ''}`, watched: looked.length, shared, likes: liked, favs: faved, skipped, shots: shotSent }
    } catch (error) {
      log.warn('刷 B 站出错：', error.message)
      return { ok: false, message: error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  /** 她看一个视频（你发的链接 / BV 号），返回给她看的内容。 */
  async function watch(text) {
    let id = findVideoId(text)
    if (!id) return { ok: false, message: '没认出视频链接或 BV 号' }
    if (id.short) {
      const real = await api.resolveShort(id.short).catch(() => '')
      id = findVideoId(real)
      if (!id || id.short) return { ok: false, message: '短链打不开' }
    }
    const x = await lookAt(id)
    memory?.addEvent?.({ kind: 'seen', meta: { title: x.info.title, author: x.info.author, url: link(x.info.bvid), platform: 'bili', id: x.info.bvid }, text: `看了别人发来的 B 站视频《${x.info.title}》`, tags: ['B站'], importance: 0.4 })
    return { ok: true, message: x.digest, bvid: x.info.bvid, aid: x.info.aid, title: x.info.title }
  }

  /** 每分钟调一次：醒着的时候按间隔刷；到点推日报摘要。 */
  async function tick() {
    const g = getConfig()
    const c = g.bili
    if (!g.enabled || !c.enabled) return
    if (c.subsOnly) return // 只要订阅：刷视频整条线都不跑
    const h = new Date().getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    const s = today(load())
    await maybeDigest(s)
    if (c.autoBrowse && s.runs < c.maxRunsPerDay && Date.now() - (s.lastRun || 0) > c.intervalHours * 3600_000) await run()
  }

  /** 面板用：刷过的视频（可按档位筛、分页）。 */
  function seenList({ tier = '', offset = 0, limit = 20 } = {}) {
    const all = loadSeen().items
    const picked = TIERS.includes(tier) ? all.filter((x) => x.tier === tier) : all
    const start = Math.max(0, Math.round(Number(offset) || 0))
    const size = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)))
    return { ok: true, items: picked.slice(start, start + size), total: picked.length, offset: start, limit: size, tier: TIERS.includes(tier) ? tier : '', count: all.length }
  }

  /** 面板用：某天的日报（默认今天），顺带给出有日报的日期。 */
  function reportOf(date = '') {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : dateKey()
    const markdown = readReport(d)
    return { ok: true, date: d, markdown, dates: reportDates(), count: countPicked(markdown) }
  }

  /** 面板用：收藏夹列表（读不到就如实说，下拉留空）。 */
  async function favFolders() {
    try {
      return { ok: true, folders: await api.favFolders() }
    } catch (error) {
      return { ok: false, folders: [], message: error.message }
    }
  }

  return {
    run, watch, tick, account, sendShot, listShots, seenList, reportOf, favFolders,
    libraryShots, shotFileOf, deleteShot,
    dispose() { stopped = true },
    state: () => {
      const s = today(load())
      return {
        runs: s.runs, likes: s.likes || 0, favs: s.favs || 0, skipped: s.skipped || 0, noSubtitle: s.noSubtitle || 0,
        comments: s.comments, replies: s.replies,
        lastRun: s.lastRun, history: s.history.slice(0, 20), canPost: canPost(s),
        pauseReason: s.pauseDay === dayKey() ? s.pauseReason : '', posture: cfg().posture,
        digestDay: s.digestDay || '', seenTotal: loadSeen().items.length,
        vision: visionState(cfg()), shots: { count: shots.count() },
      }
    },
  }
}
