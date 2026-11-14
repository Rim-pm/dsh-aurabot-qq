// Aurabot 用户扩展：B 站观察者。
// 别人发来链接时她能「看」视频（标题、简介、字幕、热评、弹幕）；定时自己去刷推荐流，
// 只点赞和收藏、私聊分享给主人；还能订阅 UP 主动态，官方号一发新动态就私聊告诉主人。
// 账号不产生任何公开内容：评论、弹幕、改资料的工具和接口都已经删掉。
//
// 这是从内置模块 bili 拆出来的：配置仍然读写 core 的 cfg.bili（面板走本扩展的 /config 路由）。

import { readFileSync, existsSync } from 'node:fs'
import { createBili } from './bili/duty.js'
import { createSubs } from './bili/dynamics.js'

const __lib = globalThis.aurabot.lib
const { canSeeImages } = __lib('core/llm.js')
const { defineTool, str } = __lib('tools/tools.js')
const { writeJson } = __lib('core/store.js')
const { publicConfig, mergeFromPanel } = __lib('core/config.js')

/**
 * 老配置升级到观察者模式时只提示一次：记一个标记文件，之后不再打日志。
 * 新装也是第一次启动打一条，面板上的姿态切换器能改。
 */
function announcePosture(api) {
  let file = ''
  try { file = api.dataDir('bili-posture.json') } catch (error) { return }
  if (!file || existsSync(file)) return
  const posture = api.config().bili?.posture === 'social' ? 'social' : 'observer'
  try { writeJson(file, { posture, at: Date.now() }) } catch (error) { return }
  if (posture === 'observer') api.log.info('B 站观察者已切到「观察者模式」：不再评论/发弹幕/改资料，只保留点赞和收藏')
}

