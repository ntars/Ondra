/**
 * 三态判定（纯函数，**无 IO、无定时器、无副作用**）。
 *
 * 本文件是整个插件的判定核心：给同样的记录、同样的口径、同样的时刻，
 * 永远得到同样的结论。这样「她今天为什么忽然冒出来一句」才查得出来。
 *
 * ## 四条最容易做错的地方
 *
 * 1. **密度高只会更安静。** 手在飞快动的时候是这个人最专注的时候，
 *    也是任何插话最刺人的时候。故 `busy` 一路压到 `quiet`，绝不参与 `ready`。
 * 2. **`ready` 的唯一来路是「密集刚停」。** 静默再久也只给 `near`。
 *    久不说话的人回来，第一句话该由「他回来了」决定，不该由「检测到空闲」决定。
 * 3. **三态里没有数字。** 判定过程用计数，出门的形状里一个数都没有——
 *    这不是洁癖：只要视图里带着 `beats`，迟早会有人把它拼进一句话。
 * 4. **`idle` 声明是权威。** 外壳的「空闲」通常来自系统空闲计时器，比本插件
 *    用事件间隔推算的更准，所以它一到就照单全收，并把内存里的密度窗口清零：
 *    「刚才动过」这件事已经被「刚才没动过」覆盖了。
 *
 * ## 判定只用两样东西
 *
 * - **落盘记录**：两个时刻（最近一次输入、最近一次空闲声明）+ 三个计数。
 * - **内存窗口**：最近若干个事件的**时刻**（不落盘），只用来算密度。
 *
 * 判定不依赖任何可变记忆变量：`burstOpen` / `burstStartAt` 只喂诊断计数，
 * 不参与三态。这样即便进程刚重启、内存窗口是空的，判定口径也不会变。
 */

import { AMBIENT_EVENT_TYPES, STATE_ZH } from './types.js'
import type {
  AmbientEvent,
  AmbientEventType,
  AmbientPolicy,
  AmbientState,
  DecisionSource,
  Nudge,
  Reaction,
  Snapshot,
} from './types.js'

/**
 * 内存窗口最多保留多少个事件时刻。
 *
 * 480 = 最短间隔 250 毫秒下两分钟的量（240 条/分 × 2 分）。两分钟刚好覆盖
 * `settleMs + burstMinMs` 这两个窗口的最坏情况（默认 45 + 20 秒）。
 * 封顶是必须的：一台连开三天的机器如果不封顶，这个数组会长成一个日志文件。
 */
export const MAX_STAMPS = 480

/** 密度窗口（毫秒）。取 20 秒：比一次换气长，比一段工作短。 */
export const DENSITY_WINDOW_MS = 20_000

/**
 * 状态稳定期（毫秒）。
 *
 * 刚翻状态的一小段时间里 `settled` 为 `false`，外壳据此可以先不动作。
 * 防的是临界点上密度反复跨线导致的来回闪——三态里的任何一档闪两次，
 * 外壳就会把两次都当成真的。
 */
export const SETTLE_HYSTERESIS_MS = 5_000

/**
 * 落盘记录。
 *
 * **只有三个计数与两个时刻。** 没有一个字段能还原「主人敲了什么」：
 * 没有键值、没有间隔序列、没有窗口名、没有应用名、没有内容。
 */
export interface AmbientRecord {
  /** 最近一次**输入**（key / mouse）的时刻；从没观测到为 `null`。 */
  readonly lastAt: number | null
  /** 最近一次**空闲声明**的时刻；从没声明为 `null`。 */
  readonly lastIdleAt: number | null
  /** 累计接受的事件数。 */
  readonly beats: number
  /** 累计成立的密集段次数。 */
  readonly bursts: number
  /** 累计被丢弃的事件数（太密 / 乱序）。 */
  readonly ignored: number
}

