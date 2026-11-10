/**
 * O-100 `ondra-memory-heal` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 刻意没有的配置项（三条，都写清理由）
 *
 * 1. **没有「自动修复开关」。** 自愈一旦能自动跑，`confirm` 档那些不可逆动作
 *    迟早会被人打开那一个布尔值顺手放过。做成常驻自愈更是双重违规：
 *    插件形态不允许常驻服务，且 §17-6 禁假开关。
 * 2. **没有「问题严重度权重」「健康分公式」类配置。** 一旦有分数，人就开始刷分
 *    （O-097 同一条理由）；体检该给的是**清单**，不是分数。
 * 3. **没有「跳过哪类问题」的开关。** 跳过等于把问题藏起来——体检面板会显示「0 问题」，
 *    而真相是「有一类没查」。真要少看，看清单时跳过即可。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：只读巡检，开着没有副作用。 */
  readonly enable: boolean
  /**
   * 单次巡检最多翻多少条记忆。默认 400。
   *
   * 上限 2000（`MAX_SCAN_ROWS`）：每条都要算一次强度，2000 条已经是
   * 一次界面操作的忍耐上限。撞上限时报告里 `complete=false`，**不静默截断**。
   */
  readonly scanLimit: number
  /**
   * 是否顺带查一次疑似重复。默认 true。
   *
   * 关掉它只影响 `duplicate-group` 这一类（它本来就只报告不修），
   * 用于「库很大、只想快快看一遍硬伤」的场合。
   */
  readonly checkDuplicates: boolean
  /** 降级与缺席时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-heal'

/** 巡检条数下限。少于 20 条看不到任何模式。 */
const SCAN_MIN = 20

/** 巡检条数上限。与 `MAX_SCAN_ROWS` 保持一致，不写第二个数。 */
const SCAN_MAX = 2000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。自愈只做按需巡检，关掉后服务仍注册但 available=false。',
  },
  scanLimit: {
    kind: 'number',
    default: 400,
    min: SCAN_MIN,
    max: SCAN_MAX,
    advancedOnly: true,
    doc: '单次巡检最多翻多少条记忆。撞上限时报告标记为不完整，不静默截断。',
  },
  checkDuplicates: {
    kind: 'boolean',
    default: true,
    doc: '是否顺带查一次疑似重复（只报告不合并，合并归 ondra-memory-dedupe）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与上游缺席时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  scanLimit: FIELD_SPECS.scanLimit.default as number,
  checkDuplicates: FIELD_SPECS.checkDuplicates.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  scanLimit: 'scan-limit',
  checkDuplicates: 'check-duplicates',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆自愈',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-heal',
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

/** 把数字夹进区间；非有限数退默认值。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    scanLimit: clampInt(raw['scanLimit'], DEFAULT_CONFIG.scanLimit, SCAN_MIN, SCAN_MAX),
    checkDuplicates: bool('checkDuplicates', DEFAULT_CONFIG.checkDuplicates),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
