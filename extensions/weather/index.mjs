// 查天气 · 早安
//
// 你自己写的模块，放在 plugins-data/aurabot/modules/weather/。保存后几秒自动加载，不用重启。
//
// 做什么：
//   1. 主人私聊里每轮都有一条「现在 + 今天的天气」，她说「早」的时候自然就知道要不要带伞、穿几件；
//   2. 主人一直没开口的话，早上（默认 7:00~8:30，每天随机一分钟、周末晚一点）主动问候一次；
//   3. 别人问天气、或者她自己想问别的城市，用 weather_now 工具；主人也能 /天气 上海。
//
// 数据：Open-Meteo（免费、不用 key，有体感温度和降雨概率）。
// 隐私：只有主人私聊会带天气；群里不带，别人看不到你所在的城市。

import { readFileSync, writeFileSync } from 'node:fs'

const TTL_MS = 30 * 60_000 // 天气缓存
const GEO_TTL_MS = 30 * 24 * 3600_000 // 城市 → 经纬度缓存
const FAIL_COOL_MS = 5 * 60_000 // 接口挂了先歇一会儿，别每轮都打
const FETCH_TIMEOUT_MS = 6000

const CODE_TEXT = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '有雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
}
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99])
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86])
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 只认「一整句就是打招呼」，免得「早点睡」也被当成早安
const GREET_ONLY = /^(?:早|早安|早上好|早呀|早啊|早哇|早早|morning|good\s*morning|gm)(?:[!！。.~～呀啊哇哦\s]*)$/i
const GREET_ANY = /(早安|早上好|早呀|早啊|早哇)/

const pad2 = (n) => String(n).padStart(2, '0')
/** 北京时间（宿主时区不一定是 +8，统一按 UTC+8 算）。 */
const bjNow = (ms = Date.now()) => new Date(Number(ms) + 8 * 3600_000)
const dayKey = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
const minutesOf = (d) => d.getUTCHours() * 60 + d.getUTCMinutes()
const hhmm = (d) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
const r0 = (v) => Math.round(num(v))

function slotOf(h) {
  if (h < 5) return '深夜'
  if (h < 8) return '早上'
  if (h < 11) return '上午'
  if (h < 13) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  if (h < 23) return '晚上'
  return '深夜'
}

