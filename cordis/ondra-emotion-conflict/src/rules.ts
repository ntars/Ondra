/**
 * 冲突锁的**全部判定**都在这个文件里。
 *
 * 为什么强制集中：第 31 轮的教训——`explain()` 用一套判据、`observe()` 用另一套，
 * 两边都不报错，只是「面板说的」和「系统做的」不一样。
 * 所以本文件只暴露一个 `resolveStatus()`，`status()` / `enter()` / `signal()` /
 * `release()` / `behavior()` / `directive()` / `explain()` 全部走它。
 *
 * 本文件不碰 ctx、不读盘、不打日志。
 */

import {
  LOCK_STRESS,
  LOCK_TENSION,
  MOOD_CEILING,
  MOOD_RISE,
  POSITIVE_STREAK,
  REASON_ZH,
  RELEASE_TENSION_MAX,
  TENSION_ADD,
  type ConflictLock,
  type ConflictReading,
  type ConflictReason,
  type ConflictStatus,
  type PromptFragment,
  type SignalKind,
} from './types.js'

/**
 * 超过这个时长仍在锁里，`note` 会带上「已持续 N 小时」。
 *
 * 一天：足够长到「不是刚吵完」，又短到能在面板上被看见。
 * 它只影响一句话，不影响任何判定——**本插件没有「超时自动解锁」**，
 * 因为手册只给了两条解锁路，第三条会让她被晾着晾到自动消气。
 */
export const LONG_LOCK_HOURS = 24

const MS_PER_HOUR = 3_600_000

/** 心情闸的三种结果。 */
export type MoodGate = 'pass' | 'low' | 'unknown'

/** 夹到 0–1；非有限值按 0。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 张力是否越过炸毛线。 */
export function tensionTriggered(tension: number): boolean {
  return clamp01(tension) > LOCK_TENSION
}

/** 应激是否越过 0.85。 */
export function stressTriggered(stress: number): boolean {
  return clamp01(stress) > LOCK_STRESS
}

/**
 * 心情闸。
 *
 * 「回升过阈」读成两条同时成立：**高于平静档下界**（§3.2 六态 `0.45`）
 * 且**高于进锁那一刻**。只看前者会出现「吵架时心情 0.6、现在 0.46，
 * 面板说哄好了、她心里其实还更差」。
 *
 * 读不到情绪（没接 O-026）时给 `unknown`，由调用方按「放行」处理——
 * 宁可早解一次，也不能因为读不到而永久锁死（那表现是「哄一整天都没用」）。
 * @param moodAtLock 进锁那一刻的心情。
 * @param reading 当前读数。
 */
export function moodGateOf(moodAtLock: number | undefined, reading: ConflictReading): MoodGate {
  if (reading.source !== 'emotion') return 'unknown'
  if (clamp01(reading.mood) < MOOD_RISE) return 'low'
  if (moodAtLock === undefined) return 'pass'
  return clamp01(reading.mood) > clamp01(moodAtLock) ? 'pass' : 'low'
}

/**
 * 正向信号这条路能不能解锁。
 *
 * `unknown`（读不到心情）按放行：见 `moodGateOf()` 的理由。
 * @param streak 连续正向信号数。
 * @param gate 心情闸。
 */
export function canReleaseByPositives(streak: number, gate: MoodGate): boolean {
  return streak >= POSITIVE_STREAK && gate !== 'low'
}

/** `resolveStatus()` 的入参。 */
export interface RuleInput {
  /** 存储里的锁。 */
  readonly lock: ConflictLock
  /** 当前情绪读数。 */
  readonly reading: ConflictReading
  /** 判定时刻。 */
  readonly at: number
  /** 总开关。关掉时永不锁。 */
  readonly enabled: boolean
}

/** 把毫秒差换成「N 小时」文本。 */
function hoursText(since: number, at: number): string {
  const hours = Math.max(0, Math.floor((at - since) / MS_PER_HOUR))
  return `${hours}`
}

