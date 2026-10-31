#!/usr/bin/env node
/**
 * Ondra 品牌改造脚本
 *
 * 三条红线：
 *   1. 只改「用户看得见的品牌层」，不动模块标识符 —— @deepseek-ai/* 包名一个都不碰，
 *      那是 Node 的模块解析契约，改了依赖链立刻崩。
 *   2. 不用字面量匹配产品名 —— 命令通道会改写这个词。一律用正则 DeepSeek\s+Harness。
 *   3. 只替换字符串字面量内部，且能识别注释与模板字符串插值 —— 标识符、键名、代码不动。
 *
 * 用法：
 *   node rebrand.mjs            # 演练，只报告不落盘
 *   node rebrand.mjs --apply    # 真正写入
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = import.meta.dirname
const PRODUCT = 'Ondra'
const CMD = 'ondra'
const VERSION_FROM = '0.2.2-alpha.2'
const VERSION_TO = '1.0.0'

// ═══════════════════════════════════════════════════════════
// 一、精确规则（作用于代码文件，模式足够独特，可全文替换）
// ═══════════════════════════════════════════════════════════
const EXACT_RULES = [
  {
    file: 'apps/desktop/scripts/electron-builder-config.mjs',
    label: '协议注册：名称 + scheme',
    from: /protocols: \[\{ name: 'DeepSeek\s+Harness', schemes: \['dsh'\] \}\]/g,
    to: `protocols: [{ name: '${PRODUCT}', schemes: ['${CMD}'] }]`,
    expect: 1,
  },
  {
    file: 'apps/desktop/scripts/electron-builder-config.mjs',
    label: 'productName（.app 名 + 进程名）',
    from: /productName: 'DeepSeek\s+Harness'/g,
    to: `productName: '${PRODUCT}'`,
    expect: 1,
  },
  {
    file: 'apps/desktop/scripts/electron-builder-config.mjs',
    label: '产物文件名前缀',
    from: /artifactName: `deepseek-harness-/g,
    to: 'artifactName: `ondra-',
    expect: 1,
  },
  {
    file: 'apps/desktop/scripts/electron-builder-config.mjs',
    label: '麦克风权限说明',
    from: /'DeepSeek\s+Harness (uses your microphone[^']*)'/g,
    to: `'${PRODUCT} $1'`,
    expect: 1,
  },
  {
    file: 'apps/desktop/src/main.ts',
    label: 'applicationName（Dock/通知名）',
    from: /applicationName: 'DeepSeek\s+Harness'/g,
    to: `applicationName: '${PRODUCT}'`,
    expect: 1,
  },
  {
    file: 'apps/desktop/src/main.ts',
    label: '默认协议客户端 scheme',
    from: /setAsDefaultProtocolClient\('dsh'\)/g,
    to: `setAsDefaultProtocolClient('${CMD}')`,
    expect: 1,
  },
  {
    file: 'packages/util/home-paths/src/index.ts',
    label: '数据目录 ~/.dsh → ~/.ondra',
    from: /DSH_HOME_DIR_NAME = '\.dsh'/g,
    to: `DSH_HOME_DIR_NAME = '.${CMD}'`,
    expect: 1,
  },
]

// ═══════════════════════════════════════════════════════════
// 二、字符串内替换规则（按顺序，前一条先吃掉更长的模式）
// ═══════════════════════════════════════════════════════════
const STRING_RULES = [
  { label: '产品全名 → Ondra', from: /DeepSeek\s+Harness/g, to: PRODUCT },
  { label: '裸 Harness → Ondra', from: /\bHarness\b/g, to: PRODUCT },
  { label: '缩写 DSH → Ondra', from: /\bDSH\b/g, to: PRODUCT },
  { label: '命令名 dsh → ondra', from: /\bdsh\b/g, to: CMD },
]

const SKIP_DIRS = new Set(['node_modules', '.git', '.desktop-build', '.tmp', 'dist', 'lib', 'coverage', 'tests'])

function walk(dir, filter, out = []) {
  let names
  try { names = readdirSync(dir) } catch { return out }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue
    const full = join(dir, n)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, filter, out)
    else if (filter(full)) out.push(full)
  }
  return out
}

// ═══════════════════════════════════════════════════════════
// 三、字符串字面量扫描器：识别注释 / 单双引号 / 模板插值
//    只有字面量内部的文本会被改写，代码与键名原样保留
// ═══════════════════════════════════════════════════════════
function mapStringLiterals(text, fn) {
  let out = ''
  let i = 0
  const n = text.length
  // 栈：'normal' | 'template'（模板内 ${} 里是代码，回到 normal 语义）
  const stack = [{ mode: 'normal' }]

  const state = () => stack[stack.length - 1]

  while (i < n) {
    const st = state()
    const ch = text[i]

    if (st.mode === 'normal' || st.mode === 'expr') {
      // 注释
      if (ch === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i)
        const stop = end < 0 ? n : end
        out += text.slice(i, stop)
        i = stop
        continue
      }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        const stop = end < 0 ? n : end + 2
        out += text.slice(i, stop)
        i = stop
        continue
      }
      // 字符串开始
      if (ch === "'" || ch === '"' || ch === '`') {
        stack.push({ mode: 'str', quote: ch, buf: '' })
        out += ch
        i++
        continue
      }
      // 插值结束
      if (st.mode === 'expr' && ch === '}') {
        stack.pop()
        out += ch
        i++
        continue
      }
      // 插值内嵌套花括号
      if (st.mode === 'expr' && ch === '{') {
        st.depth = (st.depth || 0) + 1
      }
      if (st.mode === 'expr' && ch === '}' && st.depth > 0) {
        st.depth--
      }
      out += ch
      i++
      continue
    }

    // 字符串内部
    if (ch === '\\') {
      st.buf += text.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === st.quote) {
      out += fn(st.buf)
      out += ch
      stack.pop()
      i++
      continue
    }
    if (st.quote === '`' && ch === '$' && text[i + 1] === '{') {
      out += fn(st.buf)
      st.buf = ''
      out += '${'
      stack.push({ mode: 'expr', depth: 0 })
      i += 2
      continue
    }
    st.buf += ch
    i++
  }
  return out
}

/**
 * 自然语言守卫：判断一段字符串字面量是不是「给人看的文案」。
 * 排除对象——模块标识符、包名、路径、i18n 键名、CSS 类名。
 * 这些一旦被改，构建会崩或文案查不到，属于绝对不能碰的层。
 */
