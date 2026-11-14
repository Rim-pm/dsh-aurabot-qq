// 判定例子：主人给的「这种要推 / 这种别推」。
//
// 存在每个订阅的 examples 里，判定时塞进 system 提示词。单独放一个文件是为了
// 配置归一化（config.js）和提示词拼装（judge.js）共用同一套上限，不会一边收 5 条、
// 另一边只认 3 条。这里不碰网络、不认 B 站接口，纯数据整理。

export const EXAMPLES_MAX = 5
export const EXAMPLE_TEXT_MAX = 200
export const EXAMPLE_WHY_MAX = 80

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 把面板 / 老配置里的例子收成统一形状：{text, keep, why}。
 * 没正文的丢掉（只有「为什么」的例子教不了模型），超过上限的从后面截掉。
 */
export function cleanExamples(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      if (!x || typeof x !== 'object') return null
      const text = clip(x.text ?? x.content ?? '', EXAMPLE_TEXT_MAX)
      if (!text) return null
      return {
        text,
        // 没写 keep 就当「要推」；只有明确 false 才是不推
        keep: x.keep !== false,
        why: clip(x.why ?? x.reason ?? '', EXAMPLE_WHY_MAX),
      }
    })
    .filter(Boolean)
    .slice(0, EXAMPLES_MAX)
}

/** 提示词里的几行例子；没有例子就返回空数组，不占提示词。 */
export function exampleLines(list) {
  return cleanExamples(list).map((e) => `- ${e.keep ? '推' : '不推'}：${e.text}${e.why ? ' —— ' + e.why : ''}`)
}
