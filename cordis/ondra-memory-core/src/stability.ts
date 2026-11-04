/**
 * 寿命与强度的**纯算法**层：不碰 ctx、不碰库、不读时间。
 *
 * 全部输入靠参数传进来，所以这一层可以被 `ondra-memory-audit`（O-017 遗忘可解释）、
 * `ondra-memory-decay`（O-013 衰减）、成长面板直接复用同一份公式，
 * 而不是各自抄一遍——「单一真源」在这里的落地方式就是**只有这个文件算 S**。
 *
 * ## 公式（手册 §2.4，公式变更，不是新增）
 *
 * ```
 * S(小时) = baseHours × (0.45 + salience/100 × 1.25) × (1 + arousal × 0.65)
 * ```
 *
 * 三通道 4d / 12d / 180d 作**第二层调制**：先类别、后通道，两者相乘。
 *
 * ## 三处必须写清的取舍
 *
 * 1. **提及与命中都做成「因子」，不做成「另一条衰减曲线」。**
 *    手册另给了两条：半衰期 `min(15, 3×(1+ln(1+times_said)))` 天、
 *    命中拉长 `1 + 0.6·log2(1+次数)`（封顶 4 倍）。若把前者当成第二套半衰期，
 *    就会出现「S 说这条能活 50 小时、半衰期说它能活 3 天」两个互相矛盾的答案。
 *    本插件的做法是把它们**归一化成乘在 S 上的无量纲因子**：
 *    - 提及因子 = `min(15, 3×(1+ln(1+n))) / 3`，`n=0` 时恰为 **1.0**；
 *    - 命中因子 = `min(4, 1+0.6·log2(1+n))`，`n=0` 时恰为 **1.0**。
 *    两个式子的零点都天然是 1，所以**不需要引入任何新的归一化常数**——
 *    这不是发明，是把手册给的两条曲线折进同一条 S。
 *
 * 2. **S 不是「归档倒计时」。**
 *    归档窗口是独立的 30 天 / 90 天（手册原话「30 天未引用即 archived」）。
 *    把 S 当倒计时会让 `daily`（基线 3 小时）的记忆在 3 小时后就被归档，
 *    而产品承诺是「记得昨天说过什么」。S 回答的是「这条在她心里还亮不亮」，
 *    归档回答的是「这条还占不占主动位」——两个问题，两个闸，不能压成一个。
 *
 * 3. **通道归一化锚点取 12 天（gist），且做成配置项。**
 *    手册只给了三档天数（4/12/180），没给「哪一档算 1.0」。取中位 12 天作锚点，
 *    理由是三档里它居中，乘出来的因子分布最不偏。**这是个可调参数，不是魔法数**：
 *    它是 `Config.channelAnchorDays`，改它就能整体平移三通道的相对强度。
 */

import type { MemoryCategory, MemoryChannel, Stability } from './types.js'

/**
 * 11 类基线（小时）。**手册 §2.4 原值，一个都不许改**。
 *
 * 这张表是 P0 三件之一的全部内容：`self` 20000 小时（约 833 天）与 `watch` 2 小时
 * 差 4 个数量级——「她说过的关于自己的事」和「她昨天看了个片」本来就不该一样长寿。
 */
export const STABILITY_BASE_HOURS: Readonly<Record<MemoryCategory, number>> = Object.freeze({
  watch: 2,
  daily: 3,
  food: 10,
  place: 12,
  misc: 20,
  event: 40,
  feeling: 50,
  study: 80,
  person: 240,
  promise: 8000,
  self: 20000,
})

/** 三通道的半衰期（天）。手册原值 4 / 12 / 180。 */
export const CHANNEL_DAYS: Readonly<Record<MemoryChannel, number>> = Object.freeze({
  fact: 4,
  gist: 12,
  affect: 180,
})

/** 通道归一化锚点默认值（天）：取三档中位，见文件头第 3 条。 */
export const DEFAULT_CHANNEL_ANCHOR_DAYS = 12

/** 强度地板（手册 §2.4「地板权重 0.01」）。到底不等于 0——「只忘不删」。 */
export const FLOOR_WEIGHT = 0.01

/** 写入打分的基底（普通类）。 */
export const SCORE_BASE = 30

/** 写入打分的基底（长期类）。 */
export const SCORE_BASE_LONG_TERM = 70

/**
 * 「长期类」的判定线（小时）。
 *
 * 手册只写「基底 30（长期类 70）」，**没给长期类清单**。本插件不猜清单，
 * 改用可验证的派生规则：基线 ≥ 240 小时（person / promise / self 三档）算长期类。
 * 这条线是 `Config.longTermBaseHours`，调它就能改判定，不必改代码。
 */
export const DEFAULT_LONG_TERM_BASE_HOURS = 240

/** 提及因子的上限（天）。手册 `min(15, …)`。 */
export const MENTION_CAP_DAYS = 15

/** 命中因子的上限（倍）。手册「封顶 4 倍」。 */
export const HIT_CAP = 4

