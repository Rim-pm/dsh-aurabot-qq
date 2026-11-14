// B 站观察者的面板（面板会把它当函数体执行，拿到 React、h、ui、call）。
// 配置读写的是 core 的 cfg.bili：进来先拉 /config（已脱敏），改完点「保存设置」走 /config/save。
// 其余卡片（登录、订阅、截图库、刷过什么、日报）都走本扩展自己的 /bili/* 接口。

const { useState, useEffect, useRef, Fragment } = React

const clone = (o) => JSON.parse(JSON.stringify(o))
const cx = (...a) => a.filter(Boolean).join(' ')
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
const setPath = (obj, path, value) => {
  const next = clone(obj)
  let cur = next
  const ks = path.split('.')
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = cur[ks[i]] || {}
  cur[ks[ks.length - 1]] = value
  return next
}
const timeAgo = (t) => {
  if (!t) return '—'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return new Date(t).toLocaleDateString()
}

/** 卡片式单选：选项少、需要解释时用。 */
function Choices({ value, options, onChange }) {
  return h('div', { className: 'ab-choices', role: 'radiogroup' }, options.map((o) => h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': o.value === value, className: cx('ab-choice', o.value === value && 'on'), onClick: () => onChange(o.value) },
    h('b', null, o.icon || null, o.label), o.desc ? h('small', null, o.desc) : null)))
}

/** 一行一个的列表框：输入时保留原文（含正在敲的空行），只把解析结果交给草稿。 */
function ListArea({ value, onChange, placeholder, numbers }) {
  const parse = (t) => t.split(numbers ? /[\n,，;；\s]+/ : /[\n,，;；]+/).map((s) => s.trim()).filter(Boolean)
  const [text, setText] = useState((value || []).join('\n'))
  useEffect(() => { if (parse(text).join('\n') !== (value || []).join('\n')) setText((value || []).join('\n')) }, [(value || []).join('\n')])
  return h('textarea', { className: 'ab-textarea', style: { minHeight: 60 }, placeholder, value: text,
    onChange: (e) => { setText(e.target.value); onChange(parse(e.target.value)) },
    onBlur: () => setText(parse(text).join('\n')) })
}

/** 绑定到草稿配置的控件（和内置面板的 useField 用法一致）。 */
function useField(draft, setDraft) {
  return {
    sw: (path, extra) => h(ui.Switch, { on: !!getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), ...(extra || {}) }),
    text: (path, props) => h('input', { className: cx('ab-input', props && props.size), value: getPath(draft, path) ?? '', placeholder: props && props.placeholder, type: (props && props.type) || 'text', onChange: (e) => setDraft(setPath(draft, path, e.target.value)) }),
    num: (path, props) => h('input', { className: 'ab-input sm', type: 'number', min: props && props.min, max: props && props.max, step: (props && props.step) || 1, value: getPath(draft, path) ?? '', onChange: (e) => setDraft(setPath(draft, path, e.target.value === '' ? '' : Number(e.target.value))) }),
    // 滑块只是常用范围；超过的值在旁边的框里直接填（概率这种 0~1 的不用）
    range: (path, min, max, step, fmt) => {
      const slider = h(ui.Range, { min, max, step, value: getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), fmt })
      if (max <= 1) return slider
      return h('div', { className: 'ab-flex' }, slider, h('input', { className: 'ab-input sm', type: 'number', step, value: getPath(draft, path) ?? '', onChange: (e) => setDraft(setPath(draft, path, e.target.value === '' ? '' : Number(e.target.value))) }))
    },
    list: (path, props) => h(ListArea, { value: getPath(draft, path) || [], placeholder: props && props.placeholder, numbers: props && props.numbers, onChange: (v) => setDraft(setPath(draft, path, v)) }),
    select: (path, options, props) => h(ui.Select, { value: getPath(draft, path) ?? '', options, onChange: (v) => setDraft(setPath(draft, path, v)), ...(props || {}) }),
    choices: (path, options) => h(Choices, { value: getPath(draft, path), options, onChange: (v) => setDraft(setPath(draft, path, v)) }),
  }
}

const BILI_KIND = { watch: '看了', share: '分享给你', shot: '发你截图', like: '点赞', fav: '收藏', skip: '跳过', digest: '日报摘要', error: '没成功' }
const BILI_TIER = { worth: '值得看', ok: '可以看', skip: '跳过' }
const BILI_TIER_SEG = [{ value: '', label: '全部' }, { value: 'worth', label: '值得看' }, { value: 'ok', label: '可以看' }, { value: 'skip', label: '跳过' }]

