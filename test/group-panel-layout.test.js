import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { normalize } from '../src/core/config.js'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const G = '30000003', H = '40000004', P = '50000005'
function panel() {
  let loader, cursor = 0, slots = [], draft = normalize({ allow: { groups: [G, H] }, group: { overrides: { [G]: { proactiveEnabled: false } } }, memory: { passiveGroups: [P] } })
  const React = { Component: class {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: init => { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] } }
  new Script(source.replace('exports.AurabotPage = AurabotPage', 'exports.GroupOverrides = GroupOverrides; exports.Group = Group; exports.AurabotPage = AurabotPage')).runInNewContext({ window: { __ModuleLoader__: { load: v => { loader = v } } } })
  const { GroupOverrides, Group } = loader.factory(() => React)
  return { get draft() { return draft }, render(component = GroupOverrides) { cursor = 0; return component({ draft, setDraft: v => { draft = JSON.parse(JSON.stringify(v)) }, setSection() {}, st: { modules: [] }, go() {} }) }, Group }
}
function nodes(root) { return [root, ...(root?.children || []).flat(Infinity).filter(v => v && typeof v === 'object').flatMap(nodes)] }
const find = (tree, predicate) => { const n = nodes(tree).find(predicate); assert.ok(n, 'control exists'); return n }
const text = node => typeof node === 'string' ? node : (node?.children || []).flat(Infinity).map(text).join('')

test('按群设置包含仅旁听的群，添加和切换选中项不会开放聊天', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render()
  find(tree, n => n.type === 'button' && text(n).startsWith(P)).props.onClick()
  tree = p.render()
  assert.equal(find(tree, n => n.props.ariaLabel === `群 ${P} 响应模式`).props.value, 'off')
  find(tree, n => n.props['aria-label'] === '查找或添加群号').props.onChange({ target: { value: '60000006' } })
  tree = p.render(); find(tree, n => text(n) === '添加群' && n.props.onClick).props.onClick()
  assert.deepEqual(p.draft.allow, before.allow)
  assert.deepEqual(p.draft.memory, before.memory)
  assert.deepEqual(p.draft.group.overrides['60000006'], {})
  assert.equal(find(p.render(), n => n.props.ariaLabel === '群 60000006 响应模式').props.value, 'off')
})

test('旁听只改目标名单；响应模式仍使用原有两项配置，不影响接话和人格', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render()
  find(tree, n => n.props.title === `群 ${G} 不响应时仍旁听`).props.onChange(true)
  assert.deepEqual(p.draft.memory.passiveGroups, [P, G])
  assert.deepEqual(p.draft.allow, before.allow); assert.deepEqual(p.draft.group, before.group)
  tree = p.render(); find(tree, n => n.props.ariaLabel === `群 ${G} 响应模式`).props.onChange('modules')
  assert.deepEqual(p.draft.group.moduleOnlyGroups, [G])
  assert.deepEqual(p.draft.group.overrides, before.group.overrides)
  assert.deepEqual(p.draft.persona, before.persona)
  tree = p.render(); find(tree, n => n.props.title === `群 ${G} 不响应时仍旁听`).props.onChange(false)
  assert.deepEqual(p.draft.memory.passiveGroups, [P]); assert.deepEqual(p.draft.allow, before.allow)
})

test('开关与概率分别修改，跟随默认与 /quiet 留下的值可见', () => {
  const p = panel()
  find(p.render(), n => n.props.ariaLabel === `群 ${G} 聊起来后继续回应`).props.onChange('on')
  assert.deepEqual(p.draft.group.overrides[G], { proactiveEnabled: false, engagedEnabled: true })
  find(p.render(), n => n.props['aria-label'] === `群 ${G} 插话概率`).props.onChange({ target: { value: '0' } })
  assert.match(text(p.render()), /主动插话关（基础 0%），继续回应开/)
  find(p.render(), n => n.props.ariaLabel === `群 ${G} 没人叫时主动插话`).props.onChange('')
  assert.equal(p.draft.group.overrides[G].proactiveEnabled, undefined)
  assert.equal(p.draft.group.overrides[G].engagedEnabled, true)
  assert.equal(p.draft.group.overrides[G].interjectChance, 0)
})

