/**
 * O-109 `ondra-screen-sense` 的配置**单一真源**。
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
 * master-plan §9 参数速查里**没有**「屏幕感知」这一组——只有情绪、节奏、主动、语音、
 * 对话、界面六组。故下面六个数值全是**本插件的工程取值**，依据是三条可观察的线：
 *
 * - 30 秒采样：人换一次事的典型节奏是分钟级，秒级采样只会把同一件事切成碎片；
 * - 90 秒抖动窗：一次「切过去看一眼再切回来」通常在 1 分钟内，90 秒能把这类来回吃掉；
 * - 12 分钟专注：一次真正的「坐下来做一件事」少于此数多半还在找东西；
 * - 8 分钟空闲：与 O-105 的「离开」口径同量级，避免她一边说你不在一边被护栏说你还在；
 * - 10 分钟 5 次换手：五分钟一次以上的窗口切换，已经不是「在做一件事」了。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「要不要记窗口标题」。** 那是纪律不是偏好：存档里根本没有这个字段，
 *    开后门的位置都不留（参见 `store.ts` 的字段清单）。
 * 2. **没有「说几句 / 说什么话术」。** 台词表写在 `classify.ts` 的 `LINES` 里，
 *    只有三行、只有一个状态能取到；做成可配就等于允许把「会议中也说一句」打开。
 * 3. **没有「类目自定义」。** 类目是闭集，外壳只能往里填，不能新增。
 *    能新增就等于允许某个外壳发明一个 `other`，把所有不认识的东西倒进去。
 */

import type { FieldSpecLike, SectionDeclLike, SensePolicy } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不上网、不截屏、只有一个类目枚举。 */
  readonly enable: boolean
  /** 两次采样最小间隔（秒）。 */
  readonly minIntervalSec: number
  /** 抖动吸收窗（秒）。 */
  readonly stabilitySec: number
  /** 判「在做一件事」的持续时长（分钟）。 */
  readonly focusMin: number
  /** 判「人不在」的空闲时长（分钟）。 */
  readonly idleMin: number
  /** 判「散着」所需的换手次数。 */
  readonly scatterSwitches: number
  /** 换手统计窗口（分钟）。 */
  readonly scatterWindowMin: number
  /** 是否读 O-105 的连续使用时长。 */
  readonly followSession: boolean
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'screen-sense'

/** 采样间隔的允许区间（秒）。低于 5 秒没有意义，高于 10 分钟会漏掉整段工作。 */
export const INTERVAL_FLOOR = 5
export const INTERVAL_CEILING = 600

/** 抖动窗的允许区间（秒）。 */
export const STABILITY_FLOOR = 10
export const STABILITY_CEILING = 900

/** 分钟类字段的区间。 */
export const MINUTE_FLOOR = 1
export const MINUTE_CEILING = 240

/** 换手次数的区间。低于 2 会把一次正常切换判成「散着」。 */
export const SCATTER_FLOOR = 2
export const SCATTER_CEILING = 40

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 note() 抛 disabled，view() 恒为 unknown。',
  },
  minIntervalSec: {
    kind: 'number',
    default: 30,
    min: INTERVAL_FLOOR,
    max: INTERVAL_CEILING,
    doc: '两次采样最小间隔（秒）。更密的采样只会把同一件事切成碎片。',
  },
  stabilitySec: {
    kind: 'number',
    default: 90,
    min: STABILITY_FLOOR,
    max: STABILITY_CEILING,
    doc: '抖动吸收窗（秒）。一段类目存活不满它就被换掉时，算抖了一下，不结束当前段。',
  },
  focusMin: {
    kind: 'number',
    default: 12,
    min: MINUTE_FLOOR,
    max: MINUTE_CEILING,
    doc: '判「在做一件事」的持续时长（分钟）。',
  },
  idleMin: {
    kind: 'number',
    default: 8,
    min: MINUTE_FLOOR,
    max: MINUTE_CEILING,
    doc: '判「人不在」的空闲时长（分钟）。与 O-105 的离开口径同量级。',
  },
  scatterSwitches: {
    kind: 'number',
    default: 5,
    min: SCATTER_FLOOR,
    max: SCATTER_CEILING,
    doc: '判「散着」所需的换手次数（统计窗口内）。',
  },
  scatterWindowMin: {
    kind: 'number',
    default: 10,
    min: MINUTE_FLOOR,
    max: MINUTE_CEILING,
    doc: '换手次数的统计窗口（分钟）。',
  },
  followSession: {
    kind: 'boolean',
    default: true,
    doc: '是否读 O-105 的连续使用分钟数。关掉则 sessionMinutes 恒为 null——不自己算，避免第二个真源。',
  },
})