/** B 站 Cookie：SESSDATA 和 bili_jct 分两个框填（前缀已经写好），可以显示 / 隐藏；粘整串也行，会自动拆开。 */
function BiliCookie({ draft, setDraft }) {
  const [show, setShow] = useState(false)
  const b = draft.bili
  const field = (key, prefix, setKey, hintKey, ph) => h('div', { className: 'ab-flex', style: { flexWrap: 'nowrap', marginBottom: 6 } },
    h('code', { className: 'ab-small', style: { minWidth: 82, textAlign: 'right' } }, prefix),
    h('input', {
      className: 'ab-input wide', type: show ? 'text' : 'password', autoComplete: 'off', spellCheck: false, value: b[key] || '',
      placeholder: b[setKey] ? '已保存（结尾 ' + (b[hintKey] || '…') + '），不改就留空' : ph,
      onChange: (e) => setDraft(setPath(draft, 'bili.' + key, e.target.value.trim())),
    }))
  return h(ui.Row, { label: 'B 站 Cookie', hint: '电脑浏览器登录 bilibili.com → F12 → 「应用」（Application）→ Cookie → bilibili.com，分别复制 SESSDATA 和 bili_jct 这两行的「值」。也可以直接粘整串 Cookie，会自动拆开。只存在本机；不填也能看视频，但看不到 AI 字幕、不能点赞收藏。建议用小号' },
    h('div', { style: { flex: 1 } },
      field('sessdata', 'SESSDATA=', 'sessdataSet', 'sessdataHint', '粘贴 SESSDATA 的值'),
      field('biliJct', 'bili_jct=', 'biliJctSet', 'biliJctHint', '粘贴 bili_jct 的值'),
      h('div', { className: 'ab-flex' },
        h(ui.Btn, { small: true, onClick: () => setShow(!show) }, show ? '隐藏' : '显示'),
        b.sessdataSet || b.biliJctSet ? h(ui.Btn, { small: true, kind: 'ghost', onClick: () => { if (confirm('清空保存的 B 站 Cookie？')) setDraft(setPath(setPath(setPath(draft, 'bili.sessdata', null), 'bili.biliJct', null), 'bili.cookie', null)) } }, '清空') : null,
        h('span', { className: 'ab-muted ab-small' }, '「显示」看的是正在填的内容；保存过的出于安全不回传，只显示结尾几位'))))
}

