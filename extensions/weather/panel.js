// 天气模块自己的面板（面板会把它当函数体执行，拿到 React、h、ui、call）
// 这里只放一个预览：看看她现在查到的天气、以及她会怎么道早安。设置在上面自动生成的表单里改。

const { useState } = React

return function WeatherPanel({ settings, toast }) {
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState(null)

  async function run() {
    setBusy(true)
    try {
      const r = await call('/preview')
      if (!r || r.ok === false) {
        toast((r && r.message) || '没查到')
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

  return h(ui.Card, {
    title: '现在看看',
    desc: '城市和早安的时间在下面的设置里改。这里只是预览，不会发到 QQ。',
  },
    h(ui.Row, null,
      h(ui.Btn, { disabled: busy, onClick: run }, busy ? '查天气中…' : '查一下现在的天气'),
      h('span', { className: 'ab-muted ab-small', style: { marginLeft: 10 } },
        settings.morningOn ? '主动问候：开' : '主动问候：关')),
    out && out.weather
      ? h('div', { className: 'ab-note', style: { whiteSpace: 'pre-wrap', marginTop: 12 } }, out.weather)
      : null,
    out && out.sample
      ? h('div', { className: 'ab-note', style: { whiteSpace: 'pre-wrap', marginTop: 12 } }, '她大概会这么说：\n' + out.sample)
      : null,
  )
}
