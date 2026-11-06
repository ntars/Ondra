/**
 * 能量积分（纯函数）。**本文件不碰磁盘、不读时钟。**
 *
 * ## 速率不是常数
 *
 * ```
 * 冻结          → 0        （急停是人按下的「别动」，机器不替人改主意）
 * 高于自然上限  → −0.1/min （你喂它是情分，它自己睡是本分，本分只有半血）
 * 深睡 或 深夜  → +1/min
 * 其余清醒      → +0.2/min
 * ```
 *
 * 顺序不能换：若先判深夜再判上限，一个被喂到 100 的她在凌晨三点会以 +1/min
 * **一直停在 100**——「自然上限」这条规则就失效了，而且看不出失效。
 *
 * ## 为什么必须切片
 *
 * 三个速率由「此刻能量」与「此刻钟点」共同决定，而能量本身又被积分改变。
 * 一次乘法只能用一个速率，跨了深睡门槛或跨了 6 点就会整段用错速率。
 * 5 分钟一片，片首定速率、片尾夹范围，误差上限是「一片内的变化」，
 * 对「她累不累」这个用途足够。
 *
 * ## 缺口太大怎么办
 *
 * 上限 2000 段（≈7 天）。超出的部分**不算**并标 `truncated`：假装算过
 * 会让关机一周后回来看到一个 100 点的她，而那七天里她什么也没经历。
 */

import {
  DEEP_BELOW,
  ENERGY_MAX,
  ENERGY_MIN,
  FEED_DECAY_RATE,
  MAX_SEGMENTS,
  NATURAL_CAP,
  SLEEP_BUFFER_MINUTES,
  SLEEP_RATE,
  STEP_MINUTES,
  WAKE_RATE,
} from './types.js'

/** 能量的落盘形状。 */
export interface EnergyState {
  /** 当前能量 0–100。 */
  readonly energy: number
  /** 结算到的时刻。 */
  readonly settledAt: number
  /** 是否急停冻结。 */
  readonly frozen: boolean
  /** 冻结时刻（0 表示没冻结）。 */
  readonly frozenAt: number
  /** 本觉已经连续睡了多少分钟。 */
  readonly sleepRun: number
  /** 是否有待取走的睡醒缓冲。 */
  readonly bufferPending: boolean
  /** 缓冲对应的睡眠分钟数。 */
  readonly bufferMinutes: number
}

/** 积分需要的外部读数（只有「这一刻是不是深夜」）。 */
export interface EnergyDeps {
  /** 某个时刻是否落在深夜（0–6 点）。 */
  lateNightOf(epoch: number): boolean
}

/** 一次积分的结果。 */
export interface SettleResult {
  readonly state: EnergyState
  /** 走过的段数。 */
  readonly slices: number
  /** 缺口超过上限、只算了最后 `MAX_SEGMENTS` 段。 */
  readonly truncated: boolean
}

/** 夹到 0–100，并保留两位小数（避免 0.30000000000000004 落盘）。 */
export function clampEnergy(value: number): number {
  if (!Number.isFinite(value)) return ENERGY_MIN
  const bounded = Math.min(ENERGY_MAX, Math.max(ENERGY_MIN, value))
  return Math.round(bounded * 100) / 100
}

/**
 * 初始状态。
 * @param at 起始时刻。
 */
export function emptyEnergy(at: number): EnergyState {
  return Object.freeze({
    energy: 80,
    settledAt: at,
    frozen: false,
    frozenAt: 0,
    sleepRun: 0,
    bufferPending: false,
    bufferMinutes: 0,
  })
}

/**
 * 这一刻是不是在睡（深睡或深夜）。**不看冻结**：冻结只是不动，不代表醒着。
 * @param energy 当前能量。
 * @param lateNight 是否深夜。
 */
export function asleepOf(energy: number, lateNight: boolean): boolean {
  return lateNight || energy < DEEP_BELOW
}