/**
 * 唯一的判定函数。
 * @param input 入参。
 */
export function resolveStatus(input: RuleInput): ConflictStatus {
  const { lock, reading, at, enabled } = input
  const tensionOver = tensionTriggered(reading.tension)
  const stressOver = stressTriggered(reading.stress)
  const stored = lock.locked && enabled
  // 阈值只作**派生**：存储里已经锁着时不再重复算一份，免得两个来源各报一个原因。
  const threshold = enabled && !stored && (tensionOver || stressOver)
  const locked = stored || threshold
  const reason: ConflictReason | undefined = stored ? lock.reason : threshold ? 'threshold' : undefined
  const since = stored ? lock.since : 0
  const gate = moodGateOf(lock.moodAtLock, reading)
  const canRelease = canReleaseByPositives(lock.positiveStreak, gate)

  let note: string
  if (!enabled) {
    note = '冲突锁已关闭（配置）'
  } else if (stored) {
    const cause = lock.reason === undefined ? '未知原因' : REASON_ZH[lock.reason]
    const streak = `正向信号 ${lock.positiveStreak}/${POSITIVE_STREAK}`
    const moodPart =
      gate === 'low' ? `心情 ${reading.mood.toFixed(2)} 未回升（需 ≥${MOOD_RISE} 且高于进锁时）` : '心情已回升'
    const longPart = at - since > LONG_LOCK_HOURS * MS_PER_HOUR ? `，已持续 ${hoursText(since, at)} 小时` : ''
    note = `冲突锁生效（${cause}）：${streak}，${moodPart}${longPart}`
  } else if (threshold) {
    const which: string[] = []
    if (tensionOver) which.push(`张力 ${reading.tension.toFixed(2)} 高于 ${LOCK_TENSION}`)
    if (stressOver) which.push(`应激 ${reading.stress.toFixed(2)} 高于 ${LOCK_STRESS}`)
    note = `${which.join('、')}，按冲突处理（阈值派生，未落盘）`
  } else {
    note = '没有冲突锁'
  }

  return Object.freeze({
    at,
    locked,
    stored,
    threshold,
    reason,
    since,
    positiveStreak: lock.positiveStreak,
    reading,
    tensionTriggered: tensionOver,
    stressTriggered: stressOver,
    moodGate: gate,
    canRelease,
    note,
  })
}

/**
 * 进锁后的锁状态（纯变换）。
 *
 * `already` 时**原样返回**：同一次吵架里被判定十次，张力只加一次——
 * 否则「她说了三句难听话」会把张力一路推到顶，而手册说的是「一次冲突 +0.15」。
 * @param lock 现有锁。
 * @param reason 原因。
 * @param reading 进锁时的读数。
 * @param at 时刻。
 */
export function withEnter(
  lock: ConflictLock,
  reason: ConflictReason,
  reading: ConflictReading,
  at: number,
): ConflictLock {
  if (lock.locked) return lock
  return Object.freeze({
    locked: true,
    reason,
    since: at,
    moodAtLock: reading.source === 'emotion' ? clamp01(reading.mood) : undefined,
    tensionAtLock: clamp01(reading.tension),
    // 新一场吵架，正向计数从头数。
    positiveStreak: 0,
    releases: lock.releases,
  })
}

/** 进锁时要给调用方的两个建议值。 */
export interface EnterSuggestion {
  /** 建议的张力增量。 */
  readonly tensionAdd: number
  /** 建议的心情上限。 */
  readonly moodCeiling: number
}

/** 进锁建议（`already` 时全为「什么都不做」）。 */
export function enterSuggestion(outcome: 'entered' | 'already' | 'disabled'): EnterSuggestion {
  if (outcome !== 'entered') return Object.freeze({ tensionAdd: 0, moodCeiling: 1 })
  return Object.freeze({ tensionAdd: TENSION_ADD, moodCeiling: MOOD_CEILING })
}

