/**
 * 纯状态机：把「外部喂进来的一个时刻」推进成「这一段还在不在、今天学了多久」。
 *
 * **本文件没有 IO、没有 `Date`、没有定时器、没有 `setInterval`。**
 * 所有时刻都由调用方传进来，于是同一串时刻在任何时候重放都得到同一份读数——
 * 这是它可被静态复核的前提，也是「不装定时器」这条纪律唯一能落地的形式。
 *
 * ## 为什么「间隔过大」必须判成被打断，而不是照样累加
 *
 * 这是整个插件唯一真正重要的一行判断。若不判：
 *
 * ```
 * 09:00 开始专注 → 合上电脑 → 18:00 打开外壳 → tick(18:00)
 * 不判的结果：今日累计 +9 小时，读数「今天学了 9 小时」
 * 判了的结果：这一段记「被打断」，今日累计 +0
 * ```
 *
 * 前者的错不是「数字大了点」，而是它把「没学」记成了「学了」，而且这个数是
 * 用来安慰人的——一个会夸大的学伴比没有学伴更坏。所以间隔一超门槛，
 * 那一段**一秒都不计入**，并且记的是 `segmentsBrokenToday` 而不是
 * `segmentsDoneToday`：**中断要记「被打断」，不是「完成了这一段」。**
 *
 * ## 为什么 `stop()` 也要做同一个间隔判定
 *
 * 「关掉三小时，回来点一下停止」是全流程里最容易被漏掉的口子：
 * 只要 `stop()` 无条件把整段记为完成，上面那条判定就形同虚设——
 * 谁想刷时长，关掉窗口再点停止就行。所以 `stop()` 复用的是 `endFocus()`，
 * 而 `endFocus()` 与 `advance()` 用的是同一套门槛。
 *
 * ## 为什么相位要看两次
 *
 * 落盘的相位是「上次结算时的相位」，派生相位是「按此刻时刻看，事实上的相位」。
 * 两者的差最多一次调用：段其实早断了，但要等到下一次 tick 才收拢。
 * 读数一律按**派生相位**给——否则外壳会显示「专注中 3 小时」，而人三小时前就走了。
 */

import type {
  RestAction,
  RestPrompt,
  StudyDataState,
  StudyEvent,
  StudyPhase,
  StudySnapshot,
} from './types.js'
import { STATE_VERSION } from './types.js'
import type { Config } from './settings.js'

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000

/** 存档形状。**只放时刻与毫秒数**，一个字的正文都不放。 */
export interface StudyState {
  /** 存档版本。 */
  readonly version: number
  /** 自然日键。今日计数只属于这一天。 */
  readonly dayKey: string
  /** 落盘相位。 */
  readonly phase: StudyPhase
  /**
   * 是否**曾经**开始过（跨天不清）。
   *
   * 与「今天有没有学过」分开是必须的：今日计数跨天归零，若拿它判断
   * 「有没有数据」，昨天学过、今天还没开始的人会被报成 `never-started`——
   * 那时提示语是「还没有开始过」，而事实是昨天学了一整晚。
   */
  readonly everStarted: boolean
  /** 当前专注段起点；没有进行中的段为 `null`。 */
  readonly focusStartAt: number | null
  /** 当前休息段起点；不在休息段为 `null`。 */
  readonly restStartAt: number | null
  /** 最近一次被接受的打点时刻（**唯一的水位**）。 */
  readonly lastTickAt: number | null
  /** 今日累计专注毫秒数（跨天归零）。 */
  readonly focusMsToday: number
  /** 今日完成的段数。 */
  readonly segmentsDoneToday: number
  /** 今日被打断的段数。 */
  readonly segmentsBrokenToday: number
  /** 今日采纳休息次数。 */
  readonly breaksToday: number
  /** 今日拒绝休息次数。 */
  readonly breaksDeclinedToday: number
  /** 最近一次**发出**休息提示的时刻（冷却锚点之一）。 */
  readonly lastPromptAt: number | null
  /** 最近一次**拒绝**休息提示的时刻（冷却锚点之一）。 */
  readonly lastDeclineAt: number | null
}

