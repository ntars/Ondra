/**
 * 配置的**单一真源**。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么只有四个字段
 *
 * 这个插件的形态几乎全是**手册定的**：话由的种类与顺序、72 小时冷却、
 * 「不按条数砍」。做成配置项就等于每台机器的「她为什么找你」不一样，
 * 而面板与日志只认一个版本。
 *
 * 真正需要按部署调整的只有四件：开关、冷却时长、要不要台词池兜底、日志噪声。
 */

import { COOLDOWN_HOURS } from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`plan()` 返回 `disabled`。 */
  readonly enable: boolean
  /** 同一话题的冷却小时数（台账 O-043 原值 72）。 */
  readonly cooldownHours: number
  /** 是否允许台词池兜底（手册 §9.3 的最后一位）。 */
  readonly poolEnabled: boolean
  /** 降级与拒绝时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'proactive-reason'

/** 冷却时长的上界（30 天）。再长就不是「别重复」而是「永远别提」。 */
export const MAX_COOLDOWN_HOURS = 720

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，plan() 返回 disabled。',
  },
  cooldownHours: {
    kind: 'number',
    default: COOLDOWN_HOURS,
    min: 0,
    max: MAX_COOLDOWN_HOURS,
    doc: '同一话题的冷却小时数（台账原值 72）。',
  },
  poolEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否允许台词池兜底（手册 §9.3 的最后一位）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与拒绝时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  cooldownHours: FIELD_SPECS.cooldownHours.default as number,
  poolEnabled: FIELD_SPECS.poolEnabled.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  cooldownHours: 'cooldown-hours',
  poolEnabled: 'pool-enabled',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '主动话由',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-proactive-reason',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
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
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    cooldownHours: clampInt(raw['cooldownHours'], DEFAULT_CONFIG.cooldownHours, 0, MAX_COOLDOWN_HOURS),
    poolEnabled: bool('poolEnabled', DEFAULT_CONFIG.poolEnabled),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
