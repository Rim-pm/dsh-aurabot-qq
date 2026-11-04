// 把天气扩展装进 Aurabot 的用户模块目录。没有依赖，不需要构建。
import { mkdirSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const source = fileURLToPath(new URL('../', import.meta.url))
const dataRoot = process.env.AURABOT_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'aurabot')
const target = resolve(process.argv[2] || join(dataRoot, 'modules', 'weather'))
if (resolve(source).toLowerCase() === target.toLowerCase()) throw new Error('当前目录已是安装目录；更新请从 repo 里运行这个命令。')

mkdirSync(target, { recursive: true })
for (const name of ['README.md', 'package.json', 'panel.js']) copyFileSync(join(source, name), join(target, name))
// 入口最后换，避免模块在文件没齐的时候被热重载
copyFileSync(join(source, 'index.mjs'), join(target, 'index.mjs.next'))
renameSync(join(target, 'index.mjs.next'), join(target, 'index.mjs'))
console.log(`天气扩展已安装到 ${target}。Aurabot 会在几秒内自动重载。`)