/**
 * 解锁后的锁状态（纯变换）。
 * @param lock 现有锁。
 */
export function withRelease(lock: ConflictLock): ConflictLock {
  return Object.freeze({
    locked: false,
    reason: undefined,
    since: 0,
    moodAtLock: undefined,
    tensionAtLock: undefined,
    positiveStreak: 0,
    // 解锁次数只增不减：它是跨会话的，「这段关系哄好过多少次」值得留。
    releases: lock.releases + 1,
  })
}

/** 收到信号后的锁状态（纯变换；解锁由服务另行调用 `withRelease`）。 */
export function withSignal(lock: ConflictLock, kind: SignalKind): ConflictLock {
  if (kind === 'negative') {
    // 再怼一句，正向计数归零。注意**不因此重新锁一次**：
    // 已经锁着的话没什么可加的；没锁的话，负向信号本身不构成「一次冲突事件」
    // （那要上游明确 `enter('negation')`），这里只负责把哄好的进度清掉。
    if (lock.positiveStreak === 0) return lock
    return Object.freeze({ ...lock, positiveStreak: 0 })
  }
  if (kind === 'positive') {
    return Object.freeze({ ...lock, positiveStreak: lock.positiveStreak + 1 })
  }
  // 致歉不计入正向计数：它走的是另一条路（立即解锁），
  // 两边都记会让「一次道歉」看起来像「两次正向信号」。
  return lock
}

/** 解锁建议。 */
export interface ReleaseSuggestion {
  /** 建议的张力上限。 */
  readonly tensionMax: number
  /** 是否建议顺手调 O-026 的 `comfort()`。 */
  readonly comfortSuggested: boolean
}

/**
 * 解锁建议。
 * @param by 途径。
 */
export function releaseSuggestion(by: 'apology' | 'positives'): ReleaseSuggestion {
  return Object.freeze({
    tensionMax: RELEASE_TENSION_MAX,
    // 致歉走 O-026 的 `comfort()`：它自己只降 0.08（保留嘴硬，§3.2）。
    // 本插件不复制这个数，只举一只手说「该调它了」。
    comfortSuggested: by === 'apology',
  })
}

/* ------------------------------------------------------------------ *
 * 行为指令（器官 ABI §8.1）
 * ------------------------------------------------------------------ */

/**
 * 冲突语域指令正文（**逐字**改写自手册 §3.2 的那句产品口径）。
 *
 * 手册原文：「锁定期间不撒娇、不主动、回复变短」。
 * 正文不含任何数字、不写情绪代号——「回复变短」的系数归 O-038 / O-040，
 * 在这里再写一个 0.6 就是第二个真源。
 */
export const CONFLICT_DIRECTIVE_TEXT = '[关系] 你还在生气：不撒娇、不主动找他、话短一点。'

/** 构造指令所需的两个工程参数。 */
export interface DirectiveSettings {
  /** 存活时长（分钟）。 */
  readonly directiveTtlMinutes: number
  /** 排序键（已夹到 [-1000, -1]）。 */
  readonly directiveOrder: number
}

/**
 * 按当前状态决定要不要出指令。
 *
 * **没锁就不出**（返回 `undefined`，不返回空片段：空片段会占掉一个拼装位、
 * 还可能被算进预算，而它一个字都没说）。
 * @param status 当前状态（走 `resolveStatus()` 那一个判定）。
 * @param settings 工程参数。
 */
export function buildDirective(
  status: ConflictStatus,
  settings: DirectiveSettings,
): PromptFragment | undefined {
  if (!status.locked) return undefined
  return Object.freeze({
    order: settings.directiveOrder,
    ttlMinutes: settings.directiveTtlMinutes,
    // 直接由状态导出，没有推断环节，置信度就是 1。
    confidence: 1,
    text: CONFLICT_DIRECTIVE_TEXT,
    kind: 'conflict',
  })
}

