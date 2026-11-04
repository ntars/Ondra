/**
 * 配置的**单一真源**（与 O-005 口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * 刻意**不进配置**的一组数：`TENSION_ADD 0.15`、`MOOD_CEILING 0.35`、
 * `LOCK_TENSION 0.5`、`LOCK_STRESS 0.85`、`MOOD_RISE 0.45`、`POSITIVE_STREAK 2`。
 * 它们是产品口径（前五个有手册出处，第六个手册逐字给了「连续 2 次」），
 * 做成可调就等于承认「吵到什么程度算吵架」可以随手改。
 * 要改就改 `types.ts` 一处。
 *
 * 放进来的只有**工程参数**：总开关、片段的存活时长与排序键、日志噪声。
 */

import { MIN_FRAGMENT_ORDER } from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但永不进锁、不产出指令。 */
  readonly enable: boolean
  /**
   * 行为指令的存活时长（分钟）。默认 30。
   *
   * 与 O-029 取同一个值不是巧合：那条指令跟着皮质醇（半衰期 30min），
   * 这条跟着张力（§3.4 里 tension 的半衰期是 24h，太长，不能拿来当 TTL）。
   * 取 30 分钟是「一次争执的语域大约维持半小时，再久就该由情绪自己决定」。
   */
  readonly directiveTtlMinutes: number
  /**
   * 行为指令的排序键。默认 -880。
   *
   * 比 O-029 的应激指令（-900）**低一位**：同时在应激又同时在生气时，
   * 「话短、别开玩笑」应该压过「不撒娇」——应激是生理层的，
   * 冲突是关系层的，生理先于关系。两者都不得低于器官地板 -1000。
   */
  readonly directiveOrder: number
  /** 进锁/解锁/产出指令时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'emotion-conflict'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后永不进锁，行为后果也不生效（服务照常注册，读到的是「没锁」）。',
  },
  directiveTtlMinutes: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 1440,
    doc: '冲突语域指令的存活时长（分钟）。默认 30：再久就该让情绪自己决定，而不是靠一句话定住。',
  },
  directiveOrder: {
    kind: 'number',
    default: -880,
    min: MIN_FRAGMENT_ORDER,
    max: -1,
    advancedOnly: true,
    doc: '冲突语域指令的排序键，默认 -880（低于应激指令的 -900）。夹到 [-1000, -1]，不抢疤痕的 -1e4。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '进锁、解锁、产出指令时打一行日志。只影响日志噪声。',
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
 * §8.4 的配置键正则不认大写，而 Cordis 插件实例配置历来是 camelCase。
 * 映射必须**双向唯一**，否则两个字段会抢同一个段键（「改 A 生效在 B 上」）。
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
  title: '冲突锁',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-emotion-conflict',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**（交给 O-005 报 `unknown-field`）。
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
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const order = clampInt(raw['directiveOrder'], DEFAULT_CONFIG.directiveOrder, -10000, 0)
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    directiveTtlMinutes: clampInt(raw['directiveTtlMinutes'], DEFAULT_CONFIG.directiveTtlMinutes, 1, 1440),
    directiveOrder: Math.min(-1, Math.max(MIN_FRAGMENT_ORDER, order)),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
