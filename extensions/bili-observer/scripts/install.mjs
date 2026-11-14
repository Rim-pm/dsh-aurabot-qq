// 把本扩展装到 Aurabot 的用户模块目录（没有依赖，直接拷文件）。
import { mkdirSync, copyFileSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const source = fileURLToPath(new URL('../', import.meta.url))
const dataRoot = process.env.AURABOT_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'aurabot')
const target = resolve(process.argv[2] || join(dataRoot, 'modules', 'bili-observer'))
if (resolve(source).toLowerCase() === target.toLowerCase()) throw new Error('当前目录就是安装目录，请在 repo 里运行这个脚本。')

mkdirSync(target, { recursive: true })
for (const name of ['README.md', 'package.json', 'panel.js']) copyFileSync(join(source, name), join(target, name))
// bili/ 子目录是拆出来的 B 站源码（从内置模块 bili vendored 过来），整个拷过去
const biliDir = join(target, 'bili')
mkdirSync(biliDir, { recursive: true })
for (const name of readdirSync(join(source, 'bili'))) {
  if (!name.endsWith('.js')) continue
  copyFileSync(join(source, 'bili', name), join(biliDir, name))
}
// 入口最后换：先写 .next 再 rename，避免模块文件没写完时被加载
copyFileSync(join(source, 'index.mjs'), join(target, 'index.mjs.next'))
renameSync(join(target, 'index.mjs.next'), join(target, 'index.mjs'))
console.log(`B 站观察者扩展已安装到 ${target}，Aurabot 会在几秒内自动加载。`)
