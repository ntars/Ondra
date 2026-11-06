/**
 * 在场判定（纯函数，**无 IO、无定时器、无副作用**）。
 *
 * 本文件是整个插件的判定核心：给同样的状态、同样的口径、同样的时刻，
 * 永远得到同样的结论。这样「她今天为什么忽然以为我走了」才查得出来。
 *
 * ## 三条最容易被做错的地方
 *
 * 1. **读不到 ≠ 人不在。** 两个状态分开（`unknown` / `idle`），且判据也分开：
 *    只有「最近一次成功读数之后又来了一次读不到」才走 `unknown`。
 *    合成一个之后，没给权限的机器上她会永远以为自己被丢下了。
 * 2. **抖动不切段。** 一段类目存活不满 `stabilityMs` 就被换掉，算「抖了一下」：
 *    不结束当前段，只把这次换手记进窗口。否则每次切窗口都换一次判断，
 *    她的观察永远慢一拍，而且「散着」这个状态永远抓不到——因为每段都太短，
 *    短到还没资格被判成任何东西。
 * 3. **不认识的类目一律 `unknown`，不就近归并。** 就近归并会让「开会」被并进
 *    「看东西」，于是会议中她照样开口——而那是最不该开口的场合。
 */

import {
  CATEGORY_ZH,
  SCREEN_CATEGORIES,
} from './types.js'
import type {
  PresenceState,
  ScreenCategory,
  ScreenSignal,
  ScreenView,
  SenseHint,
  SensePolicy,
} from './types.js'

/**
 * 换手时刻的最大保留条数。
 *
 * 存时刻数组是为了算「窗口内换了几次」，但数组必须有上限：
 * 一台连开三天的机器如果不封顶，这个数组会长成一个日志文件。
 * 超限时丢最早的——反正最早的那些早已落在统计窗口之外。
 */
export const MAX_HANDOVERS = 64

/**
 * 落盘的状态。
 *
 * **只有时刻与计数。** 没有一个字段能还原「主人在看什么」：
 * 没有标题、没有应用名、没有文件路径、没有网址、没有截图。
 */
export interface ScreenState {
  /** 最近一次**读到**读数的时刻；从没读到为 `null`。 */
  readonly lastAt: number | null
  /** 最近一次**读不到**的时刻；从没发生为 `null`。 */
  readonly lastMissAt: number | null
  /** 当前段起点；没有段为 `null`。 */
  readonly segmentStart: number | null
  /** 当前类目。从没读到过为 `unknown`。 */
  readonly category: ScreenCategory
  /** 换手时刻（真切换 + 被吸收的抖动），升序，长度上限 `MAX_HANDOVERS`。 */
  readonly handovers: readonly number[]
  /** 累计被吸收的抖动次数。 */
  readonly glitches: number
  /** 累计接受的采样数。 */
  readonly notes: number
  /** 累计因节流丢弃的采样数。 */
  readonly dropped: number
  /** 累计读不到次数。 */
  readonly misses: number
  /** 重来次数。 */
  readonly resets: number
}

/** 空状态。 */
export function emptyState(): ScreenState {
  return {
    lastAt: null,
    lastMissAt: null,
    segmentStart: null,
    category: 'unknown',
    handovers: [],
    glitches: 0,
    notes: 0,
    dropped: 0,
    misses: 0,
    resets: 0,
  }
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

/** 类目归一化。**不在闭集里的一律 `unknown`**，不就近归并。 */
export function normalizeCategory(value: unknown): ScreenCategory {
  if (typeof value !== 'string') return 'unknown'
  const hit = SCREEN_CATEGORIES.find((item) => item === value)
  return hit === undefined ? 'unknown' : hit
}

/**
 * 时间戳数组归一化：只留有限非负数、升序、截断到上限。
 * @param value 任意值。
 * @returns 干净的时刻数组。
 */
export function normalizeStamps(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return []
  const kept: number[] = []
  for (const item of value) {
    if (isStamp(item)) kept.push(item)
  }
  kept.sort((a, b) => a - b)
  return kept.slice(-MAX_HANDOVERS)
}

/** 存档归一化。**任何畸形输入都退化成空状态，绝不抛。** */
export function normalizeState(value: unknown): ScreenState {
  if (value === null || typeof value !== 'object') return emptyState()
  const raw = value as Record<string, unknown>
  return {
    lastAt: isStamp(raw.lastAt) ? raw.lastAt : null,
    lastMissAt: isStamp(raw.lastMissAt) ? raw.lastMissAt : null,
    segmentStart: isStamp(raw.segmentStart) ? raw.segmentStart : null,
    category: normalizeCategory(raw.category),
    handovers: normalizeStamps(raw.handovers),
    glitches: countOf(raw.glitches),
    notes: countOf(raw.notes),
    dropped: countOf(raw.dropped),
    misses: countOf(raw.misses),
    resets: countOf(raw.resets),
  }
}

/**
 * 解析一次采样。类目不在闭集或时刻不合法就返回 `null`（调用方抛 `bad-request`）。
 * @param value 任意输入。
 * @param fallbackAt 缺省时刻。
 * @returns 合法采样或 `null`。
 */
export function readSignal(value: unknown, fallbackAt: number): ScreenSignal | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.category !== 'string') return null
  const at = raw.at === undefined ? fallbackAt : raw.at
  if (!isStamp(at)) return null
  return { category: normalizeCategory(raw.category), at }
}

