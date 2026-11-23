// 阶段三·分级导航记忆/内容平台整合 回归测试（feat/panel-nav）
//
// 被测（契约与 task-8 一字不差；实现并行，未落地处用 t.skip 守卫，落地后转真断言）：
//   1. TABS：有 {id:'memory',label:'记忆'} 与 {id:'content',label:'内容平台'}；无 persona/bili/douyin/heybox
//      独立页签；TAB_MODS/NAV_GROUPS/NAV_ALIAS 同步；body 映射 memory:MemoryTab、content:ContentTab。
//   2. 记忆双视图：默认「记忆条目」；条目视图无 Persona 组件及其请求；人物视图挂 Persona；
//      aurabot.memory-view 持久化/恢复；旧 persona 页签迁移哨兵一次（tab→memory + memory-view=person）。
//   3. 内容平台三子视图：只挂当前选中平台；默认首个可用平台（boot.modules running）；aurabot.content-view
//      记住上次有效选择、失效回落；旧 bili/douyin/heybox 页签迁移到 content+对应视图。
//   4. 记忆页「更多设置」折叠卡：向量/重排/整理参数在卡内、折叠不渲染 children；
//      聊天流水留存（memory.keepChatlogDays）等原配置键不动。
//   5. mood 仍是独立页签；扩展模块 tab:'persona' 嵌入逻辑不受影响。
//
// 方法：test/panel-stage2.test.js 同款——vm 跑真 client.js + 假 React 渲染树 + 迁移块源码切片沙箱。
// 【坑】改这个文件禁用 pwsh Get-Content/Set-Content 转写（会毁 UTF-8，见 docs/MEMORY.md §3.12），用编辑工具。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const CLIENT = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// ---- 假 React：state 跨渲染保留，hook 序号每次渲染归零；副作用真跑（用于断言请求/轮询） ----
function makeReact() {
  let hook = 0
  const state = []
  return {
    reset() { hook = 0 },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'fragment',
    Component: class {},
    useState(initial) {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useEffect(fn) { try { fn() } catch (e) {} },
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

function loadPanel() {
  const source = CLIENT()
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker), 'client.js 的导出锚点变了，测试要跟着改')
  // 组件按「是否已定义」导出：实现未落地时不炸加载，测试侧用 skip 守卫
  const inject = '    exports.panelTest = Object.assign({},\n'
    + '      typeof MemoryTab !== "undefined" && { MemoryTab },\n'
    + '      typeof MemoryPage !== "undefined" && { MemoryPage },\n'
    + '      typeof PersonaMemory !== "undefined" && { PersonaMemory },\n'
    + '      typeof ContentTab !== "undefined" && { ContentTab },\n'
    + '      typeof Card !== "undefined" && { Card },\n'
    + '      { TABS, TAB_MODS, NAV_GROUPS, NAV_ALIAS })\n' + marker
  const script = new Script(source.replace(marker, inject), { filename: 'client/client.js' })
  const store = new Map()
  const calls = []
  let fetchReply = { ok: true }
  const intervals = []
  const React = makeReact()
  const env = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
      return { json: async () => fetchReply }
    },
    window: { __ModuleLoader__: { load(value) { env.loader = value } } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  script.runInNewContext(env)
  assert.ok(env.loader, 'client.js 没有走 ModuleLoader.load')
  const { panelTest } = env.loader.factory(() => React)
  // 展开函数组件（React 语义：children 在 props.children 里）
  const expand = (node, depth = 0) => {
    if (node == null || typeof node !== 'object' || depth > 32) return node
    if (Array.isArray(node)) return node.map((n) => expand(n, depth))
    if (typeof node.type === 'function') {
      const kids = [].concat(node.children ?? []).filter((c) => c !== undefined)
      const merged = Object.assign({}, node.props, kids.length || !node.props.children ? { children: kids.length ? kids : node.props.children } : {})
      return expand(node.type(merged), depth + 1)
    }
    return { type: node.type, props: node.props, children: expand(node.children, depth) }
  }
  const render = (comp, props, children) => {
    React.reset()
    calls.length = 0
    const merged = children !== undefined ? Object.assign({}, props, { children }) : props
    const raw = panelTest[comp](merged)
    return { raw, tree: expand(raw) }
  }
  return { panelTest, React, render, calls, store, intervals, env, setReply: (r) => { fetchReply = r } }
}

const find = (node, pred) => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const hit = find(n, pred); if (hit) return hit } return null }
  if (pred(node)) return node
  return find(node.children, pred)
}
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  findAll(node.children, pred, out)
  return out
}
const text = (node) => (node == null || node === false || node === true ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))

