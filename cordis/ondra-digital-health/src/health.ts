/**
 * 纯判定层：把「一串打点时刻」变成「此刻该不该劝」。
 *
 * **本文件没有 IO、没有 `Date`、没有定时器。** 所有时刻都由调用方传进来，
 * 于是同一段打点序列在任何时候重放都得到同一份结论——这是它可被静态复核的前提。
 *
 * ## 两个「段」必须分开算（本文件最容易写错的地方）
 *
 * - **连续段**（`sessionStart`）回答「这一坐坐了多久」，休息够久就断开；
 * - **当日累计**（`dayMs`）回答「今天一共用了多久」，跨天归零，休息不清零。
 *
 * 把两者合成一个数，就会出现两种都很难查的错：断续用满八小时的人
 * 永远收不到「今天够了」，而连坐三小时的人会被当成「今天才用了一小时」。
 */

import type { HealthLevel, HealthReason, HealthSnapshot } from './types.js'
import { LEVEL_ORDER, STATE_VERSION } from './types.js'
import type { Config } from './settings.js'

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000

/** 存档形状。**只放时间戳与毫秒数**，一个字的正文都不放。 */
export interface HealthState {
  /** 存档版本。 */
  readonly version: number
  /** 自然日键。 */
  readonly dayKey: string
  /** 当日累计毫秒数（跨天归零）。 */
  readonly dayMs: number
  /** 当前连续段起点；没有活动段为 `null`。 */
  readonly sessionStart: number | null
  /** 最近一次打点时刻。 */
  readonly lastPulseAt: number | null
  /** 已提醒到的档位。 */
  readonly acknowledged: HealthLevel
  /** 当日提醒次数。 */
  readonly nudges: number
  /** 最近一次提醒时刻（冷却起点）。 */
  readonly lastNudgeAt: number | null
  /** 当日打点次数（跨天归零）。 */
  readonly pulses: number
  /**
   * 是否**曾经**打过点（跨天不清）。
   *
   * 与 `pulses` 分开是必须的：`pulses` 跨天归零，若拿它判断「有没有数据」，
   * 昨天用过、今天还没打点的人会被报成 `never-pulsed`——那时提示语是
   * 「还没有收到过活动打点」，而事实是昨天收到过一整晚。
   */
  readonly everPulsed: boolean
}

/** 空状态。 */
export function emptyState(dayKey: string): HealthState {
  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    dayMs: 0,
    sessionStart: null,
    lastPulseAt: null,
    acknowledged: 'ok' as HealthLevel,
    nudges: 0,
    lastNudgeAt: null,
    pulses: 0,
    everPulsed: false,
  })
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限非负数，否则 0。 */
function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}

/** 有限正时刻，否则 `null`。 */
function stampOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.trunc(value)
}

/** 档位归一：不在闭集里一律退回 `ok`。 */
function levelOf(value: unknown): HealthLevel {
  if (value === 'gentle' || value === 'firm' || value === 'stop') return value
  return 'ok'
}

/**
 * 归一化存档。**任何异常都退化成空状态**，不抛错。
 *
 * 关键取舍：`dayKey` 与传入的当前日不同，就**整份丢掉重来**。
 * 理由：旧档里那一串时刻都属于另一天，硬留下来只会让「今天用了多久」
 * 从一个错误基数开始加，而错的那个数看起来完全正常。
 * @param raw 原始值。
 * @param dayKey 当前自然日键。
 */
export function normalizeState(raw: unknown, dayKey: string): HealthState {
  if (!isRecord(raw)) return emptyState(dayKey)
  if (raw['dayKey'] !== dayKey) {
    // 跨天：当日计数确实该清零，但「曾经打过点」这一条必须跨天带过去，
    // 否则第二天第一次读取会报「从来没有收到过活动」——那是假平安。
    return stateCarryingEver(raw, dayKey)
  }
  const sessionStart = stampOf(raw['sessionStart'])
  const lastPulseAt = stampOf(raw['lastPulseAt'])
  // 有起点没末次打点，或有末次打点没起点：这段记录已经拼不回去了，整份丢。
  if ((sessionStart === null) !== (lastPulseAt === null)) return emptyState(dayKey)
  if (sessionStart !== null && lastPulseAt !== null && sessionStart > lastPulseAt) {
    return emptyState(dayKey)
  }
  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    dayMs: countOf(raw['dayMs']),
    sessionStart,
    lastPulseAt,
    acknowledged: levelOf(raw['acknowledged']),
    nudges: countOf(raw['nudges']),
    lastNudgeAt: stampOf(raw['lastNudgeAt']),
    pulses: countOf(raw['pulses']),
    everPulsed: everOf(raw),
  })
}