/** 空状态。 */
export function emptyState(dayKey: string): StudyState {
  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    phase: 'idle' as StudyPhase,
    everStarted: false,
    focusStartAt: null,
    restStartAt: null,
    lastTickAt: null,
    focusMsToday: 0,
    segmentsDoneToday: 0,
    segmentsBrokenToday: 0,
    breaksToday: 0,
    breaksDeclinedToday: 0,
    lastPromptAt: null,
    lastDeclineAt: null,
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

/** 相位归一：不在闭集里一律退回 `idle`。 */
function phaseOf(value: unknown): StudyPhase {
  if (value === 'focus' || value === 'rest') return value
  return 'idle'
}

/**
 * 归一化存档。**任何异常都不抛错。**
 *
 * 段的三个锚点（相位 / 段起点 / 打点水位）拼不回一段连续事实时，这一段整段作废
 * （退回 `idle`），但**今日计数与 `everStarted` 保留**——计数是已经发生过的事实，
 * 不该因为一个字段坏了被清掉，那等于凭空抹掉她学过的时间。
 * @param raw 原始值。
 * @param dayKey 当前自然日键。
 */
export function normalizeState(raw: unknown, dayKey: string): StudyState {
  if (!isRecord(raw)) return emptyState(dayKey)
  const phase = phaseOf(raw['phase'])
  const focusStartAt = stampOf(raw['focusStartAt'])
  const restStartAt = stampOf(raw['restStartAt'])
  const lastTickAt = stampOf(raw['lastTickAt'])
  const usable = segmentUsable(phase, focusStartAt, restStartAt, lastTickAt)
  const rawDayKey = raw['dayKey']
  // 先按**档里写的**日键构造，再交给 rollTo 判断要不要清今日计数：
  // 直接写今天的键会让「昨天学的两小时」被悄悄搬进今天。
  const storedDayKey = typeof rawDayKey === 'string' ? rawDayKey : dayKey
  const state = Object.freeze({
    version: STATE_VERSION,
    dayKey: storedDayKey,
    phase: usable ? phase : ('idle' as StudyPhase),
    everStarted: raw['everStarted'] === true || countOf(raw['segmentsDoneToday']) > 0,
    focusStartAt: usable && phase === 'focus' ? focusStartAt : null,
    restStartAt: usable && phase === 'rest' ? restStartAt : null,
    lastTickAt: usable ? lastTickAt : null,
    focusMsToday: countOf(raw['focusMsToday']),
    segmentsDoneToday: countOf(raw['segmentsDoneToday']),
    segmentsBrokenToday: countOf(raw['segmentsBrokenToday']),
    breaksToday: countOf(raw['breaksToday']),
    breaksDeclinedToday: countOf(raw['breaksDeclinedToday']),
    lastPromptAt: stampOf(raw['lastPromptAt']),
    lastDeclineAt: stampOf(raw['lastDeclineAt']),
  })
  // 旧档日键不是今天：当日计数归零，但「曾经开始过」与进行中的段必须带过去。
  return rollTo(state, dayKey)
}

/**
 * 段锚点是否自洽。
 *
 * `focus` 必须有起点与打点水位、且起点不晚于水位；`rest` 必须有休息起点、
 * 且不能同时挂着专注段；`idle` 两个起点都得是 `null`。任一条不成立，
 * 这段记录已经拼不回去了，留着只会让「这一段有多久」算出一个荒唐的数。
 * @param phase 相位。
 * @param focusStartAt 专注段起点。
 * @param restStartAt 休息段起点。
 * @param lastTickAt 打点水位。
 */
function segmentUsable(
  phase: StudyPhase,
  focusStartAt: number | null,
  restStartAt: number | null,
  lastTickAt: number | null,
): boolean {
  if (phase === 'idle') return focusStartAt === null && restStartAt === null
  if (phase === 'rest') return restStartAt !== null && focusStartAt === null
  return focusStartAt !== null && lastTickAt !== null && focusStartAt <= lastTickAt
}

/**
 * 把状态搬到指定自然日：同日原样返回，跨天清当日计数。
 *
 * **跨天不清进行中的段**：凌晨还在专注时，那一段的时长是真的，不能因为过了零点
 * 就假装她刚坐下。清掉的是「今天」的四个计数与两个冷却锚点。
 * 单独导出是因为读路径（`snapshot`）也要用它——只在写路径跨天，
 * 会让「零点后第一次读」拿到昨天的读数。
 * @param state 旧状态。
 * @param dayKey 当前自然日键。
 */
export function rollTo(state: StudyState, dayKey: string): StudyState {
  if (state.dayKey === dayKey) return state
  return Object.freeze({
    ...state,
    dayKey,
    focusMsToday: 0,
    segmentsDoneToday: 0,
    segmentsBrokenToday: 0,
    breaksToday: 0,
    breaksDeclinedToday: 0,
    lastPromptAt: null,
    lastDeclineAt: null,
  })
}

/** 一次推进的结果。 */
export interface AdvanceResult {
  /** 推进后的状态。 */
  readonly state: StudyState
  /** 事件。 */
  readonly event: StudyEvent
  /** 实际计入的毫秒数。 */
  readonly addedMs: number
}

/** 一次收工的结果。 */
export interface EndResult extends AdvanceResult {
  /** 这一段是否算「完成了」。间隔过大 / 时钟倒退时为 `false`。 */
  readonly completed: boolean
}

/**
 * 开始一段专注。**纯函数**，不判断能不能开始（那由服务层抛 `bad-request`）。
 * @param state 旧状态。
 * @param at 时刻。
 * @param dayKey 当前自然日键。
 */
export function beginFocus(state: StudyState, at: number, dayKey: string): StudyState {
  const rolled = rollTo(state, dayKey)
  return Object.freeze({
    ...rolled,
    phase: 'focus' as StudyPhase,
    everStarted: true,
    focusStartAt: at,
    restStartAt: null,
    // 上一天留下的打点水位不能拿来给新段做锚：那会把跨天的那段空档算进来。
    lastTickAt: at,
  })
}

/**
 * 推进一步。**纯函数。**
 *
 * 焦点只在「间隔在门槛以内」时才累加，其余一律不计——理由见文件头。
 * @param state 旧状态。
 * @param at 时刻。
 * @param dayKey 当前自然日键。
 * @param settings 配置。
 */
export function advance(state: StudyState, at: number, dayKey: string, settings: Config): AdvanceResult {
  const rolled = rollTo(state, dayKey)
  if (rolled.phase === 'idle') return { state: rolled, event: 'idle' as StudyEvent, addedMs: 0 }

  if (rolled.phase === 'rest') {
    if (rolled.restStartAt === null) {
      return { state: idleOf(rolled), event: 'idle' as StudyEvent, addedMs: 0 }
    }
    const elapsed = at - rolled.restStartAt
    if (elapsed < 0) return { state: rolled, event: 'clock-back' as StudyEvent, addedMs: 0 }
    if (elapsed >= settings.restMinutes * MINUTE_MS) {
      // 休息够了就回 idle：**只是允许她回来，不是把她叫回来**。
      return { state: idleOf(rolled), event: 'rest-ended' as StudyEvent, addedMs: 0 }
    }
    return { state: rolled, event: 'resting' as StudyEvent, addedMs: 0 }
  }

  // 段在，但锚点丢了（旧档 / 手改档）：重新锚到此刻，空缺的那一段不计入。
  if (rolled.focusStartAt === null || rolled.lastTickAt === null) {
    return {
      state: Object.freeze({ ...rolled, focusStartAt: at, lastTickAt: at }),
      event: 'reanchored' as StudyEvent,
      addedMs: 0,
    }
  }

  const dt = at - rolled.lastTickAt
  if (dt < 0) {
    // 时钟倒退：既不能加负数，也不能把倒退的那段算进去，只能重新校准水位。
    return {
      state: Object.freeze({ ...rolled, lastTickAt: at }),
      event: 'clock-back' as StudyEvent,
      addedMs: 0,
    }
  }
  if (dt > settings.gapLimitMinutes * MINUTE_MS) {
    return {
      state: Object.freeze({
        ...rolled,
        phase: 'idle' as StudyPhase,
        focusStartAt: null,
        lastTickAt: null,
        segmentsBrokenToday: rolled.segmentsBrokenToday + 1,
      }),
      event: 'gap-broken' as StudyEvent,
      addedMs: 0,
    }
  }
  return {
    state: Object.freeze({ ...rolled, focusMsToday: rolled.focusMsToday + dt, lastTickAt: at }),
    event: 'accumulated' as StudyEvent,
    addedMs: dt,
  }
}

/**
 * 收工。**与 `advance()` 用同一套间隔判定**——否则关掉窗口再点停止就能刷时长。
 * @param state 旧状态。
 * @param at 时刻。
 * @param dayKey 当前自然日键。
 * @param settings 配置。
 */
export function endFocus(state: StudyState, at: number, dayKey: string, settings: Config): EndResult {
  const rolled = rollTo(state, dayKey)
  if (rolled.phase !== 'focus') {
    return { state: rolled, event: 'idle' as StudyEvent, addedMs: 0, completed: false }
  }
  if (rolled.focusStartAt === null || rolled.lastTickAt === null) {
    return {
      state: Object.freeze({
        ...idleOf(rolled),
        segmentsBrokenToday: rolled.segmentsBrokenToday + 1,
      }),
      event: 'gap-broken' as StudyEvent,
      addedMs: 0,
      completed: false,
    }
  }
  const dt = at - rolled.lastTickAt
  if (dt < 0) {
    return {
      state: Object.freeze({
        ...idleOf(rolled),
        segmentsBrokenToday: rolled.segmentsBrokenToday + 1,
      }),
      event: 'clock-back' as StudyEvent,
      addedMs: 0,
      completed: false,
    }
  }
  if (dt > settings.gapLimitMinutes * MINUTE_MS) {
    // 人早就不在了：这一段记「被打断」，不是「完成了这一段」。
    return {
      state: Object.freeze({
        ...idleOf(rolled),
        segmentsBrokenToday: rolled.segmentsBrokenToday + 1,
      }),
      event: 'gap-broken' as StudyEvent,
      addedMs: 0,
      completed: false,
    }
  }
  return {
    state: Object.freeze({
      ...idleOf(rolled),
      focusMsToday: rolled.focusMsToday + dt,
      segmentsDoneToday: rolled.segmentsDoneToday + 1,
      lastTickAt: at,
    }),
    event: 'accumulated' as StudyEvent,
    addedMs: dt,
    completed: true,
  }
}

/**
 * 回应休息提示。**纯函数。**
 *
 * - `taken`：先把这一段按间隔判定收尾（可能记完成、也可能记被打断），再进入休息段；
 * - `declined`：只记一笔拒绝并推进水位，**相位不动**——拒绝就是要继续学。
 *
 * 「稍后再说」刻意不设：它和拒绝没有区别，多一个选项只会让人多点一次。
 * @param state 旧状态。
 * @param action 动作。
 * @param at 时刻。
 * @param dayKey 当前自然日键。
 * @param settings 配置。
 */
export function markRest(
  state: StudyState,
  action: RestAction,
  at: number,
  dayKey: string,
  settings: Config,
): AdvanceResult {
  if (action === 'declined') {
    // 拒绝也要先推进水位：她说「不歇」的这一刻人是在的，这段时长是真的。
    const advanced = advance(state, at, dayKey, settings)
    return {
      state: Object.freeze({
        ...advanced.state,
        breaksDeclinedToday: advanced.state.breaksDeclinedToday + 1,
        lastDeclineAt: at,
      }),
      event: advanced.event,
      addedMs: advanced.addedMs,
    }
  }
  const ended = endFocus(state, at, dayKey, settings)
  return {
    state: Object.freeze({
      ...ended.state,
      phase: 'rest' as StudyPhase,
      restStartAt: at,
      breaksToday: ended.state.breaksToday + 1,
    }),
    event: ended.event,
    addedMs: ended.addedMs,
  }
}

/** 回到 `idle`：两个起点与打点水位一起清掉（留一个都会让下一段算错）。 */
function idleOf(state: StudyState): StudyState {
  return Object.freeze({
    ...state,
    phase: 'idle' as StudyPhase,
    focusStartAt: null,
    restStartAt: null,
    lastTickAt: null,
  })
}

/**
 * 派生相位：按此刻时刻看，事实上的相位。
 *
 * 段其实早断了就不报 `focus`；休息早够了就不报 `rest`。两者都只影响**读数**，
 * 落盘状态要等下一次写操作才收拢——差一次调用，不会多算时长。
 * @param state 状态。
 * @param at 时刻。
 * @param settings 配置。
 */
export function derivePhase(state: StudyState, at: number, settings: Config): StudyPhase {
  if (state.phase === 'focus') {
    if (state.focusStartAt === null || state.lastTickAt === null) return 'idle'
    if (at - state.lastTickAt > settings.gapLimitMinutes * MINUTE_MS) return 'idle'
    return 'focus'
  }
  if (state.phase === 'rest') {
    if (state.restStartAt === null) return 'idle'
    if (at - state.restStartAt >= settings.restMinutes * MINUTE_MS) return 'idle'
    return 'rest'
  }
  return 'idle'
}

/** 毫秒 → 整分钟（向下取整，永不出现「学了 0.4 分钟」这种读数）。 */
export function minutesOf(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / MINUTE_MS)
}