// 迁移块提取：扫所有「哨兵 if 块」（哨兵名含数字，如 -v1/-v2），按块体特征挑出目标块再沙箱执行
function findMigrationBlocks(keyword) {
  const src = CLIENT()
  const blocks = src.match(/if \(!localStorage\.getItem\('aurabot\.[a-z0-9-]+'\)\) \{[\s\S]*?\n          \}/g) || []
  return blocks.filter((b) => b.includes(keyword))
}
function migrationBlockOrNull(keyword) {
  const hits = findMigrationBlocks(keyword)
  return hits.length ? hits.at(-1) : null
}
function runBlock(blockText, store) {
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  new Script(blockText, { filename: 'migration.js' }).runInNewContext({ localStorage: ls })
}

// ================= 1. 导航常量契约 =================

test('TABS：有 memory=记忆；无 persona/bili 独立页签；douyin/heybox 保留；mood 保留', () => {
  const { panelTest } = loadPanel()
  const ids = panelTest.TABS.map((t) => t.id)
  assert.ok(ids.includes('memory'), 'TABS 要有 memory')
  assert.equal(panelTest.TABS.find((t) => t.id === 'memory').label, '记忆')
  // B站已拆成 bili-observer 扩展（有 panel.js），不再有内置页签；抖音/小黑盒仍是独立页签。
  for (const gone of ['persona', 'bili', 'content']) {
    assert.ok(!ids.includes(gone), `TABS 不能再有独立页签 ${gone}`)
  }
  assert.ok(ids.includes('douyin'), 'douyin 仍是独立页签')
  assert.ok(ids.includes('heybox'), 'heybox 仍是独立页签')
  assert.ok(ids.includes('mood'), 'mood 必须仍是独立页签')
})

test('TAB_MODS：persona 键删除；memory 归到 memory 模块；douyin/heybox 各挂自己的模块', () => {
  const { panelTest } = loadPanel()
  assert.ok(!Object.hasOwn(panelTest.TAB_MODS, 'persona'), 'TAB_MODS 要删掉 persona 键')
  assert.ok(panelTest.TAB_MODS.memory.includes('memory'), 'memory 页挂在 memory 模块上')
  assert.ok(panelTest.TAB_MODS.memory.includes('persona'), '人物画像（persona 模块）归到 memory 页')
  assert.ok(panelTest.TAB_MODS.douyin.includes('douyin'), 'douyin 页挂 douyin 模块')
  assert.ok(panelTest.TAB_MODS.heybox.includes('heybox'), 'heybox 页挂 heybox 模块')
  assert.ok(panelTest.TAB_MODS.mood.includes('mood'), 'mood 页保持不变')
})

test('NAV_GROUPS：persona/bili 从所有分组消失；memory/douyin/heybox 保留', () => {
  const { panelTest } = loadPanel()
  const grouped = panelTest.NAV_GROUPS.flatMap((g) => g.tabs)
  for (const gone of ['persona', 'bili', 'content']) {
    assert.ok(!grouped.includes(gone), `分组里不能再有 ${gone}`)
  }
  assert.ok(grouped.includes('memory'), 'memory 要在某个分组里')
  assert.ok(grouped.includes('douyin'), 'douyin 要在某个分组里')
  assert.ok(grouped.includes('heybox'), 'heybox 要在某个分组里')
})

test('NAV_ALIAS：persona 别名键删除；人物关键词并入 memory；douyin/heybox 各有别名', () => {
  const { panelTest } = loadPanel()
  assert.ok(!Object.hasOwn(panelTest.NAV_ALIAS, 'persona'), 'NAV_ALIAS 要删掉 persona 别名')
  assert.match(panelTest.NAV_ALIAS.memory, /人物|画像/, 'persona 的检索关键词要并入 memory 别名')
  assert.match(panelTest.NAV_ALIAS.memory, /记忆/, 'memory 别名保留原关键词')
  assert.match(panelTest.NAV_ALIAS.douyin, /抖音/, 'douyin 别名保留')
  assert.match(panelTest.NAV_ALIAS.heybox, /小黑盒/, 'heybox 别名保留')
})

