/**
 * 开发地图的共用底座：配置加载、源码遍历、文件用途提取、A 段条目解析与校验。
 *
 * 这里的所有逻辑都不认识具体项目——认识项目的是根目录的 `dev-map.config.json`。
 * 两个入口脚本（`gen-dev-map.mjs` / `affected.mjs`）都只从本模块取能力，
 * 这样「生成」和「反查」对配置的理解永远一致：一旦两边各写一套取法，
 * 就会出现「地图里读得到、affected 读不到」的静默失效。
 *
 * 配置怎么找：从脚本自身所在目录逐级向上找 `dev-map.config.json`，再退到当前工作目录向上找；
 * 两处都没有就**报错退出**（不退回默认值——空配置会生成一份空地图，还会写进错误的仓库）。
 * 所以脚本放在 `tools/`、`.github/scripts/` 还是根目录都能跑。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认值。配置里没写的键一律落在这里，避免每个项目都要抄一份完整配置。 */
export const DEFAULTS = {
  mapFile: 'docs/dev-map.md',
  partsDir: 'docs/.dev-map-parts',
  uncoveredFile: 'docs/.dev-map-uncovered.txt',
  decisionsFile: 'docs/decisions.md',
  skipDirs: [
    'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'output', 'target',
    'vendor', 'third_party', '__pycache__', '.venv', 'venv', '.tox', '.next', '.nuxt',
    'coverage', '.cache', 'Pods', '.gradle', '.idea', '.vscode', 'bin', 'obj',
  ],
  // 每种后缀用什么注释语法取「文件用途」。加新语言时通常只要在这里补一行。
  commentStyles: {
    '.ts': 'slash', '.tsx': 'slash', '.js': 'slash', '.jsx': 'slash',
    '.mjs': 'slash', '.cjs': 'slash', '.mts': 'slash', '.cts': 'slash',
    '.java': 'slash', '.kt': 'slash', '.kts': 'slash', '.scala': 'slash',
    '.go': 'slash', '.rs': 'slash', '.swift': 'slash', '.cs': 'slash',
    '.c': 'slash', '.h': 'slash', '.cpp': 'slash', '.cc': 'slash', '.hpp': 'slash',
    '.dart': 'slash', '.php': 'slash', '.groovy': 'slash',
    '.py': 'hash', '.rb': 'hash', '.sh': 'hash', '.bash': 'hash', '.zsh': 'hash',
    '.ps1': 'hash', '.yml': 'hash', '.yaml': 'hash', '.toml': 'hash',
    '.pl': 'hash', '.r': 'hash', '.jl': 'hash',
  },
  /**
   * 文件头注释之前允许出现的「开场语句」正则。用途注释不一定在最顶上——
   * 实测大量文件是先 import 再写文档注释，只跳到首个非空非注释行就会把它们
   * 全误报成「无文件头注释」。多行语句靠括号配平跨过去。
   */
  preamblePatterns: [
    '^#!',
    "^'use strict'\\s*;?$",
    '^"use strict"\\s*;?$',
    '^import\\b',
    '^from\\s+\\S+\\s+import\\b',
    '^(?:const|let|var)\\s+\\S[\\s\\S]*=\\s*require\\(',
    '^package\\s+[\\w.]+\\s*;?$',
    '^use\\s+[\\w:]+',
    '^#include\\b',
    '^#pragma\\b',
    '^__all__\\s*=',
  ],
  /** 路径能被 `affected` 抽出来的后缀。写成正则片段（`ya?ml` 这种也认）。 */
  pathExtensions: [
    'tsx?', 'jsx?', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte',
    'json', 'ya?ml', 'toml', 'ini', 'gradle', 'properties',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'php',
    'c', 'h', 'cc', 'cpp', 'hpp', 'dart', 'scala', 'pl', 'r',
    'md', 'mdx', 'sh', 'sql', 'xml', 'proto', 'tf',
  ],
  /** A 段条目的字段名。要换语言/换措辞时在这里改，两个脚本会同时跟着变。 */
  fields: {
    phrasing: '典型说法',
    locate: '改哪里',
    linked: '联动',
    guards: '守卫',
    deliberate: '刻意设计',
    pit: '坑',
  },
  /**
   * 建议跑守卫时套的命令模板，`{name}` = 文件名去后缀，`{ref}` = 条目里原样写的引用。
   * **默认留空**：模板不知道你的项目用什么跑测试（jest / pytest / go test / 自写脚本），
   * 编一个出来只会让 `affected` 打印一条指向不存在文件的命令。空值时 `affected` 只列
   * 守卫文件本身，并提示你到 `dev-map.config.json` 里把这条填上。
   */
  guardRun: '',
  /**
   * 宪法层 `AGENTS.md` 的体积上限（字节）。它每轮对话都要注入，越大越贵。
   * 超了只警告、不拦——有的项目确实需要更多，但应该是有意识的决定。
   */
  agentsMaxBytes: 8192,

  /** 守卫引用能带哪些后缀。 */
  guardFileExtensions: ['js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'kts', 'sh', 'bash'],
  /**
   * 什么样的文件名算「守卫」。默认覆盖三种最常见的命名：
   * `foo.test.ts` / `foo.spec.ts`（点号式）、`test-foo.js`（前缀式）、`foo_test.py`（后缀式）。
   * 换语言/换约定时改这一条正则即可。
   */
  guardNamePattern: '(^|[-_/])(test|check|spec)[-_]|\\.(test|spec)\\.',
  /** 每条条目最多列几个文件，超过就折叠——防止一条条目牵出半个仓库。 */
  maxEntriesPerFile: 6,
  maxWarnings: 10,
}

export function findRoot(start) {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'dev-map.config.json'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** 读配置。`scriptUrl` 传 `import.meta.url`，这样脚本被拷到哪都能找到项目根。 */
export function loadConfig(scriptUrl, overrideRoot) {
  const here = dirname(fileURLToPath(scriptUrl))
  const root = overrideRoot ? resolve(overrideRoot) : findRoot(here) || findRoot(process.cwd())
  const file = root ? join(root, 'dev-map.config.json') : ''
  if (!root || !existsSync(file)) {
    // 故意**不**退回默认值：没有配置时 `sourceSections` 是空数组，生成出来的是一份
    // 空地图 —— 而它会被写进「当前工作目录」那个仓库。实测踩过：在 A 仓跑 A 仓的模板、
    // 参数里带着 B 仓的路径，结果把 A 仓自己的 docs/dev-map.md 覆盖成了空地图。
    // 找不到配置是「你没跑 init」或「跑错目录了」，两种都该当场停下。
    console.error('找不到 dev-map.config.json。')
    console.error(`  脚本所在目录：${here}`)
    console.error(`  当前工作目录：${process.cwd()}`)
    console.error('  两者逐级向上都没有这份文件。')
    console.error('  先在项目根跑一次 init：node <模板目录>/init.mjs <项目根>')
    process.exit(1)
  }
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`dev-map.config.json 不是合法 JSON：${err.message}`)
    process.exit(1)
  }
  const config = {
    ...DEFAULTS,
    ...raw,
    commentStyles: { ...DEFAULTS.commentStyles, ...(raw.commentStyles || {}) },
    fields: { ...DEFAULTS.fields, ...(raw.fields || {}) },
    skipDirs: raw.skipDirs || DEFAULTS.skipDirs,
    preamblePatterns: raw.preamblePatterns || DEFAULTS.preamblePatterns,
    pathExtensions: raw.pathExtensions || DEFAULTS.pathExtensions,
    sourceSections: raw.sourceSections || [],
    guardSections: raw.guardSections || [],
  }
  return { root, config }
}

