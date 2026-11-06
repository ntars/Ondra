/**
 * 配置的**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * 刻意**不进配置**的一组数：三个锚点（40 / 60 / 80）与三个倍率（1 / 2 / 3 / 0.55 / 0.1）。
 * 它们是手册 §3.8 逐字给出的产品口径，做成可调就等于承认「多紧张算应激」可以随手改，
 * 而文档与宣传都在引用这组数。要改就改 `types.ts` 的四个锚点常量一处（斜率自动跟随）。
 *
 * 放进来的只有**工程参数**：总开关、片段的存活时长与排序键、日志噪声。
 */

import { MIN_FRAGMENT_ORDER } from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但倍率恒为 ×1/×1、不产出指令。 */
  readonly enable: boolean
  /**
   * 行为指令的存活时长（分钟）。默认 30。
   *
   * 为什么是 30：皮质醇的半衰期就是 30 分钟（手册 §3.2 化学池表）。
   * 取一个半衰期，意味着「一小时后这条指令若没人续写，它就该消失」——
   * 指令是跟着激素走的，激素退了指令还在，她会一直无缘无故地冷淡下去。
   */
  readonly directiveTtlMinutes: number
  /**
   * 行为指令的排序键。默认 -900（越小越靠前）。
   *
   * 手册 §3.8 原话是「皮质醇 ≥80 时在系统提示词**最前面**注入行为指令」。
   * 但器官 ABI §8.1 又规定「疤痕永远在 -1e4」，所以「最前」只能是
   * **疤痕之后、其余一切之前**：-900 落在 [MIN_FRAGMENT_ORDER, 0) 的靠前区。
   * 越界会被夹到 -1000（器官地板），不许去抢疤痕的位置。
   */
  readonly directiveOrder: number
  /** 产出指令与重排时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'emotion-stress'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不再改变任何排序，服务照常注册（消费方拿到的是恒等倍率）。',
  },
  directiveTtlMinutes: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 1440,
    doc: '应激行为指令的存活时长（分钟）。默认 30 = 皮质醇的一个半衰期，激素退了指令跟着退。',
  },
  directiveOrder: {
    kind: 'number',
    default: -900,
    min: MIN_FRAGMENT_ORDER,
    max: -1,
    advancedOnly: true,
    doc: '应激行为指令的排序键，越小越靠前。手册要求「最前面」，但 -1e4 是疤痕专用，故取 -900。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '重排与产出指令时打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  directiveTtlMinutes: FIELD_SPECS.directiveTtlMinutes.default as number,
  directiveOrder: FIELD_SPECS.directiveOrder.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 的配置键正则 `^[a-z][a-z0-9_-]{1,63}$` 不认大写，
 * 而 Cordis 插件实例配置历来是 camelCase。映射必须**双向唯一**，
 * 否则两个字段会抢同一个段键，表现是「改 A 生效在 B 上」。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  directiveTtlMinutes: 'directive-ttl-minutes',
  directiveOrder: 'directive-order',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '应激注意力倍率',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-emotion-stress',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**，交给 O-005 报 `unknown-field`——在这里悄悄吞掉，
 * 用户就只会看到「我填了怎么没生效」。
 * @param raw 原始配置对象。
 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_PAIRS[key as keyof Config] ?? key] = value
  }
  return out
}

/**
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状（camel 键）。
 * @param values 解析结果的 `values`。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_KEYS[key] ?? key] = value
  }
  return out
}

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 *
 * 排序键额外夹到 `[-1000, -1]`：小于 -1000 会去抢疤痕的 `-1e4`，
 * 大于等于 0 就不再是「最前面」，两种都不该被静默接受。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const order = clampInt(raw['directiveOrder'], DEFAULT_CONFIG.directiveOrder, -10000, 0)
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    directiveTtlMinutes: clampInt(raw['directiveTtlMinutes'], DEFAULT_CONFIG.directiveTtlMinutes, 1, 1440),
    // 严格夹到器官地板：-1e4 是疤痕专用，填太深也不许占。
    directiveOrder: Math.min(-1, Math.max(MIN_FRAGMENT_ORDER, order)),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
