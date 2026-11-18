import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md'])
const BINARY_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.onnx', '.zip', '.pyc'])

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

function extOf(file) {
  const i = file.lastIndexOf('.')
  return i < 0 ? '' : file.slice(i).toLowerCase()
}

function parseAsModule(source, identifier) {
  new vm.SourceTextModule(source, { identifier })
}

function parseAsFunctionBody(source, identifier) {
  new vm.Script(`(function () {\n${source}\n})`, { filename: identifier })
}

const problems = []

for (const file of trackedFiles()) {
  const ext = extOf(file)
  if (BINARY_EXT.has(ext) || !TEXT_EXT.has(ext)) continue

  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    continue
  }

  if (source.includes('\r')) {
    problems.push(`${file}: 含 CRLF 行尾（仓库统一 LF，见 .gitattributes）`)
    continue
  }

  const lines = source.split('\n')
  lines.forEach((line, i) => {
    if (/^\t/.test(line)) problems.push(`${file}:${i + 1}: 用空格缩进，不要用 Tab`)
  })

  if (ext === '.js' || ext === '.mjs') {
    try {
      parseAsModule(source, file)
    } catch (err) {
      try {
        parseAsFunctionBody(source, file)
      } catch {
        problems.push(`${file}: 语法错误 — ${err.message}`)
      }
    }
  }
}

if (problems.length > 0) {
  for (const line of problems) console.error(line)
  console.error(`\nlint: ${problems.length} 个问题`)
  process.exit(1)
}

console.log('lint: ok')