export const normalize = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '')
export const relOf = (root, f) => relative(root, f).split(sep).join('/')

export function walk(dir, exts, skipDirs, out) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (skipDirs.has(name)) continue
      walk(full, exts, skipDirs, out)
    } else if (exts.includes(extname(name))) {
      out.push(full)
    }
  }
}

/** 按 section 的描述收集文件：roots 递归 + extras 单点，再套 only / exclude。 */
export function collect(root, config, section) {
  const skip = new Set(config.skipDirs)
  const exts = section.exts && section.exts.length ? section.exts : Object.keys(config.commentStyles)
  const files = []
  for (const r of section.roots || []) walk(join(root, r), exts, skip, files)
  for (const extra of section.extras || []) {
    const full = join(root, extra)
    if (existsSync(full)) files.push(full)
  }
  const tail = (f) => f.split(sep).pop()
  const only = section.only ? new RegExp(section.only) : null
  const exclude = section.exclude ? new RegExp(section.exclude) : null
  return [...new Set(files)]
    .filter((f) => !only || only.test(tail(f)))
    .filter((f) => !exclude || !exclude.test(tail(f)))
    .sort()
}

/**
 * 项目文件索引 + 简写路径还原（`SideDrawer.tsx` → `app/src/components/SideDrawer.tsx`）。
 *
 * **生成器与 affected 必须共用这一套**：「哪些文件算源文件」「`SideDrawer.tsx` 指哪个文件」
 * 两边一旦各写一份，就会出现「地图说这个文件已覆盖、affected 却认不出它」的静默失效——
 * 本模块存在的理由就是这个，别再往任一侧抄一份。
 *
 * `index()` 把源文件与守卫文件合在一起（简写消歧要靠全量后缀匹配）；
 * 只想要「源文件」用 `collect()`，未覆盖清单统计的就是那一份。
 */
