#!/usr/bin/env node
/**
 * 插件接线校验：把「挂了没接」「要了没人给」「子集对不上」三件事变成一条命令。
 *
 * ## 为什么需要它
 *
 * `cordis/` 里 133 个插件全部靠软取用（`ctx.get()`）互相拿能力，几乎不写
 * 插件级 `inject`。好处是上游缺席时不会阻断加载；代价是**没有任何编译期或
 * 加载期机制能发现「供出方根本不存在」或「供出了但没人读」**——这两件事
 * 只会在某天上线后表现为「功能静默不生效」，日志里只有一行「就绪」。
 *
 * 另一件事是结构对位副本：`IdentityLike` / `ClockLike` 这类接口在几十个插件里
 * 各写一份（刻意不 import 对方源码，见 master-plan §18.5）。副本一旦多要了
 * 供出方没有的字段，TypeScript 也拦不住——因为消费者拿到的是 `undefined as T`
 * 的断言。本脚本按「消费方副本必须是供出方接口的子集」逐成员核对。
 *
 * ## 三项检查
 *
 * 1. **挂载完整性**：`cordis/` 目录集 与 组合包 `cordis.patch.yml` 的入口 id 集
 *    必须双向相等。少一条 = 插件永远不加载；多一条 = 宿主启动时报「目标不存在」。
 * 2. **服务可达性**：供出集合 与 取用集合求差。无人供出的键分两类——
 *    宿主内置键（`tools` / `llm` / `webServer` …）属正常外部依赖；
 *    其余就是**真缺口**。无人取用的键只做清单输出（现状是 73 个，接不接是产品决定）。
 * 3. **结构子集对位**：4 对「供出方接口 → 消费方副本」逐成员核对，含一层嵌套对象。
 *
 * 用法：
 *   node tools/verify-plugin-wiring.mjs           # 检查；1、3 不过就以退出码 1 结束
 *   node tools/verify-plugin-wiring.mjs --strict  # 第 2 项也参与判定（会让 CI 变红，慎用）
 *   node tools/verify-plugin-wiring.mjs --verbose # 连「无人取用」的完整清单一起打印
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORDIS = join(ROOT, 'cordis')
const BUNDLE_PATCH = join(ROOT, 'desktop', 'packages', 'bundle', 'ondra-core', 'cordis.patch.yml')

/** 宿主（desktop）提供、不属于 cordis/ 的服务键。 */
const HOST_KEYS = new Set([
  'webServer', 'credentials', 'browserUse', 'llm', 'pluginMarket', 'tools', 'subprocess', 'systemPrompt',
])

/** 结构对位：供出方接口所在的插件 → 接口名 → 消费方副本的接口名。 */
const STRUCTURAL_PAIRS = [
  { plugin: 'ondra-clock', provider: 'ClockService', consumer: 'ClockLike' },
  { plugin: 'ondra-identity', provider: 'IdentityService', consumer: 'IdentityLike' },
  { plugin: 'ondra-config-schema', provider: 'ConfigSchemaService', consumer: 'ConfigSchemaLike' },
  { plugin: 'ondra-path-layout', provider: 'PathLayoutService', consumer: 'PathLike' },
]

const strict = process.argv.includes('--strict')
const verbose = process.argv.includes('--verbose')
const ledger = process.argv.includes('--ledger')
const problems = []

/** 逐字符剥掉注释，保留字符串与换行，使后续按行定位仍然准确。 */
function stripComments(src) {
  let out = ''
  let state = 'code'
  let quote = ''
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 1; continue }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 1; continue }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; out += c; continue }
      out += c
      continue
    }
    if (state === 'line') { out += c === '\n' ? '\n' : ' '; if (c === '\n') state = 'code'; continue }
    if (state === 'block') {
      if (c === '*' && n === '/') { out += '  '; i += 1; state = 'code'; continue }
      out += c === '\n' ? '\n' : ' '
      continue
    }
    if (c === '\\') { out += c + (n ?? ''); i += 1; continue }
    if (c === quote) { state = 'code'; out += c; continue }
    out += c
  }
  return out
}

/** 递归收集 .ts 文件。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * 解析一个 TS 文本里的全部 interface：名字 → 顶层成员 → 成员类型原文。
 * 顶层判定靠花括号深度，因此 `register(decl: { a: string })` 的内层字段不会被误当成成员。
 */