/** 订阅 UP 主动态：填 UID / 主页链接，官方号一发动态就私聊推过来。 */
function BiliSubs({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [items, setItems] = useState(null)
  const [judged, setJudged] = useState([])
  const [who, setWho] = useState('')
  const [filters, setFilters] = useState('')
  const [edits, setEdits] = useState({})
  const [exOpen, setExOpen] = useState({})
  const [exText, setExText] = useState({})
  const [exWhy, setExWhy] = useState({})
  const [exKeep, setExKeep] = useState({})
  const [busy, setBusy] = useState('')
  const [models, setModels] = useState(null)
  const [modelsErr, setModelsErr] = useState('')
  const aiOn = !!(draft.bili && draft.bili.aiFilter)
  useEffect(() => {
    if (!aiOn || models !== null) return
    call('/models')
      .then((r) => { setModels(r.list || []); setModelsErr(r.ok === false ? (r.message || '查不到模型列表') : '') })
      .catch((e) => { setModels([]); setModelsErr(e.message || '查不到模型列表') })
  }, [aiOn])
  const load = () => call('/bili/subs')
    .then((r) => { setItems(r.items || []); setJudged(r.judged || []) })
    .catch((e) => { setItems([]); setJudged([]); toast(e.message, 'err') })
  useEffect(() => { load() }, [])
  const fm = (draft.bili && draft.bili.aiFilterModel) || {}
  const fmKey = fm.provider && fm.model ? fm.provider + '::' + fm.model : ''
  const fmHit = fmKey && models ? models.find((m) => m.provider + '::' + m.model === fmKey) : null
  const fmGone = !!(fmKey && models && !modelsErr && !fmHit)
  const pickFilterModel = (v) => {
    const [p, ...rest] = String(v || '').split('::')
    setDraft(setPath(setPath(draft, 'bili.aiFilterModel.provider', v ? p : ''), 'bili.aiFilterModel.model', v ? rest.join('::') : ''))
  }
  const editOf = (it) => ({ prompt: it.prompt || '', mode: it.mode || 'auto', examples: it.examples || [], ...(edits[it.mid] || {}) })
  const setEdit = (mid, patch) => setEdits((e) => ({ ...e, [mid]: { ...(e[mid] || {}), ...patch } }))
  const dirty = (it) => {
    const e = editOf(it)
    return e.prompt !== (it.prompt || '') || e.mode !== (it.mode || 'auto') || JSON.stringify(e.examples) !== JSON.stringify(it.examples || [])
  }
  const addExample = (it) => {
    const text = String(exText[it.mid] || '').trim()
    if (!text) return toast('先写一句例子：这个号发过的一条动态，或者一句话', 'err')
    const e = editOf(it)
    if (e.examples.length >= 5) return toast('最多 5 条例子，删一条再加', 'err')
    setEdit(it.mid, { examples: [...e.examples, { text, keep: exKeep[it.mid] !== false, why: String(exWhy[it.mid] || '').trim() }] })
    setExText((x) => ({ ...x, [it.mid]: '' }))
    setExWhy((x) => ({ ...x, [it.mid]: '' }))
  }
  const delExample = (it, i) => setEdit(it.mid, { examples: editOf(it).examples.filter((_, j) => j !== i) })
  const add = async () => {
    const v = who.trim()
    if (!v) return toast('填 UID 或主页链接', 'err')
    setBusy('add')
    const r = await call('/bili/sub/add', { who: v, filters: filters.trim() })
    setBusy('')
    toast(r.message, r.ok ? 'ok' : 'err')
    if (r.ok) { setWho(''); setFilters(''); load() }
  }
  const del = async (mid) => {
    const r = await call('/bili/sub/del', { mid })
    toast(r.message, r.ok ? 'ok' : 'err')
    load()
  }
  const saveSub = async (it) => {
    const e = editOf(it)
    setBusy('save:' + it.mid)
    const r = await call('/bili/sub/update', { mid: it.mid, prompt: e.prompt, mode: e.mode, examples: e.examples })
    setBusy('')
    toast(r.message, r.ok ? 'ok' : 'err')
    if (r.ok) { setEdits((x) => { const n = { ...x }; delete n[it.mid]; return n }); load() }
  }
  const check = async () => {
    setBusy('check')
    const r = await call('/bili/subs/check', {})
    setBusy('')
    toast(r.message, r.ok ? 'ok' : 'err')
    load()
  }
  return h(ui.Card, {
    title: '订阅 UP 主动态' + (items ? '（' + items.length + '）' : ''),
    desc: '比如游戏官方号：它一发动态（公告、开播、投稿），她就私聊告诉你，图文动态连图一起发。按动态 id 记游标，所以不会重复推；B 站偶尔返回空列表时不会当成「没发」而漏掉。AI 过滤开着时，一轮多条会合成一条 digest（最多 3 张图，合成失败自动拆回逐条发）。',
    right: h(ui.Btn, { small: true, onClick: check, disabled: !!busy }, busy === 'check' ? '正在查…' : '现在查一轮'),
  },
    h('div', { className: 'ab-flex', style: { marginBottom: 8, flexWrap: 'wrap' } },
      h('input', { className: 'ab-input', style: { flex: '1 1 220px' }, placeholder: 'UID / 主页链接 / 动态链接 / UP 主名字', value: who, onChange: (e) => setWho(e.target.value), onKeyDown: (e) => e.key === 'Enter' && add() }),
      h('input', { className: 'ab-input', style: { flex: '0 1 190px' }, placeholder: '过滤（可空）：lottery forward', value: filters, onChange: (e) => setFilters(e.target.value) }),
      h(ui.Btn, { small: true, kind: 'primary', onClick: add, disabled: !!busy }, busy === 'add' ? '添加中…' : '添加')),
    !items ? h(ui.Empty, { icon: '⏳', text: '加载中…' }) : items.length === 0 ? h(ui.Empty, { icon: '📮', text: '还没订阅。填个游戏官方的 UID 或主页链接试试。' }) :
      h('div', { className: 'ab-list' }, items.map((it) => {
        const e = editOf(it)
        return h('div', { key: it.mid, className: 'ab-li' },
          h('div', { className: 'meta' }, it.mid, h('br'), it.fails ? '连续失败 ' + it.fails + ' 次' : it.lastPollAt ? timeAgo(it.lastPollAt) + '查过' : '还没查过'),
          h('div', { className: 'body' },
            h('b', null, it.name || '（还没查到名字）'),
            it.filters && it.filters.length ? h('div', { className: 'ab-muted ab-small' }, '过滤：' + it.filters.join(' ')) : null,
            it.lastError ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, it.lastError) : null,
            aiOn ? h('div', { className: 'ab-flex', style: { marginTop: 6, flexWrap: 'wrap', gap: 6 } },
              h(ui.Seg, {
                value: e.mode,
                options: [{ value: 'auto', label: 'AI 摘要' }, { value: 'raw', label: '原样转' }],
                onChange: (v) => setEdit(it.mid, { mode: v }),
              }),
              h('input', {
                className: 'ab-input', style: { flex: '1 1 200px' },
                placeholder: '这个号的情况（可空）：比如「明日方舟官号，只看活动公告和补偿」',
                value: e.prompt, onChange: (ev) => setEdit(it.mid, { prompt: ev.target.value }),
              }),
              dirty(it) ? h(ui.Btn, { small: true, kind: 'primary', disabled: !!busy, onClick: () => saveSub(it) }, busy === 'save:' + it.mid ? '保存中…' : '保存') : null) : null,
            aiOn ? h('div', { style: { marginTop: 6 } },
              h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 6 } },
                h(ui.Btn, { small: true, kind: 'ghost', onClick: () => setExOpen((x) => ({ ...x, [it.mid]: !x[it.mid] })) }, (exOpen[it.mid] ? '收起判定例子' : '判定例子') + '（' + e.examples.length + '/5）'),
                dirty(it) ? h('span', { className: 'ab-muted ab-small' }, '有改动，点上面的「保存」') : null),
              exOpen[it.mid] ? h('div', { style: { marginTop: 4 } },
                e.examples.length
                  ? h('div', { className: 'ab-list' }, e.examples.map((ex, i) => h('div', { key: i, className: 'ab-li' },
                    h('div', { className: 'meta' }, ex.keep ? '推' : '不推'),
                    h('div', { className: 'body' }, ex.text,
                      ex.why ? h('div', { className: 'ab-muted ab-small' }, ex.why) : null,
                      h('div', { className: 'ab-flex', style: { marginTop: 4 } },
                        h(ui.Btn, { small: true, kind: 'ghost', onClick: () => delExample(it, i) }, '删掉'))))))
                  : h('div', { className: 'ab-muted ab-small' }, '还没有例子。贴一条这个号发过的原话，标上「推 / 不推」，判定时一起给模型看。'),
                e.examples.length < 5
                  ? h('div', { className: 'ab-flex', style: { marginTop: 6, flexWrap: 'wrap', gap: 6 } },
                    h('input', { className: 'ab-input', style: { flex: '1 1 220px' }, placeholder: '这个号发过的一条动态，或一句话', value: exText[it.mid] || '', onChange: (ev) => setExText((x) => ({ ...x, [it.mid]: ev.target.value })) }),
                    h('input', { className: 'ab-input', style: { flex: '0 1 150px' }, placeholder: '为什么（可空）', value: exWhy[it.mid] || '', onChange: (ev) => setExWhy((x) => ({ ...x, [it.mid]: ev.target.value })) }),
                    h(ui.Seg, { value: exKeep[it.mid] === false ? 'drop' : 'keep', options: [{ value: 'keep', label: '推' }, { value: 'drop', label: '不推' }], onChange: (v) => setExKeep((x) => ({ ...x, [it.mid]: v === 'keep' })) }),
                    h(ui.Btn, { small: true, onClick: () => addExample(it) }, '加'))
                  : h('div', { className: 'ab-muted ab-small', style: { marginTop: 4 } }, '到 5 条上限了，删一条再加。')) : null) : null,
            h('div', { className: 'ab-flex', style: { marginTop: 4 } },
              h(ui.Btn, { small: true, kind: 'ghost', onClick: () => del(it.mid) }, '取消订阅')))
        )
      })),
    h(ui.Row, { label: '多久查一轮', hint: 'B 站对高频读取会降级，别调太小' }, f.range('bili.subIntervalMin', 5, 120, 5, (v) => v + ' 分钟')),
    h(ui.Row, { label: '一个号一次最多推几条', hint: '隔了几天没开时，防止一次刷屏' }, f.num('bili.subMaxPerPoll', { min: 1, max: 10 }), h('span', { className: 'ab-muted' }, '条')),
    h(ui.Row, { label: '图文动态连图一起发' }, f.sw('bili.subForwardImages')),
    h('div', { style: { marginTop: 14, borderTop: '1px solid var(--ab-line-2)', paddingTop: 12 } },
      h(ui.Row, { label: '先让 AI 看一眼再推', hint: '开着时新动态先问一次模型：要不要推、压成一句话 + 要点。只有新动态才花 token，一轮一批一次调用；关着就是原样转，不花钱' }, f.sw('bili.aiFilter')),
      ...[
        aiOn ? h(ui.Row, { key: 'mdl', label: '判定用的模型', hint: '判定和写摘要都走这个模型；留空就用「模型」页那个聊天模型。挑个便宜的能省 token，开了「纯图动态也看图」的话得选能看图的。' },
          h(ui.Select, {
            value: fmKey, width: 320,
            options: [{ value: '', label: '跟随聊天模型', desc: '和「模型」页选的一样' }].concat((models || []).map((m) => ({
              value: m.provider + '::' + m.model,
              label: m.name + (m.vision === true ? '（能看图）' : m.vision === false ? '（不看图）' : ''),
              desc: m.provider,
              group: m.provider,
            }))),
            onChange: pickFilterModel,
          }),
          models === null ? h('span', { className: 'ab-muted ab-small' }, ' 正在查模型…') : null,
          modelsErr ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, ' 查不到模型列表：' + modelsErr) : null,
          fmGone ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, ` 存的 ${fm.provider}::${fm.model} 已经不在列表里了，判定仍按它走；要换就在上面挑一个`) : null,
          fmHit && fmHit.vision === false && draft.bili.aiFilterVision
            ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, ' 这个模型看不了图，纯图动态会跳过看图照转') : null) : null,
        aiOn ? h(ui.Row, { key: 'lvl', label: '判到多重要才推', hint: '号上还能单独设；调高就只收重要的，调低就都收' }, f.range('bili.aiFilterMinLevel', 1, 3, 1, (v) => ['', '都推', '值得说一声', '很重要'][v])) : null,
        aiOn ? h(ui.Row, { key: 'vis', label: '没有正文的纯图动态也看图', hint: '会多花 token（一张图按 token 算）；不开就照转' }, f.sw('bili.aiFilterVision')) : null,
        aiOn ? h(ui.Row, { key: 'link', label: '摘要末尾带原动态链接', hint: '默认不带，看着清爽；想回溯点进去就打开' }, f.sw('bili.aiFilterLink')) : null,
        aiOn ? h(ui.Row, { key: 'digest', label: '一轮多条合成一条', hint: '同一个号一次查到多条值得推的，合成一条 digest，图最多 3 张（重要的先占名额）；关掉就一条一条发。合成失败会自动拆回逐条发' }, f.sw('bili.subDigest')) : null,
        aiOn ? h('div', { key: 'prompt', style: { marginTop: 8 } },
          h('div', { className: 'ab-label' }, h('b', null, '全局判定提示词'), h('small', null, '什么算重要、要什么口吻；每个号还能在列表里单独写一句')),
          h('textarea', {
            className: 'ab-textarea', style: { minHeight: 96, marginTop: 6 },
            placeholder: '默认已经会做这几件事：判断值不值得推、像随口说一声那样写、把「2026/11/5 10:00」换成「明天上午10点」、只留维护时间和奖励、不带安装包大小和配置要求。\n这里只写你想额外加的，比如：\n- 我在玩这个游戏，新角色和卡池信息优先；\n- 补偿和兑换码一定要提醒我领。',
            value: getPath(draft, 'bili.aiFilterPrompt') || '',
            onChange: (ev) => setDraft(setPath(draft, 'bili.aiFilterPrompt', ev.target.value)),
          })) : null,
        aiOn && judged.length ? h('div', { key: 'judged', style: { marginTop: 12 } },
          h('div', { className: 'ab-label' }, h('b', null, '最近判定'), h('small', null, '模型为什么推 / 为什么没推；觉得判歪了就改上面的提示词')),
          h('div', { className: 'ab-list' }, judged.slice(0, 8).map((x, i) => h('div', { key: x.id + '-' + i, className: 'ab-li' },
            h('div', { className: 'meta' }, x.keep ? '推了' : '没推', x.level ? h('br') : null, x.level ? x.level + ' 级' : null, h('br'), timeAgo(x.at)),
            h('div', { className: 'body' },
              h('b', null, x.name || x.mid),
              h('div', { className: 'ab-small' }, x.title || '（没有摘要）'),
              x.why ? h('div', { className: 'ab-muted ab-small' }, x.why) : null,
              x.by === 'fail' ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '判定失败，原样转了') : null,
              x.by === 'skip' ? h('div', { className: 'ab-small', style: { color: 'var(--ab-muted)' } }, '没有正文，照转') : null,
              x.by === 'raw' ? h('div', { className: 'ab-small', style: { color: 'var(--ab-muted)' } }, '这个号设的是「原样转」，没走 AI') : null))))) : null,
      ].filter(Boolean)),
  )
}

