// 内置模块：B 站。别人发来链接时她能「看」视频（标题、简介、字幕、热评）；定时自己去刷、评论、回评论，看到好玩的分享给主人；
// 还能订阅 UP 主动态，官方号一发新动态就私聊告诉主人。

import { readFileSync } from 'node:fs'
import { createBili } from '../../bili/duty.js'
import { createSubs } from '../../bili/dynamics.js'
import { defineTool, str } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'
import { avatarSource } from '../profile/index.js'

export default {
  id: 'bili',
  name: 'B站',
  version: '1.2.0',
  description: '看别人发的 B 站视频；定时自己刷、评论、回评论；订阅 UP 主动态并私聊推送；抽帧看画面、发截图；按权限改自己的头像 / 签名（bili_watch / bili_comment / bili_subscribe / bili_unsubscribe / bili_subs / qq_send_shot / bili_set_avatar / bili_set_sign）',
  tab: 'bili',
  files: ['bili/duty.js', 'bili/api.js', 'bili/vision.js', 'bili/shots.js', 'bili/dynamics.js'],
  setup(api) {
    const { hub } = api.core
    const lastImage = new Map() // chatId → 最近一张图的网址（给 bili_set_avatar 的 last 用）
    api.on('message', (msg) => {
      const url = (msg.images || []).slice(-1)[0]?.data?.url
      if (url && /^https?:\/\//i.test(url)) lastImage.set(msg.chatId, url)
      return false
    })
    const bili = createBili({ getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log, dsh: api.dsh })
    api.every(60_000, () => bili.tick(), '刷B站')
    // 订阅 UP 主动态：单独的引擎，不跟「刷视频」抢配额（它自己会按 subIntervalMin 节流）
    const subs = createSubs({ getConfig: api.config, setConfig: api.setConfig, hub, memory: api.lazy('memory'), log: api.log })
    api.every(60_000, () => subs.tick(), '订阅B站动态')

    // 看视频谁发的链接都能看，评论要主人开口；「只要订阅」模式下这几样连同截图都不给她
    api.tool(({ chat, sessionId }) => {
      const c = api.config().bili
      if (!c.enabled || chat.kind === 'system') return []
      const tools = []
      if (!c.subsOnly) tools.push(
        defineTool({
          name: 'bili_watch',
          description: '打开一个 B 站视频看看：读标题、简介、字幕和热评，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
          properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
          required: ['link'],
          execute: async ({ link }) => bili.watch(String(link || '')),
        }),
        defineTool({
          name: 'bili_comment',
          description: '在一个 B 站视频下发评论（只有主人让你发的时候才用）。link 填链接或 BV 号，text 是评论内容。',
          properties: { link: str('B 站链接或 BV 号'), text: str('评论内容') },
          required: ['link', 'text'],
          execute: async ({ link, text }) => {
            if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我去发评论' }
            return bili.comment(String(link || ''), String(text || ''))
          },
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
            return {
              ok: true,
              list: items,
              message: `订阅了 ${items.length} 个：` + items.map((x) => `${x.name || x.mid}${x.fails ? '（最近失败 ' + x.fails + ' 次）' : ''}`).join('、'),
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
          execute: async ({ query }) => bili.sendShot({ chatId: chat.chatId, query: String(query || '') }),
        }),
        defineTool({
          name: 'qq_list_shots',
          description: '看看你手上还有哪些 B 站截图（来自哪个视频、第几秒）。挑截图之前可以先看一眼。',
          properties: { query: str('可选，按视频标题筛选') },
          required: [],
          execute: async ({ query }) => bili.listShots(String(query || '')),
        }),
      )
      return tools
    })

    // 改 B 站头像 / 签名：权限在面板「权限」页（关 / 仅主人私聊 / 所有人），默认仅主人私聊
    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.bili.enabled || cfg.bili.subsOnly) return []
      const tools = []
      if (profileToolVisible(cfg, 'biliAvatar', chat)) tools.push(defineTool({
        name: 'bili_set_avatar',
        description: '换你自己 B 站账号的头像。image 填图片网址；填 last 就用这个聊天里刚才别人发的那张图（最大 2MB）。',
        properties: { image: str('图片网址（http/https），或 last 表示刚才发的那张图') },
        required: ['image'],
        execute: async ({ image }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliAvatar', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          const raw = String(image || '').trim()
          const useLast = !raw || /^(last|刚才|上一张|最近)/i.test(raw)
          const previous = lastImage.get(hub.chatOfSession?.(sessionId) || chat.chatId)
          if (useLast && !previous) return { ok: false, message: '这个聊天里还没人发过可用的图片网址' }
          // QQ 头像模块现在只校验网址；B站的 last 在这里解析，避免与画作编号混用。
          const src = avatarSource(useLast ? previous : raw)
          if (!src.ok) return src
          return bili.setAvatar(src.file)
        },
      }))
      if (!profileToolVisible(cfg, 'biliSign', chat)) return tools
      return [...tools, defineTool({
        name: 'bili_set_sign',
        description: '改你自己 B 站账号的个性签名（最多 70 字）。有人让你改 B 站签名时用。',
        properties: { text: str('新的签名') },
        required: ['text'],
        execute: async ({ text }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliSign', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          return bili.setSign(text)
        },
      })]
    })

    api.route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
    // 订阅动态（面板「订阅」卡片）
    api.route('/bili/subs', async () => ({ ok: true, items: subs.list(), ...subs.state() }))
    api.route('/bili/sub/add', async (req) => {
      const b = await api.core.http.body(req)
      return subs.subscribe(String(b.who || b.mid || ''), b.filters)
    })
    api.route('/bili/sub/del', async (req) => {
      const b = await api.core.http.body(req)
      return subs.unsubscribe(String(b.mid || b.who || ''))
    })
    api.route('/bili/subs/check', async () => subs.poll({ force: true }))
    api.route('/bili/account', async () => bili.account(true))
    api.route('/bili/run', async () => bili.run({ force: true }))
    api.route('/bili/replies', async () => bili.checkReplies())
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