export function makeResolver(root, config) {
  const SRC_EXTS = Object.keys(config.commentStyles)
  const PREFIXES = domainPrefixes(config)
  const sections = () => [...(config.sourceSections || []), ...(config.guardSections || [])]
  let INDEX = null

  const index = () => {
    if (INDEX) return INDEX
    const out = []
    const skip = new Set(config.skipDirs)
    for (const section of sections()) {
      const exts = section.exts && section.exts.length ? section.exts : SRC_EXTS
      const files = []
      for (const r of section.roots || []) walk(join(root, r), exts, skip, files)
      for (const f of files) out.push(relative(root, f).split(sep).join('/'))
    }
    for (const section of sections()) {
      for (const extra of section.extras || []) {
        if (existsSync(join(root, extra))) out.push(normalize(extra))
      }
    }
    INDEX = [...new Set(out)]
    return INDEX
  }

  /** 简写消歧：先按领域前缀拼，再退回「唯一后缀匹配」；歧义或无匹配则丢弃（宁可漏也不误报）。 */
  const resolvePath = (raw, domain) => {
    if (raw.startsWith('../')) raw = raw.replace(/^(\.\.\/)+/, '')
    for (const prefix of PREFIXES[domain] || []) {
      const candidate = prefix + raw
      if (existsSync(join(root, candidate))) return candidate
    }
    if (existsSync(join(root, raw))) return raw
    const suffix = '/' + raw
    const matches = index().filter((f) => f.endsWith(suffix))
    return matches.length === 1 ? matches[0] : null
  }

  return { index, resolvePath }
}

const PREAMBLE_CACHE = new Map()
function preambleRes(patterns) {
  const key = patterns.join('\u0000')
  if (!PREAMBLE_CACHE.has(key)) {
    PREAMBLE_CACHE.set(key, patterns.map((p) => new RegExp(p)))
  }
  return PREAMBLE_CACHE.get(key)
}

/**
 * 从文件头部取一段用途说明。
 *
 * 顺序是：跳过开场语句（shebang / use strict / import 段 / package 行 …）→ 收集首个注释块。
 * 只要开场段之后不是注释（例如紧跟一个 `export type` 再写函数级 JSDoc），就如实报
 * 「没有文件头注释」——函数级注释不是文件用途，宁可缺也不要错。
 */
