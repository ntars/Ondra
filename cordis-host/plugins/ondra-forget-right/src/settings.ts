/**
 * O-103 `ondra-forget-right` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
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
 * 1. **没有「删哪些面」的勾选列表。** 让用户勾「只删记忆正文不删图边」，
 *    得到的就是一个删不干净的忘记——被遗忘权的全部价值在于**清算完整**。
 *    真要少删，那叫「封存」或「订正」，O-017 已有另外三种模式。
 * 2. **没有「跳过确认」开关。** `{ confirm: 'forget' }` 是硬编码的令牌，
 *    一个开关就能让它失效的话，它从一开始就不算令牌。
 * 3. **没有「清空台词库」的自动开关。** `lexicon` 面只能整份清，
 *    会自动清掉别人说的话，必须由人当次点名（见 `clearLexicon`）。
 * 4. **没有「保留期 / 自动清理」。** 本插件不装定时器、不做后台常驻——
 *    「忘记」是用户发起的一次性动作，不是后台任务。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：`plan()` 纯只读，`execute()` 必须带令牌。 */
  readonly enable: boolean
  /** 是否在残余扫描里数日记篇数（会读目录，条数多时略慢）。 */
  readonly scanDiary: boolean
  /** 是否在残余扫描里数叙事日志条数。 */
  readonly scanTrace: boolean
  /** 执行 `lexicon` 面时是否允许调用 `reset()`（**默认 false**：它会清掉别人说的话）。 */
  readonly clearLexicon: boolean
  /** 降级与缺席时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'forget-right'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，但 plan() / execute() 一律抛 disabled。',
  },
  scanDiary: {
    kind: 'boolean',
    default: true,
    doc: '残余扫描时数日记篇数。关掉后日记那一行显示「未统计」而不是 0。',
  },
  scanTrace: {
    kind: 'boolean',
    default: true,
    doc: '残余扫描时数叙事日志条数。关掉后那一行显示「未统计」而不是 0。',
  },
  clearLexicon: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '允许对 lexicon 面调用 reset()。默认关：它会把所有语感样本一起清掉，包括别人的话。',
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
  scanDiary: FIELD_SPECS.scanDiary.default as boolean,
  scanTrace: FIELD_SPECS.scanTrace.default as boolean,
  clearLexicon: FIELD_SPECS.clearLexicon.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  scanDiary: 'scan-diary',
  scanTrace: 'scan-trace',
  clearLexicon: 'clear-lexicon',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '被遗忘权',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-forget-right',
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
    scanDiary: bool('scanDiary', DEFAULT_CONFIG.scanDiary),
    scanTrace: bool('scanTrace', DEFAULT_CONFIG.scanTrace),
    clearLexicon: bool('clearLexicon', DEFAULT_CONFIG.clearLexicon),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