/**
 * 一次采样的处理结果。
 *
 * `reason` 是**可分辨的**：被节流、读不到、乱序各有各的值。
 * 折进一个 `false` 之后，外壳就再也查不出「为什么她一直不知道我在干什么」。
 */
export interface AdvanceResult {
  /** 新状态。 */
  readonly state: ScreenState
  /** 是否被接受（节流丢弃与乱序为 `false`）。 */
  readonly accepted: boolean
  /** 结果归类。 */
  readonly reason: 'accepted' | 'throttled' | 'miss' | 'out-of-order'
}

/**
 * 处理一次采样。
 *
 * 判定顺序：乱序 → 节流 → 读不到 → 同类目 → 抖动 → 真切换。
 *
 * @param state 旧状态。
 * @param category 类目。
 * @param at 时刻。
 * @param policy 口径。
 * @returns 新状态与归类。
 */
export function advance(
  state: ScreenState,
  category: ScreenCategory,
  at: number,
  policy: SensePolicy,
): AdvanceResult {
  // 乱序：时钟回拨时不倒退水位，否则「多久没读到」会变成负数。
  if (state.lastAt !== null && at < state.lastAt) {
    return { state, accepted: false, reason: 'out-of-order' }
  }
  // 节流：采样太密就不接。这里是唯一的「能量闸」——采样有代价。
  if (state.lastAt !== null && at - state.lastAt < policy.minIntervalMs) {
    return {
      state: { ...state, dropped: state.dropped + 1 },
      accepted: false,
      reason: 'throttled',
    }
  }

  // 读不到：只记时刻，**不动类目、不动段、不动 lastAt**。
  // 动了 lastAt 就会把「读不到」记成「刚活动过」，于是她永远不判 idle。
  if (category === 'unknown') {
    return {
      state: { ...state, lastMissAt: at, notes: state.notes + 1, misses: state.misses + 1 },
      accepted: true,
      reason: 'miss',
    }
  }

  // 同类目：只推进 lastAt，段继续。
  if (category === state.category) {
    return {
      state: { ...state, lastAt: at, notes: state.notes + 1 },
      accepted: true,
      reason: 'accepted',
    }
  }

  // 抖动：当前段还没活够 stabilityMs 就想被换掉 → 不切段，只记一次换手。
  // 记进 handovers 很关键：反复横跳正是「散着」的证据，抖动不能白丢。
  if (state.segmentStart !== null && at - state.segmentStart < policy.stabilityMs) {
    return {
      state: {
        ...state,
        lastAt: at,
        notes: state.notes + 1,
        glitches: state.glitches + 1,
        handovers: appendStamp(state.handovers, at),
      },
      accepted: true,
      reason: 'accepted',
    }
  }

  // 真切换：开新段。
  return {
    state: {
      ...state,
      lastAt: at,
      notes: state.notes + 1,
      segmentStart: at,
      category,
      handovers: appendStamp(state.handovers, at),
    },
    accepted: true,
    reason: 'accepted',
  }
}

/** 追加一个时刻并截到上限。 */
function appendStamp(list: readonly number[], at: number): readonly number[] {
  const next = [...list, at]
  return next.length > MAX_HANDOVERS ? next.slice(-MAX_HANDOVERS) : next
}

