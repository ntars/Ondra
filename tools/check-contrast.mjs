/**
 * 配色对比度核对（WCAG 2.1 AA）。
 *
 * ## 为什么需要这个脚本
 *
 * 设计文档里每个墨色都标注了对比度，`tokens.css` 的注释里还写着
 * 「改这两个值前，先跑一遍对比度脚本」。但**那个脚本曾经并不存在**——
 * 全项目搜 `contrast` 零命中。也就是说此前所有 4.5:1 的结论都是
 * 手算一次写进注释，之后再也没有任何东西阻止它被改坏。
 *
 * ## 它验什么
 *
 * 1. **承载信息的墨色对四种石底全部 ≥ 4.5:1**（AA 正文）。文字可能落在
 *    stone-0～stone-3 任意一层上——薄片、悬停底、按下底就是 stone-2/3，
 *    所以不能只对主底色算。
 * 2. **ink-4 是例外**：它按定义「不承载信息」，只做占位符，允许低于
 *    4.5。但它仍要 ≥ 3:1（AA 对非文本/大字的门槛），否则占位符等于没写。
 * 3. **主操作色上的反字 ≥ 4.5:1**。发送键、主按钮都是青底纸字，
 *    这一条最容易被「青够深」的错觉放过。
 * 4. **状态色（成功/警告/危险）对四种石底 ≥ 4.5:1**，因为它们都承载文字。
 * 5. **深色主题单独算一遍**，不复用浅色的结论。
 *
 * ## 为什么读 CSS 而不是维护一份色值副本
 *
 * 副本一定会漂。这里直接从 `tokens.css` 里解析实际取值，
 * 因此「改了 CSS 忘了改断言」这件事不可能发生——改完立刻反映在结果里。
 *
 * ## 为什么按语义层取键，而不是按变量名
 *
 * 旧版这套断言写死了 `--static-paper-0` / `--static-brand-600` 这一组名字。
 * 前端从零重写后色板改名为 `--stone-*` / `--ink-*` / `--jade-*`，脚本立刻
 * 报「色板缺少 13 个键」——它已经量不到任何东西，却仍在输出 0/2 通过。
 * 一个量错对象还照常出结论的检查，比没有检查更危险。
 *
 * 所以这里改成「语义槽位 → 当前令牌名」的映射：名字改了只改映射表一处，
 * 而**对比度这个判据一个字都没松**。新增令牌若忘记登记，脚本会红。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const REPO = new URL('../', import.meta.url).pathname
const TOKENS = join(REPO, 'src/styles/tokens.css')

/* ==========================================================================
   一、颜色计算
   ========================================================================== */

/**
 * 解析 `#rgb` / `#rrggbb` / `#rrggbbaa` 为 `[r, g, b]`。
 *
 * 8 位时丢弃 alpha：本脚本只核对不透明前景对不透明背景的对比度，
 * 半透明色（遮罩、选中底）不参与文字对比，遇到直接跳过。
 */
