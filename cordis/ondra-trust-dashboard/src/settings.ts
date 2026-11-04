/**
 * O-102 `ondra-trust-dashboard` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
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
 * 1. **没有「信任分权重」。** 一旦允许调权重，就说明本插件在自己算一个分。
 *    本插件只投影上游读数（见 `types.ts` 文件头），没有分可加权。
 * 2. **没有「阈值 / 及格线」。** 设一条「信任低于 60 就警告」，立刻会有人去刷那条线，
 *    而刷的对象是关系值——那是 O-028 的地盘，本插件只读。
 * 3. **没有「隐藏某一项」。** 藏起来等于让人以为「只剩这些」。真要少看，看的时候跳过即可
 *    （与 O-100 同一条理由）。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：纯只读，开着没有副作用。 */
  readonly enable: boolean
  /** 是否把「记忆存量」也算进去（大盘上唯一一项计数型读数）。 */
  readonly includeMemoryCover: boolean
  /** 降级与缺席时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'trust-dashboard'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。纯只读，关掉后服务仍注册但 available=false。',
  },
  includeMemoryCover: {
    kind: 'boolean',
    default: true,
    doc: '是否把「记忆存量」计入读数表。关掉只少一项计数，不影响其余四项。',
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
  includeMemoryCover: FIELD_SPECS.includeMemoryCover.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  includeMemoryCover: 'include-memory-cover',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '信任读数',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-trust-dashboard',
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
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    includeMemoryCover: bool('includeMemoryCover', DEFAULT_CONFIG.includeMemoryCover),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
