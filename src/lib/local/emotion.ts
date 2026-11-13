/**
 * 手机端的情绪状态。
 *
 * ## 与桌面版的关系
 *
 * 桌面版的情绪由 `ondra-emotion-core` 插件管理，它挂在 Cordis 宿主里。
 * 手机上没有宿主，但**状态本身与存储无关**：六个数、十个标签、一份气质。
 * 所以这里只做三件事——存、结算、应用一次事件——算法全部来自
 * `emotionPad.ts`（从桌面版逐字复制）。
 *
 * ## 结算为什么必须在读之前做
 *
 * 桌面版的做法是「每次读取前先按时间差结算」。手机端有一个额外的理由：
 * **手机会被挂起**。用户锁屏三小时再打开，若不在读之前结算，她会停在
 * 三小时前的情绪上——而那三小时里心情本该回落。
 *
 * 结算用闭式指数回归（`regressTowards`），所以「结算一次」与「结算一百次」
 * 在同一时刻给出同一个数，不存在「开着 app 忘得快、关了就忘得慢」。
 */

import { dbGet, dbPut } from './store.ts'
import type { Axis, Label, Temperament } from './emotionTypes.ts'
import { AXES, AXIS_SPEC, DEFAULT_TEMPERAMENT, LABELS, LABEL_MAX, LABEL_HALF_LIFE_MINUTES } from './emotionTypes.ts'
import { clampAxis, elapsedMinutes, regressTowards, settleAxis, axisDelta, labelDelta } from './emotionPad.ts'

/** 一次结算最长按多久算。与桌面版 `MAX_SETTLE_MINUTES` 同值：7 天。 */
const MAX_SETTLE_MINUTES = 7 * 24 * 60

/** 情绪状态。 */
export interface EmotionState {
  /** 六个维度。 */
  axes: Record<Axis, number>
  /** 十个标签，0–0.6。 */
  labels: Record<Label, number>
  /** 气质。 */
  temperament: Temperament
  /** 上次结算的时刻（毫秒）。 */
  settledAt: number
}

/** 出厂状态：各轴取基线、标签归零。 */
export function initialState(now: number, temperament: Temperament = DEFAULT_TEMPERAMENT): EmotionState {
  const axes = {} as Record<Axis, number>
  for (const axis of AXES) axes[axis] = AXIS_SPEC[axis].baseline
  const labels = {} as Record<Label, number>
  for (const label of LABELS) labels[label] = 0
  return { axes, labels, temperament, settledAt: now }
}

/** 存档键。单会话制，情绪只有一份。 */
const KEY = 'state'

/** 读当前状态；顺带按时间差结算。 */
export async function loadState(now: number): Promise<EmotionState> {
  const stored = await dbGet<EmotionState>('emotion', KEY)
  if (stored === undefined) return initialState(now)
  /*
   * 存档缺字段按基线补齐，不补 0。
   *
   * 补 0 的后果是「升级后她突然情绪低落」——用户不知道那是缺字段，
   * 只会觉得"更新完她心情变差了"。桌面版的 `types.ts` 里对这条有同样
   * 的说明，这里保持一致。
   */
  const axes = {} as Record<Axis, number>
  for (const axis of AXES) {
    const raw = stored.axes?.[axis]
    axes[axis] = typeof raw === 'number' && Number.isFinite(raw) ? clampAxis(axis, raw) : AXIS_SPEC[axis].baseline
  }
  const labels = {} as Record<Label, number>
  for (const label of LABELS) {
    const raw = stored.labels?.[label]
    labels[label] = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(LABEL_MAX, Math.max(0, raw)) : 0
  }
  const temperament = stored.temperament ?? DEFAULT_TEMPERAMENT
  const settledAt = typeof stored.settledAt === 'number' ? stored.settledAt : now
  return settle({ axes, labels, temperament, settledAt }, now)
}

/** 落盘。 */
export async function saveState(state: EmotionState): Promise<void> {
  await dbPut('emotion', KEY, state)
}

/**
 * 按时间差结算一次。
 *
 * 纯函数：给一个状态与目标时刻，返回新状态。不改入参。
 */