/**
 * 取「曾经打过点」标记。旧档没有这个字段时，用当日打点数兜底推断。
 * @param raw 原始存档对象。
 */
function everOf(raw: Record<string, unknown>): boolean {
  if (raw['everPulsed'] === true) return true
  return countOf(raw['pulses']) > 0
}

/**
 * 跨天时的空状态：当日归零，但保留「曾经打过点」。
 * @param raw 原始存档对象。
 * @param dayKey 当前自然日键。
 */
function stateCarryingEver(raw: Record<string, unknown>, dayKey: string): HealthState {
  const base = emptyState(dayKey)
  if (!everOf(raw)) return base
  return Object.freeze({ ...base, everPulsed: true })
}

/** 毫秒 → 整分钟（向下取整，永不出现「用了 0.4 分钟」这种读数）。 */
export function minutesOf(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / MINUTE_MS)
}

/** 取较大档位。 */
export function maxLevel(a: HealthLevel, b: HealthLevel): HealthLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b
}

/**
 * 派生当前读数。**纯函数，不改状态。**
 * @param state 状态。
 * @param at 时刻。
 * @param breakMinutes 休息门槛（分钟）。
 */
export function derive(
  state: HealthState,
  at: number,
  breakMinutes: number,
): { readonly sessionMinutes: number; readonly idleMinutes: number | null } {
  const idleMinutes = state.lastPulseAt === null ? null : minutesOf(at - state.lastPulseAt)
  if (state.sessionStart === null) return { sessionMinutes: 0, idleMinutes }
  // 已经休息够久：连续段事实上已经断了，读数不能还挂着上一个段。
  if (idleMinutes !== null && idleMinutes >= breakMinutes) {
    return { sessionMinutes: 0, idleMinutes }
  }
  return { sessionMinutes: minutesOf(at - state.sessionStart), idleMinutes }
}

/**
 * 记一次打点。**纯函数**，返回新状态。
 *
 * 三件事同时发生：
 * 1. 连续段：休息够久就开新段；
 * 2. 当日累计：只累加「休息门槛以内」的那段间隔（人不在的时候不该计时）；
 * 3. 跨天：日键变了就清当日计数，**但不动连续段**——凌晨两点还在用，
 *    那一刻的连续时长是真的，不能因为过了零点就假装她刚坐下。
 * @param state 旧状态。
 * @param at 时刻。
 * @param dayKey 当前自然日键。
 * @param breakMinutes 休息门槛（分钟）。
 */
export function pulseState(
  state: HealthState,
  at: number,
  dayKey: string,
  breakMinutes: number,
): HealthState {
  const rolled = rollTo(state, dayKey)
  const breakMs = breakMinutes * MINUTE_MS
  const idleMs = rolled.lastPulseAt === null ? null : at - rolled.lastPulseAt
  const continued = idleMs !== null && idleMs >= 0 && idleMs <= breakMs
  const addedMs = continued && idleMs !== null ? idleMs : 0
  const sessionStart = continued && rolled.sessionStart !== null ? rolled.sessionStart : at
  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    dayMs: rolled.dayMs + addedMs,
    sessionStart,
    lastPulseAt: at,
    acknowledged: rolled.acknowledged,
    nudges: rolled.nudges,
    lastNudgeAt: rolled.lastNudgeAt,
    pulses: rolled.pulses + 1,
    everPulsed: true,
  })
}

/**
 * 把状态搬到指定自然日：同日原样返回，跨天清当日计数但保留「曾经打过点」。
 *
 * 单独导出是因为读路径（`snapshot` / `advise`）也要用它——只在写路径跨天，
 * 会让「零点后第一次读」拿到昨天的读数。
 * @param state 旧状态。
 * @param dayKey 当前自然日键。
 */
export function rollTo(state: HealthState, dayKey: string): HealthState {
  if (state.dayKey === dayKey) return state
  return Object.freeze({ ...emptyState(dayKey), everPulsed: state.everPulsed })
}

/** 判定入参。 */
export interface JudgeInput {
  /** 状态。 */
  readonly state: HealthState
  /** 时刻。 */
  readonly at: number
  /** 配置。 */
  readonly settings: Config
  /** 此刻是否落在深夜窗内。 */
  readonly lateNight: boolean
}