/** 内存状态。**不落盘**：密度窗口是过程量，存下来就等于存了一份击键节奏。 */
export interface AmbientMemory {
  /** 最近若干个输入事件的时刻（升序，上限 `MAX_STAMPS`）。 */
  readonly stamps: readonly number[]
  /** 当前是否处在一段密集输入里（只喂诊断计数）。 */
  readonly burstOpen: boolean
  /** 当前密集段的起点（只喂诊断计数）。 */
  readonly burstStartAt: number | null
  /** 上一次算出来的状态，用于判断「有没有翻档」。 */
  readonly lastState: AmbientState
  /** 最近一次翻档时刻；从没翻过为 `null`。 */
  readonly changedAt: number | null
}

/** 空记录。 */
export function emptyRecord(): AmbientRecord {
  return { lastAt: null, lastIdleAt: null, beats: 0, bursts: 0, ignored: 0 }
}

/** 空内存。 */
export function emptyMemory(): AmbientMemory {
  return { stamps: [], burstOpen: false, burstStartAt: null, lastState: 'quiet', changedAt: null }
}

/** 有限的非负时间戳。 */
function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 计数：非有限数或负数一律归零。 */
function countOf(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.floor(num)
}

/** 存档归一化。**任何畸形输入都退化成空记录，绝不抛。** */
export function normalizeRecord(value: unknown): AmbientRecord {
  if (value === null || typeof value !== 'object') return emptyRecord()
  const raw = value as Record<string, unknown>
  return {
    lastAt: isStamp(raw.lastAt) ? raw.lastAt : null,
    lastIdleAt: isStamp(raw.lastIdleAt) ? raw.lastIdleAt : null,
    beats: countOf(raw.beats),
    bursts: countOf(raw.bursts),
    ignored: countOf(raw.ignored),
  }
}

/** 事件类型归一化。**不在闭集里的一律 `null`**，不就近归并。 */
export function normalizeEventType(value: unknown): AmbientEventType | null {
  if (typeof value !== 'string') return null
  const hit = AMBIENT_EVENT_TYPES.find((item) => item === value)
  return hit === undefined ? null : hit
}

/**
 * 解析一次事件。类型不在闭集或时刻不合法就返回 `null`（调用方抛 `bad-request`）。
 * **刻意只读 `type` 与 `at` 两个键**：外壳多塞的字段一律看不见，也就不可能被记住。
 * @param value 任意输入。
 * @param fallbackAt 缺省时刻。
 * @returns 合法事件或 `null`。
 */
export function readEvent(value: unknown, fallbackAt: number): AmbientEvent | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const type = normalizeEventType(raw.type)
  if (type === null) return null
  const at = raw.at === undefined ? fallbackAt : raw.at
  if (!isStamp(at)) return null
  return { type, at }
}

/** 某个窗口内需要多少条事件才算「密集」。**用率换算，不用绝对值**，口径才跟窗口长短无关。 */
function thresholdIn(policy: AmbientPolicy, windowMs: number): number {
  return Math.max(1, Math.ceil((policy.busyPerMin * windowMs) / 60_000))
}

/** 数一数 `[from, to]` 里有多少条时刻（含两端）。 */
export function stampsWithin(stamps: readonly number[], from: number, to: number): number {
  let hits = 0
  for (const at of stamps) {
    if (at >= from && at <= to) hits += 1
  }
  return hits
}

/**
 * 现在这一刻的密度够不够「密集」。
 * @param stamps 内存窗口。
 * @param policy 口径。
 * @param now 现在。
 * @returns 是否密集。
 */
export function isBusy(stamps: readonly number[], policy: AmbientPolicy, now: number): boolean {
  const hits = stampsWithin(stamps, now - DENSITY_WINDOW_MS, now)
  return hits >= thresholdIn(policy, DENSITY_WINDOW_MS)
}

/**
 * 静默之前那一段够不够「密集」。
 *
 * 只数 `[now - settleMs - burstMinMs, now - settleMs]` 这一段：它既排除了当前的静默，
 * 也排除了更早的历史。判 `ready` 必须过这一关——**没有忙碌过，就谈不上「刚停下来」**。
 * @param stamps 内存窗口。
 * @param policy 口径。
 * @param now 现在。
 * @returns 是否密集。
 */