/** 订正一次的 S 放大倍数（手册 §2.4 `revise` → `S ×1.3`）。 */
export const REVISE_BOOST = 1.3

/** 一个数字夹到区间内。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 显著度归一到 0–100；非数字按 0（「没说清」不该被当成「很重要」）。 */
export function clampSalience(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return clamp(value, 0, 100)
}

/** 唤醒度归一到 0–1；非数字按 0.5（中性）。 */
export function clampArousal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return clamp(value, 0, 1)
}

/** 取类别基线；未知类别按 `misc`（20 小时），**绝不返回 0**——0 会让强度瞬间见底。 */
export function baseHoursOf(category: string): number {
  const value = (STABILITY_BASE_HOURS as Readonly<Record<string, number>>)[category]
  return typeof value === 'number' ? value : STABILITY_BASE_HOURS.misc
}

/** 取通道天数；未知通道按 `gist`。 */
export function channelDaysOf(channel: string): number {
  const value = (CHANNEL_DAYS as Readonly<Record<string, number>>)[channel]
  return typeof value === 'number' ? value : CHANNEL_DAYS.gist
}

/**
 * 提及因子：`min(15, 3×(1+ln(1+n))) / 3`。
 *
 * 零点为 1，上限 5（=15/3）。「被反复提起的记忆衰减更慢」落在 S 上，
 * 而不是另立一条曲线，见文件头第 1 条。
 * @param timesSaid 被提起次数（含写入那一次）。
 */
export function mentionFactor(timesSaid: number): number {
  const n = Number.isFinite(timesSaid) ? Math.max(0, Math.floor(timesSaid)) : 0
  const days = Math.min(MENTION_CAP_DAYS, 3 * (1 + Math.log(1 + n)))
  return days / 3
}

/**
 * 命中因子：`min(4, 1+0.6·log2(1+hits))`。
 *
 * 零点为 1，上限 4。实测口径（手册）：同为 98 天前最后接触，
 * 被想起 0 次衰减 25.7%、3 次 12.6%、10 次 9.2%。
 * @param hits 检索命中次数。
 */
export function hitFactor(hits: number): number {
  const n = Number.isFinite(hits) ? Math.max(0, Math.floor(hits)) : 0
  return Math.min(HIT_CAP, 1 + 0.6 * Math.log2(1 + n))
}

/** 寿命计算的入参。 */
export interface StabilityParams {
  /** 11 类寿命类别。 */
  readonly category: string
  /** 三通道之一。 */
  readonly channel: string
  /** 显著度 0–100。 */
  readonly salience: number
  /** 唤醒度 0–1。 */
  readonly arousal: number
  /** 被提起次数，默认 0。 */
  readonly timesSaid?: number
  /** 检索命中次数，默认 0。 */
  readonly hits?: number
  /** 通道归一化锚点（天），默认 12。 */
  readonly channelAnchorDays?: number
}

/**
 * 算寿命。**唯一入口**，所有调用方（写入、读取、审计）都必须走这里。
 *
 * 四段相乘，顺序即手册的「先类别、后通道」：
 * 类别基线 → 显著度系数 → 唤醒度系数 → 通道系数 → 提及因子 → 命中因子。
 * @param params 入参。
 */
export function stabilityOf(params: StabilityParams): Stability {
  const baseHours = baseHoursOf(params.category)
  const salience = clampSalience(params.salience)
  const arousal = clampArousal(params.arousal)
  const anchor = params.channelAnchorDays !== undefined && params.channelAnchorDays > 0
    ? params.channelAnchorDays
    : DEFAULT_CHANNEL_ANCHOR_DAYS

  const salienceFactor = 0.45 + (salience / 100) * 1.25
  const arousalFactor = 1 + arousal * 0.65
  const channelFactor = channelDaysOf(params.channel) / anchor
  const mention = mentionFactor(params.timesSaid ?? 0)
  const hit = hitFactor(params.hits ?? 0)

  const hours = baseHours * salienceFactor * arousalFactor * channelFactor * mention * hit

  return Object.freeze({
    baseHours,
    salienceFactor,
    arousalFactor,
    channelFactor,
    mentionFactor: mention,
    hitFactor: hit,
    // 保底 1 分钟：S 变成 0 会让强度除零，而除零在 JS 里不报错、只产出 NaN，
    // NaN 一路流进界面就是「这条记忆永远模糊」。宁可给一个极小的正数。
    hours: Math.max(1 / 60, hours),
  })
}

/**
 * 当前强度：`0.5^(已过小时 / S)`，夹在 `[floor, 1]`。
 *
 * 用 0.5 的幂而不是 e 的幂，是为了让 S 的物理意义明确：**S 小时之后强度恰好剩一半**，
 * 与「半衰期」这个词严格同义。用 e 的幂会得到 `S` 小时后剩 36.8%，同一个字段两个名字。
 * @param stabilityHours 当前 S（小时）。
 * @param elapsedHours 距上次被带出的小时数。
 * @param floor 地板，默认 0.01。
 */
