/**
 * 化学池（手册 §3.9，实读原始项目的 `genome.json`）。
 *
 * ## 这一层在解决什么问题
 *
 * 只有 PAD 的时候，情绪是「事件驱动的」：挨骂 → 不悦 → 衰减回中性。
 * 那是反射，不是心情。加一层**慢变量**之后才会出现「今天一整天都压着一股气」——
 * 因为皮质醇还没代谢完，而皮质醇高的时候血清素在被持续抽走，
 * 血清素低又让人更容易被下一件小事激怒。**这才是闭环。**
 *
 * ## 三个必须照抄的细节
 *
 * 1. **血清素两条路都要走**（手册原话：「既按分钟抽、又一次性扣」）。
 *    只按分钟抽：`set_state` 把皮质醇设到 80 之后，界面上血清素纹丝不动，
 *    看起来像坏了。只按事件扣：「焦虑很久」和「焦虑一下」扣得一样多，
 *    那慢变量就白做了。
 * 2. **一次性扣只在「越过阈值」那一刻**（手册原话：「两处都扣会互相放大，
 *    几分钟打到 0，'极度烦躁'变成默认状态」）。所以这里用一个跨越检测，
 *    而不是每段都扣。
 * 3. **存档缺字段按基线 50 补，不补 0。** 0 在界面上等于「极度烦躁」，
 *    那是伪造情绪；缺字段的含义是「这条数据没存过」，不是「这个值是 0」。
 *
 * ## 手册没给的两个数
 *
 * - **跨越时一次性扣多少**：手册只说有这一次性扣，没给数值。取 5（基线的 10%），
 *   够让界面立刻看得出变化，又不至于一次就削掉大半池子。
 * - **`metabolism` 具体乘在哪**：手册只说「能耗率」。这里乘在两条慢变量的速率上——
 *   代谢快的人，情绪来得快去得也快，这与常识一致。
 */

import type { Temperament } from './types.js'
import {
  CORE_HORMONE_SPEC,
  CORE_HORMONES,
  DYNAMIC_HORMONE_SPEC,
  MAX_DYNAMIC_HORMONES,
  SEROTONIN_RECOVER_ENERGY,
  SEROTONIN_RECOVER_RATE,
  SEROTONIN_RECOVER_TENSION,
  SEROTONIN_STRESS_RATE,
  SEROTONIN_STRESS_THRESHOLD,
} from './types.js'
import { halfLifeWith, regressTowards } from './pad.js'

/** 一池子的激素值（含动态）。 */
export interface HormonePool {
  /** 激素值，0–100。 */
  readonly values: Readonly<Record<string, number>>
  /** 动态激素的名字（不含三种出厂的）。 */
  readonly dynamic: readonly string[]
}

/**
 * 慢变量积分一步的长度（分钟）。
 *
 * 与手册 §3.10 的 `stepMinutes=5` 同一个值：一次结算可能横跨「深夜→天亮→再入睡」
 * 好几个窗口，一次乘法算不出来。5 分钟是「够细，又不至于把 7 天切成 20 万段」的折中。
 */
export const STEP_MINUTES = 5

/**
 * 单次结算最多切多少段（手册 §3.10：上限 2000 段 ≈ 7 天）。
 * 超出部分直接丢弃——与 `maxSettleMinutes` 是同一件事的两道保险。
 */
export const MAX_SETTLE_STEPS = 2000

/**
 * 皮质醇越过应激阈值时，血清素的一次性扣除量。
 *
 * **手册未给数值**，取 5（基线 50 的 10%）。理由见文件头。
 */
export const SEROTONIN_CROSS_PENALTY = 5

/** 激素名合法性（与 §8.4 同一条命名规则，长度上限收到 24）。 */
const HORMONE_NAME = /^[a-z][a-z0-9_-]{1,23}$/