/**
 * 判定此刻该不该提一句休息。**纯函数，不改状态。**
 *
 * 四个条件同时成立：在专注段里、段够长、人还在（最近一次打点没超门槛）、
 * 不在冷却里。最后一条既是冷却也是「拒绝有效」的唯一实现——
 * 少了它，拒绝就只是个计数器。
 *
 * `note` **不含数字、不含评判、不含命令**：说「已经专注 47 分钟」是报数，
 * 说「你该休息了」是命令。两者都会让「陪」变成「管」。
 * @param state 状态。
 * @param at 时刻。
 * @param settings 配置。
 */
export function judgeRest(state: StudyState, at: number, settings: Config): RestPrompt | null {
  if (state.phase !== 'focus') return null
  if (state.focusStartAt === null || state.lastTickAt === null) return null
  const gap = at - state.lastTickAt
  // 人可能早就不在了：对着空房间提示休息，比不提示更糟。
  if (gap < 0 || gap > settings.gapLimitMinutes * MINUTE_MS) return null
  if (at - state.focusStartAt < settings.restAfterMinutes * MINUTE_MS) return null
  const anchor = Math.max(state.lastPromptAt ?? 0, state.lastDeclineAt ?? 0)
  if (anchor > 0 && at - anchor < settings.restCooldownMinutes * MINUTE_MS) return null
  return Object.freeze({
    reason: 'continuous-too-long' as const,
    focusMinutes: minutesOf(at - state.focusStartAt),
    declinable: true as const,
    mandatory: false as const,
    note: '连着专注了一阵，可以歇口气；不想歇就这样继续',
  })
}