export function strengthAt(stabilityHours: number, elapsedHours: number, floor = FLOOR_WEIGHT): number {
  const s = Math.max(1 / 60, stabilityHours)
  const elapsed = Math.max(0, elapsedHours)
  const raw = Math.pow(0.5, elapsed / s)
  return clamp(raw, floor, 1)
}

/**
 * 从 1.0 衰减到地板需要多少小时：`S × log2(1/floor)`。
 *
 * floor=0.01 时约 6.64 个 S。给「剩余寿命」与审计面板用。
 * @param stabilityHours 当前 S。
 * @param floor 地板。
 */
export function fadeHours(stabilityHours: number, floor = FLOOR_WEIGHT): number {
  const safeFloor = clamp(floor, 1e-6, 0.999)
  return Math.max(1 / 60, stabilityHours) * Math.log2(1 / safeFloor)
}

/**
 * 归档窗口（小时）：`important ? 90 天 : 30 天`。
 *
 * **与 S 无关**，见文件头第 2 条。故意做成独立函数，让「谁在决定归档」一眼可查。
 * @param important 是否重要。
 * @param normalDays 普通档天数。
 * @param importantDays 重要档天数。
 */
export function archiveAfterHours(important: boolean, normalDays: number, importantDays: number): number {
  const days = important ? importantDays : normalDays
  return Math.max(1, days) * 24
}

/** 一条打分规则。 */
interface ScoreRule {
  /** 加减分。 */
  readonly points: number
  /** 命中条件。 */
  readonly pattern: RegExp
  /** 为什么给这个分（写进 README，也方便排查「这条怎么这么高分」）。 */
  readonly why: string
}

/**
 * 写入打分规则表（手册 §2.4「写入时打分表」）。
 *
 * **每条规则最多命中一次**：同一句话里出现三次「难过」不该 +48。
 * 手册给的是「一句话具备某特征值多少分」，不是「每出现一次加一次」。
 */
const SCORE_RULES: readonly ScoreRule[] = Object.freeze([
  { points: 26, pattern: /第一次|头一回|头一次|初次/, why: '第一次/头一回' },
  // 「最」单独一个字太宽：「最近」「最后」「最初」「最终」「最新」「最低」「最高」都不是最高级。
  // 中文里这六个词极常见，若不加排除，几乎每条带时间状语的记忆都会白拿 +22。
  { points: 22, pattern: /最(?!近|后|初|终|新|低|高)|特别|难忘/, why: '最/特别/难忘' },
  { points: 20, pattern: /答应|约定|说好|保证/, why: '答应/约定' },
  { points: 16, pattern: /难过|哭|委屈|后悔|生气/, why: '难过/哭/委屈/后悔/生气（坏记忆更牢）' },
  { points: 12, pattern: /一辈子|永远|从此/, why: '一辈子/永远/从此' },
  { points: -14, pattern: /刷到|刷视频|刷抖音/, why: '刷到/刷视频' },
  { points: -10, pattern: /吃了饭|吃饭了/, why: '吃了饭' },
  { points: -12, pattern: /没什么|还行|就那样/, why: '没什么/还行' },
])

/** 长度加分的阈值（字）。手册「文本≥40 字 +6」。 */
export const LONG_TEXT_CHARS = 40

/** 长度减分的阈值（字）。手册「文本≤8 字 −8」。 */
export const SHORT_TEXT_CHARS = 8

/** 按码点数字符（emoji 算 1 个，不按 UTF-16 单元算）。 */
export function charCount(text: string): number {
  return [...text].length
}

/** 打分入参。 */
export interface ScoreParams {
  /** 11 类寿命类别（决定基底是 30 还是 70）。 */
  readonly category: string
  /** 长期类判定线（小时）。 */
  readonly longTermBaseHours?: number
}

/**
 * 写入打分（夹 0–100）。
 *
 * 顺序：先定基底（长期类 70 / 普通 30），再逐条加减，最后按长度加减并夹紧。
 * 夹紧放在最后而不是每一步，是因为中间值允许越界——先夹会让「基底 70 再 −14」
 * 与「基底 30 再 +26」这类组合失真。
 * @param text 正文。
 * @param params 入参。
 */
export function scoreText(text: string, params: ScoreParams): number {
  const line = typeof text === 'string' ? text : ''
  const longTermLine = params.longTermBaseHours ?? DEFAULT_LONG_TERM_BASE_HOURS
  let score = baseHoursOf(params.category) >= longTermLine ? SCORE_BASE_LONG_TERM : SCORE_BASE

  for (const rule of SCORE_RULES) {
    if (rule.pattern.test(line)) score += rule.points
  }

  const chars = charCount(line.trim())
  if (chars >= LONG_TEXT_CHARS) score += 6
  if (chars <= SHORT_TEXT_CHARS) score -= 8

  return Math.round(clamp(score, 0, 100))
}

/** 是否「重要」（归档窗口取 90 天那一档）。 */
export function isImportant(salience: number, threshold: number): boolean {
  return clampSalience(salience) >= clamp(threshold, 0, 100)
}
