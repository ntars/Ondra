/**
 * O-110 `ondra-dev-companion` 的配置**单一真源**。
 *
 * 与 O-005 的口径一致：默认值由声明方拥有、全仓只存一份。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 这些数从哪来（**必须写清，否则就是拍脑袋**）
 *
 * master-plan §9 参数速查里**没有**「开发者陪伴」这一组，故全部是**本插件的工程取值**，
 * 依据是三条可观察的线：
 *
 * - 90 秒安静期：一次「看到报错 → 找到行 → 改一行 → 再跑」的常见节奏是 1–3 分钟，
 *   90 秒能盖住「正在改」的那一段，又不至于把一次真正的失败永远咽掉；
 * - 连续 3 次同一指纹：第 1 次正常，第 2 次值得同情，第 3 次说明改动方向不对；
 * - 20 分钟跨度：三次失败挤在两分钟里可能只是手抖，跨过 20 分钟才是真的咬住了；
 * - 10 分钟出声冷却：两次非静默出声挨得太近，第二句一定显得敷衍。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「要不要报次数」。** 契约里 `DevCue` 连一个数字字段都没有，
 *    做成开关就等于允许把「今天失败 7 次」念出来。
 * 2. **没有「要不要看代码」。** 本插件从头到尾没有读文件的代码，也没有 `fs` 引入。
 * 3. **没有「台词表路径」。** 三句话写死在 `rules.ts` 的 `SAY` 里。
 *    外部 JSON 的第一件事就是被改松，而这里松一下，人正烦躁时就会被多嘴一句。
 */

import type { FieldSpecLike, SectionDeclLike, DevPolicy } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不联网、不读文件，只认外壳给的事件枚举。 */
  readonly enable: boolean
  /** 失败后的安静期（秒）。 */
  readonly quietAfterFailSec: number
  /** 判「咬住了」所需的连续失败次数。 */
  readonly stuckFails: number
  /** 判「咬久了」所需的最短跨度（分钟）。 */
  readonly stuckSpanMin: number
  /** 「绿了」的冷却（分钟）。 */
  readonly celebrateCooldownMin: number
  /** 两次非静默出声之间的最小间隔（分钟）。 */
  readonly cueCooldownMin: number
  /** 是否参考 O-109 的在场状态。 */
  readonly respectPresence: boolean
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'dev-companion'

/** 安静期的允许区间（秒）。 */
export const QUIET_FLOOR = 10
export const QUIET_CEILING = 600

/** 连续失败次数的区间。低于 2 会把一次正常的手抖判成「咬住了」。 */
export const STUCK_FLOOR = 2
export const STUCK_CEILING = 10

/** 分钟类字段的区间。 */
export const MINUTE_FLOOR = 1
export const MINUTE_CEILING = 240

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 note() 抛 disabled，cue() 恒为 quiet(disabled)。',
  },
  quietAfterFailSec: {
    kind: 'number',
    default: 90,
    min: QUIET_FLOOR,
    max: QUIET_CEILING,
    doc: '失败后的安静期（秒）。人在改的时候一个字都不说。',
  },
  stuckFails: {
    kind: 'number',
    default: 3,
    min: STUCK_FLOOR,
    max: STUCK_CEILING,
    doc: '判「咬住了」所需的连续失败次数（同一指纹）。',
  },
  stuckSpanMin: {
    kind: 'number',
    default: 20,
    min: MINUTE_FLOOR,
    max: MINUTE_CEILING,
    doc: '判「咬久了」所需的最短跨度（分钟）。三次失败挤在两分钟里只是手抖。',
  },
  celebrateCooldownMin: {
    kind: 'number',
    default: 30,
    min: MINUTE_FLOOR,
    max: MINUTE_CEILING,
    doc: '「绿了」的冷却（分钟）。夸得太勤，夸就贬值了。',
  },
  cueCooldownMin: {
    kind: 'number',
    default: 10,
    min: MINUTE_FLOOR,
    max: MINUTE_CEILING,
    doc: '两次非静默出声之间的最小间隔（分钟）。',
  },
  respectPresence: {
    kind: 'boolean',
    default: true,
    doc: '是否参考 O-109 的在场状态（开会 / 人不在 / 读不到时闭嘴）。',
  },
})