export function purposeOf(file, config) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return '(读取失败)' }
  const style = config.commentStyles[extname(file)] || 'slash'
  const lines = text.split('\n')
  const res = preambleRes(config.preamblePatterns)

  let i = 0
  let depth = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (depth === 0) {
      if (t === '') { i++; continue }
      if (isCommentStart(t, style)) break
      if (!res.some((re) => re.test(t))) break
    }
    depth += (t.match(/[([{]/g) || []).length - (t.match(/[)\]}]/g) || []).length
    if (depth < 0) depth = 0
    i++
  }

  const collected = []
  let inBlock = false
  for (; i < lines.length && collected.length < 6; i++) {
    const t = lines[i].trim()
    if (!inBlock && style === 'slash' && (t.startsWith('/**') || t.startsWith('/*'))) {
      inBlock = true
      const inner = t.replace(/^\/\*\*?/, '').replace(/\*\/$/, '').trim()
      if (inner) collected.push(inner)
      if (t.endsWith('*/') && t !== '/**' && t !== '/*') break
      continue
    }
    if (!inBlock && style === 'hash' && t.startsWith('#')) {
      collected.push(t.replace(/^#+\s?/, ''))
      continue
    }
    if (inBlock) {
      if (t.startsWith('*/')) break
      collected.push(t.replace(/^\*\s?/, ''))
      continue
    }
    if (style === 'slash' && t.startsWith('//')) {
      collected.push(t.replace(/^\/\/[/!]?\s?/, ''))
      continue
    }
    break
  }

  const joined = collected.join(' ').replace(/\s+/g, ' ').trim()
  if (!joined) return '(无文件头注释)'
  const m = joined.match(/^(.{0,110}?[。；！？;.]|.{0,110})/)
  return (m ? m[1] : joined).trim()
}

function isCommentStart(t, style) {
  if (style === 'hash') return t.startsWith('#')
  return t.startsWith('//') || t.startsWith('/*')
}

/** 带 `g` 的正则不能跨调用复用：lastIndex 会累积。每次都新建。 */
export function pathRe(config) {
  const alts = config.pathExtensions.join('|')
  return new RegExp(
    // 路径段必须允许 Unicode 字母/数字（\p{L}\p{N}）：顶层目录叫「小程序/」这类非 ASCII 名时，
    // 旧的 [A-Za-z0-9_./@-] 连一个字符都匹配不上——条目里路径写得再全，机器也当它没有。
    `\`([\\p{L}\\p{N}_./@-]+\\.(?:${alts}))(?::\\d+(?:[-,]\\d+)*)?(?=[\\s\`]|$)`,
    'gu',
  )
}

export function fieldRe(config) {
  // 字段名后面允许带一段括注（真实存在 `- **改哪里**（一次全列，漏一处就 404）：`），
  // 早先要求 `**：` 紧邻，于是这种写法整条字段都读不到——条目看着完整，机器却当它没有。
  //
  // **只认配置里声明的字段名**。条目正文常拿 `- **外壳 vs 代的分工**：` 这种加粗小标题
  // 把「改哪里」分成几段；早先任何 `- **X**：` 都算字段边界，于是小标题一冒出来，
  // 它后面列的文件就全被划到字段外——条目里白纸黑字写着，affected 却认不出。
  const names = Object.values(config.fields || DEFAULTS.fields)
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`^- \\*\\*(${alt})\\*\\*[^：:]*[：:]`)
}

/** 取一条条目的某个字段（`- **字段**：` 起，到下个字段或条目尾），支持多行。 */
export function fieldOf(body, field, fRe) {
  const out = []
  let capturing = false
  for (const line of body.split('\n')) {
    const m = line.match(fRe)
    if (m) {
      capturing = m[1].trim() === field
      if (capturing) out.push(line.replace(fRe, ''))
      continue
    }
    if (capturing) out.push(line)
  }
  return out.join('\n')
}

/**
 * 条目头。**标题要作为捕获组取出来**——早先用 `\S` 只吃掉标题的第一个字符再整段
 * `replace` 掉，于是每条条目的标题都少一个字（「出站请求」变成「站请求」）。
 */
export function entryHeadRe() {
  return /^###\s+(A(\d+)-(\d+))\.\s*(.+?)\s*$/
}

/** 一个文件名算不算守卫。 */
export function isGuardName(name, config) {
  return new RegExp(config.guardNamePattern).test(name)
}

/**
 * 从一段文字里抽出守卫引用。两种写法都认：**带后缀的路径**与**不带后缀的裸名**。
 * 只按名字判定，不按目录 —— 因为「测试放哪」各项目差别太大，而命名约定相对稳定。
 */
export function guardNamesIn(text, config) {
  const exts = config.guardFileExtensions.join('|')
  const withExt = new RegExp(`(?:^|[\\s\`(])([\\p{L}\\p{N}_./@-]+\\.(?:${exts}))`, 'gu')
  const bare = /(?:^|[\s`(])((?:test|check|spec)[-_][A-Za-z0-9_-]+)(?=[\s`),.，。]|$)/g
  const out = []
  for (const m of text.matchAll(withExt)) {
    if (isGuardName(m[1].split('/').pop(), config)) out.push(m[1])
  }
  for (const m of text.matchAll(bare)) out.push(m[1])
  return [...new Set(out)]
}

