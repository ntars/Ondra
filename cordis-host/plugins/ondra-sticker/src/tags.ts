/**
 * 标签推导与同义归一 —— **「文件名即标签」这一条的全部实现**。
 *
 * ## 剥到什么程度才算标签
 *
 * 用户导出的图长这样：`开心_01.png`、`开心 (2).png`、`smile@2x.png`、
 * `开心-03.webp`。若把整个文件名当标签，同一个"开心"会散成三个标签，
 * 面板里出现三个只有一张图的组——用户会以为导入坏了。
 *
 * 所以规则是**只剥"看起来像序号/缩放后缀"的尾巴**：
 *
 * | 文件名 | 标签 | 说明 |
 * |---|---|---|
 * | `开心.png` | 开心 | 没有尾巴 |
 * | `开心_01.png` | 开心 | `_数字` |
 * | `开心 (2).png` | 开心 | 括号数字 |
 * | `开心-3.png` | 开心 | `-数字` |
 * | `smile@2x.png` | smile | 缩放后缀 |
 * | `开心_01_02.png` | 开心 | 连续剥两次 |
 * | `开心2.png` | 开心2 | **没有分隔符 → 不猜** |
 * | `v1.2.png` | v1.2 | **点不算分隔符 → 不猜** |
 *
 * 最后两条是刻意的：`开心2` 也许是「第二版开心」，也许就是名字里带 2。
 * 猜错的代价是两张图被并成一组（还算轻），而猜「`v1.2` 的 `.2` 是序号」
 * 会把版本号砍掉，症状是"标签莫名其妙少了一截"。
 *
 * ## 同义归一：把六态接到贴纸包上
 *
 * O-052 给的是六态英文名（`joyful`），而贴纸包的文件名是人写的
 * （`开心.png`）。这两套词永远对不上，除非有人做一次映射。
 * 映射放在**包的主人**这里（而不是让调用方自己翻译）：
 * 谁的标签谁归一，改一次到处生效，`registerAlias()` 还能现场加。
 */

import { FORMATS } from './types.js'
import type { StickerFormatName } from './types.js'

/** 缩放后缀：`@2x` / `@3x` / ` 2x`。导出图常见。 */
const SCALE_SUFFIX = /(?:@|\s)\d(?:\.\d)?x$/i

/** 括号序号：`(2)` / `（２）`。 */
const BRACKET_INDEX = /[（(]\s*\d{1,3}\s*[)）]$/