/** 段声明。交给 O-005 做四层合并与来源追溯。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '开发者陪伴',
  fields: FIELD_SPECS,
  owner: 'ondra-dev-companion',
})

/** 全部段键（自检按集合比对）。 */
export const SECTION_KEYS: readonly string[] = Object.freeze(Object.keys(FIELD_SPECS) as string[])

/** 默认配置。从 `FIELD_SPECS` 派生，**不手写第二份**。 */
function defaultsOf(): Config {
  return {
    enable: FIELD_SPECS.enable.default === true,
    quietAfterFailSec: Number(FIELD_SPECS.quietAfterFailSec.default),
    stuckFails: Number(FIELD_SPECS.stuckFails.default),
    stuckSpanMin: Number(FIELD_SPECS.stuckSpanMin.default),
    celebrateCooldownMin: Number(FIELD_SPECS.celebrateCooldownMin.default),
    cueCooldownMin: Number(FIELD_SPECS.cueCooldownMin.default),
    respectPresence: FIELD_SPECS.respectPresence.default !== false,
  }
}

/** 默认配置（只读外观）。 */
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze(defaultsOf())

/** 把任意值夹到闭区间；非有限数回退默认。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  if (num < min) return min
  if (num > max) return max
  return Math.round(num)
}

/**
 * 补全配置。**永不抛错**：配置错不该让插件不加载。
 *
 * 顺序约束（`cueCooldownMin` 不得长于 `celebrateCooldownMin`）向下压：
 * 出声冷却比「绿了」的冷却还长时，一次真正的转绿会被出声冷却吞掉，
 * 于是她会在一整段修复之后仍然一声不吭——而那句「绿了呀」正是最该说的。
 * @param value 任意配置。
 * @returns 合法配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const base = defaultsOf()

  const celebrateCooldownMin = clampNumber(
    raw.celebrateCooldownMin,
    base.celebrateCooldownMin,
    MINUTE_FLOOR,
    MINUTE_CEILING,
  )
  let cueCooldownMin = clampNumber(
    raw.cueCooldownMin,
    base.cueCooldownMin,
    MINUTE_FLOOR,
    MINUTE_CEILING,
  )
  if (cueCooldownMin > celebrateCooldownMin) cueCooldownMin = celebrateCooldownMin

  return {
    enable: raw.enable === undefined ? base.enable : raw.enable !== false,
    quietAfterFailSec: clampNumber(
      raw.quietAfterFailSec,
      base.quietAfterFailSec,
      QUIET_FLOOR,
      QUIET_CEILING,
    ),
    stuckFails: clampNumber(raw.stuckFails, base.stuckFails, STUCK_FLOOR, STUCK_CEILING),
    stuckSpanMin: clampNumber(
      raw.stuckSpanMin,
      base.stuckSpanMin,
      MINUTE_FLOOR,
      MINUTE_CEILING,
    ),
    celebrateCooldownMin,
    cueCooldownMin,
    respectPresence:
      raw.respectPresence === undefined ? base.respectPresence : raw.respectPresence !== false,
  }
}

/** 只保留已知字段，丢掉陌生键（四层合并的 user 层用）。**入参可以是任意值。** */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === null || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(FIELD_SPECS)) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/** 把 O-005 的扁平值表还原成配置形状。 */
export function valuesToConfigShape(
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...values }
}

/**
 * 配置 → 判定口径（毫秒）。
 * @param config 合法配置。
 * @returns 判定口径。
 */
export function policyOf(config: Config): DevPolicy {
  return {
    quietAfterFailMs: config.quietAfterFailSec * 1000,
    stuckFails: config.stuckFails,
    stuckSpanMs: config.stuckSpanMin * 60_000,
    celebrateCooldownMs: config.celebrateCooldownMin * 60_000,
    cueCooldownMs: config.cueCooldownMin * 60_000,
    respectPresence: config.respectPresence,
  }
}
