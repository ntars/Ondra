/**
 * 从 `/icon.svg` 生成 `src/brand/mark.ts`。
 *
 * ## 为什么需要这一步
 *
 * `docs/UI-DESIGN.md` §4.5 定死了「品牌标志唯一真源是仓库根 `icon.svg`」。
 * 界面上要内联画这个标志（Rail 顶部的品牌位、首页中央），但 SVG 文件不能
 * 直接内联进 TSX——那样等于把图形数据抄了第二份，改图标时必然漏。
 *
 * 所以脚本把 `icon.svg` 里的几何抽出来，写成一份 TS 常量。界面上用的是
 * **真源的派生物**，不是第二真源。
 *
 * ## 输出形状
 *
 * `mark.ts` 只导出两个值：
 *
 * - `MARK_VIEW_BOX`：视窗坐标，`icon.svg` 是 `0 0 24 24`
 * - `MARK_PATHS`：底板矩形与图形路径，含各自的 transform
 *
 * 不含颜色。颜色由使用处通过 `currentColor` / CSS 令牌决定——图标文件里的
 * 白底黑鱼是「应用图标」的配色，不该被界面沿用（深色模式下会变成一个白方块）。
 *
 * ## 幂等
 *
 * 生成结果只依赖 `icon.svg` 的内容，重复运行结果一致。首行带
 * `AUTO-GENERATED` 标记，CI 可据此校验「真源改了但没重新生成」。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const svgPath = join(repoRoot, 'icon.svg')
const outPath = join(repoRoot, 'src', 'brand', 'mark.ts')

const svg = readFileSync(svgPath, 'utf8')

/** 取视窗。缺失时兜底 24 × 24 并告警——不静默产出错数据。 */
const viewBoxMatch = /viewBox="([^"]+)"/.exec(svg)
if (viewBoxMatch === null) {
  throw new Error('icon.svg 缺少 viewBox，无法派生品牌标志')
}
const viewBox = viewBoxMatch[1]

/** 底板：一个圆角矩形，决定标志的外轮廓。 */
const rectMatch = /<rect\b([^>]*)\/?>/.exec(svg)
if (rectMatch === null) {
  throw new Error('icon.svg 缺少底板矩形')
}
const attr = (name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(rectMatch[1])
  return m === null ? undefined : m[1]
}
const plate = {
  rx: attr('rx') ?? '0',
}

/** 图形路径。`icon.svg` 只有一条 path，带 transform 换算。 */
const pathMatch = /<path\b([^>]*)\/?>/.exec(svg)
if (pathMatch === null) {
  throw new Error('icon.svg 缺少图形路径')
}
const pathAttr = (name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(pathMatch[1])
  return m === null ? undefined : m[1]
}
const d = pathAttr('d')
if (d === undefined) {
  throw new Error('icon.svg 的 path 缺少 d 属性')
}
const transform = pathAttr('transform')
const evenOdd = pathAttr('fill-rule') === 'evenodd'

/**
 * 转义成单引号字符串。
 *
 * 路径里有 `"`，没有 `'`，所以用单引号包裹最省事；仍做一次兜底替换，
 * 避免将来图标换成含单引号的写法后生成出语法错误的 TS。
 */
const quote = (value) => `'${value.replace(/'/g, "\\'")}'`

const lines = []
lines.push('/* AUTO-GENERATED from /icon.svg — do not edit */')
lines.push('')
lines.push('/**')
lines.push(' * 品牌标志的图形数据。')
lines.push(' *')
lines.push(' * **不要手改这个文件。** 唯一真源是仓库根的 `icon.svg`，')
lines.push(' * 重新生成用 `node tools/gen-brand.mjs`（见 `docs/UI-DESIGN.md` §4.5）。')
lines.push(' *')
lines.push(' * 这里只有几何，没有颜色：')
lines.push(' * 图标文件里的白底黑鱼是「应用图标」的配色，界面不能用它——')
lines.push(' * 深色模式下会变成一个刺眼的白方块。界面用 `currentColor` 上色。')
lines.push(' */')
lines.push('')
lines.push(`/** 视窗坐标，与 \`icon.svg\` 的 \`viewBox\` 一致。 */`)
lines.push(`export const MARK_VIEW_BOX = ${quote(viewBox)}`)
lines.push('')
lines.push('/** 底板矩形的圆角半径（用户单位）。 */')
lines.push(`export const MARK_PLATE_RX = ${quote(plate.rx)}`)
lines.push('')
lines.push('/** 鲸鱼图形的路径数据。 */')
lines.push(`export const MARK_PATH_D = ${quote(d)}`)
lines.push('')
lines.push('/** 图形路径的坐标系变换。`null` 表示不需要变换。 */')
lines.push(`export const MARK_PATH_TRANSFORM: string | null = ${transform === undefined ? 'null' : quote(transform)}`)
lines.push('')
lines.push('/** 路径是否使用 evenodd 填充规则（决定镂空部位是否挖空）。 */')
lines.push(`export const MARK_PATH_EVEN_ODD = ${evenOdd ? 'true' : 'false'}`)
lines.push('')

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, lines.join('\n'), 'utf8')
console.log(`已生成 ${outPath}`)
