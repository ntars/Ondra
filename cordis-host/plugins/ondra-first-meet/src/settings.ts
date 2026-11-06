/**
 * O-107 `ondra-first-meet` 的配置**单一真源**。
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
 * ## 为什么只有三个字段（这是本轮最克制的决定）
 *
 * 初见最容易做成一张设置表：「是否自我介绍」「是否立边界」「是否问第一个问题」
 * 「第几拍说多久」……每加一个勾选，就多一种「她第一次见面像客服」的配置组合。
 * 而初见**只发生一次**，用户不会为了那一次去调七个开关。
 *
 * 保留的三个字段各自回答一个真问题：
 * - `enable`：彻底关掉（关掉后服务仍注册，读接口照常可读）；
 * - `autoStart`：第一条对话要不要自动进初见（老用户重装时不想再看一遍）；
 * - `maxSentencesCap`：**只许收紧、不许放宽**的句数上限，产品口径要「更少话」时改这一处。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「节拍顺序」。** 把 `boundary` 调到 `invite` 之后，第一句就变成索取；
 *    顺序是语义，不是偏好。
 * 2. **没有「每拍句数」。** 单拍句数写在 `beats.ts` 里，只受 `maxSentencesCap` 向下约束。
 *    做成逐拍可配，等于允许把「到场」调成五句话的开场白。
 * 3. **没有「人设口吻」。** 口吻归人格（O-020）；这里只有一个旋钮，且只能往下拧。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：本插件不联网、不写正文，只有一个进度 JSON。 */
  readonly enable: boolean
  /** 第一条对话是否自动进入初见。默认 true。 */
  readonly autoStart: boolean
  /**
   * 单拍句数上限的**天花板**（1–3）。
   *
   * 语义是「节拍自带的句数不得超过它」，即 `min(beat.maxSentences, cap)`。
   * 只能收紧不能放宽：`beats.ts` 里最长的拍是 3 句，把 cap 设成 10 不会让任何拍变长。
   */
  readonly maxSentencesCap: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'first-meet'

/** 句数上限的允许区间。`beats.ts` 里最长的拍是 3 句，故上限就是 3。 */
export const SENTENCE_CAP_FLOOR = 1
export const SENTENCE_CAP_CEILING = 3

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，advance() / reset() 抛 disabled，plan() 照常可读。',
  },
  autoStart: {
    kind: 'boolean',
    default: true,
    doc: '第一条对话是否自动进入初见。关掉后 plan() 返回空节拍，必须显式调用才走流程。',
  },
  maxSentencesCap: {
    kind: 'number',
    default: 3,
    min: SENTENCE_CAP_FLOOR,
    max: SENTENCE_CAP_CEILING,
    advancedOnly: true,
    doc: '单拍句数天花板（只收不放）。调小可以让每一拍都更短，调大不会有任何效果。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  autoStart: FIELD_SPECS.autoStart.default as boolean,
  maxSentencesCap: FIELD_SPECS.maxSentencesCap.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  autoStart: 'auto-start',
  maxSentencesCap: 'max-sentences-cap',
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
  title: '初见剧本',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-first-meet',
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
  const given = raw['maxSentencesCap']
  const cap =
    typeof given === 'number' && Number.isFinite(given)
      ? Math.min(SENTENCE_CAP_CEILING, Math.max(SENTENCE_CAP_FLOOR, Math.trunc(given)))
      : DEFAULT_CONFIG.maxSentencesCap
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    autoStart: bool('autoStart', DEFAULT_CONFIG.autoStart),
    maxSentencesCap: cap,
  })
}