function parseInterfaces(text) {
  const result = new Map()
  const header = /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)[^{]*\{/g
  let m
  while ((m = header.exec(text)) !== null) {
    const name = m[1]
    let depth = 1
    let i = header.lastIndex
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') depth -= 1
      i += 1
    }
    const body = text.slice(start, i - 1)
    result.set(name, parseMembers(body))
  }
  return result
}

/** 解析一段接口体，返回顶层成员：名字 → { kind, type }。 */
function parseMembers(body) {
  const members = new Map()
  let depth = 0
  let buf = ''
  const flush = () => {
    const raw = buf.trim()
    buf = ''
    if (raw === '' || raw.startsWith('[')) return
    const cleaned = raw.replace(/^readonly\s+/, '')
    const mm = cleaned.match(/^([A-Za-z_$][\w$]*)\s*[?]?\s*(\([^)]*\))?\s*:?\s*([\s\S]*)$/)
    if (!mm) return
    const [, name, params, rest] = mm
    members.set(name, { kind: params ? 'method' : 'property', type: (rest ?? '').trim() })
  }
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    // 只统计 () [] {} —— 尖括号会让 `=>` 里的 `>` 把深度带负，多行方法参数就会被拆成假成员。
    if (c === '{' || c === '(' || c === '[') depth += 1
    else if (c === '}' || c === ')' || c === ']') depth -= 1
    if ((c === ';' || c === '\n') && depth <= 0) { flush(); continue }
    buf += c
  }
  flush()
  return members
}

/** 读一个插件 src 下全部源码，合成一份已剥注释的文本。 */
function readPluginSource(plugin) {
  const files = walk(join(CORDIS, plugin, 'src'))
  const parts = files.map((f) => ({ file: f, text: stripComments(readFileSync(f, 'utf8')) }))
  return { files: parts, all: parts.map((p) => p.text).join('\n') }
}

/** 解析常量：`const X = 'literal'`，用于把 `ctx.provide(KEY, …)` 还原成字面量键。 */
function constMap(parts) {
  const map = new Map()
  for (const { text } of parts) {
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*'([^']+)'/g)) {
      map.set(m[1], m[2])
    }
  }
  return map
}

// ---------- 收集数据 ----------

// 一个目录算不算插件：有 package.json 且 src/ 存在。空目录（例如只剩壳的
// 素材目录）不算——否则「磁盘 134 / 清单 133」会天天报假缺口。
const pluginDirs = readdirSync(CORDIS)
  .filter((d) => !d.startsWith('.') && statSync(join(CORDIS, d)).isDirectory())
  .filter((d) => existsSync(join(CORDIS, d, 'package.json')) && existsSync(join(CORDIS, d, 'src')))
  .sort()

