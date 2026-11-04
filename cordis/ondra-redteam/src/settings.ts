/**
 * O-104 `ondra-redteam` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 刻意没有的配置项（四条，都写清理由）
 *
 * 1. **没有「及格分 / 通过阈值」。** 本插件不出总分，也没有阈值可设——
 *    有阈值就意味着有人在追那个数，而追分的方式是调人格，不是修问题。
 * 2. **没有「跳过某一类套件」的勾选。** 跳过某套件之后报告会变好看，
 *    而人格一点没变好；这正是题库写死而不放配置的原因。
 * 3. **没有「自定义题库路径」。** 题库是真源，路径可配就等于允许换一份更宽松的题。
 * 4. **没有「自动跑评测」的定时器。** 本插件不装定时器、不做后台常驻：
 *    评测要人发起，因为**攻击话术必须由调用方送进去**（本插件不驱动对话）。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：纯判定，不发网络、不写盘。 */
  readonly enable: boolean
  /** 单条回复的长度上限（码位）。超长一律拒收。 */
  readonly maxReplyChars: number
  /** 报告里是否把「不过的 critical 题号」单独列出来（关掉只影响报告可读性）。 */
  readonly highlightCritical: boolean
  /** 降级与拒收时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'redteam'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，但 grade() / batch() 一律抛 disabled。',
  },
  maxReplyChars: {
    kind: 'number',
    default: 8000,
    min: 200,
    max: 40000,
    advancedOnly: true,
    doc: '单条回复长度上限（码位）。超长的多半是把整段对话粘进来了，判出来的结论没意义。',
  },
  highlightCritical: {
    kind: 'boolean',
    default: true,
    doc: '报告里单列「不过的 critical 题号」。关掉只影响可读性，不影响判定。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '拒收与降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxReplyChars: FIELD_SPECS.maxReplyChars.default as number,
  highlightCritical: FIELD_SPECS.highlightCritical.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxReplyChars: 'max-reply-chars',
  highlightCritical: 'highlight-critical',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '红队评测',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-redteam',
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
  const int = (key: keyof Config, fallback: number, min: number, max: number): number => {
    const given = raw[key]
    if (typeof given !== 'number' || !Number.isFinite(given)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(given)))
  }
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    maxReplyChars: int('maxReplyChars', DEFAULT_CONFIG.maxReplyChars, 200, 40000),
    highlightCritical: bool('highlightCritical', DEFAULT_CONFIG.highlightCritical),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