/** 夹紧一个激素值。 */
function clampHormone(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * 取某个激素的参数。
 *
 * 出厂三种走 `CORE_HORMONE_SPEC`，其余一律走动态参数（基线 50 / 30 分钟）。
 * @param name 激素名。
 */
export function specOf(name: string): { readonly baseline: number; readonly halfLifeMinutes: number } {
  const core = CORE_HORMONE_SPEC[name as (typeof CORE_HORMONES)[number]]
  return core ?? DYNAMIC_HORMONE_SPEC
}

/**
 * 一个激素在静息时的水平。
 *
 * **多巴胺的基线会被 `enthusiasm` 覆盖**（手册 §3.9：`enthusiasm` 是
 * 「多巴胺出厂基线」）。这正是「热情的人天生更容易开心」的实现方式——
 * 不是让她的开心涨得更快，而是让她的**静息点更高**：
 * 同样一件事，基线 60 的人回到 60 就算过去了，基线 40 的人回到 40 才算。
 *
 * @param name 激素名。
 * @param temperament 气质。
 */
export function baselineOf(name: string, temperament: Temperament): number {
  if (name === 'dopamine') return temperament.enthusiasm
  return specOf(name).baseline
}

/** 新建一个只有三种出厂激素的池子。 */
export function createPool(temperament: Temperament): HormonePool {
  const values: Record<string, number> = {}
  for (const name of CORE_HORMONES) values[name] = baselineOf(name, temperament)
  return { values, dynamic: [] }
}

/**
 * 从存档恢复一个池子。
 *
 * 三条规矩：
 * - 出厂三种**一定存在**，缺了就按基线补（不是 0）。
 * - 动态激素只恢复名单里声明过的；值缺失同样按 50 补。
 * - 数量超过 12 时**截断**（不是报错）：存档可能来自上限更宽松的旧版本，
 *   拒整份存档比丢掉几个激素严重得多。
 *
 * @param raw 存档里的 `values`。
 * @param dynamicRaw 存档里的动态激素名单。
 * @param temperament 气质。
 */
export function parsePool(raw: unknown, dynamicRaw: unknown, temperament: Temperament): HormonePool {
  const values: Record<string, number> = {}
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

  for (const name of CORE_HORMONES) {
    const value = source[name]
    values[name] = typeof value === 'number' && Number.isFinite(value) ? clampHormone(value) : baselineOf(name, temperament)
  }

  const dynamic: string[] = []
  if (Array.isArray(dynamicRaw)) {
    for (const item of dynamicRaw) {
      if (typeof item !== 'string' || !HORMONE_NAME.test(item)) continue
      if (dynamic.includes(item) || (CORE_HORMONES as readonly string[]).includes(item)) continue
      if (dynamic.length >= MAX_DYNAMIC_HORMONES) break
      dynamic.push(item)
      const value = source[item]
      values[item] = typeof value === 'number' && Number.isFinite(value) ? clampHormone(value) : DYNAMIC_HORMONE_SPEC.baseline
    }
  }

  return { values, dynamic }
}

/**
 * 结算化学池：只做回归与两条慢变量。
 *
 * **不做「跨越阈值的一次性扣除」**——那件事必须在**事件发生的那一刻**做，不能放在这里。
 * 理由是实跑踩出来的：`set_state` 把皮质醇拉到 80 之后再结算，池子里的皮质醇
 * 起始就已经是 80，`wasStressed` 一上来就是 true，跨越永远检测不到。
 * 表现就是手册警告过的那个现象——**界面上血清素纹丝不动，看起来像坏了**。
 * 所以跨越判定挪进 `service.shiftHormone()`，用 `crossedStress()` 判。
 *
 * @param pool 当前池子。
 * @param dtMinutes 经过的分钟数（已按 `maxSettleMinutes` 截断）。
 * @param energy 当前能量（0–100，血清素 recover 的条件之一）。
 * @param tension 当前张力（0–1，血清素 recover 的另一个条件）。
 * @param temperament 气质。
 * @returns 结算后的池子。
 */
export function settlePool(
  pool: HormonePool,
  dtMinutes: number,
  energy: number,
  tension: number,
  temperament: Temperament,
): HormonePool {
  if (!(dtMinutes > 0)) return pool

  const values: Record<string, number> = { ...pool.values }

  let remaining = Math.min(dtMinutes, STEP_MINUTES * MAX_SETTLE_STEPS)
  let guard = 0
  while (remaining > 0 && guard < MAX_SETTLE_STEPS) {
    guard += 1
    const step = Math.min(STEP_MINUTES, remaining)
    remaining -= step

    // 1) 所有激素先各自回归一格。
    for (const name of Object.keys(values)) {
      const halfLife = halfLifeWith(specOf(name).halfLifeMinutes, temperament.resilience)
      values[name] = clampHormone(regressTowards(values[name] ?? baselineOf(name, temperament), baselineOf(name, temperament), halfLife, step))
    }

    // 2) 血清素的两条慢变量，用**回归之后**的皮质醇判定——
    //    用回归前的值会让「刚好卡在 70」的那个格子多抽一次。
    const cortisol = values['cortisol'] ?? baselineOf('cortisol', temperament)
    const serotonin = values['serotonin'] ?? baselineOf('serotonin', temperament)

    if (cortisol >= SEROTONIN_STRESS_THRESHOLD) {
      // 应激：持续抽水。
      values['serotonin'] = clampHormone(serotonin + SEROTONIN_STRESS_RATE * step * temperament.metabolism)
    } else if (energy > SEROTONIN_RECOVER_ENERGY && tension < SEROTONIN_RECOVER_TENSION) {
      // 恢复：只有在「有劲」且「没有压着事」的时候才回充。
      // 两个条件缺一个都不回——这就是「心里有事的时候，睡再久也不解乏」。
      values['serotonin'] = clampHormone(serotonin + SEROTONIN_RECOVER_RATE * step * temperament.metabolism)
    }
  }

  return { values, dynamic: pool.dynamic }
}

/**
 * 这次改动是否让皮质醇**越过了**应激阈值（从线下到线上）。
 *
 * 只在真正跨过去的那一次返回 true——这是手册 §3.9 特意强调的口径：
 * 「『越过阈值』才扣（两处都扣会互相放大，几分钟打到 0）」。
 *
 * @param before 改动前的皮质醇。
 * @param after 改动后的皮质醇。
 */
export function crossedStress(before: number, after: number): boolean {
  return before < SEROTONIN_STRESS_THRESHOLD && after >= SEROTONIN_STRESS_THRESHOLD
}

/**
 * 改动一个激素。
 *
 * **皮质醇的增量会被 `sensitivity` 放大**（手册 §3.9：敏感度是「报错时皮质醇
 * 飙升乘数」）。乘在这里而不是乘在调用方，是为了让「她有多容易上头」只有一处定义——
 * 否则每个调 `feel()` 的地方都要记得自己乘一次，漏一个就有人「天生不敏感」。
 *
 * @param pool 当前池子。
 * @param name 激素名。
 * @param delta 增量（0–100 尺度，已由调用方夹过 `MAX_HORMONE_STEP`）。
 * @param temperament 气质。
 * @returns 新池子；若名字非法或超出上限且是新名字，返回 `undefined`。
 */
export function applyHormone(
  pool: HormonePool,
  name: string,
  delta: number,
  temperament: Temperament,
): HormonePool | undefined {
  if (!HORMONE_NAME.test(name)) return undefined
  const isDynamic = !(CORE_HORMONES as readonly string[]).includes(name)
  const known = pool.values[name] !== undefined

  if (isDynamic && !known && pool.dynamic.length >= MAX_DYNAMIC_HORMONES) return undefined

  const scaled = name === 'cortisol' ? delta * temperament.sensitivity : delta
  const current = pool.values[name] ?? baselineOf(name, temperament)
  const values: Record<string, number> = { ...pool.values, [name]: clampHormone(current + scaled) }
  const dynamic = isDynamic && !known ? [...pool.dynamic, name] : pool.dynamic
  return { values, dynamic }
}

/** 取一个激素的当前值。 */
export function hormoneOf(pool: HormonePool, name: string, temperament: Temperament): number {
  return pool.values[name] ?? baselineOf(name, temperament)
}