test('body 映射：memory:MemoryTab；无 persona:Persona(PersonaMemory)/bili: Bili 直挂；douyin/heybox 各自直挂', () => {
  const src = CLIENT()
  assert.match(src, /memory: MemoryTab/, 'memory 页要映射到 MemoryTab 双视图外壳')
  // B站已拆成 bili-observer 扩展（自带 panel.js），client 里不再有内置 Bili 页
  assert.ok(!/\bbili: Bili\b/.test(src), '不能再直挂 bili: Bili（B 站是扩展）')
  assert.match(src, /\bdouyin: Douyin\b/, 'douyin 仍是内置页')
  assert.match(src, /\bheybox: Heybox\b/, 'heybox 仍是内置页')
  assert.ok(!/\bpersona: Persona\b/.test(src), '不能再有 persona: Persona 映射')
  assert.ok(!/\bpersona: PersonaMemory\b/.test(src), '不能再有 persona: PersonaMemory 映射')
})

test('mood 独立性：mood 页映射不动；扩展模块 tab:"persona" 嵌入钩子仍在', () => {
  const src = CLIENT()
  assert.match(src, /mood: Mood,/, 'mood 页映射保持原样')
  // 扩展模块声明 tab:'persona' 时仍能嵌进页面（现在应落进 memory 页所在的嵌入逻辑）
  assert.ok(/'persona'/.test(src.slice(src.indexOf('extTabs') - 500, src.indexOf('extTabs') + 1500)) || /tab === 'persona'|tab: 'persona'/.test(src), '扩展模块 tab:"persona" 的嵌入钩子不能被删掉')
})

// ================= 2. 记忆三视图（星图默认 / 记忆条目 / 人物，按需挂载） =================

const memSt = { config: { memory: {} }, modules: [] }
const memDraft = { memory: {}, song: {} }