export default {
  id: 'bili-observer',
  name: 'B站观察者',
  version: '1.0.0',
  description: '看别人发的 B 站视频（标题、简介、字幕、热评、弹幕）；定时刷推荐流，只点赞和收藏、私聊分享给主人；订阅 UP 主动态并私聊推送（可让 AI 先判断要不要、并总结成要点；可给每个号存判定例子；一轮多条可合成一条 digest）；抽帧看画面、发截图（bili_watch / bili_subscribe / bili_unsubscribe / bili_subs / qq_send_shot / qq_list_shots）',
  panel: 'panel.js',
  setup(api) {
    const { hub } = api.core
    announcePosture(api)
    // 刷视频这条线可以单独选模型：后台会话固定叫 system:bili，在这里拦一下就行（不用改 hub）
    api.on('model', (sel, chat) => {
      if (!chat || chat.chatId !== 'system:bili') return undefined
      const m = api.config().bili?.browseModel || {}
      const provider = String(m.provider || '').trim()
      const model = String(m.model || '').trim()
      return provider && model ? { provider, model } : undefined
    })
    const bili = createBili({ getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log, dsh: api.dsh, local: api.core.local })
    api.every(60_000, () => bili.tick(), '刷B站')
    // 订阅 UP 主动态：单独的引擎，不跟「刷视频」抢配额（它自己会按 subIntervalMin 节流）
    const subs = createSubs({
      getConfig: api.config, setConfig: api.setConfig, hub, memory: api.lazy('memory'), log: api.log, ask: api.ask,
      // 判定用哪个模型由面板单独选；问图之前先确认它真的能看图。
      // 单独选了判定模型时只看这个模型的元数据（主人的手动声明是给聊天模型的，不该管到它）；
      // 没选（target 为 null）就是跟随聊天模型，这时手动声明的「视觉能力」照常生效。
      canSee: (target) => canSeeImages(api.dsh, api.config(), target),
    })
    api.every(60_000, () => subs.tick(), '订阅B站动态')

    // 只在她真的能用时告诉她（原来写在 core 的 rulesText 里，拆出来后由扩展补这一句）
    api.rule(() => {
      const c = api.config().bili
      if (!c?.enabled) return []
      return [c.subsOnly
        ? '- 你在帮主人盯着几个 B 站 UP 主的动态（订阅）：它们一发新动态就会推给主人。别人发来 B 站链接时你没有看视频的本事，别答应。'
        : '- 你会刷 B 站：别人发来 B 站链接、BV 号或分享卡片时，可以用 bili_watch 先看看再聊；你自己刷过、评过的视频也记得。']
    })

    // 看视频谁发的链接都能看；「只要订阅」模式下这几样连同截图都不给她
    api.tool(({ chat, sessionId }) => {
      const c = api.config().bili
      if (!c.enabled || chat.kind === 'system') return []
      const tools = []
      if (!c.subsOnly) tools.push(
        defineTool({
          name: 'bili_watch',
          description: '打开一个 B 站视频看看：读标题、简介、字幕、热评和弹幕，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
          properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
          required: ['link'],
          execute: async ({ link }) => bili.watch(String(link || '')),
        }),
      )
      // 订阅 UP 主动态：游戏官方号一发公告就私聊告诉主人。改订阅只有主人能改。
      tools.push(
        defineTool({
          name: 'bili_subscribe',
          description: '订阅一个 B 站 UP 主的动态（比如游戏官方号）：它一发新动态，你就私聊告诉主人。who 可以是 UID、space.bilibili.com/123456 主页链接、一条动态的链接（会反查作者），或者 UP 主的名字；filters 可选，想过滤掉的内容类型：forward 转发 / lottery 抽奖 / video 视频 / article 专栏 / draw 图文 / live 直播 / live_end 下播，别的词当正则过滤正文。',
          properties: { who: str('UP 主 UID、主页链接、动态链接，或者 UP 主的名字'), filters: str('可选：想过滤掉的类型，空格隔开') },
          required: ['who'],
          execute: async ({ who, filters }) => {
            if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能改订阅' }
            return subs.subscribe(String(who || ''), String(filters || '').split(/[\s,，]+/).filter(Boolean))
          },
        }),
        defineTool({
          name: 'bili_unsubscribe',
          description: '取消订阅某个 B 站 UP 主的动态。who 填 UID、名字或主页链接。',
          properties: { who: str('UP 主 UID、名字或主页链接') },
          required: ['who'],
          execute: async ({ who }) => {
            if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能改订阅' }
            return subs.unsubscribe(String(who || ''))
          },
        }),
        defineTool({
          name: 'bili_subs',
          description: '看看现在订阅了哪些 B 站 UP 主，以及最近一次查询有没有失败。',
          properties: {},
          required: [],
          execute: async () => {
            const items = subs.list()
            if (!items.length) return { ok: true, list: [], message: '还没订阅任何 UP 主' }
            const ai = api.config().bili.aiFilter
            return {
              ok: true,
              list: items,
              message: `订阅了 ${items.length} 个：` + items.map((x) => `${x.name || x.mid}${ai && x.mode !== 'raw' ? '（AI 过滤）' : ''}${x.fails ? '（最近失败 ' + x.fails + ' 次）' : ''}`).join('、'),
            }
          },
        }),
      )
      // 截图：刷 B 站看画面时截下来的那些帧，存在本机，随时能挑一张发出来
      if (!c.subsOnly) tools.push(
        defineTool({
          name: 'qq_send_shot',
          description: '把你在 B 站视频里截到的画面发到当前聊天。主人说「发张截图」「给我看看你刷到的」「刚才那个视频长啥样」这类话时用。query 填视频标题里的词或想看的内容，不填就挑最近的一张。',
          properties: { query: str('可选：视频标题关键词，或想看的内容') },
          required: [],
          execute: async ({ query }) => {
            if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '截图只给主人看' }
            return bili.sendShot({ chatId: chat.chatId, query: String(query || '') })
          },
        }),
        defineTool({
          name: 'qq_list_shots',
          description: '看看你手上还有哪些 B 站截图（来自哪个视频、第几秒）。挑截图之前可以先看一眼。',
          properties: { query: str('可选，按视频标题筛选') },
          required: [],
          execute: async ({ query }) => {
            if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '截图只给主人看' }
            return bili.listShots(String(query || ''))
          },
        }),
      )
      return tools
    })

    // 面板读写 core 的 cfg.bili：读的时候脱敏（密码类只回传结尾几位），写的时候走 mergeFromPanel，
    // 空串 = 保留原值、null = 清空。这样面板和内置页的保存语义一致。
    api.route('/config', async () => ({ ok: true, bili: publicConfig(api.config()).bili }))
    api.route('/config/save', async (req) => {
      const body = await api.core.http.body(req)
      const incoming = body?.bili && typeof body.bili === 'object' ? body.bili : null
      if (!incoming) return { ok: false, message: '没收到 bili 配置' }
      const next = mergeFromPanel(api.config(), { bili: incoming })
      api.setConfig(() => next)
      return { ok: true, bili: publicConfig(api.config()).bili, message: '保存好了' }
    })
    api.route('/models', async () => {
      try { return { ok: true, list: await api.core.listModels() } } catch (error) { return { ok: false, message: error.message, list: [] } }
    })

    api.route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
    // 订阅动态（面板「订阅」卡片）
    api.route('/bili/subs', async () => ({ ok: true, items: subs.list(), judged: subs.judged(), ...subs.state() }))
    api.route('/bili/sub/add', async (req) => {
      const b = await api.core.http.body(req)
      return subs.subscribe(String(b.who || b.mid || ''), b.filters)
    })
    api.route('/bili/sub/update', async (req) => {
      const b = await api.core.http.body(req)
      return subs.update(String(b.mid || ''), { prompt: b.prompt, mode: b.mode, minLevel: b.minLevel, examples: b.examples })
    })
    api.route('/bili/sub/del', async (req) => {
      const b = await api.core.http.body(req)
      return subs.unsubscribe(String(b.mid || b.who || ''))
    })
    api.route('/bili/subs/check', async () => subs.poll({ force: true }))
    api.route('/bili/account', async () => bili.account(true))
    api.route('/bili/run', async () => bili.run({ force: true }))
    // 观察者新增：刷过的视频、当天日报、收藏夹下拉
    api.route('/bili/seen', async (req) => {
      const q = api.core.http.query(req) || {}
      return bili.seenList({ tier: q.tier, offset: q.offset, limit: q.limit })
    })
    api.route('/bili/report', async (req) => {
      const q = api.core.http.query(req) || {}
      return bili.reportOf(q.date)
    })
    api.route('/bili/fav/folders', async () => bili.favFolders())
    // 截图库（面板里看全部、手动删）
    api.route('/bili/shots', async () => ({ ...bili.libraryShots(), limit: api.config().bili.shotLibrary }))
    api.route('/bili/shot/image', async (req, res) => {
      const p = bili.shotFileOf(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      return api.core.http.send(res, 200, readFileSync(p), 'image/jpeg')
    })
    api.route('/bili/shot/delete', async (req) => bili.deleteShot(String((await api.core.http.body(req)).file || '')))
    return bili
  },
}