test('页面默认展示按群设置，分区切换不修改配置，旧入口和搜索仍能找到', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render(p.Group)
  assert.equal(find(tree, n => n.props.className === 'ab-group-home').props.hidden, false)
  for (const label of ['回复方式', '权限与限制', '群聊']) {
    find(tree, n => n.type === 'button' && text(n) === label).props.onClick(); tree = p.render(p.Group)
  }
  assert.deepEqual(p.draft, before)
  assert.match(source, /打开群聊设置/)
  assert.match(source, /group: '群聊 发言 白名单 仅模块 主动 窗口 插话 旁听 静默 合并 不回应 不理 屏蔽 黑名单 通用设置 继续回应 回复方式 权限与限制'/)
  assert.match(source, /JSON.stringify\(draft.allow\?\.groups\) !== JSON.stringify\(cfg.allow\?\.groups\)/)
})


test('群聊通用设置是群聊里的次级入口，导航和返回不改配置', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render(p.Group)
  const nav = find(tree, n => n.props['aria-label'] === '聊天设置分类')
  assert.deepEqual(nodes(nav).filter(n => n.type === 'button').map(text), ['群聊', '回复方式', '权限与限制'])
  find(tree, n => n.type?.name === 'GroupOverrides').props.setSection('defaults')
  tree = p.render(p.Group)
  const common = find(tree, n => n.props.title === '群聊通用设置')
  assert.match(common.props.desc, /单独设置过的项目不受影响/)
  assert.equal(find(tree, n => n.type === 'button' && text(n) === '群聊').props['aria-pressed'], true)
  assert.equal(find(tree, n => n.props.className === 'ab-group-home').props.hidden, true)
  assert.ok(find(tree, n => n.props.title === '被叫到时回复'))
  const topics = find(tree, n => n.type === 'details' && text(n).includes('话题与群活跃度'))
  assert.notEqual(topics.props.open, true)
  common.props.right.props.onClick()
  assert.equal(find(p.render(p.Group), n => n.props.className === 'ab-group-home').props.hidden, false)
  assert.deepEqual(p.draft, before)
})

test('通用规则只改通用字段，不覆盖单群选择；回复页不再混入群叫醒规则', () => {
  const p = panel(), before = structuredClone(p.draft)
  find(p.render(p.Group), n => n.type?.name === 'GroupOverrides').props.setSection('defaults')
  find(p.render(p.Group), n => n.props.title === '没人叫时主动插话').props.onChange(false)
  find(p.render(p.Group), n => n.props.title === '聊起来后继续回应').props.onChange(true)
  find(p.render(p.Group), n => n.props['aria-label'] === '不主动说话的开始小时').props.onChange({target:{value:'23'}})
  const expected = structuredClone(before)
  expected.group.proactiveEnabled = false; expected.group.engagedEnabled = true; expected.group.quietHours[0] = 23
  assert.deepEqual(p.draft, expected)
  find(p.render(p.Group), n => n.type === 'button' && text(n) === '回复方式').props.onClick()
  const tree = p.render(p.Group)
  assert.equal(nodes(tree).some(n => n.props.title === '被叫到时回复'), false)
  assert.ok(find(tree, n => n.props.title === '连发合并'))
})


test('插话频率收起但仍可改，恢复通用只清除本群接话设置', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render()
  const advanced = find(tree, n => n.type === 'details' && (n.children || []).some(c => c?.type === 'summary' && text(c) === '插话频率与次数'))
  assert.notEqual(advanced.props.open, true)
  find(advanced, n => n.props['aria-label'] === `群 ${G} 插话概率`).props.onChange({ target: { value: '0' } })
  assert.equal(p.draft.group.overrides[G].interjectChance, 0)
  find(p.render(), n => text(n) === '本群接话改用通用设置' && n.props.onClick).props.onClick()
  const expected = structuredClone(before); delete expected.group.overrides[G]
  assert.deepEqual(p.draft, expected)
})