/** 段声明。交给 O-005 做四层合并与来源追溯。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '屏幕感知',
  fields: FIELD_SPECS,
  owner: 'ondra-screen-sense',
})

/** 全部段键（自检按集合比对）。 */
export const SECTION_KEYS: readonly string[] = Object.freeze(
  Object.keys(FIELD_SPECS) as string[],
)

/** 默认配置。从 `FIELD_SPECS` 派生，**不手写第二份**。 */
function defaultsOf(): Config {
  return {
    enable: FIELD_SPECS.enable.default === true,
    minIntervalSec: Number(FIELD_SPECS.minIntervalSec.default),
    stabilitySec: Number(FIELD_SPECS.stabilitySec.default),
    focusMin: Number(FIELD_SPECS.focusMin.default),
    idleMin: Number(FIELD_SPECS.idleMin.default),
    scatterSwitches: Number(FIELD_SPECS.scatterSwitches.default),
    scatterWindowMin: Number(FIELD_SPECS.scatterWindowMin.default),
    followSession: FIELD_SPECS.followSession.default !== false,
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
 * 顺序类约束（`idleMin` 必须大于 `focusMin`）**向下压而不是向上抬**：
 * 若「人不在」比「在做一件事」还短，任何一段专注都会被先判成离开，
 * 于是她永远只有两句话——「你在忙」和「你走了」，中间那段没有。
 * @param value 任意配置。
 * @returns 合法配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const base = defaultsOf()

  const minIntervalSec = clampNumber(
    raw.minIntervalSec,
    base.minIntervalSec,
    INTERVAL_FLOOR,
    INTERVAL_CEILING,
  )
  const stabilitySec = clampNumber(
    raw.stabilitySec,
    base.stabilitySec,
    STABILITY_FLOOR,
    STABILITY_CEILING,
  )
  const focusMin = clampNumber(raw.focusMin, base.focusMin, MINUTE_FLOOR, MINUTE_CEILING)
  let idleMin = clampNumber(raw.idleMin, base.idleMin, MINUTE_FLOOR, MINUTE_CEILING)
  if (idleMin <= focusMin) idleMin = Math.min(MINUTE_CEILING, focusMin + 1)

  return {
    enable: raw.enable === undefined ? base.enable : raw.enable !== false,
    minIntervalSec,
    stabilitySec,
    focusMin,
    idleMin,
    scatterSwitches: clampNumber(
      raw.scatterSwitches,
      base.scatterSwitches,
      SCATTER_FLOOR,
      SCATTER_CEILING,
    ),
    scatterWindowMin: clampNumber(
      raw.scatterWindowMin,
      base.scatterWindowMin,
      MINUTE_FLOOR,
      MINUTE_CEILING,
    ),
    followSession: raw.followSession === undefined ? base.followSession : raw.followSession !== false,
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
 *
 * 换算只在这里做一次：纯函数拿到的一律是毫秒，不让每个判定各自乘 60。
 * @param config 合法配置。
 * @returns 判定口径。
 */
export function policyOf(config: Config): SensePolicy {
  return {
    minIntervalMs: config.minIntervalSec * 1000,
    stabilityMs: config.stabilitySec * 1000,
    focusMs: config.focusMin * 60_000,
    idleMs: config.idleMin * 60_000,
    scatterSwitches: config.scatterSwitches,
    scatterWindowMs: config.scatterWindowMin * 60_000,
    followSession: config.followSession,
  }
}
