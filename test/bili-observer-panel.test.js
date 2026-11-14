// 扩展面板渲染测试：panel.js 在真浏览器里是 new Function 出来的 React 组件，
// 仓库里没有 react，所以这里用一套极小的 hooks 运行时把它真渲染一遍，
// 抓「顶层崩溃、缺 ui 组件、接口返回形状变了就炸」这类只有渲染时才暴露的问题。
// 注意：这不是像素级测试，只保证能渲染出该有的卡片、保存按钮真的会走 /config/save。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dirname, '..', 'extensions', 'bili-observer', 'panel.js'), 'utf8')

function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props && node.props.children)
}

/** 迷你 React：支持 useState / useEffect / useRef / Fragment，按渲染路径存 hook。 */
function createRuntime() {
  const containers = new Map()
  let cur = null
  let dirty = false
  let effects = []
  let seen = []

  const React = {
    Fragment: Symbol('Fragment'),
    useState(init) {
      const c = cur
      const i = c.index++
      if (!(i in c.hooks)) c.hooks[i] = { value: typeof init === 'function' ? init() : init }
      const slot = c.hooks[i]
      return [slot.value, (v) => {
        const next = typeof v === 'function' ? v(slot.value) : v
        if (next !== slot.value) { slot.value = next; dirty = true }
      }]
    },
    useEffect(fn, deps) {
      const c = cur
      const i = c.index++
      const slot = c.hooks[i] || (c.hooks[i] = {})
      const prev = slot.deps
      const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, j) => !Object.is(d, prev[j]))
      slot.deps = deps
      if (changed) effects.push(fn)
    },
    useRef(init) {
      const c = cur
      const i = c.index++
      if (!(i in c.hooks)) c.hooks[i] = { ref: { current: init } }
      return c.hooks[i].ref
    },
  }

  const h = (type, props, ...children) => ({ type, props: { ...(props || {}), children } })

  function render(el, path) {
    if (el == null || el === false || el === true) return ''
    if (typeof el === 'string' || typeof el === 'number') return String(el)
    if (Array.isArray(el)) return el.map((c, i) => render(c, path + '/' + i)).join('')
    seen.push(el)
    const { type, props } = el
    if (type === React.Fragment) return render(props.children, path)
    if (typeof type === 'function') {
      const c = containers.get(path) || { hooks: [], index: 0 }
      containers.set(path, c)
      const prev = cur
      cur = c
      c.index = 0
      let out
      try { out = type(props) } finally { cur = prev }
      return render(out, path + '>')
    }
    return render(props.children, path)
  }

  return {
    React,
    h,
    async flush(Comp, props, max = 30) {
      let text = ''
      for (let i = 0; i < max; i++) {
        seen = []
        effects = []
        dirty = false
        text = render(h(Comp, props), 'root')
        const fns = effects
        for (const fn of fns) fn()
        // 接口都是 resolved promise：让 then 回调跑完，setState 才会把 dirty 立起来
        await new Promise((r) => setTimeout(r, 0))
        await new Promise((r) => setTimeout(r, 0))
        if (!dirty) return { text, elements: seen }
      }
      throw new Error('面板渲染没有稳定下来（可能 useEffect 里反复 setState）')
    },
  }
}

function uiStubs(h) {
  return {
    Card: ({ title, desc, right, children }) => h('section', { 'data-card': title || '' }, title ? h('h3', null, title) : null, desc ? h('p', null, desc) : null, right, children),
    Row: ({ label, hint, children }) => h('div', { className: 'row' }, label ? h('span', null, label) : null, hint ? h('small', null, hint) : null, children),
    Btn: ({ children, onClick, disabled, title, kind, small }) => h('button', { onClick, disabled, title, 'data-kind': kind, 'data-small': small }, children),
    Switch: ({ on, onChange, disabled, title }) => h('input', { type: 'checkbox', checked: !!on, disabled, title, onChange: (e) => onChange && onChange(e.target.checked) }),
    Empty: ({ icon, text }) => h('div', { className: 'empty' }, icon || '', text || ''),
    Select: ({ value, options, onChange, placeholder, width }) => h('select', { value, placeholder, 'data-width': width, onChange: (e) => onChange && onChange(e.target.value) },
      (options || []).map((o) => h('option', { key: o.value, value: o.value }, o.label))),
    Seg: ({ value, options, onChange }) => h('div', { className: 'seg' }, (options || []).map((o) => h('button', { key: o.value, onClick: () => onChange && onChange(o.value) }, o.label))),
    Range: ({ min, max, step, value, onChange, fmt }) => h('input', { type: 'range', min, max, step, value, onChange: (e) => onChange && onChange(Number(e.target.value)), 'data-fmt': fmt ? fmt(value) : '' }),
  }
}