function ShotCell({ it, onChanged, toast }) {
  const src = '/aurabot/api/ext/bili-observer/bili/shot/image?file=' + encodeURIComponent(it.file)
  const cap = (it.title ? '《' + it.title + '》' : '截图') + (it.clock ? '　' + it.clock : '')
  return h('div', { className: 'ab-shot' },
    h('a', { href: src, target: '_blank', rel: 'noreferrer' }, h('img', { src, alt: cap, loading: 'lazy' })),
    h('div', { className: 'cap', title: it.note || '' }, cap),
    h('button', {
      type: 'button',
      className: 'ab-btn sm danger x',
      title: '删除',
      onClick: async () => {
        if (!confirm('删掉这张截图？\n' + cap)) return
        const r = await call('/bili/shot/delete', { file: it.file })
        toast(r.message || '删掉了', r.ok ? 'ok' : 'err')
        onChanged()
      },
    }, '✕'),
  )
}

return function BiliObserverPanel({ toast, reload }) {
  // draft = { bili: <cfg.bili> }，和内置面板用同一套路径写法，方便对照
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState('')
  const [saving, setSaving] = useState(false)
  const [s, setS] = useState(null)
  const [shots, setShots] = useState(null)
  const [seen, setSeen] = useState(null)
  const [seenTier, setSeenTier] = useState('')
  const [seenOffset, setSeenOffset] = useState(0)
  const [report, setReport] = useState(null)
  const [folders, setFolders] = useState([])
  const [folderErr, setFolderErr] = useState('')
  const [models, setModels] = useState(null)
  const [modelsErr, setModelsErr] = useState('')

  const loadConfig = () => call('/config')
    .then((r) => {
      if (r.ok === false || !r.bili) { setLoadErr(r.message || '读不到 B 站配置'); return }
      setLoadErr('')
      setSaved(clone(r.bili))
      setDraft((cur) => cur || { bili: clone(r.bili) })
    })
    .catch((e) => setLoadErr(e.message || '读不到 B 站配置'))
  const load = () => call('/bili/state').then(setS).catch((e) => toast(e.message, 'err'))
  const loadShots = () => call('/bili/shots').then((r) => setShots(r.items || [])).catch((e) => { setShots([]); toast(e.message, 'err') })
  const loadSeen = (tier = '', offset = 0) => call('/bili/seen?tier=' + encodeURIComponent(tier) + '&offset=' + offset + '&limit=20')
    .then((r) => { setSeen(r); setSeenTier(tier); setSeenOffset(offset) })
    .catch(() => setSeen({ ok: false, items: [], total: 0 }))
  const loadReport = (date = '') => call('/bili/report' + (date ? '?date=' + encodeURIComponent(date) : ''))
    .then(setReport)
    .catch(() => setReport({ ok: false, markdown: '', dates: [] }))
  const loadFolders = () => call('/bili/fav/folders')
    .then((r) => { setFolders(r.folders || []); setFolderErr(r.ok ? '' : (r.message || '读不到收藏夹')) })
    .catch((e) => setFolderErr(e.message))

  const onlySubs = !!(draft && draft.bili && draft.bili.subsOnly)

  useEffect(() => { loadConfig() }, [])
  useEffect(() => {
    if (onlySubs) return
    call('/models')
      .then((r) => { setModels(r.list || []); setModelsErr(r.ok === false ? (r.message || '查不到模型列表') : '') })
      .catch((e) => { setModels([]); setModelsErr(e.message || '查不到模型列表') })
  }, [onlySubs])
  useEffect(() => { load(); loadShots(); loadSeen('', 0); loadReport(); loadFolders() }, [])

  if (loadErr) return h('div', { className: 'ab-note err' }, 'B 站观察者面板读不到配置：' + loadErr)
  if (!draft) return h(ui.Empty, { icon: '⏳', text: '加载中…' })

  const f = useField(draft, setDraft)
  const dirty = JSON.stringify(draft.bili) !== JSON.stringify(saved)
  const saveAll = async () => {
    setSaving(true)
    const r = await call('/config/save', { bili: draft.bili })
    setSaving(false)
    if (r.ok === false) return toast(r.message || '保存失败', 'err')
    setSaved(clone(r.bili || draft.bili))
    setDraft({ bili: clone(r.bili || draft.bili) })
    toast('保存好了', 'ok')
    // 全局那份草稿里还留着旧的 bili：不刷新的话，下次在别的页点「保存」会把它盖回来
    if (reload) reload()
    load()
  }

  const act = (path, label) => async () => { setBusy(label); const r = await call(path, {}); setBusy(''); toast(r.message, r.ok ? 'ok' : 'err'); load(); loadShots(); loadSeen(seenTier, 0); loadReport() }
  const acct = s && s.account
  const observer = (draft.bili && draft.bili.posture) !== 'social'
  const favOptions = [{ value: '0', label: '不收藏' }, ...folders.map((x) => ({ value: String(x.id), label: x.title + '（' + x.count + '）' }))]
  const favRow = (path, label) => h(ui.Row, { label, hint: folderErr || '0 = 不收藏' },
    h(ui.Select, { value: String(getPath(draft, path) ?? 0), options: favOptions, onChange: (v) => setDraft(setPath(draft, path, Number(v))), width: 240 }))
  const bm = (draft.bili && draft.bili.browseModel) || {}
  const bmKey = bm.provider && bm.model ? bm.provider + '::' + bm.model : ''
  const bmHit = bmKey && models ? models.find((m) => m.provider + '::' + m.model === bmKey) : null
  const bmGone = !!(bmKey && models && !modelsErr && !bmHit)
  const pickBrowseModel = (v) => {
    const [p, ...rest] = String(v || '').split('::')
    setDraft(setPath(setPath(draft, 'bili.browseModel.provider', v ? p : ''), 'bili.browseModel.model', v ? rest.join('::') : ''))
  }
  const browseModelRow = h(ui.Row, { label: '刷 B 站用的模型', hint: '挑关键词、看完写想法都走这个模型；留空就用「模型」页那个聊天模型。挑个便宜的能省 token，开了「看画面」的话得选能看图的（不然抽帧会被跳过，只读文字）。' },
    h(ui.Select, {
      value: bmKey, width: 320,
      options: [{ value: '', label: '跟随聊天模型', desc: '和「模型」页选的一样' }].concat((models || []).map((m) => ({
        value: m.provider + '::' + m.model,
        label: m.name + (m.vision === true ? '（能看图）' : m.vision === false ? '（不看图）' : ''),
        desc: m.provider,
        group: m.provider,
      }))),
      onChange: pickBrowseModel,
    }),
    models === null ? h('span', { className: 'ab-muted ab-small' }, ' 正在查模型…') : null,
    modelsErr ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, ' 查不到模型列表：' + modelsErr) : null,
    bmGone ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, ` 存的 ${bm.provider}::${bm.model} 已经不在列表里了，刷 B 站仍按它走；要换就在上面挑一个`) : null,
    bmHit && bmHit.vision === false && draft.bili?.vision
      ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, ' 这个模型看不了图，抽帧会被跳过，只读文字') : null)

  return h('div', { className: 'ab-grid' },
    h(ui.Card, {
      title: 'B 站观察者',
      desc: '这是从内置「B站」拆出来的扩展：读写的是同一份 B 站配置（cfg.bili），关掉内置模块后由它接管。改完点右边的「保存设置」。',
      right: h('div', { className: 'ab-flex' },
        dirty ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '有未保存的改动') : null,
        h(ui.Btn, { small: true, kind: 'primary', disabled: !dirty || saving, onClick: saveAll }, saving ? '保存中…' : '保存设置')),
    },
      h(ui.Row, { label: '模块', hint: '模块本身的开关在「已安装」页；这里的开关控制 B 站功能本身' },
        h('span', { className: 'ab-muted ab-small' }, draft.bili.enabled ? 'B 站功能开着' : 'B 站功能关着'))),

    h(ui.Card, { title: onlySubs ? 'B 站（只订阅）' : '刷 B 站', right: f.sw('bili.enabled'), desc: onlySubs ? '开着「只要订阅」，ta只会定时查你订阅的 UP 主动态并私聊推给你；不刷视频、不点赞不收藏、不发截图。下面填的 Cookie 订阅也会用（只读填 SESSDATA 就够）。' : '观察者模式：ta会定时去 B 站看视频（关键词留空就刷账号推荐流），读简介、字幕、热评和弹幕，判断值不值得看。只点赞和收藏，不评论、不发弹幕、不改资料；值得看的会私聊分享给你，每天还有一条日报摘要。你在 QQ 里发 B 站链接或分享卡片，ta也能点进去看完再聊。' },
      h(ui.Row, { label: '姿态', hint: observer ? '只看只记：不评论、不发弹幕、不改资料，只保留点赞和收藏' : '社交模式：放开写闸门（评论 / 弹幕 / 改资料的工具和路由已下线，闸门留着兜底）' },
        h(Choices, {
          value: observer ? 'observer' : 'social',
          options: [
            { value: 'observer', label: '观察者', desc: '只看只记（默认）' },
            { value: 'social', label: '社交', desc: '放开写闸门' },
          ],
          onChange: (v) => {
            if (v === 'social' && !confirm('切到社交模式？\n\n写闸门会放开（评论 / 改资料接口不再拒绝），但评论、弹幕、改资料的工具和面板入口已经删掉，实际不会有公开互动。')) return
            setDraft(setPath(draft, 'bili.posture', v))
          },
        })),
      h(ui.Row, { label: '只要订阅，别的 B 站功能都关掉', hint: '不刷视频、不点赞不收藏、不发截图；聊天里也不再给ta看视频的工具' }, f.sw('bili.subsOnly')),
      h(BiliCookie, { draft, setDraft }),
      h('div', { className: 'ab-flex', style: { marginTop: 4 } },
        h(ui.Btn, { small: true, onClick: async () => { await call('/bili/account'); load() } }, '检查登录'),
        acct ? h('span', { className: 'ab-small', style: { color: acct.isLogin ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, acct.isLogin ? '已登录：' + acct.uname : '没登录（只能看，不能点赞收藏）') : null),
    ),
    h(BiliSubs, { draft, setDraft, toast }),
    onlySubs ? null : h(ui.Card, { title: '怎么刷', desc: '只在「主动搭话」里设的醒着时间内刷。' },
      browseModelRow,
      h(ui.Row, { label: '定时自己去刷' }, f.sw('bili.autoBrowse')),
      h(ui.Row, { label: '多久刷一轮' }, f.range('bili.intervalHours', 1, 24, 1, (v) => v + ' 小时')),
      h(ui.Row, { label: '每天最多刷' }, f.range('bili.maxRunsPerDay', 0, 12, 1, (v) => v + ' 轮')),
      h(ui.Row, { label: '一轮看几个视频' }, f.range('bili.perRun', 1, 6, 1, (v) => v + ' 个')),
      h(ui.Row, { label: '额外想看的方向', hint: '留空 = 刷账号推荐流；填了才按关键词搜（一行一个，另外还会参考ta的兴趣和记忆）' }, f.list('bili.keywords', { placeholder: '白米饭 做法\n猫咪\n游戏解说' })),
      h(ui.Row, { label: '播放量门槛', hint: '只对搜索 / 热门生效，推荐流不过滤' }, f.num('bili.minViews', { min: 0 }), h('span', { className: 'ab-muted' }, '次以上')),
      h(ui.Row, { label: '只看最近', hint: '只对搜索 / 热门生效，推荐流不过滤' }, f.num('bili.maxAgeDays', { min: 0 }), h('span', { className: 'ab-muted' }, '天内发的（0 = 不限）')),
    ),
    onlySubs ? null : h(ui.Card, { title: '分享、点赞和日报', desc: '点赞和收藏要登录，并且 Cookie 里要有 bili_jct；试运行开着时只记日志不写。' },
      h(ui.Row, { label: '看到值得看的分享给你', hint: '私聊发给主人，带视频链接；只发「值得看」那一档' }, f.sw('bili.shareToOwner')),
      h(ui.Row, { label: '顺手点赞（只给值得看）', hint: '每天最多 N 条，第 N+1 条不再发请求' }, f.sw('bili.like'), h('span', { className: 'ab-muted' }, '每天最多'), f.num('bili.maxLikesPerDay', { min: 0, max: 50 }), h('span', { className: 'ab-muted' }, '条')),
      h(ui.Row, { label: '每天推一条日报摘要', hint: '汇总当天值得看的，私聊发给你；当天没刷就不发' }, f.sw('bili.dailyDigest'), h('span', { className: 'ab-muted' }, '几点'), f.num('bili.dailyDigestHour', { min: 0, max: 23 }), h('span', { className: 'ab-muted' }, '点')),
    ),
    onlySubs ? null : h(ui.Card, { title: '收藏夹', desc: '按档位收藏到两个夹子：值得看 → 夹 A，可以看 → 夹 B。注意：B 站收藏夹默认是公开的，别人点进主页能看到。想「不参与互动」就把这两个夹设成私密——插件只能选夹子，改不了可见性。' },
      favRow('bili.favWorthFolderId', '值得看 → 收藏夹'),
      favRow('bili.favOkFolderId', '可以看 → 收藏夹'),
      h(ui.Row, { label: '每天最多收藏' }, f.num('bili.maxFavsPerDay', { min: 0, max: 100 }), h('span', { className: 'ab-muted' }, '条')),
    ),
    onlySubs ? null : h(ui.Card, { title: '看画面（抽帧 + 视觉）', desc: '默认只读标题、简介、字幕、热评和弹幕。打开后用 ffmpeg 抽帧交给视觉模型，截图保存到本机，可以在 QQ 聊天里让ta挑一张发送。没有 ffmpeg、模型明确不支持图片或处理失败时，自动继续文字阅读。' },
      h(ui.Row, { label: '让ta看画面', hint: '需要视觉模型 + ffmpeg；关掉就退回只看文字' }, f.sw('bili.vision')),
      h(ui.Row, { label: '每个视频抽几帧' }, f.range('bili.visionFrames', 2, 12, 1, (v) => v + ' 帧')),
      h(ui.Row, { label: '刷完顺手发张截图', hint: '概率；跟发一张表情包一样默认 35%，0 = 从不。截图都存在本机，你让ta发ta也能挑' }, f.range('bili.shotChance', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')),
      h(ui.Row, { label: '截图库最多存', hint: '超过就自动删最旧的；下面的截图库里也能一张张手动删' }, f.num('bili.shotLibrary', { min: 20, max: 2000 }), h('span', { className: 'ab-muted' }, '张')),
      h(ui.Row, { label: 'ffmpeg 路径', hint: '留空就自己在 PATH 里找；找不到就填绝对路径' }, f.text('bili.ffmpegPath', { placeholder: 'C:\\ffmpeg\\bin\\ffmpeg.exe' })),
      s && s.vision ? h('div', { className: 'ab-small', style: { marginTop: 4, color: s.vision.ffmpeg ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, (s.vision.ffmpeg ? '✓ 已找到 ffmpeg：' + s.vision.ffmpeg : '✗ 没找到 ffmpeg：抽帧会被跳过，装一个或者在上面填路径') + (s.shots ? '　·　手上存了 ' + s.shots.count + ' 张截图' : '')) : null,
    ),
    onlySubs ? null : h(ui.Card, { title: '截图库' + (shots ? '（' + shots.length + ' / ' + ((draft.bili && draft.bili.shotLibrary) || 300) + '）' : ''), right: h('div', { className: 'ab-flex' },
      h(ui.Btn, { small: true, kind: 'ghost', onClick: loadShots }, '刷新')) },
      !shots ? h(ui.Empty, { icon: '⏳', text: '加载中…' }) : shots.length === 0 ? h(ui.Empty, { icon: '🎬', text: '还没有截图。打开上面的「让ta看画面」刷一轮 B 站，就会开始截。' }) :
        h('div', { className: 'ab-shots' }, shots.map((it) => h(ShotCell, { key: it.file, it, onChanged: () => { loadShots(); load() }, toast }))),
    ),
    onlySubs ? null : h(ui.Card, { title: '它刷过的视频' + (seen ? '（' + seen.total + ' 条）' : ''), right: h(ui.Seg, { value: seenTier, options: BILI_TIER_SEG, onChange: (v) => loadSeen(v, 0) }) },
      !seen ? h(ui.Empty, { icon: '⏳', text: '加载中…' }) : seen.items.length === 0 ? h(ui.Empty, { icon: '📼', text: seenTier ? '这个档位还没有记录。' : '还没有记录。点上面的「现在刷一轮」试试。' }) :
        h('div', { className: 'ab-list' }, seen.items.map((x) => h('div', { key: x.bvid, className: 'ab-li' },
          h('div', { className: 'meta' }, BILI_TIER[x.tier] || x.tier, h('br'), x.at ? timeAgo(x.at) : ''),
          h('div', { className: 'body' },
            h('a', { href: 'https://www.bilibili.com/video/' + x.bvid, target: '_blank', rel: 'noreferrer' }, '《' + (x.title || x.bvid) + '》'),
            x.up ? h('span', { className: 'ab-muted' }, '　' + x.up) : null,
            x.status === 'liked' ? h('span', { className: 'ab-small', style: { marginLeft: 6 } }, '♥ 点赞') : null,
            x.status === 'faved' ? h('span', { className: 'ab-small', style: { marginLeft: 6 } }, '★ 收藏') : null,
            x.why ? h('div', { className: 'ab-muted' }, x.why) : null)))),
      seen && seen.total > 20 ? h('div', { className: 'ab-flex', style: { marginTop: 8 } },
        h(ui.Btn, { small: true, kind: 'ghost', disabled: seenOffset <= 0, onClick: () => loadSeen(seenTier, Math.max(0, seenOffset - 20)) }, '上一页'),
        h('span', { className: 'ab-small ab-muted' }, (seenOffset + 1) + '–' + Math.min(seenOffset + 20, seen.total) + ' / ' + seen.total),
        h(ui.Btn, { small: true, kind: 'ghost', disabled: seenOffset + 20 >= seen.total, onClick: () => loadSeen(seenTier, seenOffset + 20) }, '下一页')) : null,
    ),
    onlySubs ? null : h(ui.Card, { title: '今天的日报' + (report ? '（' + (report.count || 0) + ' 条）' : ''), right: h('div', { className: 'ab-flex' },
      h(ui.Select, { value: report?.date || '', options: (report?.dates || []).map((d) => ({ value: d, label: d })), onChange: (d) => loadReport(d), placeholder: '今天', width: 150 }),
      h(ui.Btn, { small: true, kind: 'ghost', onClick: () => loadReport() }, '今天')) },
      !report ? h(ui.Empty, { icon: '⏳', text: '加载中…' }) : report.markdown
        ? h('pre', { className: 'ab-code', style: { whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' } }, report.markdown)
        : h(ui.Empty, { icon: '📄', text: '这一天还没有日报。' }),
    ),
    onlySubs ? null : h(ui.Card, { title: 'ta刷过什么', right: h('div', { className: 'ab-flex' },
      h(ui.Btn, { small: true, kind: 'primary', onClick: act('/bili/run', 'run'), disabled: !!busy }, busy === 'run' ? h(Fragment, null, h('i', { className: 'ab-spin' }), ' 正在刷…') : '现在刷一轮')) },
      s && s.pauseReason ? h('div', { className: 'ab-note warn', style: { marginBottom: 8 } }, '今天先不点赞和收藏了：' + s.pauseReason + '。登录失效请保存新 Cookie 后点「检查登录」；验证、风控或频率限制不会因登录成功而解除。') : null,
      s ? h('div', { className: 'ab-muted ab-small', style: { marginBottom: 8 } }, '今天自动刷了 ' + s.runs + ' 轮 · 点赞 ' + (s.likes || 0) + ' 条 · 收藏 ' + (s.favs || 0) + ' 条' + (s.lastRun ? ' · 上次 ' + timeAgo(s.lastRun) : '') + '（手动刷不占次数）') : null,
      !s ? h(ui.Empty, { icon: '⏳', text: '加载中…' }) : s.history.length === 0 ? h(ui.Empty, { icon: '📺', text: '还没刷过。点「现在刷一轮」试试。' }) :
        h('div', { className: 'ab-list' }, s.history.map((x, i) => h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'meta' }, timeAgo(x.at), h('br'), BILI_KIND[x.kind] || x.kind),
          h('div', { className: 'body' }, x.bvid ? h('a', { href: 'https://www.bilibili.com/video/' + x.bvid, target: '_blank', rel: 'noreferrer' }, '《' + x.title + '》') : h('b', null, '《' + x.title + '》'), x.text ? h('div', { className: 'ab-muted' }, x.text) : null)))),
    ),
  )
}