/**
 * 当前速率（每分钟）。
 * @param energy 当前能量。
 * @param lateNight 是否深夜。
 * @param frozen 是否冻结。
 */
export function rateOf(energy: number, lateNight: boolean, frozen: boolean): number {
  if (frozen) return 0
  if (energy >= NATURAL_CAP) return -FEED_DECAY_RATE
  if (lateNight || energy < DEEP_BELOW) return SLEEP_RATE
  return WAKE_RATE
}

/**
 * 从 `state.settledAt` 积分到 `to`。
 * @param state 起始状态。
 * @param to 目标时刻。
 * @param deps 外部读数。
 * @param stepMinutes 片长（分钟），默认手册值 5。
 */
export function settleEnergy(
  state: EnergyState,
  to: number,
  deps: EnergyDeps,
  stepMinutes: number = STEP_MINUTES,
): SettleResult {
  if (!Number.isFinite(to) || to <= state.settledAt) {
    return { state, slices: 0, truncated: false }
  }

  const span = Math.max(1, Math.trunc(stepMinutes)) * 60_000

  let from = state.settledAt
  let truncated = false
  const total = Math.ceil((to - from) / span)
  if (total > MAX_SEGMENTS) {
    from = to - MAX_SEGMENTS * span
    truncated = true
  }

  let energy = clampEnergy(state.energy)
  let sleepRun = Math.max(0, state.sleepRun)
  let bufferPending = state.bufferPending
  let bufferMinutes = Math.max(0, state.bufferMinutes)
  let slices = 0

  for (let cursor = from; cursor < to; cursor += span) {
    // 片尾不越过目标时刻：最后一片可能是半片，按实际长度算，否则「结算到 14:03」
    // 会被记成「到 14:05」，一天下来能多出十几分钟。
    const end = Math.min(cursor + span, to)
    const minutes = (end - cursor) / 60_000
    const lateNight = deps.lateNightOf(cursor)

    if (state.frozen) {
      // 冻结：一点不动。但**时间照走**（`settledAt` 跟着前移），
      // 否则解冻那一刻会把冻结期间整段补算回来——那就等于没冻结。
      slices += 1
      continue
    }

    const rate = rateOf(energy, lateNight, false)
    if (rate > 0 && asleepOf(energy, lateNight)) {
      sleepRun += minutes
      // 睡够就算「一觉」；只记第一次，睡更久不会把已攒的缓冲改长。
      if (!bufferPending && sleepRun >= SLEEP_BUFFER_MINUTES) {
        bufferPending = true
        bufferMinutes = sleepRun
      }
    } else {
      sleepRun = 0
    }

    const next = energy + rate * minutes
    // 回落不越过自然上限：60.3 只掉 0.3 就停，不会掉到 59.8 再涨回来来回抖。
    energy = rate < 0 ? Math.max(NATURAL_CAP, Math.min(energy, next)) : clampEnergy(next)
    slices += 1
  }

  return {
    state: Object.freeze({
      energy: clampEnergy(energy),
      settledAt: to,
      frozen: state.frozen,
      frozenAt: state.frozenAt,
      sleepRun: Math.round(sleepRun * 100) / 100,
      bufferPending,
      bufferMinutes: Math.round(bufferMinutes * 100) / 100,
    }),
    slices,
    truncated,
  }
}

/**
 * 取走睡醒缓冲。**取走即清零**（手册 §3.3）：留着会让每次组装提示词都提示一遍。
 * @param state 当前状态。
 * @returns 清空后的状态与「这一觉睡了多少分钟」。
 */
export function takeBuffer(state: EnergyState): { readonly state: EnergyState; readonly minutes?: number } {
  if (!state.bufferPending) {
    return { state, minutes: undefined }
  }
  return {
    state: Object.freeze({ ...state, bufferPending: false, bufferMinutes: 0, sleepRun: 0 }),
    minutes: state.bufferMinutes,
  }
}
