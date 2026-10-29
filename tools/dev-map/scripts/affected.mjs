#!/usr/bin/env node
/**
 * 改完文件之后，告诉我「你碰到了开发地图里的哪几条」——以及该跑哪些守卫、该留意什么。
 *
 * 这是把地图从「被动查询」升级成「主动提示」的那一步：agent 不必记得去 grep，
 * 脚本拿当前改动反查 A 段条目，把命中的条目、守卫清单、坑与刻意设计一次摆出来。
 *
 *   node tools/dev-map/scripts/affected.mjs              # 未提交的改动（vs HEAD）
 *   node tools/dev-map/scripts/affected.mjs --staged     # 只算已 staged 的
 *   node tools/dev-map/scripts/affected.mjs <ref>        # 与某个 ref 比（如 HEAD~1）
 *   node tools/dev-map/scripts/affected.mjs --stdin      # 从 stdin 读文件列表（每行一个）
 *   node tools/dev-map/scripts/affected.mjs --files A B  # 动手前：假定要改这几个文件会命中什么
 *
 * 只读：不动工作树，不改任何文件。
 *
 * 为什么区分「改哪里」和「联动」：一条条目的「改哪里」是它的主战场，「联动」只是
 * 顺带点名。只有前者能判定命中——否则像共享常量表这种被十几条「联动」点到的文件
 * 会一次牵出十几条条目，输出就没法看了。
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, extname } from 'node:path'
import {
  loadConfig, parseParts, makeResolver,
  normalize, isGuardName,
} from './dev-map-lib.mjs'

const { root, config } = loadConfig(import.meta.url)
const MAX_ENTRIES_PER_FILE = config.maxEntriesPerFile
const MAX_WARNINGS = config.maxWarnings
const SRC_EXTS = Object.keys(config.commentStyles)

/** `--files` 模式下这些文件还没被改，措辞要跟着变，免得看起来像已经动了。 */
let VERB = '改了'

function changedFiles() {
  const args = process.argv.slice(2)
  if (args.includes('--stdin')) {
    return readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  }
  const fi = args.indexOf('--files')
  if (fi !== -1) {
    const list = args.slice(fi + 1).filter((a) => !a.startsWith('--')).map(normalize)
    if (!list.length) {
      console.error('`--files` 后面要跟至少一个文件路径（项目相对）。')
      process.exit(1)
    }
    VERB = '假定要改'
    return list
  }
  let gitArgs
  if (args.includes('--staged')) gitArgs = ['diff', '--cached', '--name-only']
  else if (args[0]) gitArgs = ['diff', '--name-only', args[0]]
  else gitArgs = ['diff', '--name-only', 'HEAD']
  try {
    return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    // 只报我们自己的话：git 的 `fatal: ambiguous argument …` 对使用者没有信息量。
    console.error(`\`git ${gitArgs.join(' ')}\` 没跑成（ref 不存在？不在 git 仓库里？）。`)
    console.error('可以直接喂文件列表：`... --stdin`，或用 `--files <路径...>` 假定要改哪几个。')
    process.exit(1)
  }
}

// ── 简写路径还原：与生成器共用同一套（见 dev-map-lib.mjs 的 makeResolver）────────────
const { resolvePath } = makeResolver(root, config)

/** 与地图 B 段「用途」列同一套取法：文件头有没有注释块。 */
function hasHeaderComment(relPath) {
  if (!SRC_EXTS.includes(extname(relPath))) return true
  let text
  try { text = readFileSync(join(root, relPath), 'utf8') } catch { return true }
  const style = config.commentStyles[extname(relPath)] || 'slash'
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    const bare = t === '' || t.startsWith('#!')
      || t === "'use strict'" || t === "'use strict';" || t === '"use strict"' || t === '"use strict";'
    if (bare) i++
    else break
  }
  const t = (lines[i] || '').trim()
  return style === 'hash' ? t.startsWith('#') : (t.startsWith('//') || t.startsWith('/*'))
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const strip = (s) => s.replace(/\s+/g, ' ').trim()

/** 守卫脚本与文档本来就不会出现在 A 段的「改哪里」里，不必为此刷一行「没有条目」。 */
const isGuard = (f) => isGuardName(f.split('/').pop(), config) || /\/(?:tests?|scripts|spec|specs)\//.test(f)
const isDoc = (f) => f.endsWith('.md') || f.startsWith('docs/')

const files = changedFiles()
if (!files.length) {
  console.log('没有改动文件（对比 HEAD）。用 `--staged` / 指定 ref 换比对基准，')
  console.log('或者动手前用 `--files <路径...>` 假定要改哪几个文件。')
  process.exit(0)
}

