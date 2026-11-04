/**
 * 纯判定层：把「一个时刻」变成「这一档该怎么接」。
 *
 * **本文件没有 IO、没有 `Date`、没有定时器。** 所有时刻都由调用方传进来，
 * 于是同一组时刻在任何时候重放都得到同一份课表——这是它可被静态复核的前提。
 *
 * ## 为什么 `planOf()` 里一个数字都没有
 *
 * 五档课表里只有 `maxSentences` 是数字，而它约束的是「说几句」，不是「隔了多久」。
 * 间隔只以 `coarse` 的五个词出现（今天 / 昨天 / 几天 / 一阵子 / 很久）。
 * 把天数放进来，一定有一天会被念出来：「我们 17 天没说话了」——
 * 那不是关心，那是把重逢变成审讯。
 *
 * ## 「已经提过」为什么要把课表收窄，而不是照样返回
 *
 * 回归那一刻最容易发生的二次伤害是**重复**：外壳先渲染一次课表、
 * 主动闸又触发一次，于是同一句「好久不见」说了两遍。所以 `mention()` 记过之后，
 * `planOf()` 会把句数上限压到 1，并把「承认隔了一段」这条撤掉——
 * 已经承认过了，再说一遍就是念台词。
 */

import type { AbsenceTier, CoarseGap, RegreetPlan } from './types.js'
import { COARSE_OF, TIER_ORDER } from './types.js'
import type { Config } from './settings.js'

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000

/** 一小时的毫秒数。 */
const HOUR_MS = 3_600_000

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000

/**
 * 四条**通用禁令**。每一档都必须带上，顺序固定。
 *
 * 这四条不是风格偏好，是四种真实会让对方关掉这个应用的说法：
 * 清算（去哪了）、审讯（多少天）、施压（我一直等着你）、自我贬低（你都不理我）。
 */
const UNIVERSAL_MUST_NOT: readonly string[] = Object.freeze([
  '不许问对方这段时间去哪了',
  '不许报出精确的间隔（天数、小时数）',
  '不许替空窗期编造情节（例如「我一直在等你」）',
  '不许把缺席解读成「被丢下」',
])

/** 一档的出厂规格（不含通用禁令）。 */
interface TierSpec {
  readonly mustDo: readonly string[]
  readonly extraMustNot: readonly string[]
  readonly maxSentences: number
  readonly allowWarmth: boolean
  readonly mustAcknowledgeGap: boolean
}

/** 五档规格表。**句数按「句」不按「字」**：字数上限会让人把三句塞进一句长句。 */
const TIER_SPECS: Readonly<Record<AbsenceTier, TierSpec>> = Object.freeze({
  brief: Object.freeze({
    mustDo: Object.freeze(['直接接上上次的话头或当下的事', '不解释隔了多久，几小时不值得提']),
    extraMustNot: Object.freeze(['不许把几小时夸张成「好久不见」']),
    maxSentences: 2,
    allowWarmth: true,
    mustAcknowledgeGap: false,
  }),
  noticed: Object.freeze({
    mustDo: Object.freeze(['可以轻提一句「隔了会儿」，只提一次', '给对方一个不必解释的台阶']),
    extraMustNot: Object.freeze(['不许检讨自己「是不是吵到你了」']),
    maxSentences: 2,
    allowWarmth: true,
    mustAcknowledgeGap: false,
  }),
  long: Object.freeze({
    mustDo: Object.freeze(['承认隔了一段，但不给天数', '把话题递回对方现在手上的事']),
    extraMustNot: Object.freeze(['不许在这时候要承诺（「下次早点回来」）']),
    maxSentences: 2,
    allowWarmth: false,
    mustAcknowledgeGap: true,
  }),
  distant: Object.freeze({
    mustDo: Object.freeze([
      '先打招呼，再说别的',
      '把「我还在」说清，不问原因',
      '最多问一次近况，问完就停',
    ]),
    extraMustNot: Object.freeze(['不许问「你还记得我吗」——那是把尴尬推给对方']),
    maxSentences: 3,
    allowWarmth: false,
    mustAcknowledgeGap: true,
  }),
  stranger: Object.freeze({
    mustDo: Object.freeze([
      '先报自己是谁（对方可能已经忘了）',
      '给一个不必回应的开口',
      '不追问上次的事',
    ]),
    extraMustNot: Object.freeze(['不许假装熟络', '不许翻旧账（提上次说过什么）']),
    maxSentences: 3,
    allowWarmth: false,
    mustAcknowledgeGap: true,
  }),
})

/** 存档形状。**只放时刻与计数**，一个字的内容都不放。 */
export interface AbsenceState {
  /** 第一次被看到活动的时刻。 */
  readonly firstSeenAt: number | null
  /** 最近一次活动时刻。 */
  readonly lastSeenAt: number | null
  /** 最近一次「真的提了一句」的时刻。 */
  readonly lastMentionAt: number | null
  /** 记录活动次数。 */
  readonly touches: number
  /** 真的提过的次数。 */
  readonly mentions: number
  /** 重来次数。 */
  readonly restarts: number
}

/** 空状态。 */
export function emptyState(restarts = 0): AbsenceState {
  return Object.freeze({
    firstSeenAt: null,
    lastSeenAt: null,
    lastMentionAt: null,
    touches: 0,
    mentions: 0,
    restarts,
  })
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限正时刻，否则 `null`。 */
function stampOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.trunc(value)
}