/**
 * 一句话标签。**不含数字、不含分数、不是话术。**
 *
 * 话术归人格与 O-047：这里只给调用方一个能进日志、能进调试面板的短标签。
 * @param phase 派生相位。
 * @param state 数据状态。
 */
export function noteOf(phase: StudyPhase, state: StudyDataState): string {
  if (state === 'never-started') return '还没有开始过一段专注，学伴此刻没有在工作'
  if (phase === 'focus') return '专注段进行中'
  if (phase === 'rest') return '休息段进行中'
  return '当前没有进行中的段'
}

/**
 * 组装只读快照。**按派生相位给读数**，不按落盘相位。
 * @param state 状态。
 * @param at 时刻。
 * @param settings 配置。
 * @param stored 是否落盘。
 */
export function snapshotOf(
  state: StudyState,
  at: number,
  settings: Config,
  stored: boolean,
): StudySnapshot {
  const phase = derivePhase(state, at, settings)
  const focusMsCurrent =
    phase === 'focus' && state.focusStartAt !== null ? Math.max(0, at - state.focusStartAt) : 0
  const dataState: StudyDataState = state.everStarted ? 'measured' : 'never-started'
  return Object.freeze({
    dayKey: state.dayKey,
    phase,
    dataState,
    everStarted: state.everStarted,
    focusStartAt: phase === 'focus' ? state.focusStartAt : null,
    focusMsCurrent,
    focusMsToday: state.focusMsToday,
    lastTickAt: state.lastTickAt,
    idleMs: state.lastTickAt === null ? null : Math.max(0, at - state.lastTickAt),
    segmentsDoneToday: state.segmentsDoneToday,
    segmentsBrokenToday: state.segmentsBrokenToday,
    breaksToday: state.breaksToday,
    breaksDeclinedToday: state.breaksDeclinedToday,
    stored,
  })
}