/** 「11月5日 周四 早上」——不带分钟，系统提示词不容易因为时间抖动而失效。 */
function dayText(d = bjNow()) {
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]} ${slotOf(d.getUTCHours())}`
}

/** 主动问候用的完整时间（带分钟）。 */
function nowText(d = bjNow()) {
  return `${dayText(d)} ${hhmm(d)}`
}

/** 每天固定的随机偏移：同一天重启也不会变。 */
function hash32(s) {
  let h = 2166136261
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function parseHM(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return fallback
  const v = Number(m[1]) * 60 + Number(m[2])
  return v >= 0 && v < 1440 ? v : fallback
}

function loadJson(file, fallback) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : fallback
  } catch (error) {
    return fallback
  }
}

function saveJson(file, data) {
  try { writeFileSync(file, JSON.stringify(data, null, 2)) } catch (error) {}
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'aurabot-weather/1.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`天气接口 HTTP ${res.status}`)
  return res.json()
}

/** 傍晚以后聊的是明天：夜里再拿「今天」的温度和降雨去建议穿衣，就驴唇不对马嘴了。 */
function dayOf(s, now = bjNow()) {
  const tomorrow = now.getUTCHours() >= 18
  const list = Array.isArray(s.days) ? s.days : []
  const raw = (tomorrow ? list[1] : list[0]) || list[0] || null
  const code = raw ? raw.code : s.code
  return {
    tomorrow,
    label: tomorrow ? '明天' : '今天',
    desc: CODE_TEXT[code] || s.desc,
    min: raw ? raw.min : s.min,
    max: raw ? raw.max : s.max,
    pop: raw ? raw.pop : s.pop,
    code,
  }
}

/** 体感温度 → 穿几件。别让模型自由发挥，不然今天两件明天三件。 */
function outfit(s, day = dayOf(s)) {
  // 明天没有实时体感，用当天均温估一下
  const f = day.tomorrow ? (num(day.min) + num(day.max)) / 2 : num(s.feels, s.temp)
  let base
  if (f >= 26) base = '一件短袖'
  else if (f >= 22) base = '一件短袖或薄长袖'
  else if (f >= 18) base = '一件长袖'
  else if (f >= 14) base = '两件：长袖 + 薄外套'
  else if (f >= 9) base = '两件：毛衣或卫衣 + 外套'
  else if (f >= 3) base = '三件：保暖内衣 + 毛衣 + 大衣'
  else base = '三件起步：保暖内衣 + 毛衣 + 羽绒服'
  const extra = []
  if (num(day.max) - num(day.min) >= 9) extra.push(`早晚温差 ${r0(day.max - day.min)} 度，带件能脱的`)
  if (!day.tomorrow && num(s.wind) >= 25) extra.push('风有点大，外套挑防风的')
  return `穿${base}${extra.length ? '；' + extra.join('；') : ''}`
}

/** 带不带伞。pct 是面板里设的「提醒带伞」阈值。 */
function umbrella(s, day = dayOf(s), now = bjNow(), pct = 40) {
  if (!day.tomorrow) {
    if (s.snowNow) return '外面在下雪，带伞，路上慢点'
    if (s.rainNow) return '外面在下雨，出门记得带伞'
  }
  // 上午看全天 + 接下来 6 小时；下午以后只看接下来 6 小时，别拿早上已经下过的雨吓人
  const morning = now.getUTCHours() < 12
  const p = day.tomorrow || !morning ? num(day.pop) : Math.max(num(day.pop), num(s.pop6))
  const t = Math.max(0, Math.min(100, num(pct, 40)))
  const when = day.tomorrow ? '明天' : ''
  if (p >= Math.min(95, t + 30)) return `${when}大概率下雨，带伞`
  if (p >= t) return `${when}可能会下雨，带把伞保险`
  if (p >= Math.max(10, t - 20)) return `${when}雨不一定下，带把折叠伞也行`
  return '不用带伞'
}

function advice(s, day = dayOf(s), pct = 40) {
  return `出门：${umbrella(s, day, bjNow(), pct)}；${outfit(s, day)}`
}

/** 给工具 / 命令 / 预览看的一小段。 */
function formatPlain(s, pct = 40, place = '') {
  const day = dayOf(s)
  const where = place || s.city
  const wind = !day.tomorrow && num(s.wind) >= 20 ? `，风 ${r0(s.wind)} km/h` : ''
  return [
    `${where}：现在${s.desc}，${r0(s.temp)}℃（体感 ${r0(s.feels)}℃）`,
    `${day.label} ${r0(day.min)}~${r0(day.max)}℃，降雨概率 ${r0(day.pop)}%${wind}`,
    advice(s, day, pct),
  ].join('\n')
}

/** 进系统提示词的那一段：像她自己刚看了眼手机，不是数据播报。 */
function contextBlock(s, pct = 40, place = '') {
  const day = dayOf(s)
  const where = place || s.city
  return [
    '【你手机上的天气】',
    `${where} · 现在${s.desc} · ${r0(s.temp)}℃（体感 ${r0(s.feels)}℃）`,
    `${day.label} ${r0(day.min)}~${r0(day.max)}℃，降雨概率 ${r0(day.pop)}%`,
    advice(s, day, pct),
    '（你刚查到的。他要是说早、或者问出门穿什么，就顺口提一句带不带伞、穿几件；别照念、别列条目）',
  ].join('\n')
}

/** 天气查不到时的兜底早安，别让主动问候变成哑巴。 */
function fallbackGreeting(s, pct = 40, place = '') {
  if (!s) return '早呀～新的一天，起来了吗'
  const day = dayOf(s)
  const where = place || s.city
  return `早呀～${day.label}${where}${day.desc}，${r0(day.min)}~${r0(day.max)}度，${umbrella(s, day, bjNow(), pct)}，${outfit(s, day)}。`
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'weather',
  name: '天气 · 早安',
  version: '1.0.0',
  api: 1,
  description: '主人说早就顺口报天气、提醒带伞和穿衣；主人没开口，早上也会主动问候一次',
  panel: 'panel.js',
  defaults: {
    city: '合肥',
    district: '蜀山区',
    umbrella: 40,
    morningOn: true,
    morningFrom: '07:00',
    morningTo: '08:30',
    weekendLater: true,
    skipIfChatted: true,
  },
  settings: [
    { key: 'city', label: '城市', type: 'text', placeholder: '合肥', hint: '填你所在的城市（天气按城市查），改完下一轮就生效' },
    { key: 'district', label: '区 / 街道（只用于显示）', type: 'text', placeholder: '蜀山区', hint: '比如 蜀山区；天气是市级的，这里只影响她怎么称呼你那儿，留空就只显示城市' },
    { key: 'umbrella', label: '带伞提醒阈值（%）', type: 'number', min: 0, max: 100, step: 5, hint: '降雨概率到这个数就提醒带伞，默认 40' },
    { key: 'morningOn', label: '我没说话时也主动问候', type: 'switch', hint: '早上到点你还没开口，她主动发一条早安（带天气）' },
    { key: 'morningFrom', label: '最早几点', type: 'text', placeholder: '07:00', hint: '格式 07:00；每天会在最早和最晚之间随机挑一分钟' },
    { key: 'morningTo', label: '最晚几点', type: 'text', placeholder: '08:30' },
    { key: 'weekendLater', label: '周末晚一点（+1.5 小时）', type: 'switch' },
    { key: 'skipIfChatted', label: '你已经说过话就不打扰', type: 'switch', hint: '你早上先说了「早」，她就不再补一条主动问候' },
  ],

  setup(api) {
    const stateFile = api.dataDir('state.json')
    const geoFile = api.dataDir('geo.json')
    const state = loadJson(stateFile, {})
    const geo = loadJson(geoFile, {})
    let cache = { at: 0, city: '', data: null }
    let inflight = null
    let failAt = 0
    let failMsg = ''

    const cityName = () => String(api.settings().city || '').trim()
    const areaName = () => String(api.settings().district || '').trim()
    const place = (city) => {
      const a = areaName()
      return a ? `${city} · ${a}` : String(city || '')
    }
    const pct = () => {
      const v = Number(api.settings().umbrella)
      return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 40
    }

    async function locate(name) {
      const key = name.toLowerCase()
      const hit = geo[key]
      if (hit && Date.now() - hit.at < GEO_TTL_MS) return hit
      const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
        encodeURIComponent(name) + '&count=1&language=zh&format=json'
      const j = await getJson(url)
      const r = j && Array.isArray(j.results) ? j.results[0] : null
      if (!r) throw new Error(`找不到「${name}」这个城市`)
      const item = { at: Date.now(), name: r.name || name, admin: r.admin1 || '', lat: r.latitude, lon: r.longitude }
      geo[key] = item
      saveJson(geoFile, geo)
      return item
    }

    function snapshot(j, g, name) {
      const c = j.current || {}
      const d = j.daily || {}
      const h = j.hourly || {}
      const temp = num(c.temperature_2m)
      const feels = num(c.apparent_temperature, temp)
      const code = num(c.weather_code)
      const times = Array.isArray(d.time) ? d.time : []
      const days = times.map((_, i) => ({
        min: num(d.temperature_2m_min && d.temperature_2m_min[i], temp),
        max: num(d.temperature_2m_max && d.temperature_2m_max[i], temp),
        pop: num(d.precipitation_probability_max && d.precipitation_probability_max[i]),
        code: num(d.weather_code && d.weather_code[i], code),
      }))
      const today = days[0] || { min: temp, max: temp, pop: 0, code }
      // 接下来 6 小时里最大的降雨概率：早上看这个比看全天更准
      const hourKey = String(c.time || '').slice(0, 13)
      const hours = Array.isArray(h.time) ? h.time : []
      let idx = hours.findIndex((t) => String(t).startsWith(hourKey))
      if (idx < 0) idx = 0
      let pop6 = 0
      for (let i = idx; i < idx + 6; i++) pop6 = Math.max(pop6, num(h.precipitation_probability && h.precipitation_probability[i]))
      return {
        at: Date.now(),
        day: dayKey(bjNow()), // 缓存跨过零点就作废，别拿昨天的「今天」说事
        city: g.name || name,
        admin: g.admin || '',
        desc: CODE_TEXT[code] || '天气不明',
        code,
        temp,
        feels,
        min: today.min,
        max: today.max,
        pop: today.pop,
        pop6,
        days,
        wind: num(c.wind_speed_10m),
        rainNow: RAIN_CODES.has(code) || num(c.precipitation) > 0.1,
        snowNow: SNOW_CODES.has(code),
      }
    }

    /** 拉一次天气；同一个城市同时只拉一次，失败后 5 分钟内不再重试。 */
    function refresh(city, force = false) {
      const name = String(city || '').trim() || cityName()
      if (!name) return Promise.reject(new Error('还没填城市（面板「天气」页填一下）'))
      if (!force && failAt && Date.now() - failAt < FAIL_COOL_MS) {
        return Promise.reject(new Error(failMsg || '天气接口刚才没连上'))
      }
      if (inflight && inflight.city === name) return inflight.p

      const p = (async () => {
        const g = await locate(name)
        const u = new URL('https://api.open-meteo.com/v1/forecast')
        u.searchParams.set('latitude', String(g.lat))
        u.searchParams.set('longitude', String(g.lon))
        u.searchParams.set('current', 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m')
        u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code')
        u.searchParams.set('hourly', 'precipitation_probability')
        u.searchParams.set('timezone', 'Asia/Shanghai')
        u.searchParams.set('forecast_days', '2')
        const j = await getJson(u.href)
        const data = snapshot(j, g, name)
        cache = { at: Date.now(), city: name, data }
        failAt = 0
        failMsg = ''
        api.log.debug('天气已更新：', `${data.city} ${data.desc} ${r0(data.temp)}℃`)
        return data
      })()

      inflight = { city: name, p }
      p.catch((error) => {
        const msg = String((error && error.message) || error).slice(0, 120)
        if (!failAt) api.log.warn('天气没拉到：', msg) // 一次故障只提醒一次，别每轮刷屏
        failAt = Date.now()
        failMsg = msg
      }).finally(() => {
        if (inflight && inflight.p === p) inflight = null
      })
      return p
    }

    /** 拿天气：有缓存就用缓存，除非 force。 */
    async function ensureWeather(city, force = false) {
      const name = String(city || '').trim() || cityName()
      if (!name) throw new Error('还没填城市（面板「天气」页填一下）')
      if (!force && cache.data && cache.city === name && cache.data.day === dayKey(bjNow()) && Date.now() - cache.at < TTL_MS) return cache.data
      return refresh(name, force)
    }

    /** 同步版：给系统提示词用。没缓存就先返回空，顺手在后台拉。 */
    function weatherLine() {
      const name = cityName()
      if (!name) return ''
      if (cache.data && cache.city === name && cache.data.day === dayKey(bjNow())) {
        if (Date.now() - cache.at > TTL_MS) refresh(name).catch(() => {})
        return contextBlock(cache.data, pct(), place(cache.data.city))
      }
      refresh(name).catch(() => {})
      return ''
    }

    /** 今天已经主动问候过的话，告诉她别再重复。 */
    function greetedLine() {
      if (!state.greetedAt) return ''
      const at = bjNow(state.greetedAt)
      if (dayKey(at) !== dayKey(bjNow())) return ''
      return `【今天】你 ${hhmm(at)} 已经主动跟他说过早安了，别再说一遍，接着聊就行。`
    }

    // ---------- 1. 让天气一直在她脑子里（只给主人私聊） ----------
    api.context(({ chat }) => {
      if (!chat || chat.kind !== 'private' || !api.isOwner(chat.userId)) return ''
      const parts = []
      const w = weatherLine()
      if (w) parts.push(w)
      parts.push(`【现在】${dayText()}`)
      const g = greetedLine()
      if (g) parts.push(g)
      return parts.join('\n')
    })

    // ---------- 2. 规则：什么时候自然地带一句 ----------
    api.rule((kind) => {
      if (kind === 'private') {
        // 没拉到天气就别让她吹牛
        if (!cache.data) return ['主人问天气时，用 weather_now 查一下再答，别瞎猜。']
        return [
          '你手机上有天气（在【你手机上的天气】里）。主人说早、早安、早上好，或者聊到出门、下雨、穿衣服、冷热的时候，自然地带一句要不要带伞、穿几件（他特意要的）；像随口说的，别用天气预报的腔调、别列条目、也别每句都提。',
        ]
      }
      return ['别人问天气、或者聊到出门下雨穿衣时，先问清楚是哪个城市，再用 weather_now 查（别拿主人设的默认城市替别人查）。']
    })

    // ---------- 2.5 他说「早」的那一轮，直接提醒一句，别让小模型偷懒 ----------
    api.on('prompt', (content, info) => {
      const chat = info && info.chat
      if (!chat || chat.kind !== 'private' || !api.isOwner(chat.userId)) return
      if (!cache.data) return
      if (state.greetedAt && dayKey(bjNow(state.greetedAt)) === dayKey(bjNow())) return
      const text = String((info && info.queryText) || '').trim()
      if (!text || !(GREET_ONLY.test(text) || GREET_ANY.test(text))) return
      return [
        ...content,
        { type: 'text', text: '（他刚跟你道早。回一句早，顺口说一句要不要带伞、穿几件，像随口说的，别列条目。）' },
      ]
    })

    // ---------- 3. 工具：问别的城市、或者群里有人问 ----------
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'weather_now',
        description: '查某个城市现在和今天的天气（真实数据，含降雨概率和穿衣建议）。有人问天气、或者聊到出门 / 下雨 / 穿衣时用；不填城市就查默认城市（群聊里必须先问清城市名）。',
        properties: { city: { type: 'string', description: '城市名，比如 杭州、上海、Tokyo；不知道就留空' } },
        required: [],
        execute: async ({ city } = {}) => {
          // 群里不能拿主人的默认城市替别人查：那等于把主人所在城市说出去
          if (chat.kind !== 'private' && !String(city || '').trim()) {
            return { ok: false, message: '要查哪个城市？得先说城市名' }
          }
          try {
            const s = await ensureWeather(city, true)
            return { ok: true, message: formatPlain(s, pct(), place(s.city)) }
          } catch (error) {
            return { ok: false, message: String((error && error.message) || error) }
          }
        },
      })
    })

    // ---------- 4. 主人命令 /天气 上海 ----------
    api.command({
      name: '天气',
      aliases: ['weather', 'tq'],
      desc: '查天气：/天气 城市（不写城市就查默认城市）',
      async run(arg) {
        try {
          const s = await ensureWeather(arg, true)
          return formatPlain(s, pct(), place(s.city))
        } catch (error) {
          return `没查到：${String((error && error.message) || error)}`
        }
      },
    })

    // ---------- 5. 没开口也问候一下 ----------
    function windowOf(st, now) {
      let from = parseHM(st.morningFrom, 7 * 60)
      let to = parseHM(st.morningTo, 8 * 60 + 30)
      if (to <= from) to = from + 60
      if (st.weekendLater && (now.getUTCDay() === 0 || now.getUTCDay() === 6)) {
        from += 90
        to += 90
      }
      return [from, to]
    }

    function ownerChattedToday(now) {
      const at = Number(api.core.hub && api.core.hub.lastOwnerChatAt)
      if (!at) return false
      const d = bjNow(at)
      if (dayKey(d) !== dayKey(now)) return false
      return minutesOf(d) >= 5 * 60 // 凌晨说的话不算「今天已经聊过」
    }

    /** done = 今天已经检查过（不管发没发）；greetedAt 只在真的交出去以后记。 */
    function mark(day) {
      state.done = day
      saveJson(stateFile, state)
    }

    async function greet() {
      const cfg = api.config()
      const owner = String(cfg.ownerQQ || '')
      if (!owner) return
      let w = null
      try {
        w = await ensureWeather()
      } catch (error) {
        api.log.warn('早安：天气没查到，先空着说', (error && error.message) || error)
      }
      const prompt = [
        '【系统提醒，不是主人说的话】',
        `现在是${nowText()}，主人今天还没跟你说话。`,
        w ? `你刚看了眼天气：\n${formatPlain(w, pct(), place(w.city))}` : '你还没来得及看天气。',
        '主动跟主人说声早安，顺口把要不要带伞、穿几件带上。像刚睡醒随手打的，一两句，别用天气预报的腔调，别列条目，也别解释你为什么发这条。',
      ].join('\n')
      api.log.info('主动早安：交给会话')
      await api.core.hub.pushToSession(
        { chatId: `private:${owner}`, kind: 'private', userId: owner, nickname: cfg.ownerName || '主人' },
        [{ type: 'text', text: prompt }],
        '',
      )
    }

    function tick() {
      try {
        const st = api.settings()
        if (!st.morningOn) return
        const now = bjNow()
        const today = dayKey(now)
        if (state.done === today) return
        const [from, to] = windowOf(st, now)
        const min = minutesOf(now)
        if (min < from || min > to) return
        // 每天在窗口里随机挑一分钟，别天天 7:00 整点报到
        const span = Math.max(1, to - from)
        const target = from + (hash32(today + '|' + (st.city || '')) % span)
        if (min < target) return
        const cfg = api.config()
        if (!cfg.enabled || cfg.dryRun) {
          mark(today)
          api.log.info('总开关关着或试运行，今天的早安先不发')
          return
        }
        if (st.skipIfChatted && ownerChattedToday(now)) {
          mark(today)
          api.log.info('主人今天已经说过话，早安不打扰')
          return
        }
        const chatId = `private:${api.config().ownerQQ}`
        if (api.core.mutes && api.core.mutes.muted && api.core.mutes.muted(chatId)) {
          mark(today)
          return
        }
        mark(today)
        greet()
          .then(() => {
            // 真交出去了才记「今天已经问候过」，免得失败时上下文里吹牛
            state.greetedAt = Date.now()
            saveJson(stateFile, state)
          })
          .catch((error) => api.log.warn('主动早安失败', (error && error.message) || error))
      } catch (error) {
        api.log.warn('早安检查出错', (error && error.message) || error)
      }
    }

    // ---------- 6. 面板预览：看看她现在会怎么说 ----------
    async function draft(s) {
      const persona = (api.core.personas && api.core.personas.current && api.core.personas.current()) || ''
      const system = [
        persona,
        `【现在】${nowText()}`,
        `【天气】\n${formatPlain(s, pct(), place(s.city))}`,
        '【这次的任务】用你自己的口气跟主人说声早安，顺口带一句要不要带伞、穿几件。一两句，别用天气预报的腔调，别列条目，只输出要发的话。天气里写的是今天还是明天，就按那个说，别改。',
      ].filter(Boolean).join('\n\n')
      const out = await api.ask({ system, text: '写这条早安。', maxTokens: 160, temperature: 0.95 })
      return String(out || '').trim().slice(0, 300)
    }

    api.route('/preview', async () => {
      let s = null
      try {
        s = await ensureWeather('', true)
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) }
      }
      let sample = ''
      try {
        sample = await draft(s)
      } catch (error) {
        sample = fallbackGreeting(s, pct(), place(s.city))
      }
      return { ok: true, weather: formatPlain(s, pct(), place(s.city)), sample }
    })

    api.every(60_000, tick, '早安问候')
    // 启动时先把天气拉进缓存，顺便看一眼现在是不是已经到问候的点了
    api.later(12_000, () => {
      ensureWeather().catch(() => {})
      tick()
    })

    return { refresh, ensureWeather, weatherLine, formatPlain, dayOf, tick, greet, draft }
  },
}