/**
 * 统计窗口内的换手次数。
 * @param state 状态。
 * @param policy 口径。
 * @param now 现在。
 * @returns 次数。
 */
export function handoversWithin(state: ScreenState, policy: SensePolicy, now: number): number {
  const from = now - policy.scatterWindowMs
  let hits = 0
  for (const at of state.handovers) {
    // 未来时刻不算：时钟回拨时它们会全落在窗口里，凭空判成「散着」。
    if (at >= from && at <= now) hits += 1
  }
  return hits
}

/**
 * 在场状态。优先级：unknown > idle > scattered > focused > wandering。
 * @param state 状态。
 * @param policy 口径。
 * @param now 现在。
 * @returns 状态。
 */
export function presenceOf(state: ScreenState, policy: SensePolicy, now: number): PresenceState {
  if (state.lastAt === null) return 'unknown'

  if (now - state.lastAt >= policy.idleMs) {
    // 沉默期里如果最近一次是「读不到」，那不是人不在，是不知道。
    if (state.lastMissAt !== null && state.lastMissAt > state.lastAt) return 'unknown'
    return 'idle'
  }

  if (handoversWithin(state, policy, now) >= policy.scatterSwitches) return 'scattered'

  if (state.segmentStart !== null && now - state.segmentStart >= policy.focusMs) return 'focused'
  return 'wandering'
}

/**
 * 只读视图。
 * @param state 状态。
 * @param policy 口径。
 * @param now 现在。
 * @param sessionMinutes O-105 的连续使用分钟数；读不到为 `null`。
 * @param stored 是否真的落盘。
 * @returns 视图。
 */
export function viewOf(
  state: ScreenState,
  policy: SensePolicy,
  now: number,
  sessionMinutes: number | null,
  stored: boolean,
): ScreenView {
  const measured = state.lastAt !== null
  const dwellMs =
    state.segmentStart === null || !measured ? null : Math.max(0, now - state.segmentStart)

  return {
    category: state.category,
    categoryZh: CATEGORY_ZH[state.category],
    state: presenceOf(state, policy, now),
    since: state.segmentStart,
    dwellMs,
    handovers: handoversWithin(state, policy, now),
    glitches: state.glitches,
    notes: state.notes,
    dropped: state.dropped,
    sessionMinutes: policy.followSession ? sessionMinutes : null,
    measured,
    stored,
  }
}

/**
 * 可说的话。**只有三个类目、只有一个状态能取到台词。**
 *
 * 每一句都不含数字、不含窗口信息、不评价。会议中、看片时、切换中、
 * 人不在、读不到——一律 `null`：她安静不代表她不在，乱说才代表。
 */
export const LINES: Readonly<Record<ScreenCategory, string | null>> = Object.freeze({
  coding: '主人还在弄那个呀，玖玖在旁边待着。',
  writing: '主人写着呢，玖玖不吵。',
  reading: '主人看着东西呢，玖玖守着。',
  meeting: null,
  media: null,
  browsing: null,
  gaming: null,
  idle: null,
  unknown: null,
})

/** 恒定四条禁令。**每一档都在，连「不该说话」时也照样给。** */
export const MUST_NOT: readonly string[] = Object.freeze([
  '不提窗口标题、应用名、文件名、网址——说出口就等于承认「我一直在看你的屏幕」。',
  '不报时长、不报切换次数：时长归 O-105，报数归 O-032 的禁报数铁律。',
  '不猜具体内容。「你在写情书吧」猜对了是惊悚，猜错了是冒犯。',
  '读不到时就承认读不到，不许假装知道。',
])

/** 状态 → 为什么不说（中文，不含数字）。 */
const WHY: Readonly<Record<PresenceState, string>> = Object.freeze({
  unknown: '读不到，那就当不知道，不说。',
  idle: '人不在，说了没人听。',
  scattered: '正在来回切，这时候插话就是添乱。',
  focused: '在做一件事，可以轻轻应一声。',
  wandering: '刚换过来，还没坐稳，先不开口。',
})

/**
 * 只读观察。
 * @param view 视图。
 * @returns 观察。
 */
export function hintOf(view: ScreenView): SenseHint {
  const say = view.state === 'focused' ? LINES[view.category] : null
  return {
    category: view.category,
    state: view.state,
    confidence: view.state === 'unknown' ? 'none' : 'read',
    say,
    mustNot: MUST_NOT,
    note: WHY[view.state],
  }
}
