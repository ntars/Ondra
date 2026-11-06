/**
 * 判定逻辑（**纯函数，不碰磁盘、不碰 ctx**）。
 *
 * ## 执行顺序，以及为什么是这个顺序
 *
 * ```
 * policy（总开关 / 静音）→ quota（额度）→ interval（间隔）
 * → retreat（退场）→ give-up（抽签）→ send
 * ```
 *
 * 三点说明：
 *
 * 1. **退场排在抽签之前。** 退场句是纪律性的一句（「今天先到这儿」），
 *    它不该被性格化沉默抽掉——抽掉的后果是她一声不响地消失，
 *    而手册 §9.3 那条规则的本意正相反：**要体面地收尾**。
 * 2. **间隔排在退场之前。** 退场句也是一条主动消息，得守同一套节律；
 *    否则刚说完一句又补一句「那我先走啦」，比不说更奇怪。
 * 3. **额度排在间隔之前。** 两者都是两次整数比较，但额度用完是「今天到底了」，
 *    间隔是「再等一会儿」。先判到底的那条，`deferMs` 才不会被一个
 *    「其实今天已经没额度」的等待时间骗到。
 *
 * ## 抽签为什么不用 `Math.random()`
 *
 * 30% 的放弃率如果用随机数，调用方**每重试一次就重抽一次**：一轮里试 5 次，
 * 实际放弃率就从 30% 掉到 17%，而日志里每一行都写着「抽到放弃」，
 * 看不出这是个偏差。所以这里用**确定性哈希**：种子是
 * `(自然日, 话题键, 间隔窗口)`，同一件事在同一个窗口里抽到的结果恒定，
 * 换个窗口才重抽。这样重试不会改变结果，评估集也能复现。
 */

import { DAY_MS, MINUTE_MS, PROFILE_QUOTA } from './types.js'
import type { Config } from './settings.js'
import type {
  IntervalView,
  PlanAction,
  PlanCode,
  PlanGate,
  QuotaPlan,
  QuotaState,
  QuotaView,
  StreakView,
} from './types.js'

/** 判定入参（全部已算好，`decide()` 只做比较）。 */
export interface DecideInput {
  /** 配置。 */
  readonly settings: Config
  /** 额度视图。 */
  readonly quota: QuotaView
  /** 间隔视图。 */
  readonly interval: IntervalView
  /** 连续无回应视图。 */
  readonly streak: StreakView
  /** 静音截止时刻（`0` = 没静音）。 */
  readonly mutedUntil: number
  /** 这一次是否抽到放弃。 */
  readonly giveUp: boolean
  /** 判定时刻。 */
  readonly at: number
}

/**
 * 档位（或高级覆盖）给出的**未衰减**额度。
 *
 * 优先级只在这一处判：`quotaOverride > 0` 就用它，否则查档位表。
 * 写在两处的下场是「选快速档、只有 2 条」，因为另一处还在按档位算。
 * @param settings 配置。
 */
export function quotaFor(settings: Config): number {
  const override = Math.trunc(settings.quotaOverride)
  if (override > 0) return override
  return PROFILE_QUOTA[settings.profile]
}

/**
 * 连续沉默天数（毫秒差折算）。
 *
 * **与 O-042 `window.ts` 的 `silentDaysOf` 同口径**（`floor(diff / 86400000)`），
 * 刻意不 import（§18.5）。差别只在「不知道」的表示：那边返回 `0`，
 * 这里返回 `undefined`——因为本插件拿不到自己的记录时还要去问 O-042，
 * 把「不知道」压成 `0` 就再也问不出口了。
 *
 * 注意这里**只算天数、不判阈值**：`≥3 减半 / ≥7 归零` 那套仍在 O-042 的
 * `budgetOf()` 里，本插件把天数交回去让它算——那是「一份衰减」的落点。
 * @param at 当前时刻。
 * @param lastUserAt 用户上次开口的时刻（`0` = 不知道）。
 */
export function silentDaysBetween(at: number, lastUserAt: number): number | undefined {
  if (lastUserAt <= 0) return undefined
  const diff = at - lastUserAt
  if (diff <= 0) return 0
  return Math.floor(diff / DAY_MS)
}

/**
 * 间隔视图。
 * @param settings 配置。
 * @param state 状态。
 * @param at 当前时刻。
 */
export function intervalOf(settings: Config, state: QuotaState, at: number): IntervalView {
  const intervalMs = Math.max(0, Math.trunc(settings.minIntervalMinutes)) * MINUTE_MS
  const lastAt = state.lastProactiveAt
  if (lastAt <= 0) {
    return Object.freeze({ lastAt: 0, sinceMs: 0, remainMs: 0, intervalMs })
  }
  const sinceMs = Math.max(0, at - lastAt)
  const remainMs = intervalMs > 0 ? Math.max(0, intervalMs - sinceMs) : 0
  return Object.freeze({ lastAt, sinceMs, remainMs, intervalMs })
}

/**
 * 把字符串散成 0–1 的确定性数值（FNV-1a 32 位）。
 *
 * 不追求密码学强度：它只需要「同一输入同结果、不同输入大致均匀」。
 * @param seed 种子文本。
 */