const entries = parseParts(root, config, resolvePath)
const hits = []
const byFile = new Map()
for (const file of files) {
  const primary = entries.filter((e) => e.paths.includes(file))
  const secondary = entries.filter((e) => !e.paths.includes(file) && e.linked.includes(file))
  byFile.set(file, { primary, secondary })
  for (const e of primary) if (!hits.includes(e)) hits.push(e)
}

console.log(`${VERB} ${files.length} 个文件：\n`)
const orphans = []
let printed = 0
for (const file of files) {
  const { primary, secondary } = byFile.get(file)
  if (!primary.length && (isGuard(file) || isDoc(file))) continue
  printed++
  console.log(`  ${file}`)
  if (!primary.length) {
    console.log(`    （地图里没有条目把它列入「${config.fields.locate}」）`)
    // 只在「改哪里」和「联动」都没提到它时才算孤儿：被「联动」点到也是进了地图，
    // 上面那行已经说了它不是主战场，再报一次「没有任何条目」就是自相矛盾。
    if (!secondary.length) orphans.push(file)
  }
  for (const e of primary.slice(0, MAX_ENTRIES_PER_FILE)) console.log(`    ${e.id}  ${e.title}`)
  if (primary.length > MAX_ENTRIES_PER_FILE) {
    console.log(`    …另有 ${primary.length - MAX_ENTRIES_PER_FILE} 条`)
  }
  if (secondary.length) {
    const ids = secondary.slice(0, 6).map((e) => e.id).join('、')
    const more = secondary.length > 6 ? ` 等 ${secondary.length} 条` : ''
    console.log(`    （顺带在「${config.fields.linked}」里被点到：${ids}${more}）`)
  }
}
console.log(printed ? '' : `  （全是守卫脚本 / 文档，本来就不进 A 段「${config.fields.locate}」；下面只看守卫与回写建议）\n`)

if (!hits.length) {
  console.log(`没有命中任何 A 段条目的「${config.fields.locate}」。`)
  console.log(`→ 按 AGENTS.md §0 的回写规则：给这次改动补一条条目到 ${config.partsDir}/*.md，再跑 \`npm run map\`。`)
} else {
  const guards = [...new Set(hits.flatMap((e) => e.guards))].sort()
  console.log(`命中 ${hits.length} 条；建议跑这些守卫（挑秒级的跑，也可直接跑全套）：`)
  if (guards.length) {
    for (const g of guards) {
      const name = g.split('/').pop().replace(/\.[^.]+$/, '')
      const cmd = config.guardRun
        ? '  →  ' + config.guardRun.replace('{name}', name).replace('{ref}', g)
        : ''
      console.log(`  ${g}${cmd}`)
    }
    if (!config.guardRun) {
      console.log('  （在 dev-map.config.json 里填 guardRun，这里就会直接打出该跑的命令，')
      console.log('    例如 "npx jest {ref}" 或 "pytest {ref}"；{name} 是文件名去后缀）')
    }
  } else {
    console.log('  这几条都没标注守卫；全量守卫（含类型检查）仍然要跑。')
  }

  const warnings = hits.filter((e) => e.pit || e.deliberate)
  if (warnings.length) {
    console.log('')
    console.log('动手前先看这些：')
    for (const e of warnings.slice(0, MAX_WARNINGS)) {
      if (e.deliberate) console.log(`  ⚠️ ${e.id} ${config.fields.deliberate}：${clip(strip(e.deliberate), 200)}`)
      if (e.pit) console.log(`     ${e.id} ${config.fields.pit}：${clip(strip(e.pit), 200)}`)
    }
    if (warnings.length > MAX_WARNINGS) {
      console.log(`  …另有 ${warnings.length - MAX_WARNINGS} 条，见 ${config.partsDir}/*.md`)
    }
  }
}

const noHeader = files.filter((f) => SRC_EXTS.includes(extname(f)) && !hasHeaderComment(f))
if (noHeader.length) {
  console.log('')
  console.log('缺文件头的改动文件（AGENTS.md §0：动过就顺手补一行用途）：')
  for (const f of noHeader) console.log(`  ${f}`)
}

if (orphans.length) {
  console.log('')
  console.log(`这些改动的源码文件没有任何 A 段条目（补一条条目再 \`npm run map\`）：`)
  for (const f of orphans) console.log(`  ${f}`)
}

console.log('')
console.log(`修完 bug 记得把根因一句话补进相关条目的「${config.fields.pit}」字段，再跑 \`npm run map\`。`)
