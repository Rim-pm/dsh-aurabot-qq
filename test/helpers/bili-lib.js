// 扩展 extensions/bili-observer/bili/*.js 是 vendored 的 B 站源码，顶层就用
// globalThis.aurabot.lib 取核心模块（装进 modules/ 后由 core/modules.js 注入）。
// 测试要直接 import 这些文件，所以这里先按同样的映射把 lib 桩装好。
// 必须在 import 扩展里的文件之前执行：把它放在测试文件的第一行 import。

import * as store from '../../src/core/store.js'
import * as config from '../../src/core/config.js'
import * as llm from '../../src/core/llm.js'
import * as img from '../../src/core/img.js'
import * as net from '../../src/core/net.js'
import * as reply from '../../src/chat/reply.js'
import * as tools from '../../src/tools/tools.js'

const libs = {
  'core/store.js': store,
  'core/config.js': config,
  'core/llm.js': llm,
  'core/img.js': img,
  'core/net.js': net,
  'chat/reply.js': reply,
  'tools/tools.js': tools,
}

globalThis.aurabot = {
  lib: (key) => {
    const m = libs[key]
    if (!m) throw new Error(`没有 ${key} 这个内部文件`)
    return m
  },
  src: new URL('../../src/', import.meta.url).href,
}

export const BILI_DIR = new URL('../../extensions/bili-observer/', import.meta.url)
export const biliFile = (name) => new URL(`bili/${name}`, BILI_DIR)
export const biliModule = new URL('index.mjs', BILI_DIR)
export const biliPanel = new URL('panel.js', BILI_DIR)