const BILI = {
  enabled: true, posture: 'observer', subsOnly: false, autoBrowse: true, intervalHours: 4, maxRunsPerDay: 6, perRun: 3,
  keywords: ['白米饭'], minViews: 0, maxAgeDays: 7, shareToOwner: true, like: true, maxLikesPerDay: 5, maxFavsPerDay: 10,
  dailyDigest: true, dailyDigestHour: 21, favWorthFolderId: 0, favOkFolderId: 0, vision: false, visionFrames: 6, shotChance: 0.35,
  shotLibrary: 300, ffmpegPath: '', subs: [], subIntervalMin: 15, subMaxPerPoll: 5, subForwardImages: true, aiFilter: true,
  aiFilterMinLevel: 1, aiFilterVision: false, aiFilterLink: false, subDigest: true, aiFilterPrompt: '', aiFilterModel: {}, browseModel: {},
  sessdata: '', biliJct: '', sessdataSet: true, biliJctSet: true, sessdataHint: '…1234', biliJctHint: '…5678', cookie: '',
}

function routesFor(bili = BILI) {
  return (p) => {
    const path = p.split('?')[0]
    if (path === '/config') return { ok: true, bili: { ...bili } }
    if (path === '/config/save') return { ok: true, bili: { ...bili }, message: '保存好了' }
    if (path === '/models') return { ok: true, list: [{ provider: 'p', model: 'm', name: '模型M', vision: true }] }
    if (path === '/bili/state') {
      return {
        ok: true, posture: bili.posture, runs: 2, likes: 1, favs: 0, skipped: 3, seenTotal: 1, lastRun: Date.now() - 3600_000,
        canPost: true, pauseReason: '', digestDay: '', shots: { count: 1 }, vision: { ffmpeg: 'C:\\ffmpeg\\ffmpeg.exe' },
        account: { isLogin: true, uname: '测试号' },
        history: [{ at: Date.now() - 3600_000, kind: 'watch', title: '一个视频', bvid: 'BV1aaaaaaaaa', text: '还行' }],
      }
    }
    if (path === '/bili/subs') return {
      ok: true, items: [{ mid: '123456', name: '官方号', mode: 'auto', prompt: '', examples: [{ text: '例子', keep: true, why: '重要' }], lastPollAt: Date.now(), filters: ['lottery'], fails: 0 }],
      judged: [{ id: 'd1', keep: true, level: 3, at: Date.now(), name: '官方号', title: '摘要', why: '值得', by: 'ai' }],
    }
    if (path === '/bili/shots') return { ok: true, items: [{ file: 'shot-1.jpg', title: '一个视频', clock: '1:15', note: '' }], limit: bili.shotLibrary }
    if (path === '/bili/seen') return { ok: true, total: 1, items: [{ bvid: 'BV1aaaaaaaaa', title: '一个视频', tier: 'worth', up: 'UP主', at: Date.now(), status: 'liked', why: '有意思' }] }
    if (path === '/bili/report') return { ok: true, date: '2026-11-13', dates: ['2026-11-13'], count: 1, markdown: '# 今天的日报' }
    if (path === '/bili/fav/folders') return { ok: true, folders: [{ id: 1, title: '夹A', count: 3 }] }
    return { ok: false, message: '没有这个接口：' + path }
  }
}

