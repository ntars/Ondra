/**
 * O-118 `ondra-consistency-bench` 的配置**单一真源**（与 O-005 的口径一致：
 * 默认值由声明方拥有、只存一份）。
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
 * 1. **没有「及格线 / 通过阈值」。** 本插件不出总分，也没有阈值可设——
 *    有阈值就意味着有人在追那个数，而追分的方式是调人格参数，不是修问题。
 * 2. **没有「跳过某一类」的勾选。** 跳过口吻类之后报告会变好看，而人格一点没变好；
 *    这正是题库写死而不放配置的原因。
 * 3. **没有「判据强度 / 严格模式」。** 判据一旦可调，第一件事就是被调松——
 *    且调松之后没有任何痕迹能说明「这一轮的报告是宽松档跑出来的」。
 * 4. **没有「自定义题库路径」。** 题库是真源，路径可配就等于允许换一份更宽松的题。
 *
 * 剩下的四个字段**都不影响判定口径**，只影响拒收上限与报告细节量。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：纯判定，不发网络、不写盘。 */
  readonly enable: boolean
  /** 单条回复的长度上限（码位）。超长一律拒收。 */
  readonly maxReplyChars: number
  /** 报告里是否带命中位置区间。关掉只少一点细节，**不改判定**。 */
  readonly listSpans: boolean
  /** 降级与拒收时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致（去掉 `ondra-` 前缀），符合 §8.4。 */
export const CONFIG_SECTION_ID = 'consistency-bench'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，但 grade() / report() 一律抛 disabled。',
  },
  maxReplyChars: {
    kind: 'number',
    default: 6000,
    min: 200,
    max: 40000,
    advancedOnly: true,
    doc: '单条回复长度上限（码位）。超长的多半是把整段对话粘进来了，判出来的结论没意义。',
  },
  listSpans: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '报告里是否带命中位置区间（只给 from/to，不给原文）。关掉只少一点细节，不改判定。',
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
  listSpans: FIELD_SPECS.listSpans.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxReplyChars: 'max-reply-chars',
  listSpans: 'list-spans',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '人格一致性评测',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-consistency-bench',
})

/**
 * 判空对象。
 * @param value 待判值。
 */
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
 * 配置错不该让插件不加载——这是「体检工具」与「对话链」最大的区别：
 * 它缺席时没有任何人受影响，所以它可以宽容；而它一旦抛错，宿主会把它整块摘掉。
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
    listSpans: bool('listSpans', DEFAULT_CONFIG.listSpans),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