export function wasBusyBefore(
  stamps: readonly number[],
  policy: AmbientPolicy,
  now: number,
): boolean {
  const to = now - policy.settleMs
  const from = to - policy.burstMinMs
  return stampsWithin(stamps, from, to) >= thresholdIn(policy, policy.burstMinMs)
}

/** 一次事件的处理结果。`reason` 可分辨，折进一个 `false` 就再也查不出「为什么她一直不知道我在干什么」。 */
export interface AcceptResult {
  /** 新记录。 */
  readonly record: AmbientRecord
  /** 新内存。 */
  readonly memory: AmbientMemory
  /** 是否被接受。 */
  readonly accepted: boolean
  /** 结果归类。 */
  readonly reason: 'accepted' | 'idle' | 'throttled' | 'out-of-order'
}

/**
 * 处理一次事件。**纯函数**：不改入参，只回新值。
 *
 * 判定顺序：乱序 → 节流 → 空闲 → 输入。
 * @param record 旧记录。
 * @param memory 旧内存。
 * @param type 事件类型。
 * @param at 事件时刻（调用方已解析，必然是有限非负数）。
 * @param policy 口径。
 * @returns 新记录、新内存与归类。
 */
export function acceptEvent(
  record: AmbientRecord,
  memory: AmbientMemory,
  type: AmbientEventType,
  at: number,
  policy: AmbientPolicy,
): AcceptResult {
  // 乱序：时钟回拨时不倒退水位，否则「静默多久」会变成负数。
  if (record.lastAt !== null && at < record.lastAt) {
    return {
      record: { ...record, ignored: record.ignored + 1 },
      memory,
      accepted: false,
      reason: 'out-of-order',
    }
  }

  // 空闲声明：只记时刻，**绝不动 lastAt**。
  // 动了 lastAt 就等于把「没在动」记成「刚动过」，于是静默永远到不了。
  if (type === 'idle') {
    const closed = closeBurst(record, memory, at, policy)
    return {
      record: {
        ...closed.record,
        lastIdleAt: at,
        beats: closed.record.beats + 1,
      },
      memory: {
        ...closed.memory,
        // 密度窗口清零：「刚才动过」已被「刚才没动过」覆盖。
        stamps: [],
      },
      accepted: true,
      reason: 'idle',
    }
  }

  // 节流：两条输入之间太近就丢。这是唯一的「能量闸」，也是隐私的那条线——
  // 全都收下来，就等于收了一份击键节奏。
  if (record.lastAt !== null && at - record.lastAt < policy.minGapMs) {
    return {
      record: { ...record, ignored: record.ignored + 1 },
      memory,
      accepted: false,
      reason: 'throttled',
    }
  }

  const stamps = appendStamp(memory.stamps, at)
  const busy = isBusy(stamps, policy, at)
  const burst = trackBurst(memory, busy, at, policy)

  return {
    record: {
      ...record,
      lastAt: at,
      beats: record.beats + 1,
      bursts: record.bursts + burst.bursts,
    },
    memory: { ...memory, stamps, burstOpen: burst.open, burstStartAt: burst.startAt },
    accepted: true,
    reason: 'accepted',
  }
}

/** 追加一个时刻并截到上限（丢最早的：它们早已落在统计窗口之外）。 */
function appendStamp(stamps: readonly number[], at: number): readonly number[] {
  const next = [...stamps, at]
  return next.length > MAX_STAMPS ? next.slice(-MAX_STAMPS) : next
}