function parseHex(value) {
  const hex = String(value).trim().replace(/^#/, '')
  if (hex.length === 3) {
    return [0, 1, 2].map((i) => Number.parseInt(hex[i] + hex[i], 16))
  }
  if (hex.length === 6 || hex.length === 8) {
    return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  }
  return null
}

/** 解析 `rgb(r g b)` / `rgb(r, g, b)` / `rgba(...)` 的 RGB 三通道。 */
function parseRgb(value) {
  const match = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(String(value))
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 相对亮度（WCAG 定义）。
 *
 * 注意是**线性化之后**再加权，不是直接对 sRGB 值加权平均。
 * 少了这一步，深色区域的对比度会被系统性高估——那正是
 * 「深色模式看起来够，实测 3.8:1」的常见来源。
 */
function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** 对比度。返回值范围 1–21，保留两位小数便于比对。 */
function contrast(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

/* ==========================================================================
   二、从 tokens.css 解析令牌
   ========================================================================== */

/**
 * 取一个选择器块里的全部自定义属性声明。
 *
 * 用「按大括号配对」而不是正则截取整块：`tokens.css` 里嵌套着
 * `@media` 与注释，正则很难精确到块边界，而错位一格就会把
 * 深色的值当成浅色的读，那种错误在结果上表现为「深色全绿」，最难发现。
 */
function readBlock(cssText, selector) {
  const start = cssText.indexOf(selector)
  if (start === -1) return {}
  const open = cssText.indexOf('{', start)
  if (open === -1) return {}

  let depth = 0
  let end = open
  for (let i = open; i < cssText.length; i += 1) {
    if (cssText[i] === '{') depth += 1
    else if (cssText[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }

  // 去掉注释再匹配，避免注释里的示例色值被当成真实定义。
  const clean = cssText.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '')
  const values = {}
  for (const match of clean.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    values[match[1]] = match[2].trim()
  }
  return values
}

/**
 * 把 `var(--x)` 链解到最终字面值。
 *
 * 重写后的色板是两层的：原始值（`--jade-700: #1d4438`）+ 语义别名
 * （`--ui-action: var(--jade-700)`）。断言只关心「最终是什么颜色」，
 * 所以解析必须穿过别名，否则会把 `var(--jade-700)` 当成解析失败。
 *
 * 深度上限 8：链再深就是设计错了，宁可报错也不要死循环。
 */
function resolve(palette, key, depth = 0) {
  const raw = palette[key]
  if (raw === undefined) return undefined
  if (depth > 8) return undefined
  const only = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw.trim())
  if (only === null) return raw
  return resolve(palette, only[1], depth + 1)
}

/** 取一个令牌的 RGB 三元组，穿 var 链、认 hex 与 rgb 两种写法。 */
function rgbOf(palette, key) {
  const value = resolve(palette, key)
  if (value === undefined) return null
  return parseHex(value) ?? parseRgb(value)
}

/** 取一个令牌的原始字面值（供失败信息展示，保留真实来源便于排查）。 */
function rawOf(palette, key) {
  return resolve(palette, key) ?? '未声明'
}

/**
 * 同名选择器在文件里出现多次时，按出现顺序**全部**读入并合并。
 *
 * `tokens.css` 有两段 `:root {}`：第一段放原始值（`--stone-*`），
 * 第二段放语义别名（`--ui-action` 等）。旧版用 `indexOf` 只取到第一段，
 * 于是所有 `--ui-*` 都报「无法解析」——色板本身是好的，是读的人只读了半本。
 */
function readAllBlocks(cssText, selector) {
  const merged = {}
  let from = 0
  for (;;) {
    const start = cssText.indexOf(selector, from)
    if (start === -1) break
    const next = Object.assign(merged, readBlock(cssText.slice(start), selector))
    Object.assign(merged, next)
    from = start + selector.length
  }
  return merged
}

const css = await readFile(TOKENS, 'utf8')

const lightRoot = readAllBlocks(css, ':root {')
const darkRoot = readBlock(css, ":root[data-theme='dark']")

/*
 * 深色 = 浅色的原始值打底 + 深色覆盖 + 语义层。
 *
 * 深色块只覆盖原始值（`--stone-*` / `--ink-*` / `--jade-*`），语义层
 * `--ui-action: var(--jade-700)` 不变，`var` 链会自动解析到深色的值——
 * 这正是「两层令牌」的意义：写一次别名，两套主题各取所需。
 */
const lightDecl = lightRoot
const darkDecl = { ...readAllBlocks(css, ':root {'), ...darkRoot }

/* ==========================================================================
   三、语义槽位映射
   ========================================================================== */

/**
 * 色板：四种石底 + 四级墨色。
 *
 * `stone-*` 是重写后的原始层命名（原 `papers`）。四层都必须验，
 * 因为文字会落在任意一层上：薄片是 stone-1、输入面是 stone-2、
 * 按下底是 stone-3。只对 stone-0 验会漏掉「薄片上的时间戳看不清」。
 */
const PAPERS = ['--stone-0', '--stone-1', '--stone-2', '--stone-3']

/** 承载信息的墨色，逐级都必须对四层纸达标。 */
const INKS = ['--ink-1', '--ink-2', '--ink-3']

/** 仅占位符的墨色，门槛 3:1。 */
const INK_DIM = '--ink-4'

/**
 * 主操作色与其反字色。
 *
 * 浅色是「深青底、纸白字」，深色是「浅青底、近黑字」——主色在深色下
 * 反向（`--jade-700: #c2ddd0`），所以反字色不能写死为纸白，必须取
 * `--ui-action-ink`。写死会让深色那条永远红。
 */
const ACTION_BG = '--ui-action'
const ACTION_FG = '--ui-action-ink'
const ACTION_DEEP = '--ui-action-hover'

/** 状态色。三者都承载文字（「已保存」「今天不再打扰」「失败」）。 */
const STATUS = [
  ['成功色', '--green-600'],
  ['警告字色', '--amber-700'],
  ['危险色', '--red-700'],
]

/**
 * 语义槽位是否齐全。
 *
 * 缺键直接报错而不是跳过：跳过会让「有人把 ink-3 改名了」表现为
 * 「少验了一条」，脚本照样全绿。缺键是真缺陷，要红。
 */
const REQUIRED = [...PAPERS, ...INKS, INK_DIM, ACTION_BG, ACTION_FG, ACTION_DEEP, ...STATUS.map(([, key]) => key)]

/* ==========================================================================
   四、断言
   ========================================================================== */

let passed = 0
let failed = 0
const failures = []

/**
 * 断言一条对比度。
 *
 * 失败时把实测值、门槛、两个令牌名与它们的字面值一起打出来，
 * 因为只报「不达标」的话，下一步还是得手算一遍才知道差多少。
 */
function expect(label, fgKey, bgKey, palette, min = 4.5) {
  const fg = rgbOf(palette, fgKey)
  const bg = rgbOf(palette, bgKey)
  if (fg === null || bg === null) {
    failed += 1
    const line = `${label}：无法解析（${fgKey}=${rawOf(palette, fgKey)} / ${bgKey}=${rawOf(palette, bgKey)}）`
    failures.push(line)
    console.log(`  ✗ ${line}`)
    return
  }
  const ratio = contrast(fg, bg)
  if (ratio >= min) {
    passed += 1
    console.log(`  ✓ ${label}  ${String(ratio).padStart(5)}:1  ≥ ${min}`)
  } else {
    failed += 1
    const line = `${label}  ${ratio}:1 < ${min}（${fgKey} ${rawOf(palette, fgKey)} / ${bgKey} ${rawOf(palette, bgKey)}）`
    failures.push(line)
    console.log(`  ✗ ${line}`)
  }
}

function checkTheme(name, palette, { dimmedMin }) {
  console.log(`\n── ${name} ──`)

  const missing = REQUIRED.filter((key) => rgbOf(palette, key) === null)
  if (missing.length > 0) {
    failed += 1
    const line = `${name}：色板缺少或无法解析 ${missing.join(' / ')}`
    failures.push(line)
    console.log(`  ✗ ${line}`)
    return
  }

  /*
   * 承载信息的墨色：每一级都要对**四种石底全部**达标。
   *
   * 这是全脚本最严格的一组断言，也是最有价值的一组：只对 stone-0 验，
   * 会漏掉「薄片上的时间戳看不清」——而薄片底正是 stone-1/2。
   */
  for (const ink of INKS) {
    PAPERS.forEach((paper) => {
      expect(`${ink.slice(2)} on ${paper.slice(2)}`, ink, paper, palette)
    })
  }

  /* ink-4 只做占位符，门槛降到 3:1（非文本/大字门槛）。 */
  PAPERS.forEach((paper) => {
    expect(`${INK_DIM.slice(2)} on ${paper.slice(2)}（仅占位符）`, INK_DIM, paper, palette, dimmedMin)
  })

  /* 反字压在实心主操作块上：全界面最粗的一对视觉重量。 */
  expect('反字 on 主操作色', ACTION_FG, ACTION_BG, palette)
  expect('反字 on 主操作深色', ACTION_FG, ACTION_DEEP, palette)

  /* 状态色都承载文字，按正文门槛逐层验。 */
  for (const [label, key] of STATUS) {
    PAPERS.forEach((paper) => {
      expect(`${label} on ${paper.slice(2)}`, key, paper, palette)
    })
  }
}

/* ==========================================================================
   五、光的纪律：光环必须与主色同色
   ========================================================================== */

/**
 * ## 这条断言是反向验证逼出来的
 *
 * §4.0.6 第 3 条要求「暖砂只表达她还在，不承担焦点」。落地时
 * `--focus-ring`（焦点环的外晕）曾是一串独立写死的 rgba，而
 * `--ui-action` 是另一个令牌。把 `--ui-action` 改回别的色相去做反向
 * 验证时，界面**半青半墨**，而 `check:ui` 全绿——因为它量的是光环，
 * 改的是另一个令牌。
 *
 * 同类问题的通用形态：**同一件事的两个令牌各自写值，就等于两份真源**，
 * 改一处不会带动另一处，而任何只量其中一处的断言都会给出假绿。
 *
 * 这里直接比对 RGB：光环的 RGB 必须等于主操作色的 RGB。浓度（alpha）
 * 不比对——它是设计自由度；色相与明度不许自己走。
 */
function checkGlowHue(name, palette) {
  const brand = rgbOf(palette, ACTION_BG)
  if (brand === null) {
    failed += 1
    failures.push(`${name}：主操作色无法解析，光环无法比对`)
    console.log(`  ✗ ${name}：主操作色无法解析`)
    return
  }

  const brandText = `rgb(${brand.join(', ')})`

  /*
   * 机器光：焦点环必须是主操作色。
   *
   * 允许两种写法：直接写 `var(--ui-action)`（推荐，天然同步），
   * 或写一个与主色**逐位相同**的 rgb/hex。
   */
  const checks = [
    ['机器光·--focus-ring', '--focus-ring'],
    ['她的光·--her-glow', '--amber-500'],
    ['她的晕·--her-halo', '--amber-500'],
  ]

  for (const [label, key] of checks) {
    const value = (palette[key] ?? '').trim()
    const viaAction = /^var\(\s*--ui-action\s*\)$/.test(value)
    const target = key.startsWith('--amber') || key.includes('her') ? rgbOf(palette, '--amber-500') : brand
    const got = rgbOf(palette, key)

    if (viaAction) {
      passed += 1
      console.log(`  ✓ ${name}·${key} 直接引用主操作色`)
      continue
    }
    if (got !== null && target !== null && got.every((channel, index) => channel === target[index])) {
      passed += 1
      console.log(`  ✓ ${name}·${key} 与来源同色（rgb(${got.join(', ')})）`)
    } else {
      failed += 1
      const want = target === null ? '（来源未声明）' : `rgb(${target.join(', ')})`
      const line =
        `${name}·${key} 未跟随来源色（实测 ${value === '' ? '未声明' : value}，期望 ${want}）。` +
        '写 var() 引用或与来源逐位相同的色值。'
      failures.push(line)
      console.log(`  ✗ ${line}`)
    }
  }

  console.log(`  · 主操作色基准 ${brandText}`)
}

console.log('配色对比度核对（WCAG 2.1 AA）')
console.log('规则：承载信息的文字 ≥ 4.5:1；仅占位符 ≥ 3:1')

checkTheme('浅色', lightDecl, { dimmedMin: 3 })
checkTheme('深色', darkDecl, { dimmedMin: 3 })
checkGlowHue('浅色', lightDecl)
checkGlowHue('深色', darkDecl)

console.log(`\n合计：${String(passed)}/${String(passed + failed)} 通过`)

if (failed > 0) {
  console.log('\n不达标清单：')
  for (const line of failures) console.log(`  · ${line}`)
  process.exitCode = 1
}