export function drawOf(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

/**
 * 这一次的抽签值。
 *
 * 种子里的「间隔窗口」是刻意加的：只按 `(日, 话题)` 抽的话，同一件事一整天
 * 只有一个结果——上午抽到放弃，下午她还是一句话都不说，而用户看到的是
 * 「她一整天没理我」而不是「她这次没想说」。
 * @param dayKey 自然日键。
 * @param topicKey 话题键（空串表示与具体事由无关）。
 * @param at 当前时刻。
 * @param slotMs 窗口长度（一般就是最小间隔）。
 */
export function giveUpDrawOf(dayKey: string, topicKey: string, at: number, slotMs: number): number {
  const span = slotMs > 0 ? slotMs : MINUTE_MS * 60
  const slot = Math.floor(at / span)
  return drawOf(dayKey + '|' + topicKey + '|' + String(slot))
}

/**
 * 抽签是否落进放弃区间。
 * @param rate 放弃率（0–1）。
 * @param draw 抽签值（0–1）。
 */
export function shouldGiveUp(rate: number, draw: number): boolean {
  if (!(rate > 0)) return false
  if (!Number.isFinite(draw)) return false
  return draw < rate
}

/**
 * 退场状态。
 *
 * 两条判据取「或」：`silentDays ≥ 2`（用户两天没说话）或
 * `sinceUser ≥ 2`（用户上次开口后她主动说了两次都没被接住）。
 * 手册 §9.3 原话就是这两条并列。
 *
 * `retreatPerDay = 0` 时**整套退场都不启用**（不是「永远说过了」）：
 * 前者是「不要告别」，后者是「今天已经告过别了」，两句中文不一样，
 * 面板上也不能混成同一句。
 * @param settings 配置。
 * @param state 状态。
 * @param silentDays 连续沉默天数（`undefined` = 不知道，只按另一半判）。
 * @param dayKey 今日键。
 */
export function retreatOf(
  settings: Config,
  state: QuotaState,
  silentDays: number | undefined,
  dayKey: string,
): { readonly retreat: boolean; readonly retreatLeft: number } {
  const byDays = silentDays !== undefined && silentDays >= settings.retreatSilentDays
  const byStreak = state.proactiveSinceUser >= settings.retreatAfterProactive
  const usedToday = state.retreatDayKey === dayKey ? state.retreatDayCount : 0
  const retreatLeft = Math.max(0, settings.retreatPerDay - usedToday)
  const retreat = settings.retreatPerDay > 0 && (byDays || byStreak)
  return Object.freeze({ retreat, retreatLeft })
}

/** 造一条结论。`allow` 由动作派生，不单独传——两处各写一遍必然会不一致。 */
function make(
  input: DecideInput,
  action: PlanAction,
  gate: PlanGate,
  code: PlanCode,
  detail: string,
  deferMs = 0,
): QuotaPlan {
  return Object.freeze({
    allow: action === 'send' || action === 'retreat',
    action,
    gate,
    code,
    detail,
    deferMs: action === 'defer' ? Math.max(1, deferMs) : 0,
    quota: input.quota,
    streak: input.streak,
    interval: input.interval,
    giveUp: input.giveUp,
    retreat: input.streak.retreat,
    at: input.at,
  })
}

/** 把毫秒说成人话（日志与面板用；这一段不进提示词，允许出现数字）。 */
function waitText(ms: number): string {
  const minutes = Math.ceil(ms / MINUTE_MS)
  if (minutes < 60) return String(minutes) + ' 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? String(hours) + ' 小时' : String(hours) + ' 小时 ' + String(rest) + ' 分'
}

/**
 * 主判定。**纯函数**：同样的入参永远同样结论。
 * @param input 入参。
 */
export function decide(input: DecideInput): QuotaPlan {
  const { settings, quota, interval, streak } = input

  if (!settings.enable) {
    return make(input, 'drop', 'policy', 'disabled', '主动节律已关闭（enable=false）')
  }

  if (input.mutedUntil > input.at) {
    // 静音是 `drop` 而不是 `defer`：`defer` 会在解除静音那一刻把攒下的话
    // 一次说出来（O-042 同一条判断）。
    return make(
      input,
      'drop',
      'policy',
      'muted',
      '一键静音中，还有 ' + waitText(input.mutedUntil - input.at),
    )
  }

  // 额度闸只在拿得到 O-042 的日计数时才判。拿不到就没有「今天说了几句」这个事实，
  // 编一个 0 出来会让她在没装 O-042 的部署里无限说下去。
  if (quota.source === 'gate') {
    if (quota.effective <= 0) {
      return make(input, 'drop', 'quota', 'quota-zero', '今日主动额度为 0（连续沉默太久，或档位额度为 0）')
    }
    if (quota.remaining <= 0) {
      return make(
        input,
        'drop',
        'quota',
        'quota-exhausted',
        '今日 ' + String(quota.effective) + ' 条已经说完（已用 ' + String(quota.used) + '）',
      )
    }
  }

  if (interval.remainMs > 0) {
    return make(
      input,
      'defer',
      'interval',
      'interval',
      '距上次主动才 ' + waitText(interval.sinceMs) + '，再等 ' + waitText(interval.remainMs),
      interval.remainMs,
    )
  }

  if (streak.retreat) {
    if (streak.retreatLeft <= 0) {
      return make(input, 'drop', 'retreat', 'retreat-sent', '今天的退场句已经说过了，不再打扰')
    }
    return make(input, 'retreat', 'retreat', 'retreat', '该收尾了：只说一句退场句，不长篇大论')
  }

  if (input.giveUp) {
    return make(input, 'drop', 'give-up', 'give-up', '这一次她想把话咽回去（性格化沉默）')
  }

  return make(input, 'send', 'pass', 'ok', '可以主动说一句')
}