export function settle(state: EmotionState, now: number): EmotionState {
  const minutes = elapsedMinutes(state.settledAt, now, MAX_SETTLE_MINUTES)
  if (minutes <= 0) return state

  const axes = {} as Record<Axis, number>
  for (const axis of AXES) {
    axes[axis] = settleAxis(axis, state.axes[axis], minutes, state.temperament)
  }

  /*
   * 标签按同一个半衰期回落。
   *
   * 标签不挂在轴里（它是「现在有几分开心」而不是「底色多愉悦」），
   * 所以单独算一遍，但用同一个 `regressTowards`——两处若用不同公式，
   * 会出现「P 已经回到中性、标签还挂着」的错位。
   */
  const labels = {} as Record<Label, number>
  for (const label of LABELS) {
    const value = regressTowards(state.labels[label], 0, LABEL_HALF_LIFE_MINUTES, minutes)
    labels[label] = Math.min(LABEL_MAX, Math.max(0, value))
  }

  return { axes, labels, temperament: state.temperament, settledAt: now }
}

/** 一次情绪事件：哪些轴被推动、哪些标签被点亮、推多重。 */
export interface EmotionEvent {
  /** 轴位移意图，−1–1。键缺省表示这一轴不动。 */
  axes?: Partial<Record<Axis, number>>
  /** 标签意图，−1–1。键缺省表示这个标签不动。 */
  labels?: Partial<Record<Label, number>>
}

/**
 * 应用一次事件。
 *
 * 纯函数。位移上限由 `axisDelta` / `labelDelta` 给出（单条消息最多 0.12），
 * 所以调用方不必知道那个数字，也就不容易写错量纲。
 */
export function applyEvent(state: EmotionState, event: EmotionEvent): EmotionState {
  const axes = { ...state.axes }
  for (const axis of AXES) {
    const intent = event.axes?.[axis]
    if (intent === undefined) continue
    /*
     * 心情是「底色」，位移要打折。
     *
     * 桌面版对 mood 用 `MOOD_COUPLING = 0.5`：一句夸奖能让此刻高兴
     * （P 涨满档），但不该让一整天都变好。这里保持一致。
     */
    const coupling = axis === 'mood' ? 0.5 : 1
    /*
     * ## 量纲换算
     *
     * `axisDelta()` 返回的是 **0–1 尺度**的位移（单条消息上限 0.12）。
     * 但 `energy` 的取值范围是 0–100——直接加 0.042 到 60 上，用户完全
     * 感觉不到（0.07%）。
     *
     * 所以按轴的实际跨度换算：0–1 的轴原样加，0–100 的轴乘 100。
     * 这不是「放大情绪」，是让同一句「今天好累」在两种刻度上产生
     * **等效**的变化量。
     */
    const span = AXIS_SPEC[axis].max - AXIS_SPEC[axis].min
    axes[axis] = clampAxis(axis, axes[axis] + axisDelta(intent, coupling) * span)
  }

  const labels = { ...state.labels }
  for (const label of LABELS) {
    const intent = event.labels?.[label]
    if (intent === undefined) continue
    labels[label] = Math.min(LABEL_MAX, Math.max(0, labels[label] + labelDelta(intent)))
  }

  return { ...state, axes, labels }
}

/**
 * 当前最强的标签。全部低于阈值时返回 undefined。
 *
 * 「最强」而不是「最正」：委屈 0.4 比开心 0.2 更该被说出来。
 */
export function dominantLabel(state: EmotionState, threshold = 0.15): Label | undefined {
  let best: Label | undefined
  let bestValue = threshold
  for (const label of LABELS) {
    if (state.labels[label] > bestValue) {
      best = label
      bestValue = state.labels[label]
    }
  }
  return best
}

/**
 * 把情绪压成界面要的读数。
 *
 * 与桌面版 `/api/companion/state` 的字段对齐：`mood` 是 0–100，
 * `energy` 是 0–100，`tension` 是 0–1（单极，0 = 无张力）。
 *
 * ## `tension` 为什么不再乘 2 减 1
 *
 * 桌面版曾经把它当双极量映射成 −1..1，静息态显示成 −1.00，看起来像
 * 「极度紧绷」。`AXIS_SPEC.tension` 的基线是 0，它没有负向状态——
 * 这里直接用原值。
 */
export function readout(state: EmotionState): {
  mood: number
  energy: number
  tension: number
  label: Label | undefined
} {
  return {
    mood: Math.round(state.axes.mood * 100),
    energy: Math.round(state.axes.energy),
    tension: state.axes.tension,
    label: dominantLabel(state),
  }
}