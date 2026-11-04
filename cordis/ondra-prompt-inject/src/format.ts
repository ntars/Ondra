/**
 * 行格式与段标题 —— 手册 §2.6 那两行的**唯一实现**。
 *
 * 手册逐字给了两条：
 *
 * ```
 * 行格式：- [类] 文本（X 前记下，提过 N 次，订正过 N 次，是从几件小事里归纳出来的，记不太清了）
 * 段标题：另有 N 条未展开（chain_recall 可查）
 * ```
 *
 * 这两处**只在这里拼**。散到 `blocks.ts` / `service.ts` 各拼一次，
 * 就会出现「记忆块的行格式和别的块不一样」这种没人报错、只有用户觉得「排版怪」的问题。
 *
 * ## 括号为什么改了
 *
 * 手册的段标题是 `另有 N 条未展开（chain_recall 可查）`，而段标题本身已经带一层
 * `【…】`。再套一层圆括号会读成「另有 3 条未展开（可查（…））」，
 * 所以本插件把内层括号换成逗号：`【不能忘的】（另有 3 条未展开，chain_recall 可查）`。
 * 词一个没少，层级清楚一层。
 */

import type { BlockSpec } from './types.js'

/** 11 类寿命类别的中文名（手册 §2.4 的类别表）。 */
const CATEGORY_TMP: Readonly<Record<string, string>> = {
  watch: '围观',
  daily: '日常',
  food: '吃的',
  place: '地方',
  misc: '杂事',
  event: '事情',
  feeling: '心情',
  study: '学业',
  person: '人',
  promise: '约定',
  self: '我自己',
}

/** 类别中文名表（冻结）。 */
export const CATEGORY_ZH: Readonly<Record<string, string>> = Object.freeze(CATEGORY_TMP)

/** 一天多少毫秒。 */
const DAY_MS = 86_400_000

/** 一小时多少毫秒。 */
const HOUR_MS = 3_600_000

/**
 * 类别中文名。查不到时用「杂事」，**不抛错也不留空**——
 * 一个空方括号 `[]` 会让模型以为这一行的类别是空的。
 * @param category 类别 id。
 */
export function categoryZh(category: string): string {
  return CATEGORY_ZH[category] ?? '杂事'
}

/**
 * 「多久以前」的中文说法。手册的行格式里是 `X 前记下`。
 *
 * 刻意只到「年」这一档：`3 年 2 个月前` 这种精度对模型没有意义，
 * 而多一段计算就多一处能算错的地方。
 * @param timestamp 写入时刻。
 * @param at 当前时刻。
 */
export function agoText(timestamp: number, at: number): string {
  const delta = Math.max(0, at - timestamp)
  if (delta < HOUR_MS) return '刚刚'
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} 小时`
  const days = Math.floor(delta / DAY_MS)
  if (days < 30) return `${days} 天`
  if (days < 365) return `${Math.floor(days / 30)} 个月`
  return `${Math.floor(days / 365)} 年`
}

/** 一行的原料。 */
export interface LineInput {
  /** 11 类寿命类别。 */
  readonly category: string
  /** 正文。 */
  readonly text: string
  /** 写入时刻（算「X 前记下」）。 */
  readonly createdAt: number
  /** 当前时刻。 */
  readonly at: number
  /** 被提起次数（`0` 或 `1` 都不写这一段：写入那一次不算「反复提起」）。 */
  readonly timesSaid?: number
  /** 订正次数。 */
  readonly revisions?: number
  /** 是否是归纳出来的（`gist`）。 */
  readonly gist?: boolean
  /** 清晰度话术（来自 O-013，可能带前导「，」）。 */
  readonly clarity?: string
}

/**
 * 拼一行。
 *
 * 括号里那几段是**可选**的：没有就不写，不写空占位符。
 * 手册给的是一条完整样例，不是「每行都必须有五个括号项」。
 * @param input 原料。
 */
export function formatLine(input: LineInput): string {
  const parts: string[] = [`${agoText(input.createdAt, input.at)}前记下`]
  const times = input.timesSaid ?? 0
  // O-010 的口径是「写入时为 0，每被提起一次 +1」，所以 0 不写、1 就是「提过 1 次」。
  if (times > 0) parts.push(`提过 ${times} 次`)
  const revisions = input.revisions ?? 0
  if (revisions > 0) parts.push(`订正过 ${revisions} 次`)
  if (input.gist === true) parts.push('是从几件小事里归纳出来的')
  if (typeof input.clarity === 'string' && input.clarity.length > 0) {
    // O-013 的话术自带前导「，」（`，记不太清了`），这里要的是括号内的一项。
    parts.push(input.clarity.replace(/^，/, ''))
  }
  return `- [${categoryZh(input.category)}] ${input.text}（${parts.join('，')}）`
}

/**
 * 拼一条承诺行（① 说好的事）。
 *
 * 承诺**不能套用记忆行格式**：记忆行说的是「多久以前记下的」，
 * 而承诺要说的是「还有多久到期」——写成「3 天前记下」会把「3 天后要考试」
 * 读成「3 天前记了一件事」，方向正好反过来。
 * @param input 原料。
 */
export function formatPromiseLine(input: {
  readonly text: string
  readonly hoursLeft: number
  readonly inGrace: boolean
}): string {
  const hours = Math.round(input.hoursLeft)
  if (hours > 0) return `- [约定] ${input.text}（还有 ${hours} 小时）`
  if (hours === 0) return `- [约定] ${input.text}（就在这会儿）`
  const overdue = Math.abs(hours)
  if (input.inGrace) return `- [约定] ${input.text}（已经过了 ${overdue} 小时，还在宽限里）`
  return `- [约定] ${input.text}（已经过了 ${overdue} 小时）`
}

/**
 * 拼一条最简行（⑦ 想到的）。没有类别、没有时刻的地方用这个。
 * @param label 方括号里的词。
 * @param text 正文。
 */
export function formatSimpleLine(label: string, text: string): string {
  return `- [${label}] ${text}`
}

/**
 * 段标题。
 * @param spec 块声明。
 * @param dropped 这一块掉了几条。
 * @param includeHeadings 是否要标题。
 */
export function headingOf(spec: BlockSpec, dropped: number, includeHeadings: boolean): string {
  if (!includeHeadings) return ''
  if (dropped <= 0) return spec.title
  return `${spec.title}（另有 ${dropped} 条未展开，chain_recall 可查）`
}

/**
 * 水波纹那一块的免责句（手册 §2.6 ⑦「带免责句」）。
 *
 * 手册只写「带免责句」，没给原文。这里取一句最短的、不带任何数字的说法：
 * 它必须能让人立刻明白「这条不一定准」，又不能长到喧宾夺主。
 */
export const RIPPLE_DISCLAIMER = '（这些是顺着话头想到的，不一定准）'

/**
 * djb2 指纹（8 位十六进制）。
 *
 * 用途只有一个：`digest` 变了才需要重推。用它而不是时间戳，
 * 是因为「内容没变但时间变了」不该触发一次重推。
 * @param text 正文。
 */
export function djb2(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