/** 判定结果。 */
export interface JudgeResult {
  /** 档位。 */
  readonly level: HealthLevel
  /** 命中的信号，按档位从高到低。 */
  readonly reasons: readonly HealthReason[]
  /** 连续段分钟数。 */
  readonly sessionMinutes: number
  /** 当日累计分钟数。 */
  readonly dayMinutes: number
  /** 距最近打点的分钟数。 */
  readonly idleMinutes: number | null
  /** 数据状态。 */
  readonly state: 'measured' | 'never-pulsed'
}

/**
 * 判定此刻该在哪一档。**纯函数。**
 *
 * 叠加规则（刻意不做成配置）：
 * - 只有连续时长能推到 `stop`——当日累计再长，也只是一句「今天够了」；
 * - 深夜单独出现只到 `gentle`（半夜醒来用十分钟不该被当成熬夜）；
 * - **深夜 + 连续超门槛才升到 `firm`**：两个信号叠在一起才是真的该劝。
 * @param input 入参。
 */
export function judge(input: JudgeInput): JudgeResult {
  const { state, at, settings, lateNight } = input
  const { sessionMinutes, idleMinutes } = derive(state, at, settings.breakMinutes)
  const dayMinutes = minutesOf(state.dayMs)
  const reasons: HealthReason[] = []
  const dataState: 'measured' | 'never-pulsed' = state.everPulsed ? 'measured' : 'never-pulsed'

  if (dataState === 'never-pulsed') {
    // 一次打点都没有：不猜、不报平安。档位恒 ok，由 state 字段把话说清。
    return { level: 'ok', reasons: [], sessionMinutes, dayMinutes, idleMinutes, state: dataState }
  }

  let level: HealthLevel = 'ok'

  if (sessionMinutes >= settings.sessionStopMinutes) {
    level = 'stop'
    reasons.push({
      code: 'session-too-long',
      minutes: sessionMinutes,
      detail: '连续使用已超过收工阈值',
    })
  } else if (sessionMinutes >= settings.sessionWarnMinutes) {
    level = maxLevel(level, 'gentle')
    reasons.push({
      code: 'session-long',
      minutes: sessionMinutes,
      detail: '连续使用已超过提醒阈值',
    })
  }

  if (dayMinutes >= settings.dailyWarnMinutes) {
    level = maxLevel(level, 'gentle')
    reasons.push({
      code: 'daily-long',
      minutes: dayMinutes,
      detail: '当日累计已超过阈值',
    })
  }

  // 深夜只在这个人**此刻还在用**时才算信号。已经两小时没动静的人多半是睡了，
  // 那时给一句「该睡了」既不成立也很吓人。
  const active = idleMinutes !== null && idleMinutes < settings.breakMinutes
  if (lateNight && active) {
    level = maxLevel(level, 'gentle')
    reasons.push({
      code: 'late-night',
      minutes: 0,
      detail: '当前处在深夜窗内且仍在活动',
    })
    if (sessionMinutes >= settings.sessionWarnMinutes) level = maxLevel(level, 'firm')
  }

  return { level, reasons, sessionMinutes, dayMinutes, idleMinutes, state: dataState }
}

/**
 * 一句话标签。**不含数字、不含分数、不是话术。**
 *
 * 话术归人格与 O-047：这里只给调用方一个能进日志、能进调试面板的短标签。
 * 时长在 `sessionMinutes` / `dayMinutes` 字段里，要报就由调用方自己拼——
 * 一旦这里开始写句子，它迟早会变成第二份话术真源。
 * @param level 档位。
 * @param state 数据状态。
 */
export function noteOf(level: HealthLevel, state: 'measured' | 'never-pulsed'): string {
  if (state === 'never-pulsed') return '还没有收到过活动打点，护栏此刻没有在工作'
  if (level === 'stop') return '连续使用已经很长，该收工了'
  if (level === 'firm') return '深夜还在连着用，该认真劝一句'
  if (level === 'gentle') return '用了一会儿了，可以歇一歇'
  return '没发现需要劝的地方'
}

/**
 * 组装只读快照。
 * @param state 状态。
 * @param at 时刻。
 * @param settings 配置。
 * @param stored 是否落盘。
 */
export function snapshotOf(
  state: HealthState,
  at: number,
  settings: Config,
  stored: boolean,
): HealthSnapshot {
  const { sessionMinutes, idleMinutes } = derive(state, at, settings.breakMinutes)
  return Object.freeze({
    dayKey: state.dayKey,
    dayMinutes: minutesOf(state.dayMs),
    sessionMinutes,
    sessionStart: sessionMinutes > 0 ? state.sessionStart : null,
    lastPulseAt: state.lastPulseAt,
    idleMinutes,
    acknowledged: state.acknowledged,
    nudges: state.nudges,
    pulses: state.pulses,
    stored,
  })
}