const pluginData = pluginDirs.map((dir) => {
  const src = readPluginSource(dir)
  const consts = constMap(src.files)
  const resolve = (raw) => {
    if (raw.startsWith("'")) return raw.slice(1, -1)
    return consts.get(raw) ?? raw
  }
  const provides = [...src.all.matchAll(/ctx\s*\.\s*provide\s*\(\s*([A-Za-z_$][\w$]*|'[^']+')\s*,/g)].map((m) => resolve(m[1]))
  const gets = [...src.all.matchAll(/ctx\s*\.\s*get\s*\(\s*([A-Za-z_$][\w$]*|'[^']+')\s*[,)]/g)].map((m) => resolve(m[1]))
  const injects = [...src.all.matchAll(/ctx\s*\.\s*inject\s*\(\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
  return { dir, provides: [...new Set(provides)], uses: [...new Set([...gets, ...injects])], src }
})

const providerOf = new Map()
for (const p of pluginData) for (const key of p.provides) providerOf.set(key, p.dir)

const consumerOf = new Map()
for (const p of pluginData) for (const key of p.uses) {
  if (!consumerOf.has(key)) consumerOf.set(key, new Set())
  consumerOf.get(key).add(p.dir)
}

// ---------- 检查 1：挂载完整性 ----------

function checkMount() {
  const patch = readFileSync(BUNDLE_PATCH, 'utf8')
  const mounted = new Set([...patch.matchAll(/- id: (ondra-[a-z0-9-]+)/g)].map((m) => m[1]))
  const onDisk = new Set(pluginDirs)
  const notMounted = [...onDisk].filter((d) => !mounted.has(d))
  const notOnDisk = [...mounted].filter((d) => !onDisk.has(d))
  console.log(`\n[1] 挂载完整性：磁盘 ${onDisk.size} 个，清单 ${mounted.size} 条`)
  if (notMounted.length === 0 && notOnDisk.length === 0) {
    console.log('    通过：两侧完全一致')
    return true
  }
  for (const d of notMounted) { console.log(`    ✗ 磁盘有但未挂载：${d}`); problems.push(`未挂载 ${d}`) }
  for (const d of notOnDisk) { console.log(`    ✗ 挂载了但磁盘没有：${d}`); problems.push(`幽灵条目 ${d}`) }
  return false
}

/**
 * 「无人取用」不等于「没人用」：一部分插件本身就是入口，被外部世界驱动，
 * 在进程内找不到调用方是**设计如此**。这里按源码证据判定，不靠名字猜。
 */
const SELF_DRIVEN_SIGNALS = [
  { reason: '自启动定时器', re: /setInterval\s*\(/ },
  { reason: '自启动入口', re: /\.start\s*\(\s*\)/ },
  { reason: 'HTTP 监听', re: /listen\s*\(|createServer\s*\(|\.serve\s*\(/ },
  { reason: '长轮询', re: /getUpdates|pollOnce|longPoll/ },
  { reason: '工具面（模型调用）', re: /ctx\.get\('tools'\)|inject:\s*\[\s*'tools'/ },
  { reason: 'WebSocket 服务', re: /WebSocket|wsServer|upgrade/ },
  { reason: '子进程托管', re: /spawn\s*\(|ChildProcess/ },
]

// ---------- 检查 2：服务可达性 ----------

function checkWiring() {
  const missing = []
  const orphans = []
  for (const [key, users] of consumerOf) {
    if (!providerOf.has(key) && !HOST_KEYS.has(key)) missing.push({ key, users: [...users] })
  }
  for (const [key, owner] of providerOf) {
    if (!consumerOf.has(key)) orphans.push({ key, owner })
  }
  const hostUsed = [...consumerOf.keys()].filter((k) => HOST_KEYS.has(k))

  console.log(`\n[2] 服务可达性：供出 ${providerOf.size} 个，取用 ${consumerOf.size} 个，宿主键 ${hostUsed.length} 个在用`)
  console.log(`    无人供出：${missing.length} 个${missing.length === 0 ? '（通过）' : ''}`)
  for (const { key, users } of missing) {
    console.log(`    ✗ ${key}  ←  ${users.join(', ')}`)
    problems.push(`服务键无人供出：${key}`)
  }
  console.log(`    无人取用：${orphans.length} 个`)
  const entryPoints = []
  const pending = []
  for (const o of orphans) {
    const text = (pluginData.find((p) => p.dir === o.owner)?.src.all) ?? ''
    const hit = SELF_DRIVEN_SIGNALS.find((s) => s.re.test(text))
    if (hit) entryPoints.push({ ...o, reason: hit.reason })
    else pending.push(o)
  }
  console.log(`      ├─ 入口型（外部驱动，设计如此）：${entryPoints.length} 个`)
  console.log(`      └─ 待接（进程内无调用方）：${pending.length} 个${pending.length === 0 ? '，通过' : ''}`)
  if (verbose || strict) {
    for (const e of entryPoints) console.log(`      · ${e.key}  ← ${e.reason}`)
    for (const p of pending) console.log(`      ○ ${p.key}  ← 待接`)
  } else if (pending.length > 0) {
    console.log(`      待接举例：${pending.slice(0, 6).map((o) => o.key).join(', ')} …（--verbose 看全部）`)
  }
  if (strict) for (const o of pending) problems.push(`服务键无人取用：${o.key}`)
  return missing.length === 0
}

// ---------- 检查 3：结构子集对位 ----------

/** 判断消费方成员是否都能在供出方找到；嵌套对象递归一层。 */
function diffMembers(consumerName, consumerMembers, providerMembers, providerIfaces, trail, out) {
  for (const [name, spec] of consumerMembers) {
    const target = providerMembers.get(name)
    if (!target) {
      out.push(`${consumerName}.${trail}${name}（供出方没有这个成员）`)
      continue
    }
    if (spec.kind === 'method' || target.kind === 'method') continue
    const inner = spec.type.trim()
    const inlineMatch = inner.match(/^\{([\s\S]*)\}$/)
    let nested = null
    if (inlineMatch) nested = parseMembers(inlineMatch[1])
    else {
      const named = inner.match(/^([A-Za-z_$][\w$]*)$/)
      if (named && providerIfaces.has(named[1])) nested = providerIfaces.get(named[1])
    }
    if (!nested) continue
    const targetInline = target.type.trim().match(/^\{([\s\S]*)\}$/)
    const targetNamed = target.type.trim().match(/^([A-Za-z_$][\w$]*)$/)
    const targetMembers = targetInline
      ? parseMembers(targetInline[1])
      : (targetNamed && providerIfaces.get(targetNamed[1])) || null
    if (!targetMembers) continue
    diffMembers(consumerName, nested, targetMembers, providerIfaces, `${trail}${name}.`, out)
  }
}

function checkStructural() {
  let failed = 0
  console.log('\n[3] 结构子集对位')
  for (const pair of STRUCTURAL_PAIRS) {
    const providerSrc = readPluginSource(pair.plugin).all
    const providerIfaces = parseInterfaces(providerSrc)
    const providerMembers = providerIfaces.get(pair.provider)
    if (!providerMembers) {
      console.log(`    ✗ 找不到供出方接口 ${pair.provider}（${pair.plugin}）`)
      problems.push(`供出方接口缺失：${pair.provider}`)
      failed += 1
      continue
    }
    let copies = 0
    let bad = 0
    for (const p of pluginData) {
      if (p.dir === pair.plugin) continue
      const ifaces = parseInterfaces(p.src.all)
      const consumerMembers = ifaces.get(pair.consumer)
      if (!consumerMembers) continue
      copies += 1
      const out = []
      diffMembers(pair.consumer, consumerMembers, providerMembers, providerIfaces, '', out)
      if (out.length > 0) {
        bad += 1
        console.log(`    ✗ ${p.dir} 的 ${pair.consumer} 越界：${out.join('；')}`)
        for (const o of out) problems.push(`${p.dir} 结构越界：${o}`)
      }
    }
    const status = bad === 0 ? '通过' : `${bad} 处越界`
    console.log(`    ${pair.provider} → ${pair.consumer}：${copies} 份副本，${status}`)
    if (bad > 0) failed += 1
  }
  return failed === 0
}

// ---------- 台账模式 ----------

if (ledger) {
  const rows = pluginData
    .map((p) => {
      const key = p.provides[0] ?? '(无)'
      const consumers = consumerOf.get(key)?.size ?? 0
      const text = p.src.all
      const hit = SELF_DRIVEN_SIGNALS.find((s) => s.re.test(text))
      const category = consumers > 0 ? '已接' : (hit ? '入口型' : '待接')
      const note = consumers > 0
        ? `${consumers} 个插件在读`
        : (hit ? hit.reason : '进程内无调用方')
      return { key, consumers, category, note, uses: p.uses.length }
    })
    .sort((a, b) => a.category.localeCompare(b.category) || b.consumers - a.consumers || a.key.localeCompare(b.key))

  console.log('| 服务键 | 消费方 | 分类 | 说明 | 自身取用 |')
  console.log('|---|---:|---|---|---:|')
  for (const r of rows) console.log(`| \`${r.key}\` | ${r.consumers} | ${r.category} | ${r.note} | ${r.uses} |`)
  const count = (c) => rows.filter((r) => r.category === c).length
  console.log('')
  console.log(`合计 ${rows.length}：已接 ${count('已接')} ｜ 入口型 ${count('入口型')} ｜ 待接 ${count('待接')}`)
  process.exit(0)
}

// ---------- 主流程 ----------

const okMount = checkMount()
const okWiring = checkWiring()
const okStruct = checkStructural()

console.log('\n────────────────────────────')
console.log(`挂载完整性 ${okMount ? '通过' : '失败'} ｜ 服务可达性 ${okWiring ? '通过' : '失败'} ｜ 结构对位 ${okStruct ? '通过' : '失败'}`)
if (problems.length === 0) {
  console.log('结论：三项全过')
  process.exit(0)
}
console.log(`结论：${problems.length} 个问题（${relative(ROOT, fileURLToPath(import.meta.url))}）`)
process.exit(1)