export function listParts(root, config) {
  const dir = join(root, config.partsDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
}

/** 领域号取自文件名前缀（`02-app-data.md` → `A2`）。文件名里没有 `A`，别从内容里找。 */
export function domainOf(name) {
  const m = name.match(/^0*(\d+)-/)
  return m ? 'A' + m[1] : 'A0'
}

/**
 * 解析 A 段全部条目。两个脚本共用这一份，避免「生成器能读、affected 读不到」。
 * `resolvePath` 用来把条目里的简写路径还原成仓库相对路径；不传就原样保留。
 */
export function parseParts(root, config, resolvePath) {
  const fRe = fieldRe(config)
  const pRe = pathRe(config)
  const entries = []
  for (const name of listParts(root, config)) {
    const domain = domainOf(name)
    let current = null
    for (const line of readFileSync(join(root, config.partsDir, name), 'utf8').split('\n')) {
      const m = line.match(entryHeadRe())
      if (m) {
        current = { id: m[1], title: m[4], domain, part: name, body: [] }
        entries.push(current)
        continue
      }
      if (current) current.body.push(line)
    }
  }
  const pathsIn = (text) => {
    const found = [...text.matchAll(pRe)].map((m) => m[1])
    const mapped = found.map((p) => (resolvePath ? resolvePath(p) : null) || normalize(p))
    return [...new Set(mapped)]
  }
  for (const entry of entries) {
    const body = entry.body.join('\n')
    entry.paths = pathsIn(fieldOf(body, config.fields.locate, fRe))
    entry.linked = pathsIn(fieldOf(body, config.fields.linked, fRe))
    entry.guards = guardNamesIn(fieldOf(body, config.fields.guards, fRe), config)
    entry.pit = fieldOf(body, config.fields.pit, fRe).trim()
    entry.deliberate = fieldOf(body, config.fields.deliberate, fRe).trim()
  }
  return entries
}

/**
 * A 段的机械校验。最容易腐化的不是内容而是编号：追加条目时会跳号、重号，
 * 或把 A2 的条目写进 A3 的文件里。编号一乱，条目号就不再能当坐标用，
 * 而地图的价值恰恰建立在「条目号可引用」上。
 *
 * 还有一条更隐蔽的：条目看着有「改哪里」，但里面一个路径都抽不出来——
 * 这条条目对 `affected` 等于不存在，而未覆盖清单用的是子串判断，照样是绿的。
 *
 * 除错误外还报两类**警告**（只打印、绝不进 `errors`，所以不会让 `map:check` 变红）：
 *   1. 「改哪里」里有脱离文件名的裸行号（`` `:83` ``）——机器能从 `路径:行号` 读出归属，
 *      裸行号没有归属，读了也不知道该给哪个文件。
 *   2. 「改哪里」里写了一个磁盘上不存在的完整仓库相对路径——路径漂移/写错，机器按字面
 *      找不到文件；但条目结构没问题，属于内容可疑而非机械错误，因此只警告。
 */
export function validateParts(root, config) {
  const errors = []
  const warnings = []
  const fRe = fieldRe(config)
  const pRe = pathRe(config)
  const headRe = entryHeadRe()
  const locate = config.fields.locate
  // 非全局探针：绝不能拿 pRe（带 g）直接 `.test()`——它会推进 lastIndex，而
  // `matchAll(pRe)` 会继承该 lastIndex，后面的条目就从半路开始抽路径、误报「抽不出路径」。
  const pProbe = new RegExp(pRe.source, 'u')
  // 占位符 / 通配 / 变量 / 家目录：`<域>.ts`、`{name}.json`、`*.ts`、`$HOME/x.ts`、`~/x.ts`
  const PLACEHOLDER_RE = /[<>{}*$~?]/
  // 标题里写明已退役的条目只留作历史，路径不再要求真实存在。
  const RETIRED_RE = /已(?:整条|全部|完全)?(?:下线|删除|移除|废弃)\s*\*{0,2}\s*(?:[）)】]|$)/
  for (const name of listParts(root, config)) {
    const domain = domainOf(name)
    if (domain === 'A0') {
      errors.push(`${name}：文件名不是 \`NN-*.md\`，无法判定领域`)
      continue
    }
    const nums = []
    let current = null
    const flush = () => {
      if (!current) return
      const where = fieldOf(current.body.join('\n'), locate, fRe)
      if (!where.trim()) {
        errors.push(`${name}：条目 ${current.id} 没有「${locate}」字段`)
      } else if (![...where.matchAll(pRe)].length) {
        errors.push(`${name}：条目 ${current.id} 的「${locate}」里抽不出任何文件路径`)
      }
      // 警告 1：脱离文件名的裸行号。`路径:83` 是完整 token，只有 `:83` 单独出现才算裸。
      // **「脱离」按整个「改哪里」字段判定**：先写一条完整路径、后继行只写 `:51` 的续行写法
      // 很常见，那是「行号挂在前面那个文件上」，机器顺着同一字段读得到归属；只有整个字段里
      // 此前一个路径都没出现、`:` 开头的 token 才真的无处依附。
      const isPathToken = (t) => pProbe.test('`' + t + '`')
      let seenPath = false
      for (const m of where.matchAll(/`([^`\n]*)`/g)) {
        if (isPathToken(m[1])) { seenPath = true; continue }
        if (!seenPath && /^:\d+(?:-\d+)?$/.test(m[1])) {
          warnings.push(
            `条目 ${current.id} 的「${locate}」里有脱离文件名的裸行号：\`${m[1]}\`。` +
            '行号必须跟在完整仓库相对路径后面（如 `app/src/lib/publish.ts:83`），否则机器读不到。',
          )
        }
      }
      // 警告 2：路径在磁盘上不存在。标题说已退役就整条跳过，其余先过滤噪声再 existsSync。
      if (!RETIRED_RE.test(current.title)) {
        for (const p of new Set([...where.matchAll(pRe)].map((m) => m[1]))) {
          if (PLACEHOLDER_RE.test(p)) continue
          if (p.startsWith('/')) continue
          // 「含 ..」只在真的**跨出仓库根**时才跳过。写成「含 .. 就跳过」会把
          // `config/agent-presets/../cordis.mobile-host.yml` 这类真正写错的路径一并滤掉——
          // 它 resolve 之后仍落在仓库内，恰恰是最该报出来的一种。
          if (relative(root, resolve(root, p)).startsWith('..')) continue
          if (!/\.[A-Za-z0-9]+$/.test(p)) continue
          // 只判**完整仓库相对路径**：`x.ts` 这类简写与领域内相对路径要交给 `affected` 的
          // 解析器消歧，按字面 resolve 到仓库根上必然不存在 —— 不设这道闸会冒出一堆假警报。
          // 判据：第一段在仓库根上存在。
          const first = p.split('/')[0]
          if (!p.includes('/') || !existsSync(join(root, first))) continue
          if (!existsSync(resolve(root, p))) {
            warnings.push(`条目 ${current.id} 的「${locate}」里的路径在磁盘上不存在：${p}`)
          }
        }
      }
    }
    for (const line of readFileSync(join(root, config.partsDir, name), 'utf8').split('\n')) {
      const m = line.match(headRe)
      if (m) {
        flush()
        if (m[2] !== domain.slice(1)) errors.push(`${name}：条目 ${m[1]} 的领域与文件名不符（本文件应为 A${domain.slice(1)}-xx）`)
        nums.push(Number(m[3]))
        current = { id: m[1], title: m[4], body: [] }
        continue
      }
      if (/^#{1,3}\s*A\d+-\d+/.test(line)) errors.push(`${name}：条目行格式不对 → ${line.trim()}`)
      if (current) current.body.push(line)
    }
    flush()
    if (!nums.length) {
      errors.push(`${name}：一条条目都没有`)
      continue
    }
    for (const n of [...new Set(nums)]) {
      if (nums.filter((x) => x === n).length > 1) errors.push(`${name}：条目编号 A${domain.slice(1)}-${n} 重复`)
    }
    const uniq = [...new Set(nums)].sort((a, b) => a - b)
    for (let i = 0; i < uniq.length; i++) {
      if (uniq[i] !== i + 1) {
        errors.push(
          `${name}：编号不连续——期望 A${domain.slice(1)}-${String(i + 1).padStart(2, '0')}，` +
          `实际 A${domain.slice(1)}-${String(uniq[i]).padStart(2, '0')}`,
        )
        break
      }
    }
  }
  // 警告只打印、不进 errors：`map:check` 绝不能因为这两类内容问题变红。
  if (warnings.length) {
    console.warn(`A 段条目有 ${warnings.length} 条警告（不影响退出码）：`)
    for (const w of warnings) console.warn('  ' + w)
  }
  return errors
}

/** 按 section 的 `domain` 推出「简写路径的默认前缀」，供 affected 消歧。 */
export function domainPrefixes(config) {
  const out = {}
  for (const s of [...(config.sourceSections || []), ...(config.guardSections || [])]) {
    if (!s.domain) continue
    const prefixes = [...(s.roots || []), ...(s.extras || [])].map((p) => (p.endsWith('/') ? p : p + '/'))
    out[s.domain] = [...new Set([...(out[s.domain] || []), ...prefixes])]
  }
  return out
}

export function replaceBlock(doc, name, content) {
  const begin = `<!-- BEGIN:${name} -->`
  const end = `<!-- END:${name} -->`
  const a = doc.indexOf(begin)
  const b = doc.indexOf(end)
  if (a < 0 || b < 0 || b < a) throw new Error(`地图缺少区块标记 ${name}（应有 ${begin} … ${end}）`)
  return doc.slice(0, a + begin.length) + '\n' + content.trim() + '\n' + doc.slice(b)
}
