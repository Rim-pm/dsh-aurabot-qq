import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneLocal } from '../scripts/backup-local.js'

const makeDir = (names) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-local-backup-'))
  for (const name of names) writeFileSync(join(dir, name), 'x')
  return dir
}

test('本地保留份数：只留最新 N 份完整备份，按时间戳倒序', () => {
  const dir = makeDir([
    'aurabot-backup-20261101-0330.zip',
    'aurabot-backup-20261102-0330.zip',
    'aurabot-backup-20261103-0330.zip',
    'aurabot-backup-20261104-0330.zip',
  ])
  const r = pruneLocal(dir, 2)
  assert.deepEqual(r.dropped, ['aurabot-backup-20261102-0330.zip', 'aurabot-backup-20261101-0330.zip'])
  assert.equal(r.kept, 2)
  assert.deepEqual(readdirSync(dir).sort(), ['aurabot-backup-20261103-0330.zip', 'aurabot-backup-20261104-0330.zip'])
})

test('恢复兜底和仅配置备份永远不删：pre-restore-* / aurabot-config-* / 其它文件', () => {
  const dir = makeDir([
    'aurabot-backup-20261101-0330.zip',
    'aurabot-backup-20261102-0330.zip',
    'aurabot-config-20261001-0330.zip',
    'incoming.zip',
    'notes.txt',
  ])
  mkdirSync(join(dir, 'pre-restore-1'))
  pruneLocal(dir, 1)
  const left = readdirSync(dir).sort()
  assert.deepEqual(left, [
    'aurabot-backup-20261102-0330.zip',
    'aurabot-config-20261001-0330.zip',
    'incoming.zip',
    'notes.txt',
    'pre-restore-1',
  ])
})

test('份数小于 1 时至少留一份，不会把本地备份清空', () => {
  const dir = makeDir(['aurabot-backup-20261101-0330.zip', 'aurabot-backup-20261102-0330.zip'])
  const r = pruneLocal(dir, 0)
  assert.equal(r.kept, 1)
  assert.deepEqual(readdirSync(dir), ['aurabot-backup-20261102-0330.zip'])
})

test('目录不存在时安静返回空结果', () => {
  const dir = join(tmpdir(), 'aurabot-local-backup-missing-' + Date.now())
  assert.deepEqual(pruneLocal(dir, 30), { kept: 0, dropped: [] })
  rmSync(dir, { force: true, recursive: true })
})