test('记忆三视图：页签三段（星图第一/记忆条目/人物）；条目视图无 Persona/StarMap、无 persona 与星图请求', (t) => {
  const p = loadPanel()
  if (!p.panelTest.MemoryTab) return t.skip('MemoryTab 未落地（task-8 进行中）')
  const { raw, tree } = p.render('MemoryTab', { memoryView: 'entries', setMemoryView() {}, st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  const tabs = findAll(tree, (n) => n.props && n.props.role === 'tab')
  assert.deepEqual(tabs.map((x) => text(x)), ['星图', '记忆条目', '人物'], '记忆页要有三段子视图页签（星图默认排第一）')
  assert.equal(tabs[1].props['aria-selected'], true, 'entries 视图下「记忆条目」选中')
  // 条目视图：星图与人物都不挂载（raw 里按函数名找）
  assert.ok(!find(raw, (n) => n.type?.name === 'PersonaMemory'), '条目视图不能挂 PersonaMemory')
  assert.ok(!find(raw, (n) => n.type?.name === 'StarMap'), '条目视图不能挂 StarMap')
  // 无 persona 与星图请求（/memories 是条目自己的，允许）
  const extraCalls = p.calls.filter((c) => /\/persona|\/memory\/graph/.test(c.url))
  assert.equal(extraCalls.length, 0, `条目视图发了越界请求：${extraCalls.map((c) => c.url).join(',')}`)
  void tree
})

test('记忆三视图：人物视图挂 PersonaMemory 拉 persona 数据；星图视图挂 StarMap 拉 graph 数据', (t) => {
  const p = loadPanel()
  if (!p.panelTest.MemoryTab) return t.skip('MemoryTab 未落地（task-8 进行中）')
  const { raw } = p.render('MemoryTab', { memoryView: 'person', setMemoryView() {}, st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  assert.ok(find(raw, (n) => n.type?.name === 'PersonaMemory'), '人物视图要挂 PersonaMemory')
  assert.ok(!find(raw, (n) => n.type?.name === 'StarMap'), '人物视图不能顺带挂 StarMap')
  assert.ok(p.calls.some((c) => /\/persona/.test(c.url)), '人物视图要拉 persona 数据')
  assert.ok(!p.calls.some((c) => /\/memory\/graph/.test(c.url)), '人物视图不发星图请求')
  const { raw: raw2 } = p.render('MemoryTab', { memoryView: 'starmap', setMemoryView() {}, st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  assert.ok(find(raw2, (n) => n.type?.name === 'StarMap'), '星图视图要挂 StarMap')
  assert.ok(!find(raw2, (n) => n.type?.name === 'PersonaMemory'), '星图视图不能顺带挂 PersonaMemory')
  assert.ok(p.calls.some((c) => /\/memory\/graph/.test(c.url)), '星图视图要拉 /memory/graph')
  assert.ok(!p.calls.some((c) => /\/persona/.test(c.url)), '星图视图不发 persona 请求')
})

test('记忆子视图：默认「星图」+ 老值兼容；点「人物」切视图；aurabot.memory-view 持久化与恢复（源码契约）', (t) => {
  const p = loadPanel()
  if (!p.panelTest.MemoryTab) return t.skip('MemoryTab 未落地（task-8 进行中）')
  // 默认视图：starmap（未存过/异常值都落星图）；老值 entries/person 仍兼容
  const src = CLIENT()
  assert.match(src, /memoryView === 'entries' \|\| memoryView === 'person' \? memoryView : 'starmap'/, '视图归一化：entries/person 兼容，其余落默认星图')
  assert.match(src, /return v === 'entries' \|\| v === 'person' \? v : 'starmap'/, 'aurabot.memory-view 恢复时老值兼容，默认星图')
  // 三段页签、点第三个切人物
  const seen = []
  const { tree } = p.render('MemoryTab', { memoryView: 'entries', setMemoryView: (v) => seen.push(v), st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  const tabs = findAll(tree, (n) => n.props && n.props.role === 'tab')
  tabs[2].props.onClick()
  assert.deepEqual(seen, ['person'], '点「人物」要切视图')
  tabs[0].props.onClick()
  assert.deepEqual(seen.at(-1), 'starmap', '点「星图」要切回默认视图')
  assert.match(src, /const pickMemoryView = \(v\) => \{ setMemoryView\(v\); try \{ localStorage\.setItem\('aurabot\.memory-view', v\) \} catch \(e\) \{\} \}/, '子视图切换要持久化到 aurabot.memory-view')
})

test('旧 persona 页签迁移：tab→memory + memory-view=person；navlast 修正；哨兵只生效一次', () => {
  const block = migrationBlockOrNull("'persona'")
  if (!block) return // 迁移块未落地：跳过（实现完成后启用）
  const store = new Map([
    ['aurabot.tab', 'persona'],
    ['aurabot.navlast', JSON.stringify({ self: 'persona', system: 'logs' })],
  ])
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'memory', '旧 persona 页签要迁到 memory')
  assert.equal(store.get('aurabot.memory-view'), 'person', '迁移要顺带记住「人物」子视图')
  const last = JSON.parse(store.get('aurabot.navlast'))
  assert.equal(last.self, 'memory', 'navlast 里的 persona 也要映射成 memory')
  assert.equal(last.system, 'logs', '其它组的记忆不能被动到')
  assert.equal(store.get('aurabot.memory-tab-v1'), '1', '要落哨兵')
  // 哨兵一次：改回旧值再跑，不许再动
  store.set('aurabot.tab', 'overview')
  store.set('aurabot.memory-view', 'entries')
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'overview', '哨兵生效后不再迁移')
  assert.equal(store.get('aurabot.memory-view'), 'entries', '哨兵生效后不覆盖用户选择')
})

// ================= 3. 平台页签（B 站已拆成扩展，抖音/小黑盒仍是独立页） =================

test('平台页签：douyin/heybox 各自独立挂载；client 里没有内置 Bili 页（B 站走扩展面板）', () => {
  const src = CLIENT()
  assert.ok(!/function Bili\b/.test(src), 'client 里不该再有内置 Bili 页（已迁到 bili-observer 扩展的 panel.js）')
  assert.match(src, /\bdouyin: Douyin\b/, 'douyin 直挂 Douyin')
  assert.match(src, /\bheybox: Heybox\b/, 'heybox 直挂 Heybox')
  const { panelTest } = loadPanel()
  assert.equal(panelTest.TAB_MODS.douyin.join(','), 'douyin')
  assert.equal(panelTest.TAB_MODS.heybox.join(','), 'heybox')
})

test('平台页签：模块没在跑就不显示；跑起来才出现', () => {
  const src = CLIENT()
  assert.match(src, /const tabs = TABS\.filter\(\(t\) => !TAB_MODS\[t\.id\] \|\| TAB_MODS\[t\.id\]\.some\(running\)\)/, 'TAB_MODS 门控要保留')
})

test('旧 content 页签迁移：content→douyin（B 站已拆扩展，不再有 content 页）', () => {
  const block = migrationBlockOrNull("'content'")
  if (!block) return
  const store = new Map([
    ['aurabot.tab', 'content'],
    ['aurabot.content-view', 'douyin'],
    ['aurabot.navlast', JSON.stringify({ platform: 'content', system: 'logs' })],
  ])
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'douyin', 'content 页签要还原成 douyin')
  const last = JSON.parse(store.get('aurabot.navlast'))
  assert.equal(last.platform, 'douyin', 'navlast 里的 content 也要映射成 douyin')
  assert.equal(last.system, 'logs', '其它组的记忆不能被动到')
  store.set('aurabot.tab', 'overview')
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'overview', '哨兵生效后不再迁移')
})


// ================= 4. 记忆页「更多设置」折叠卡 =================

test('记忆页折叠卡：向量/重排/整理参数收进「高级调优」折叠卡（defaultOpen=false，折叠不渲染 children）', (t) => {
  const src = CLIENT()
  const mp = src.indexOf('function MemoryPage')
  assert.ok(mp >= 0, '要有 MemoryPage')
  // 折叠契约源码：more() 子折叠卡默认不展开（可见区只放少数高频组行，其余全收进来）
  const mpZone = src.slice(mp, mp + 40000)
  assert.match(mpZone, /const more = \(title, items\) => \(items\.length \? h\(Card, \{ title: \(title \|\| '更多设置'\) \+ '（' \+ items\.length \+ ' 项）', collapsible: true, defaultOpen: false/, '折叠卡必须默认不展开')
  // 向量/重排/分层遗忘统一收进「高级调优」折叠卡
  const adv = mpZone.indexOf("more('高级调优'")
  assert.ok(adv >= 0, '要有「高级调优」折叠卡')
  const advBlock = mpZone.slice(adv, adv + 12000)
  assert.match(advBlock, /memory\.vector/, '向量检索参数要收进高级调优折叠卡')
  assert.match(advBlock, /stats\?\.vectorLastError && stats\.vectorLastErrorAt != null[\s\S]*?最近失败[\s\S]*?vectorLastErrorAt[\s\S]*?toLocaleString\(\)[\s\S]*?stats\.vectorLastError/, '向量卡同时显示最近失败原因和时间')
  assert.match(advBlock, /memory\.rerank/, '重排参数要收进高级调优折叠卡')
  assert.match(advBlock, /memory\.retentionBase|分层|遗忘/, '分层遗忘/整理参数要收进高级调优折叠卡')
  // 聊天流水留存等原配置键不动（MemoryPage 区域里，键名没被改名）
  assert.match(mpZone, /memory\.keepChatlogDays/, '聊天流水留存沿用原配置键 memory.keepChatlogDays')
  // 折叠行为渲染断言（复用 Card：折叠时 children 不进树）
  const p = loadPanel()
  if (!p.panelTest.Card) return t.skip('Card 未导出')
  const props = { title: '折叠卡', desc: 'd', collapsible: true, defaultOpen: false }
  let { tree } = p.render('Card', props, '低频参数内容')
  assert.ok(!text(tree).includes('低频参数内容'), '折叠时 children 不能渲染')
  const head = find(tree, (n) => n.type === 'h3')
  head.props.onClick()
  ;({ tree } = p.render('Card', props, '低频参数内容'))
  assert.ok(text(tree).includes('低频参数内容'), '展开后 children 要渲染')
})
