/**
 * 六态判定（纯函数，不碰 ctx、不读时间、不写日志）。
 *
 * 拆成单独文件的好处很实：这一段是**唯一有分支逻辑**的地方，
 * 也是 Python 复刻对拍时唯一需要逐行照着抄的地方。
 * 把它混进 `service.ts`（那里有情绪读数、日志、计数器），
 * 对拍就得连宿主 API 一起模拟，成本高到没人愿意做。
 */

import { STATES, STATE_SPECS } from './types.js'
import type { ExpressState, NumericRange, StateSpec } from './types.js'

/* ------------------------------------------------------------------ *
 * 尺度
 * ------------------------------------------------------------------ */

/**
 * 能量阈值的换算基数。
 *
 * 手册的 `energy > 0.6` / `energy < 0.3` 是**以 0–1 写的**，
 * 而 O-026 的 `axes.energy` 是 **0–100**（§3.10 的 `energy > 80` 是同一套尺度）。
 *
 * 换算方向是「**把阈值乘 100**」，不是「把读数除以 100」。
 * 后者会让 `energy = 60` 变成 `0.6`，而 `0.6 > 0.6` 为假 ——
 * 于是「她永远是困的」。这个 100 只在本文件出现一次，
 * `types.ts` 的 `STATE_SPECS` 里已经写成换算后的 `> 60` / `< 30`。
 */
export const ENERGY_SCALE = 100

/** 心情下界。 */
export const MOOD_MIN = 0
/** 心情上界。 */
export const MOOD_MAX = 1
/** 张力下界。 */
export const TENSION_MIN = 0
/** 张力上界。 */
export const TENSION_MAX = 1
/** 能量下界。 */
export const ENERGY_MIN = 0
/** 能量上界（0–100，O-026 口径）。 */
export const ENERGY_MAX = ENERGY_SCALE

/**
 * 三个维度的出厂基线，**逐字对齐 O-026 的 `AXIS_SPEC`**：
 * `mood 0.5` / `energy 60` / `tension 0`。
 *
 * 读不到情绪时用这一组，恰好落在「平静」——这是「读不到就什么都不做」。
 * 若拿 0 当缺省，会得到 `mood 0 / energy 0 / tension 0`：
 * 能量 0 直接命中「困」，于是**没装情绪服务时她永远是困的**。
 */
export const BASELINE_MOOD = 0.5
/** 能量基线。 */
export const BASELINE_ENERGY = 60
/** 张力基线。 */
export const BASELINE_TENSION = 0

/** 三个维度的读数。 */
export interface Axes {
  /** 心情 0–1。 */
  readonly mood: number
  /** 能量 0–100。 */
  readonly energy: number
  /** 张力 0–1。 */
  readonly tension: number
}

/** 夹一个数；非有限值回退到给定缺省。 */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 夹紧三个维度。非法值（NaN / ±Infinity / 非数字）回退基线。
 * @param input 原始输入。
 */
export function clampAxes(input: { readonly mood?: number; readonly energy?: number; readonly tension?: number }): Axes {
  return Object.freeze({
    mood: clamp(input.mood, MOOD_MIN, MOOD_MAX, BASELINE_MOOD),
    energy: clamp(input.energy, ENERGY_MIN, ENERGY_MAX, BASELINE_ENERGY),
    tension: clamp(input.tension, TENSION_MIN, TENSION_MAX, BASELINE_TENSION),
  })
}

/* ------------------------------------------------------------------ *
 * 区间与判据
 * ------------------------------------------------------------------ */

/**
 * 区间是否命中。
 *
 * 四向开闭**全部可能同时出现**（例如 `0.55 ≤ x ≤ 0.7`），逐条与即可；
 * 不写「先转成闭区间再比」——那会把 `gt` 悄悄变成 `gte`，
 * 而 0.7 恰好是两档的分界，错一格就是两档同时命中。
 * @param range 区间。
 * @param value 数值。
 */
export function rangeMatches(range: NumericRange, value: number): boolean {
  if (range.gt !== undefined && !(value > range.gt)) return false
  if (range.gte !== undefined && !(value >= range.gte)) return false
  if (range.lt !== undefined && !(value < range.lt)) return false
  if (range.lte !== undefined && !(value <= range.lte)) return false
  return true
}

/**
 * 一个状态的判据是否全部满足。
 *
 * 某个维度没写 → **不约束**（不是「必须等于 0」）。
 * 这条看着显然，但把 `undefined` 当 0 比是这类判定的经典错法：
 * 「软和」只写了 mood，若把没写的 `tension` 当 0 处理，
 * 一个 `tension = 0.2` 的平静时刻就永远判不出软和了。
 * @param spec 状态判据。
 * @param axes 三维读数。
 */
export function specMatches(spec: StateSpec, axes: Axes): boolean {
  if (spec.mood !== undefined && !rangeMatches(spec.mood, axes.mood)) return false
  if (spec.energy !== undefined && !rangeMatches(spec.energy, axes.energy)) return false
  if (spec.tension !== undefined && !rangeMatches(spec.tension, axes.tension)) return false
  return true
}

/**
 * 判定顺序：按 `priority` 升序排好的六态。
 *
 * 模块加载时排一次，不在每次判定里 `sort`——判定每秒可能被调好几次，
 * 而这张表是常量。更重要的是：**排序只能有一处**，
 * 若 `matchedStateOf` 与 `describe` 各自排一次，两份顺序迟早会不同。
 */
const PRIORITY_ORDER: readonly ExpressState[] = Object.freeze(
  [...STATES].sort((a, b) => STATE_SPECS[a].priority - STATE_SPECS[b].priority),
)

/**
 * 按优先级找第一个命中的状态。
 * @param axes 三维读数。
 * @returns 没命中任何显式判据时为 `undefined`。
 */
export function matchedStateOf(axes: Axes): ExpressState | undefined {
  for (const state of PRIORITY_ORDER) {
    if (specMatches(STATE_SPECS[state], axes)) return state
  }
  return undefined
}

/**
 * 空档兜底。
 *
 * 手册的判据有两处**没定义**的缝：
 * 1. `0.35 ≤ mood < 0.45`（蔫的下界与平静的下界之间）；
 * 2. `mood > 0.7` 但 `energy ≤ 60`（够开心但没劲）。
 *
 * 兜底规则只看心情：`≥ 0.55` 落软和，否则落平静。
 * **刻意不落蔫**：蔫会同时改四项（语速 −15%、音量低、额度 −1、长句一条说完），
 * 把这段只是「略微偏低」的心情判成蔫，用户会看到「她忽然没精神了」。
 * 误判宁可平淡，不要夸张——这是表达层的取舍，不是心情层的。
 * @param mood 心情。
 */
export function fallbackStateOf(mood: number): ExpressState {
  return mood >= 0.55 ? 'soft' : 'calm'
}

/**
 * 判定：先按优先级找显式判据，找不到再兜底。
 * @param axes 三维读数（应先经 `clampAxes`）。
 */
export function resolveState(axes: Axes): { readonly state: ExpressState; readonly matched: boolean } {
  const matched = matchedStateOf(axes)
  if (matched !== undefined) return { state: matched, matched: true }
  return { state: fallbackStateOf(axes.mood), matched: false }
}