function isNaturalLanguage(s) {
  if (s.length === 0) return false
  if (s.includes('@deepseek-ai/')) return false // 包名 / 模块标识符
  if (/^\s*[./@]/.test(s)) return false // 路径、相对引用、装饰器
  if (/^[a-z0-9._\-/:]+$/i.test(s)) return false // 纯标识符形态：无空格无大写词
  if (/^[A-Z0-9_]+$/.test(s)) return false // 全大写下划线：常量名
  // 含空格、中文、日文假名、标点，才认为是文案
  return /[\s\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(s)
}

function applyStringRules(text) {
  return mapStringLiterals(text, (s) => {
    if (!isNaturalLanguage(s)) return s
    let v = s
    for (const r of STRING_RULES) v = v.replace(new RegExp(r.from.source, r.from.flags), r.to)
    return v
  })
}

// ═══════════════════════════════════════════════════════════
// 四、执行
// ═══════════════════════════════════════════════════════════
const doWrite = process.argv.includes('--apply')
console.log(doWrite ? '══════ Ondra 品牌改造（写入模式）══════\n' : '══════ Ondra 品牌改造（演练模式，不落盘）══════\n')

let changed = 0

// 4.1 精确规则
for (const rule of EXACT_RULES) {  const full = join(ROOT, rule.file)
  const before = readFileSync(full, 'utf8')
  const re = new RegExp(rule.from.source, rule.from.flags) // 每次新建，避免 lastIndex 污染
  const hits = (before.match(re) || []).length
  if (hits === 0) {
    console.log(`✗ 零命中 ${rule.label.padEnd(26)} ${rule.file}`)
    continue
  }
  const flag = rule.expect && hits !== rule.expect ? ` △期望${rule.expect}` : ''
  console.log(`✓ ${String(hits).padStart(2)} 处 ${rule.label.padEnd(26)} ${rule.file}${flag}`)
  if (doWrite) writeFileSync(full, before.replace(new RegExp(re.source, re.flags), rule.to), 'utf8')
  changed++
}

// 4.1b Electron 用户目录隔离
// package.json 缺 productName 时，Electron 会拿包名当用户目录名，
// 于是与官方 dsh 共用同一个 userData 和单实例锁 —— 启动会被已有实例"吞掉"。
const desktopPkg = join(ROOT, 'apps/desktop/package.json')
const pkgText = readFileSync(desktopPkg, 'utf8')
if (!pkgText.includes('"productName"')) {
  const next = pkgText.replace(/"name": "@deepseek-ai\/dsh-desktop",/,
    `"name": "@deepseek-ai/dsh-desktop",\n  "productName": "${PRODUCT}",`)
  if (next !== pkgText) {
    console.log(`✓ +1 处 productName（Electron 用户目录隔离） apps/desktop/package.json`)
    if (doWrite) writeFileSync(desktopPkg, next, 'utf8')
  }
} else {
  console.log('✓ productName 已存在，跳过')
}

// 4.2 文案文件（字符串内替换）
console.log('\n── UI 文案（仅替换字符串内部）──')
const localeFiles = [
  ...walk(join(ROOT, 'apps'), (f) => /\.tsx?$/.test(f) && /locale/i.test(f)),
  ...walk(join(ROOT, 'packages'), (f) => /\.tsx?$/.test(f) && /locale/i.test(f)),
]
const preview = process.argv.includes('--preview')
let localeTotal = 0
const samples = []
for (const f of localeFiles) {
  const before = readFileSync(f, 'utf8')
  const after = applyStringRules(before)
  if (after === before) continue
  console.log(`✓ 有变更 ${relative(ROOT, f).padEnd(62)}`)
  if (preview && samples.length < 80) {
    const b = before.split('\n')
    const a = after.split('\n')
    for (let i = 0; i < b.length && samples.length < 80; i++) {
      if (b[i] === a[i]) continue
      samples.push({ file: relative(ROOT, f), line: i + 1, from: b[i].trim().slice(0, 150), to: a[i].trim().slice(0, 150) })
    }
  }
  if (doWrite) writeFileSync(f, after, 'utf8')
  localeTotal++
}
if (preview) {
  console.log('\n── 改动抽样（逐行对比）──')
  for (const s of samples) {
    console.log(`\n${s.file}:${s.line}`)
    console.log(`  − ${s.from}`)
    console.log(`  + ${s.to}`)
  }
}
console.log(`\n文案文件变更：${localeTotal} 个`)

// 4.3 脚本层：打包/冒烟脚本里把 .app / .exe 名写死的地方
// 这些不是文案，是路径拼接，必须跟着 productName 一起换，否则打包最后一步找不到产物
console.log('\n── 打包脚本硬编码路径 ──')
const scriptFiles = walk(join(ROOT, 'apps/desktop/scripts'), (f) => /\.(ts|mjs)$/.test(f))
const SCRIPT_RULES = [
  { from: /'DeepSeek\s+Harness\.app'/g, to: `'${PRODUCT}.app'`, label: '.app 路径（单引号）' },
  { from: /"DeepSeek\s+Harness\.app"/g, to: `"${PRODUCT}.app"`, label: '.app 路径（双引号）' },
  { from: /'DeepSeek\s+Harness\.exe'/g, to: `'${PRODUCT}.exe'`, label: '.exe 路径' },
  { from: /DeepSeek\s+Harness\.app/g, to: `${PRODUCT}.app`, label: '.app（模板字符串）' },
  { from: /DeepSeek\s+Harness\.exe/g, to: `${PRODUCT}.exe`, label: '.exe（模板字符串）' },
  { from: /CFBundleURLName: 'DeepSeek\s+Harness'/g, to: `CFBundleURLName: '${PRODUCT}'`, label: '开发态 URL 名' },
  { from: /CFBundleURLSchemes: \['dsh'\]/g, to: `CFBundleURLSchemes: ['${CMD}']`, label: '开发态 scheme' },
  // macOS 包内可执行文件名没有扩展名，必须单独抓，否则冒烟测试会 spawn 不到进程
  { from: /'MacOS', 'DeepSeek\s+Harness'/g, to: `'MacOS', '${PRODUCT}'`, label: '包内可执行文件名' },
  // 产物名前缀：DMG / ZIP / EXE 和上传清单都用它拼名字
  { from: /deepseek-harness-/g, to: `${CMD}-`, label: '产物名前缀' },
  // 本地打包会强制覆写 Bundle ID，必须直接改默认值（环境变量传不进去）
  { from: /'com\.deepseek\.harness'/g, to: `'com.ntars.${CMD}'`, label: 'Bundle ID 默认值' },
  { from: /com\.deepseek\.harness/g, to: `com.ntars.${CMD}`, label: 'Bundle ID（无限定引号）' },
]
let scriptHits = 0
for (const f of scriptFiles) {
  const before = readFileSync(f, 'utf8')
  let after = before
  for (const r of SCRIPT_RULES) after = after.replace(new RegExp(r.from.source, r.from.flags), r.to)
  if (after === before) continue
  const n = before.split('\n').filter((l, i) => l !== after.split('\n')[i]).length
  console.log(`✓ ${String(n).padStart(2)} 行 ${relative(ROOT, f)}`)
  if (doWrite) writeFileSync(f, after, 'utf8')
  scriptHits += n
}
console.log(`打包脚本改动：${scriptHits} 行`)

// 4.4 版本号
console.log('\n── 版本号 ──')
const pkgFiles = walk(ROOT, (f) => f.endsWith('package.json'))
let vHits = 0
for (const f of pkgFiles) {
  const text = readFileSync(f, 'utf8')
  const re = new RegExp(`"version": "${VERSION_FROM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
  if (!re.test(text)) continue
  vHits++
  if (doWrite) writeFileSync(f, text.replace(new RegExp(re.source, 'g'), `"version": "${VERSION_TO}"`), 'utf8')
}
console.log(`版本号 ${VERSION_FROM} → ${VERSION_TO}：${vHits} 个 package.json`)

console.log(`\n合计：精确规则 ${changed}/${EXACT_RULES.length} 条命中，文案文件 ${localeTotal} 个，版本 ${vHits} 个`)
if (!doWrite) console.log('（演练结束，未修改任何文件。确认无误后加 --apply）')
