// 抖音转存模块自己的面板（面板会把它当函数体执行，拿到 React、h、ui、call）
// 这里只放一个试看：贴一条链接，看看她「看」这条东西时会拿到什么。不会发到 QQ。
// 默认值（看几条评论、读不读稿、看几张图）在下面的设置里改。

const { useState } = React

return function DouyinPanel({ settings, toast }) {
  const [url, setUrl] = useState('')
  const [comments, setComments] = useState(0)
  const [transcript, setTranscript] = useState(true)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState(null)

  async function run() {
    if (!url.trim()) return toast('先贴一条链接')
    setBusy(true)
    try {
      const r = await call('/look', { url: url.trim(), comments: Number(comments) || 0, transcript })
      if (!r || r.ok === false) {
        toast((r && r.message) || '没看成')
        setOut(null)
      } else {
        setOut(r)
      }
    } catch (e) {
      toast(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }

  const meta = out
    ? [
      out.title ? `《${out.title}》` : '（没有标题）',
      `${out.platform === 'bilibili' ? 'B站' : '抖音'}${out.kind === 'image_album' ? '图集' : '视频'}${out.dur ? ' · ' + out.dur : ''}`,
    ].join(' ')
    : ''

  return h(ui.Card, {
    title: '试看一条链接',
    desc: '贴链接看看她「看」这条时会拿到什么：标题、时长、文字稿、热评、图。只是预览，不会发到 QQ，也不改配置。',
  },
    h(ui.Row, { label: '链接' },
      h('input', {
        className: 'ab-input',
        placeholder: 'https://v.douyin.com/… 或 https://b23.tv/…',
        value: url,
        onChange: (e) => setUrl(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter' && !busy) run() },
      })),
    h(ui.Row, { label: '热评条数', hint: '0 = 不看；试的时候临时改，不影响默认值' },
      h('input', {
        className: 'ab-input',
        style: { maxWidth: 100 },
        type: 'number',
        min: 0,
        max: 30,
        value: comments,
        onChange: (e) => setComments(e.target.value),
      })),
    h(ui.Row, { label: '读文字稿', hint: '视频要跑语音识别，几十秒；图集没声音会自动跳过' },
      h(ui.Switch, { on: transcript, onChange: setTranscript })),
    h(ui.Row, null,
      h(ui.Btn, { kind: 'primary', disabled: busy, onClick: run }, busy ? '看着呢…' : '看这条'),
      h('span', { className: 'ab-muted ab-small', style: { marginLeft: 10 } },
        settings.lookTranscript === false ? '默认不读稿' : '默认读稿')),

    out
      ? h('div', { style: { marginTop: 14 } },
        h('div', { style: { fontWeight: 620, marginBottom: 6 } }, meta),
        out.link ? h('a', { className: 'ab-small', href: out.link, target: '_blank', rel: 'noreferrer' }, out.link) : null,
        (out.notes || []).length
          ? h('div', { className: 'ab-note', style: { marginTop: 10 } }, out.notes.join('；'))
          : null,
        (out.thumbs || []).length
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
            out.thumbs.map((src, i) => h('img', {
              key: i,
              src,
              style: { width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(127,127,127,.25)' },
            })),
            out.imageTotal ? h('div', { className: 'ab-muted ab-small', style: { alignSelf: 'flex-end' } }, `共 ${out.imageTotal} 张`) : null)
          : null,
        out.transcript
          ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } },
              `文字稿${out.transcriptDur ? '（' + out.transcriptDur + '）' : ''}，共 ${out.transcriptTotal} 字`
              + (out.transcriptMore ? `，后面还有 ${out.transcriptMore} 字没给她` : '')),
            h('div', { className: 'ab-note', style: { whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' } }, out.transcript))
          : null,
        out.comments
          ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } },
              `热评 ${out.commentsCount} 条` + (out.commentsMore ? `，后面还有 ${out.commentsMore} 字` : '')),
            h('div', { className: 'ab-note', style: { whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' } }, out.comments))
          : null,
      )
      : null,
  )
}