function setup(bili) {
  const rt = createRuntime()
  const calls = []
  const call = (p, body) => { calls.push({ path: p, body }); return Promise.resolve(routesFor(bili)(p)) }
  const C = new Function('React', 'h', 'ui', 'call', src)(rt.React, rt.h, uiStubs(rt.h), call)
  assert.equal(typeof C, 'function', 'panel.js 要 return 一个组件')
  return { rt, C, calls }
}

test('面板能真渲染出所有卡片（观察者模式、有数据）', async () => {
  const { rt, C } = setup()
  const { text } = await rt.flush(C, { toast() {}, reload() {} })
  for (const label of ['B 站观察者', '刷 B 站', '订阅 UP 主动态（1）', '怎么刷', '分享、点赞和日报', '收藏夹', '看画面（抽帧 + 视觉）', '截图库（1 / 300）', '它刷过的视频（1 条）', '今天的日报（1 条）', 'ta刷过什么', '保存设置']) {
    assert.ok(text.includes(label), '缺了：' + label)
  }
  assert.match(text, /已登录：测试号/)
  assert.match(text, /官方号/)
  assert.match(text, /《一个视频》/)
  assert.match(text, /已找到 ffmpeg/)
})

test('只要订阅：刷视频 / 截图 / 日报卡片都不渲染', async () => {
  const { rt, C } = setup({ ...BILI, subsOnly: true })
  const { text } = await rt.flush(C, { toast() {}, reload() {} })
  assert.ok(text.includes('订阅 UP 主动态（1）'))
  for (const label of ['怎么刷', '分享、点赞和日报', '收藏夹', '看画面（抽帧 + 视觉）', '截图库', '它刷过的视频', '今天的日报', 'ta刷过什么']) {
    assert.equal(text.includes(label), false, '不该出现：' + label)
  }
  assert.match(text, /B 站（只订阅）/)
})

test('AI 过滤关掉时不渲染判定模型和判定例子', async () => {
  const { rt, C } = setup({ ...BILI, aiFilter: false })
  const { text } = await rt.flush(C, { toast() {}, reload() {} })
  assert.equal(text.includes('判定用的模型'), false)
  assert.equal(text.includes('全局判定提示词'), false)
  assert.equal(text.includes('最近判定'), false)
})

test('接口全挂也能渲染出错误提示，不会白屏', async () => {
  const rt = createRuntime()
  const call = () => Promise.resolve({ ok: false, message: '后端没开' })
  const C = new Function('React', 'h', 'ui', 'call', src)(rt.React, rt.h, uiStubs(rt.h), call)
  const { text } = await rt.flush(C, { toast() {}, reload() {} })
  assert.match(text, /读不到配置|读不到 B 站配置/)
})

test('改一个开关后出现「有未保存的改动」，点保存走 /config/save 并 reload', async () => {
  const { rt, C, calls } = setup()
  let reloads = 0
  let result = await rt.flush(C, { toast() {}, reload: () => { reloads++ } })
  const sw = result.elements.find((el) => el.type && el.type.name === 'Switch')
  assert.ok(sw, '至少有一个 Switch')
  sw.props.onChange(!sw.props.on)
  result = await rt.flush(C, { toast() {}, reload: () => { reloads++ } })
  assert.match(result.text, /有未保存的改动/)

  const save = result.elements.find((el) => el.type && el.type.name === 'Btn' && textOf(el.props.children).includes('保存设置'))
  assert.ok(save, '找到保存按钮')
  assert.equal(save.props.disabled, false, '有改动时保存按钮要可点')
  await save.props.onClick()
  result = await rt.flush(C, { toast() {}, reload: () => { reloads++ } })

  const saved = calls.find((c) => c.path === '/config/save')
  assert.ok(saved, '保存要打 /config/save')
  assert.equal(typeof saved.body.bili, 'object')
  assert.equal(reloads > 0, true, '保存后要 reload，否则全局草稿会把 bili 盖回去')
  assert.equal(/有未保存的改动/.test(result.text), false, '保存后不再显示未保存')
})
