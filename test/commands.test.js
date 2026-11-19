// QQ 主人命令：解析、闭嘴/恢复、群插话模式、开关。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let parseCommand
let runCommand
let createMutes
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-cmd-'))
  ;({ parseCommand, runCommand, createMutes } = await import('../src/chat/commands.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

test('解析：英文、中文别名、全角斜杠、中文命令不加空格', () => {
  assert.deepEqual(parseCommand('/silent 30'), { name: 'silent', arg: '30' })
  assert.deepEqual(parseCommand('／闭嘴'), { name: 'silent', arg: '' })
  assert.deepEqual(parseCommand('/记住我不吃香菜'), { name: 'remember', arg: '我不吃香菜' })
  assert.deepEqual(parseCommand('/ACTIVE'), { name: 'active', arg: '' })
  assert.equal(parseCommand('/不存在的命令'), null)
  assert.equal(parseCommand('在吗'), null)
})

// 模块命令（尤其单字中文命令）不能把更长的内置命令前缀吃掉：
// 「/记住我不吃香菜」同时是模块「记」和内置「记住」的前缀，按最长匹配走内置。
const extCommands = () => [
  { name: '身体', aliases: ['身体状态'], module: 'real-life' },
  { name: '身体测试', aliases: ['真人测试'], module: 'real-life' },
  { name: '本子', module: 'little-notes' },
  { name: '记', module: 'little-notes' },
  { name: '翻', module: 'little-notes' },
  { name: '天气', aliases: ['tq'], module: 'weather' },
]

test('解析：模块命令和内置命令的中文前缀按最长匹配，内置不被单字模块命令吃掉', () => {
  const extra = extCommands()
  assert.deepEqual(parseCommand('/记住我不吃香菜', extra), { name: 'remember', arg: '我不吃香菜' })
  assert.deepEqual(parseCommand('/记一下 明天买菜', extra), { name: 'remember', arg: '明天买菜' })
  assert.deepEqual(parseCommand('/翻唱 晴天', extra), { name: 'sing', arg: '晴天' })
  assert.deepEqual(parseCommand('/身体测试 经期1', extra), { name: '身体测试', arg: '经期1', ext: extra[1] })
  assert.deepEqual(parseCommand('/身体', extra), { name: '身体', arg: '', ext: extra[0] })
  assert.deepEqual(parseCommand('/身体状态', extra), { name: '身体', arg: '', ext: extra[0] })
  // 模块自己的前缀匹配仍然可用
  assert.deepEqual(parseCommand('/记 买菜', extra), { name: '记', arg: '买菜', ext: extra[3] })
  assert.deepEqual(parseCommand('/翻 快递', extra), { name: '翻', arg: '快递', ext: extra[4] })
  assert.deepEqual(parseCommand('/天气北京', extra), { name: '天气', arg: '北京', ext: extra[5] })
  // 没有模块时行为不变
  assert.deepEqual(parseCommand('/记住我不吃香菜'), { name: 'remember', arg: '我不吃香菜' })
  assert.deepEqual(parseCommand('/翻唱 晴天'), { name: 'sing', arg: '晴天' })
})

test('解析：和内置同名的模块命令仍然优先（文档承诺的覆盖行为）', () => {
  const extra = [{ name: 'status', desc: '假的', module: 'fake' }, { name: '状态', module: 'fake2' }]
  assert.equal(parseCommand('/status', extra).ext.module, 'fake')
  assert.equal(parseCommand('/状态', extra).ext.module, 'fake2')
  assert.deepEqual(parseCommand('/state'), null, '不存在的命令仍然返回 null')
})

function deps() {
  let cfg = normalize({ enabled: true, ownerQQ: '10000001', allow: { groups: ['555'] } })
  const calls = []
  return {
    calls,
    cfg: () => cfg,
    d: {
      getConfig: () => cfg,
      setConfig: (next) => { cfg = normalize(next) },
      mutes: createMutes(),
      hub: { joinTopic: (g) => calls.push(['join', g]), leaveTopic: (g) => calls.push(['leave', g]), resetChat: (c) => calls.push(['reset', c]), stats: () => ({ received: 3, sent: 2 }) },
      mood: { label: () => '开心' },
      memory: { add: (x) => { calls.push(['remember', x.text]); return { ok: true, id: 'm1' } } },
      qzone: null,
    },
  }
}
const grp = { kind: 'group', chatId: 'group:555', groupId: '555', userId: '10000001' }
const priv = { kind: 'private', chatId: 'private:10000001', userId: '10000001' }

test('/silent 和 /active：按聊天闭嘴，带分钟数会自己解除', async () => {
  const { d, calls } = deps()
  assert.match(await runCommand(parseCommand('/silent'), grp, d), /不说话/)
  assert.equal(d.mutes.muted('group:555'), true)
  assert.equal(d.mutes.muted('private:10000001'), false, '只影响这个群')
  await runCommand(parseCommand('/active'), grp, d)
  assert.equal(d.mutes.muted('group:555'), false)
  assert.deepEqual(calls.map((c) => c[0]), ['leave', 'join'])

  await runCommand(parseCommand('/闭嘴 10'), priv, d)
  assert.equal(d.mutes.muted('private:10000001'), true)
  assert.equal(d.mutes.muted('private:10000001', Date.now() + 11 * 60_000), false, '10 分钟后自动解除')
})

test('/quiet /chatty /normal 改这个群的插话频率', async () => {
  const { d, cfg } = deps()
  await runCommand(parseCommand('/quiet'), grp, d)
  assert.equal(cfg().group.overrides['555'].interjectChance, 0)
  await runCommand(parseCommand('/chatty'), grp, d)
  assert.equal(cfg().group.overrides['555'].interjectChance, 0.4)
  await runCommand(parseCommand('/normal'), grp, d)
  assert.equal(cfg().group.overrides['555'], undefined)
  assert.match(await runCommand(parseCommand('/quiet'), priv, d), /要在群里用/)
})

test('/off /on /status /remember /reset /help', async () => {
  const { d, cfg, calls } = deps()
  await runCommand(parseCommand('/off'), priv, d)
  assert.equal(cfg().enabled, false)
  await runCommand(parseCommand('/开机'), priv, d)
  assert.equal(cfg().enabled, true)
  assert.match(await runCommand(parseCommand('/status'), grp, d), /心情：开心[\s\S]*主动加入话题：开；窗口内接话：开/)
  assert.equal(await runCommand(parseCommand('/记住 我不吃香菜'), priv, d), '记住了')
  await runCommand(parseCommand('/reset'), grp, d)
  assert.deepEqual(calls.filter((c) => c[0] !== 'join' && c[0] !== 'leave'), [['remember', '我不吃香菜'], ['reset', 'group:555']])
  assert.match(await runCommand(parseCommand('/help'), priv, d), /\/silent/)
})

test('/model：看列表、按序号或名字换、换回默认', async () => {
  const { d, cfg } = deps()
  d.listModels = async () => [
    { provider: 'deepseek-account', model: 'deepseek-flash', name: 'DeepSeek Flash' },
    { provider: 'deepseek-account', model: 'deepseek-pro', name: 'DeepSeek Pro' },
  ]
  d.defaultModel = () => ({ provider: 'deepseek-account', model: 'deepseek-pro' })
  const list = await runCommand(parseCommand('/model'), priv, d)
  assert.match(list, /跟随 DSH 默认：deepseek-pro/)
  assert.match(list, /1\. DeepSeek Flash（deepseek-flash）/)
  assert.match(await runCommand(parseCommand('/model 1'), priv, d), /换成 DeepSeek Flash/)
  assert.deepEqual([cfg().model.provider, cfg().model.model], ['deepseek-account', 'deepseek-flash'])
  assert.match(await runCommand(parseCommand('/model'), priv, d), /deepseek-flash）  ← 当前/)
  await runCommand(parseCommand('/换模型 pro'), priv, d)
  assert.equal(cfg().model.model, 'deepseek-pro')
  assert.match(await runCommand(parseCommand('/model gpt'), priv, d), /没找到/)
  await runCommand(parseCommand('/model 默认'), priv, d)
  assert.equal(cfg().model.model, '')
})


test('群命令覆盖新开关，/normal 恢复继承，/status 显示实际策略', async () => {
  const { d, cfg } = deps()
  d.setConfig({ ...cfg(), group: { ...cfg().group, overrides: { '555': { proactiveEnabled: false, engagedEnabled: true } } } })
  assert.match(await runCommand(parseCommand('/status'), grp, d), /主动加入话题：关；窗口内接话：开/)
  await runCommand(parseCommand('/quiet'), grp, d)
  assert.equal(cfg().group.overrides['555'].engagedEnabled, false)
  assert.equal(cfg().group.overrides['555'].proactiveEnabled, false)
  assert.match(await runCommand(parseCommand('/status'), grp, d), /主动加入话题：关；窗口内接话：关/)
  await runCommand(parseCommand('/chatty'), grp, d)
  assert.equal(cfg().group.overrides['555'].proactiveEnabled, true)
  assert.equal(cfg().group.overrides['555'].engagedEnabled, true)
  await runCommand(parseCommand('/normal'), grp, d)
  assert.equal(cfg().group.overrides['555'], undefined)
})
