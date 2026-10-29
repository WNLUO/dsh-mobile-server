#!/usr/bin/env node
/**
 * 再生地图的三个区块：
 *   A. 需求 → 改哪里（汇总 `docs/.dev-map-parts/*.md`，人手写的语义层）
 *   B. 文件清单（每个源文件 → 文件头注释里的用途，机械生成）
 *   C. 守卫与测试索引（机械生成）
 *
 * 定位任何文件前先看地图；定位失败时把新条目补回 A 段——这条回写规则是地图
 * 不腐烂的唯一机制。B / C 两段绝不能手改，它们由本脚本再生。
 *
 *   node tools/dev-map/scripts/gen-dev-map.mjs           # 就地更新
 *   node tools/dev-map/scripts/gen-dev-map.mjs --check   # 只校验是否过期（CI 用）
 *   node tools/dev-map/scripts/gen-dev-map.mjs --root <目录>   # 指定项目根（脚本不必在项目里）
 *
 * 认哪些目录、哪些后缀、字段叫什么，全在根目录 `dev-map.config.json`。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, relative, dirname, sep } from 'node:path'
import {
  loadConfig, collect, relOf, purposeOf, validateParts,
  listParts, replaceBlock, parseParts, makeResolver,
} from './dev-map-lib.mjs'

// --root 是给「脚本在别处、项目在这里」用的（模板自己的回归测试就靠它）；
// 正常流程里脚本被 init 拷进项目，直接跑就行。
const rootArgIndex = process.argv.indexOf('--root')
const { root, config } = loadConfig(import.meta.url, rootArgIndex > -1 ? process.argv[rootArgIndex + 1] : undefined)
const CHECK = process.argv.includes('--check')
const DOC = join(root, config.mapFile)
const UNCOVERED = join(root, config.uncoveredFile)

const escapeCell = (s) => s.replace(/\|/g, '\\|')

function renderSection(section) {
  const files = collect(root, config, section)
  const lines = [`### ${section.title}`, '', `共 ${files.length} 个文件。`, '', '| 文件 | 用途 |', '| --- | --- |']
  for (const f of files) {
    lines.push(`| \`${relOf(root, f)}\` | ${escapeCell(purposeOf(f, config))} |`)
  }
  return lines.join('\n')
}

function renderPlaybooks() {
  const parts = listParts(root, config)
  if (!parts.length) {
    return `（尚未编写：在 \`${config.partsDir}/\` 下每个领域一份 \`NN-*.md\`）`
  }
  return parts.map((n) => readFileSync(join(root, config.partsDir, n), 'utf8').trim()).join('\n\n---\n\n')
}

// ── A 段机械校验先跑：编号乱了就没必要再谈生成 ─────────────────────────────────
const idErrors = validateParts(root, config)
if (idErrors.length) {
  console.error(`A 段条目的机械可读性有问题（${config.partsDir}/*.md）：`)
  for (const e of idErrors) console.error('  ' + e)
  console.error('\n规则：每个领域 `A<领域号>-<两位序号>`，从 01 起连续、不重号，领域号与文件名一致；')
  console.error(`且每条条目的「${config.fields.locate}」里必须至少有一个能抽出来的文件路径——`)
  console.error('`affected` 只认它抽得出来的路径，抽不出来这条条目就等于不存在。')
  process.exit(1)
}

if (!existsSync(DOC)) {
  console.error(`找不到地图文件 ${config.mapFile}。先用模板里的骨架建一个（见 dev-map-template/README.md）。`)
  process.exit(1)
}

const original = readFileSync(DOC, 'utf8')
const playbookText = renderPlaybooks()

// A 段覆盖率的量尺：既把「还有哪些文件没人写条目」变成一份带进度的待补清单，
// 也让「补条目」这件事有可验证的终点（数字变小），而不是等下次踩坑才想起来。
//
// **认「拥有」而不是「提过」**：只有出现在某条条目的「改哪里」里，affected 才认得出这个文件；
// 只被「联动」「坑」点到的文件，改到它时只会得到一句「顺带被点到」。
// 早先这里写的是「路径字符串在 A 段正文里出现过就算覆盖」，于是生成器报「已覆盖」、
// affected 却报「没有条目把它列入改哪里」——本模板存在的理由就是消灭这种静默失效。
const allSource = [...new Set(
  [...(config.sourceSections || [])].flatMap((s) => collect(root, config, s).map((f) => relOf(root, f))),
)].sort()
const { resolvePath } = makeResolver(root, config)
const entries = parseParts(root, config, resolvePath)
const owned = new Set(entries.flatMap((e) => e.paths))
const linked = new Set(entries.flatMap((e) => e.linked))
const uncovered = allSource.filter((rel) => !owned.has(rel))
const uncoveredLinked = uncovered.filter((rel) => linked.has(rel)).length

// 链接按「地图所在目录 → 未覆盖清单」算，这样两个文件不在同一层也不会链错。
const uncoveredLink = relative(dirname(config.mapFile), config.uncoveredFile).split(sep).join('/')
const uncoveredNote = [
  `> **A 段未覆盖**：${uncovered.length} / ${allSource.length} 个源文件没有任何条目的「改哪里」收它们。`,
  `> 其中 ${uncoveredLinked} 个被「联动」点到过——\`affected\` 按名字找得到，但只会提示「顺带被点到」，`,
  '> 没有条目「拥有」它们。完整清单见',
  `> [\`${config.uncoveredFile}\`](${uncoveredLink})——那是一份「地图待补清单」，`,
  '> 不是缺陷清单；把条目补进 A 段后跑 `npm run map`，它会自己变短。',
].join('\n')

const uncoveredFileText = [
  '# A 段未覆盖的源文件（没有任何条目的「改哪里」收它们）',
  '# 由 gen-dev-map.mjs 生成，勿手改。',
  '# 补条目到 A 段后跑 `npm run map`，这份清单会自动变短。',
  `# 共 ${uncovered.length} / ${allSource.length} 个；其中 ${uncoveredLinked} 个已被「联动」点到过。`,
  ...uncovered,
  '',
].join('\n')

let next = replaceBlock(original, 'TASK-PLAYBOOKS', playbookText)
next = replaceBlock(next, 'GENERATED-FILES', `${uncoveredNote}\n\n${(config.sourceSections || []).map(renderSection).join('\n\n')}`)
next = replaceBlock(next, 'GENERATED-GUARDS', (config.guardSections || []).map(renderSection).join('\n\n'))

const previousUncovered = existsSync(UNCOVERED) ? readFileSync(UNCOVERED, 'utf8') : ''

// 宪法层是每轮对话都要注入的，越大越贵。模板自己写着「控制在 8KB 以内」，
// 但没有任何东西在盯着——实测一个真项目合并完就 10.4KB。这里只警告、不拦：
// 有的项目确实需要更多，但超了应该是有意识的决定，而不是没人发现。
const agentsFile = join(root, 'AGENTS.md')
const agentsWarn = (() => {
  if (!existsSync(agentsFile)) return null
  const size = statSync(agentsFile).size
  const max = config.agentsMaxBytes
  if (!max || size <= max) return null
  return `⚠️ AGENTS.md 有 ${(size / 1024).toFixed(1)}KB，超过 ${(max / 1024).toFixed(0)}KB —— 它每轮对话都要注入，建议删掉能被别处替代的段落。`
})()

if (CHECK) {
  const staleDoc = next !== original
  const staleList = uncoveredFileText !== previousUncovered
  if (!staleDoc && !staleList) {
    console.log(`地图与未覆盖清单都是最新的（A 段未覆盖 ${uncovered.length} / ${allSource.length}）`)
    if (agentsWarn) console.log(agentsWarn)
    process.exit(0)
  }
  if (staleList) console.error(`${config.uncoveredFile} 过期：当前应为 ${uncovered.length} 个未覆盖文件。`)
  if (staleDoc) {
    const missing = []
    for (const section of [...(config.sourceSections || []), ...(config.guardSections || [])]) {
      for (const f of collect(root, config, section)) {
        const rel = relOf(root, f)
        if (!original.includes(rel)) missing.push(rel)
      }
    }
    if (missing.length) {
      console.error(`地图未收录 ${missing.length} 个文件：`)
      for (const rel of missing) console.error('  ' + rel)
    } else {
      console.error('地图的用途描述或 A 段已过期（文件都在，但内容变了）。')
    }
  }
  if (agentsWarn) console.error('\n' + agentsWarn)
  console.error('\n请运行：npm run map')
  process.exit(1)
}

const docChanged = next !== original
const listChanged = uncoveredFileText !== previousUncovered
if (docChanged) writeFileSync(DOC, next)
if (listChanged) writeFileSync(UNCOVERED, uncoveredFileText)

console.log(
  `${docChanged || listChanged ? '已更新' : '无变化'}：A 段未覆盖 ${uncovered.length} / ${allSource.length}` +
  `${docChanged ? '（地图）' : ''}${listChanged ? '（未覆盖清单）' : ''}`,
)
if (agentsWarn) console.log(agentsWarn)
