// 本机定时备份：不进 DSH 也能跑，供 Windows 计划任务每天调一次。
//
// 为什么不直接开面板里的「云备份」：那套流程是「打包 + 推远端」，没填 Gitee/WebDAV 凭证时
// 每天会打包成功但推送报错，而且本地 zip 不设上限会一直堆积。这里只做「打包 + 按份数留旧的」，
// 不碰网络、不需要令牌，坏盘以外的误删/误改都能靠它回退。
//
// 与面板「立即备份」共用 createBackup，所以产物、排除项、记忆库加锁快照都完全一致。

import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBackup, listBackups } from '../src/core/backup.js'
import { loadConfig } from '../src/core/config.js'
import { workspaceDirOf } from '../src/chat/hub.js'
import { dataDir, ensureDir } from '../src/core/store.js'

const DEFAULT_KEEP = 30
// 备份名带补零的时间戳，字典序就是时间序；只认完整备份，pre-restore-* 和仅配置备份都不动。
const FULL_BACKUP_RE = /^aurabot-backup-\d{8}-\d{4}\.zip$/
const LOG = () => dataDir('logs', 'backup-local.log')

function log(line) {
  const stamp = new Date().toISOString()
  const text = `[${stamp}] ${line}`
  console.log(text)
  try {
    ensureDir(dataDir('logs'))
    appendFileSync(LOG(), text + '\n', 'utf8')
  } catch { /* 日志写不了不影响备份本身 */ }
}

/** 只清完整备份 zip，按份数留最新的 N 个。pre-restore-* 是恢复兜底，任何情况下都不删。 */
export function pruneLocal(dir, keep = DEFAULT_KEEP) {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => FULL_BACKUP_RE.test(n)).sort().reverse() : []
  const dropped = names.slice(Math.max(1, keep))
  for (const name of dropped) rmSync(join(dir, name), { force: true })
  return { kept: names.length - dropped.length, dropped }
}

function version() {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version } catch { return '' }
}

/** 记忆库用 BEGIN IMMEDIATE 取快照，插件正在写时可能撞上 busy；等一会儿重试，别把当天的备份丢了。 */
async function packWithRetry(options, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await createBackup(options)
    } catch (error) {
      const busy = /busy|locked|正在使用|占用/i.test(error.message)
      if (!busy || i >= attempts) throw error
      log(`第 ${i} 次打包撞上数据库占用，2 秒后重试：${error.message}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

async function main() {
  const keep = Math.max(1, Math.round(Number(process.argv[2]) || DEFAULT_KEEP))
  const cfg = loadConfig()
  const result = await packWithRetry({ version: version(), workspaceDir: workspaceDirOf(cfg) })
  const dir = dataDir('backups')
  const bytes = statSync(result.file).size
  log(`备份完成：${result.name}，${result.files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB`)
  if (result.skipped.length) log(`跳过 ${result.skipped.length} 个读不了的文件：${result.skipped.slice(0, 5).join(', ')}`)
  const pruned = pruneLocal(dir, keep)
  if (pruned.dropped.length) log(`清理旧备份 ${pruned.dropped.length} 份，本地保留 ${pruned.kept} 份`)
  return listBackups().length
}

// 只有被当作脚本直接执行时才真的备份；测试 import 它只拿 pruneLocal。
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((count) => {
    log(`本地共有 ${count} 份备份，目录：${dataDir('backups')}`)
  }).catch((error) => {
    log(`备份失败：${error.message}`)
    process.exitCode = 1
  })
}