/** 跟踪密集段，只为诊断计数。**不参与三态判定**。 */
function trackBurst(
  memory: AmbientMemory,
  busy: boolean,
  at: number,
  policy: AmbientPolicy,
): { open: boolean, startAt: number | null, bursts: number } {
  if (busy && !memory.burstOpen) {
    return { open: true, startAt: at, bursts: 0 }
  }
  if (!busy && memory.burstOpen) {
    const startAt = memory.burstStartAt
    const long = startAt !== null && at - startAt >= policy.burstMinMs
    return { open: false, startAt: null, bursts: long ? 1 : 0 }
  }
  return { open: memory.burstOpen, startAt: memory.burstStartAt, bursts: 0 }
}

/** 空闲声明到达时收尾当前密集段，同样只为诊断计数。 */
function closeBurst(
  record: AmbientRecord,
  memory: AmbientMemory,
  at: number,
  policy: AmbientPolicy,
): { record: AmbientRecord, memory: AmbientMemory } {
  if (!memory.burstOpen) return { record, memory }
  const startAt = memory.burstStartAt
  const long = startAt !== null && at - startAt >= policy.burstMinMs
  return {
    record: long ? { ...record, bursts: record.bursts + 1 } : record,
    memory: { ...memory, burstOpen: false, burstStartAt: null },
  }
}

/** 判定结果（内部形状，比 `Snapshot` 少一层落盘信息）。 */
export interface Decision {
  /** 反应态。 */
  readonly state: AmbientState
  /** 判定来源。 */
  readonly source: DecisionSource
  /** 是否观测到过输入或空闲声明。 */
  readonly measured: boolean
}

/**
 * 三态裁决。**纯函数，不写盘、不推进。**
 *
 * 优先级：不知道 → 空闲 → 忙碌 → 停稳可接话 → 其余。
 * 「不知道」排在最前是因为它和「忙」处理方式相反：前者要降级，后者要尊重。
 * @param record 记录。
 * @param memory 内存。
 * @param policy 口径。
 * @param now 现在。
 * @returns 状态与来源。
 */
export function decideOf(
  record: AmbientRecord,
  memory: AmbientMemory,
  policy: AmbientPolicy,
  now: number,
): Decision {
  const measured = record.lastAt !== null || record.lastIdleAt !== null
  if (!measured) return { state: 'quiet', source: 'none', measured: false }

  // 空闲声明是权威，且只给 near——**不会自己升到 ready**。
  const idleIsLatest =
    record.lastIdleAt !== null && (record.lastAt === null || record.lastIdleAt >= record.lastAt)
  if (idleIsLatest) return { state: 'near', source: 'idle', measured: true }

  if (record.lastAt === null) return { state: 'quiet', source: 'none', measured: true }

  // 忙碌 → 更安静，绝不参与 ready。
  if (isBusy(memory.stamps, policy, now)) return { state: 'quiet', source: 'busy', measured: true }

  const silence = now - record.lastAt

  // 静默很久 → near，不是 ready。
  if (silence >= policy.idleMs) return { state: 'near', source: 'idle', measured: true }

  // 停稳窗口：静默够久 + 之前在密集做事 + 还没超出可接话窗。
  if (
    silence >= policy.settleMs &&
    silence < policy.settleMs + policy.readyWindowMs &&
    wasBusyBefore(memory.stamps, policy, now)
  ) {
    return { state: 'ready', source: 'settle', measured: true }
  }

  return { state: 'near', source: 'steady', measured: true }
}

/**
 * 只读快照。**没有一个数值字段**。
 * @param decision 裁决。
 * @param memory 内存（只为算「有没有稳定」）。
 * @param now 现在。
 * @param stored 是否真的落盘。
 * @returns 快照。
 */
export function snapshotOf(
  decision: Decision,
  memory: AmbientMemory,
  now: number,
  stored: boolean,
): Snapshot {
  const settled =
    memory.changedAt !== null && now - memory.changedAt >= SETTLE_HYSTERESIS_MS
  return {
    state: decision.state,
    stateZh: STATE_ZH[decision.state],
    confidence: decision.measured ? 'read' : 'none',
    source: decision.source,
    settled,
    measured: decision.measured,
    stored,
  }
}

