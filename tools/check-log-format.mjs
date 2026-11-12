/**
 * 核对「日志格式串的占位符都得被吃掉」，防止精度占位符静默失效。
 *
 * ## 这条为什么要单独一份检查
 *
 * Cordis 的 logger 只认 `%s` / `%d` / `%i` / `%o` / `%j` / `%%`，**不认精度**。
 * 于是 `'置信度 %.2f'` 会这样落地：
 *
 * ```
 * debug ondra.emotion.project 情感投影：平静，排序 800（尾部），置信度 %.2f 0.9
 * ```
 *
 * `%.2f` 原样留在行里，实参 `0.9` 被追加到行尾——**没有报错、没有告警**，
 * 只是那一行从此读不出人话。全仓 10 处犯过这个毛病，分布在 9 个插件里
 * （对话编排 / 情感投影 / 输出过滤 / 情绪弥散 / 关系结算 ×2 / 六态表达 /
 * 器官宿主 / 缺口池 / 人格演化），全部是「日志难读」而不是「功能坏了」，
 * 所以一直没人报。
 *
 * 修法不是让 logger 支持精度（那要改 `@ntars/cordis` 这个外部依赖），
 * 而是在调用点把值先 `toFixed(n)` 再交给 `%s`。
 *
 * ## 判据
 *
 * 源码（`src/` 与 `cordis-host/src/`，不含 `lib/` 产物）里不得出现
 * `%.<数字>f` 形式的精度占位符。这一条是**纯静态**的：它不依赖任何运行时，
 * 因此不会像「跑一遍看有没有报错」那样漏掉静默降级。
 *
 * ## 反向验证
 *
 * 把 `ondra-emotion-project/src/service.ts` 里那句改回 `%.2f` → 立刻红 1 条。
 * 改回 `toFixed(2)` + `%s` → 转绿。
 *
 * 用法：
 *   node tools/check-log-format.mjs
 *
 * 退出码：全部通过为 0，发现精度占位符为 1。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

/** 要扫的源码根（`lib/` 是产物，扫它等于扫同一段代码两遍）。 */
const SOURCE_ROOTS = [join(ROOT, 'cordis-host', 'plugins'), join(ROOT, 'cordis-host', 'src')]

/** 精度占位符：`%.2f` / `%.0f` / `%.1f` 之类。logger 不支持，会被原样留在行里。 */
const PRECISION_PLACEHOLDER = /%\.[0-9]+f/

/** 递归收集 `.ts` 源码（跳过 `lib` / `node_modules` / `dist`）。 */
function collect(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'lib' || entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, out)
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
    // 目录本身可能不是目录（软链），`statSync` 报错时跳过。
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    out.push(full)
  }
  return out
}

const files = []
for (const root of SOURCE_ROOTS) collect(root, files)

/** 命中清单：`文件:行号 内容`。 */
const offenders = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (!PRECISION_PLACEHOLDER.test(text)) continue
  text.split('\n').forEach((line, index) => {
    if (PRECISION_PLACEHOLDER.test(line)) {
      offenders.push(`${relative(ROOT, file)}:${index + 1}  ${line.trim()}`)
    }
  })
}

let failed = 0

/** 断言并计数。 */
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `（${detail}）`}`)
  }
}

console.log('=== A 段 · 日志格式串里没有精度占位符 ===')
check(`扫了 ${files.length} 个源文件`, files.length > 0, '一个文件都没扫到，说明路径写错了')
check('无 `%.Nf` 精度占位符', offenders.length === 0, offenders.join(' / '))

if (failed > 0) {
  console.log('')
  console.log('原因：Cordis logger 只认 %s/%d/%i/%o/%j/%%，精度占位符会被原样留在行里，')
  console.log('      实参则被追加到行尾（例：`置信度 %.2f 0.9`）。改法：值先 toFixed(n)，串里用 %s。')
  console.log('')
  console.log(`合计：${failed} 项未通过`)
  process.exit(1)
}

console.log('')
console.log('合计：全部通过')