/** 分隔符序号：`_1` / `-3` / ` 01` / `#2`。**点不在其中**（见文件头）。 */
const SEP_INDEX = /[ _\-—–~#]+\d{1,3}$/

/** 取序号的模式（与上面两条同口径，但要带捕获组）。 */
const INDEX_CAPTURE = /(?:[ _\-—–~#]+|[（(])\s*(\d{1,3})\s*[)）]?$/

/** 标签最大长度。过长的"标签"多半是没改过的原始文件名。 */
export const TAG_MAX = 24

/**
 * 去扩展名。
 * @param file 文件名（可带路径）。
 */
export function baseOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  // `dot <= 0` 覆盖「没有扩展名」与「.png 这种隐藏文件」两种情况。
  return dot <= 0 ? name : name.slice(0, dot)
}

/**
 * 判格式。
 * @param file 文件名。
 */
export function formatOf(file: string): StickerFormatName | undefined {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return FORMATS[name.slice(dot + 1).toLowerCase()]
}

/**
 * 取序号（同标签内的排序依据）。
 * @param file 文件名。
 */
export function orderOf(file: string): number {
  const hit = INDEX_CAPTURE.exec(baseOf(file))
  return hit === null ? 0 : Number(hit[1])
}

/**
 * 剥序号与缩放后缀，得到"原始标签"（还没过同义表）。
 * @param file 文件名。
 */
export function rawTagOf(file: string): string {
  let tag = baseOf(file)
  const stripped = tag.replace(SCALE_SUFFIX, '').trim()
  if (stripped !== '') tag = stripped

  // 最多剥三次：`开心_01_02` 需要两次。设上限是为了防"全是数字的文件名"被剥成空串。
  for (let i = 0; i < 3; i += 1) {
    const next = tag.replace(BRACKET_INDEX, '').replace(SEP_INDEX, '').trim()
    if (next === tag || next === '') break
    tag = next
  }
  if (tag === '') return baseOf(file)
  return tag.length > TAG_MAX ? tag.slice(0, TAG_MAX) : tag
}

/** 归一用的键：去空白 + 小写（只影响 ASCII，中文无大小写）。 */
export function tagKey(tag: string): string {
  return tag.replace(/\s+/g, '').toLowerCase()
}

/**
 * 同义表的**种子**（可被 `registerAlias()` 增补，不可删）。
 *
 * 每一行左边是"别人可能写的"，右边是"本插件认的"。
 * 六态英文名也在里面——这是 O-052 的标记能直接喂给本插件的唯一原因。
 */
export const ALIAS_SEEDS: readonly (readonly [string, string])[] = Object.freeze([
  // 雀跃
  Object.freeze(['joyful', '开心'] as const),
  Object.freeze(['happy', '开心'] as const),
  Object.freeze(['高兴', '开心'] as const),
  Object.freeze(['喜悦', '开心'] as const),
  Object.freeze(['好开心', '开心'] as const),
  // 软和
  Object.freeze(['soft', '温柔'] as const),
  Object.freeze(['软和', '温柔'] as const),
  Object.freeze(['摸摸', '温柔'] as const),
  // 平静
  Object.freeze(['calm', '平静'] as const),
  Object.freeze(['平常', '平静'] as const),
  // 蔫
  Object.freeze(['wilted', '难过'] as const),
  Object.freeze(['sad', '难过'] as const),
  Object.freeze(['蔫', '难过'] as const),
  Object.freeze(['委屈', '难过'] as const),
  Object.freeze(['流泪', '难过'] as const),
  // 炸毛
  Object.freeze(['bristled', '生气'] as const),
  Object.freeze(['angry', '生气'] as const),
  Object.freeze(['炸毛', '生气'] as const),
  Object.freeze(['愤怒', '生气'] as const),
  // 困
  Object.freeze(['sleepy', '困'] as const),
  Object.freeze(['困了', '困'] as const),
  Object.freeze(['打哈欠', '困'] as const),
])

/**
 * 建一张归一表（键已小写）。
 * @param extra 额外的别名（注册进来的）。
 */
export function buildAliasTable(extra: readonly (readonly [string, string])[] = []): Map<string, string> {
  const table = new Map<string, string>()
  for (const [alias, canonical] of [...ALIAS_SEEDS, ...extra]) {
    const key = tagKey(alias)
    if (key === '') continue
    table.set(key, canonical)
  }
  return table
}

/**
 * 归一一个标签。
 * @param tag 原始标签（文件名推导的或调用方传的）。
 * @param table 归一表。
 */
export function canonicalOf(tag: string, table: ReadonlyMap<string, string>): string {
  const trimmed = tag.trim()
  if (trimmed === '') return ''
  return table.get(tagKey(trimmed)) ?? trimmed
}

/**
 * 同义表自检：右边不能是另一条规则左边的"中转站"。
 *
 * 只需查一件事：**归一的终点必须不在表里**。若 `高兴 → 开心` 而
 * `开心 → 笑脸`，那么一次归一得到「开心」，两次得到「笑脸」——
 * 两处结果不同，而代码里两处都"看起来对"。
 * @param table 归一表。
 */
export function aliasIssues(table: ReadonlyMap<string, string>): readonly string[] {
  const issues: string[] = []
  for (const [alias, canonical] of table) {
    if (tagKey(canonical) === alias) continue
    const again = table.get(tagKey(canonical))
    if (again !== undefined && again !== canonical) {
      issues.push(`「${alias}」→「${canonical}」→「${again}」是两级跳`)
    }
  }
  return issues
}