/** 每一档「为什么是这一档」。**不含数字**。 */
const WHY: Readonly<Record<DecisionSource, string>> = Object.freeze({
  none: '什么都没观测到，就当作不知道，不打扰。',
  busy: '手一直在飞快地动，这时候插话最刺人，退远一点。',
  settle: '手刚停下来，这一刻出现最合适。',
  idle: '静默很久了，先停在「在」，不急着开口——久不说话的人回来，第一句不该由「检测到空闲」决定。',
  steady: '有动静，但不密也没停够，在就够了，不用说话。',
})

/** 恒定五条禁令。**每一档都在，连「不该说话」时也照样给。** */
export const MUST_NOT: readonly string[] = Object.freeze([
  '不报次数、不报时长、不报密度：数量只进 stats()，进了台词就是把陪伴变成仪表盘。',
  '不提键值、窗口、应用名、输入内容：本插件根本没有这些字段，说出来就是编造。',
  '不在 quiet 时出现：忙碌时打扰，是所有打扰里最典型的一种。',
  '不把「静默很久」当成「他回来了」：空闲只给 near，不给 ready。',
  '不自己发消息：要不要说、什么时候说归 O-042 的六道闸，说什么归 O-020。',
])

/**
 * 把快照翻成裁决。**只有 `ready` 且已稳定才允许接一句。**
 * @param snapshot 快照。
 * @returns 裁决。
 */
export function reactionOf(snapshot: Snapshot): Reaction {
  const maySpeak = snapshot.state === 'ready' && snapshot.confidence === 'read' && snapshot.settled
  return {
    state: snapshot.state,
    stateZh: snapshot.stateZh,
    confidence: snapshot.confidence,
    maySpeak,
    reason: WHY[snapshot.source],
    mustNot: MUST_NOT,
  }
}

/** 冒泡配额的判定参数。日界由调用方用 O-003 的 `dayKey` 给，本插件不自己算日历。 */
export interface NudgeQuota {
  /** 上一次冒泡的时刻；从没冒过为 `null`。 */
  readonly lastNudgeAt: number | null
  /** 今天已经冒过几次（调用方按 `dayKey` 归日）。 */
  readonly nudgedToday: number
  /** 一天的上限。 */
  readonly cap: number
  /** 冷却（毫秒）。 */
  readonly cooldownMs: number
}

/**
 * 要不要冒个泡。**纯函数：不写盘、不产生台词、不发送。**
 *
 * 只有 `ready` 且稳定、冷却已过、当日未超上限才「值得」。
 * 三档之外的任何一档都直接不值得——尤其 `near`：`near` 的定义就是「不用说话」。
 * @param snapshot 快照。
 * @param quota 配额。
 * @param now 现在。
 * @returns 判断。
 */
export function nudgeOf(snapshot: Snapshot, quota: NudgeQuota, now: number): Nudge {
  if (!snapshot.measured) {
    return { worth: false, state: snapshot.state, reason: WHY.none, mustNot: MUST_NOT }
  }
  if (snapshot.state !== 'ready') {
    return { worth: false, state: snapshot.state, reason: WHY[snapshot.source], mustNot: MUST_NOT }
  }
  if (!snapshot.settled) {
    return {
      worth: false,
      state: snapshot.state,
      reason: '刚翻到「可以接一句」，再等它稳一稳，别在临界点上抢话。',
      mustNot: MUST_NOT,
    }
  }
  if (quota.lastNudgeAt !== null && now - quota.lastNudgeAt < quota.cooldownMs) {
    return {
      worth: false,
      state: snapshot.state,
      reason: '离上次冒泡太近了，同一个窗口里说两次就成了催。',
      mustNot: MUST_NOT,
    }
  }
  if (quota.nudgedToday >= quota.cap) {
    return {
      worth: false,
      state: snapshot.state,
      reason: '今天的次数用完了，再冒就是打扰。',
      mustNot: MUST_NOT,
    }
  }
  return { worth: true, state: snapshot.state, reason: WHY.settle, mustNot: MUST_NOT }
}
