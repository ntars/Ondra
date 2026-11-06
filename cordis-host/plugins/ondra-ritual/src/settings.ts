/**
 * O-115 `ondra-ritual` 的配置**单一真源**。
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
 * ## 配置项为什么只有这几个
 *
 * 全部是**收窄**用的：能关掉一类日子、能少说几个、能不动用天气。
 * **没有一个能放宽**：没有「允许模型自己想一个节日」、没有「允许报还有几天」、
 * 没有「允许主动提醒」。这三条是纪律，做成开关就等于留了一个会被打开的口子。
 *
 * `scanDays` 是全表唯一的「天数」，它只决定**往后翻几天去找下一个节气**，
 * 本身从不出现在任何输出里——这一点写在字段说明里，免得日后有人顺手把它念出来。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不联网、不落盘、不算历法。 */
  readonly enable: boolean
  /** 是否把传统节日也纳入仪式。关掉只认节气。 */
  readonly includeFestivals: boolean
  /** `upcoming()` 最多给几个（不是几天）。 */
  readonly upcomingLimit: number
  /** 往后翻几天去找下一个日子。**只用于扫描窗口，绝不外传。** */
  readonly scanDays: number
  /** 有天气且要下雨时，是否把动作换成室内替代。 */
  readonly wetAdjust: boolean
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'ritual'

/** `upcoming()` 的条数区间：给一条太少（等于倒计时），给五条以上就是一张日程表。 */
export const UPCOMING_FLOOR = 1
export const UPCOMING_CEILING = 5

/** 扫描窗口的区间。上限与 O-046 `upcoming()` 的上限一致（60 天）。 */
export const SCAN_FLOOR = 1
export const SCAN_CEILING = 60

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，today() / upcoming() 抛 disabled，stats() 照常可读。',
  },
  includeFestivals: {
    kind: 'boolean',
    default: true,
    doc: '是否把传统节日（春节、中秋这类）也纳入仪式。关掉只认二十四节气。',
  },
  upcomingLimit: {
    kind: 'number',
    default: 3,
    min: UPCOMING_FLOOR,
    max: UPCOMING_CEILING,
    advancedOnly: true,
    doc: 'upcoming() 最多给几个日子（是条数，不是天数）。默认 3。',
  },
  scanDays: {
    kind: 'number',
    default: 15,
    min: SCAN_FLOOR,
    max: SCAN_CEILING,
    advancedOnly: true,
    doc: '往后翻几天去找下一个节气。两个节气大约相隔半个月，所以默认 15。只用于扫描窗口，从不出现在输出里。',
  },
  wetAdjust: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '有天气服务且今天要下雨下雪时，把动作换成室内替代。天气取不到时什么都不做。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  includeFestivals: FIELD_SPECS.includeFestivals.default as boolean,
  upcomingLimit: FIELD_SPECS.upcomingLimit.default as number,
  scanDays: FIELD_SPECS.scanDays.default as number,
  wetAdjust: FIELD_SPECS.wetAdjust.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  includeFestivals: 'include-festivals',
  upcomingLimit: 'upcoming-limit',
  scanDays: 'scan-days',
  wetAdjust: 'wet-adjust',
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
  title: '节气仪式',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-ritual',
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

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 *
 * 没有任何跨字段约束：这五个字段互不相干，调错一个只影响它自己。
 * 「配置错不该让插件不加载」这条比「配置错要报出来」重要——
 * 一个节气插件因为少写了一个字段就不加载，代价远大于它多给了一句默认仪式。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const num = (key: keyof Config, fallback: number, min: number, max: number): number => {
    const given = raw[key]
    if (typeof given !== 'number' || !Number.isFinite(given)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(given)))
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    includeFestivals: bool('includeFestivals', DEFAULT_CONFIG.includeFestivals),
    upcomingLimit: num('upcomingLimit', DEFAULT_CONFIG.upcomingLimit, UPCOMING_FLOOR, UPCOMING_CEILING),
    scanDays: num('scanDays', DEFAULT_CONFIG.scanDays, SCAN_FLOOR, SCAN_CEILING),
    wetAdjust: bool('wetAdjust', DEFAULT_CONFIG.wetAdjust),
  })
}