/** 非负整数，否则 0。 */
function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}

/**
 * 归一化存档。**任何异常都退化成空状态**，不抛错。
 *
 * 关键取舍：`lastSeenAt` 缺失就整份丢掉。留着「有首次时刻但没有末次」
 * 这种半截状态，会让 `gap` 算不出来而档位却存在——那时外壳会拿到一个
 * 没有间隔的空窗，只能编一个。
 * @param raw 原始值。
 */
export function normalizeState(raw: unknown): AbsenceState {
  if (!isRecord(raw)) return emptyState()
  const restarts = countOf(raw['restarts'])
  const lastSeenAt = stampOf(raw['lastSeenAt'])
  if (lastSeenAt === null) return emptyState(restarts)
  const firstSeenAt = stampOf(raw['firstSeenAt'])
  const lastMentionAt = stampOf(raw['lastMentionAt'])
  return Object.freeze({
    // 首次时刻晚于末次是坏档：夹到末次，避免出现负的「第一次到现在」。
    firstSeenAt: firstSeenAt !== null && firstSeenAt <= lastSeenAt ? firstSeenAt : lastSeenAt,
    lastSeenAt,
    lastMentionAt,
    touches: countOf(raw['touches']),
    mentions: countOf(raw['mentions']),
    restarts,
  })
}

/**
 * 空窗毫秒数。**从没记录过返回 `null`，不返回 0**——0 会被读成「刚刚才见过」。
 * @param state 状态。
 * @param at 时刻。
 */
export function gapOf(state: AbsenceState, at: number): number | null {
  if (state.lastSeenAt === null) return null
  // 时钟回拨时会算出负数：夹到 0，当作「刚刚才见」，不报一段倒流的空窗。
  return Math.max(0, at - state.lastSeenAt)
}

/**
 * 分档。**纯函数。**
 *
 * 边界一律取「大于等于」：`6000ms` 之外的 6 小时整点算进 `noticed`，
 * 因为「刚好睡满六小时回来」更接近「隔了一觉」而不是「刚离开」。
 * @param gapMs 空窗毫秒数；`null` 表示从没记录过。
 * @param settings 配置。
 */
export function tierOf(gapMs: number | null, settings: Config): AbsenceTier | null {
  if (gapMs === null) return null
  const hours = gapMs / HOUR_MS
  if (hours < settings.briefHours) return 'brief'
  const days = gapMs / DAY_MS
  if (days < settings.noticedDays) return 'noticed'
  if (days < settings.longDays) return 'long'
  if (days < settings.distantDays) return 'distant'
  return 'stranger'
}

/** 粗粒度词 → 中文标签。 */
const COARSE_ZH: Readonly<Record<CoarseGap, string>> = Object.freeze({
  today: '今天',
  yesterday: '昨天',
  'few-days': '几天',
  'a-while': '一阵子',
  'very-long': '很久',
})

/** 取中文标签。 */
export function coarseZhOf(coarse: CoarseGap): string {
  return COARSE_ZH[coarse]
}

/**
 * 组装课表。**纯函数。**
 * @param tier 档位。
 * @param cap 句数天花板（1–3）。
 * @param mentioned 这一轮是否已经提过。
 */
export function planOf(tier: AbsenceTier, cap: number, mentioned: boolean): RegreetPlan {
  const spec = TIER_SPECS[tier]
  const coarse = COARSE_OF[tier]
  const limit = Math.min(spec.maxSentences, Math.max(1, Math.trunc(cap)))
  const mustNot = Object.freeze([...UNIVERSAL_MUST_NOT, ...spec.extraMustNot])
  if (mentioned) {
    // 已经提过一次：只留一句，并且把「承认隔了一段」撤掉——再说一遍就是念台词。
    return Object.freeze({
      tier,
      coarse,
      coarseZh: COARSE_ZH[coarse],
      mustDo: Object.freeze(['这一轮已经把话接上了，不要再提间隔']),
      mustNot,
      maxSentences: 1,
      allowWarmth: spec.allowWarmth,
      mustAcknowledgeGap: false,
      askAboutGap: false,
      note: '这一轮已经提过一次间隔，接下来只接话',
    })
  }
  return Object.freeze({
    tier,
    coarse,
    coarseZh: COARSE_ZH[coarse],
    mustDo: spec.mustDo,
    mustNot,
    maxSentences: limit,
    allowWarmth: spec.allowWarmth,
    mustAcknowledgeGap: spec.mustAcknowledgeGap,
    askAboutGap: false,
    note: noteOf(tier),
  })
}

/**
 * 一句中文状态说明。**不含数字、不含台词。**
 * @param tier 档位。
 */
export function noteOf(tier: AbsenceTier): string {
  if (tier === 'brief') return '刚离开一会儿，直接接上就行'
  if (tier === 'noticed') return '隔了会儿，可以轻提一次'
  if (tier === 'long') return '隔了几天，承认一句但别给天数'
  if (tier === 'distant') return '隔了一阵子，先打招呼再把「还在」说清'
  return '隔了很久，当作重新认识的前半段'
}

/**
 * 档位比较。**取大用**：交给消费方一个函数，省得每处自己排一遍。
 * @param a 档位。
 * @param b 档位。
 */
export function maxTier(a: AbsenceTier, b: AbsenceTier): AbsenceTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b
}

/** 分钟换算（供外壳画时间轴；**不许念出来**）。 */
export function minutesOf(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / MINUTE_MS)
}
