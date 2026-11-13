/**
 * 配置的**单一真源**（与 O-005 口径一致：默认值由声明方拥有、只存一份）。
 *
 * 全部字段都有合理默认值：装上去就能提炼。唯一「默认关」的是 `allowGroup`——
 * 群聊不提炼是手册 §2.2 的**准入红线**（不收群友闲聊），不是性能取舍，
 * 所以它默认 `false`，要打开得由主人明确改。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。默认 `true`；关掉后服务照常注册但 `available=false`（区分「没装」与「关了」）。 */
  readonly enable: boolean
  /** 是否允许从群聊提炼。默认 `false`（准入红线）。 */
  readonly allowGroup: boolean
  /** 单轮最多提炼几条。默认 8。 */
  readonly maxFacts: number
  /** 单条正文上限（字）。默认 200（手册 §2.2）。 */
  readonly maxTextChars: number
  /** 摘要上限（字）。默认 80（手册 §2.2）。 */
  readonly maxSummaryChars: number
  /** 引文最短字数。默认 2。 */
  readonly minQuoteChars: number
  /**
   * 数字是否**只**认 TOOL 引文。默认 `false`（TOOL 与 USER 都算出处）。
   *
   * 打开它等于严格照手册 §2.2 字面执行，代价是用户亲口说的数字
   * （「我 28 岁」「尾号 3721」）会被整条拒掉——见 `verify.ts` 那段注释。
   */
  readonly requireToolForDigits: boolean
  /** 采样温度。默认 0.2（提炼要稳，不要发挥）。 */
  readonly temperature: number
  /** 输出上限 token。默认 1200。 */
  readonly maxTokens: number
  /** 输入预算（字）。默认 12000；超了从**最早**的消息开始丢。 */
  readonly maxInputChars: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-extract'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归应用侧。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '提炼总开关。关掉后服务仍注册但不可用——「关了」与「没装」必须能区分。',
  },
  allowGroup: {
    kind: 'boolean',
    default: false,
    doc: '是否从群聊提炼。默认关：手册把「不收群友闲聊」列为准入红线，不是性能取舍。',
  },
  maxFacts: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 64,
    doc: '单轮最多提炼几条。超出部分记 `over-limit` 拒绝，不静默丢。',
  },
  maxTextChars: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2000,
    doc: '单条正文上限（字）。超长截断（与 O-010 同一口径），不整条拒绝。',
    unit: '字',
  },
  maxSummaryChars: {
    kind: 'number',
    default: 80,
    min: 10,
    max: 500,
    doc: '摘要上限（字）。模型没给摘要时用正文前若干字代替。',
    unit: '字',
  },
  minQuoteChars: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 20,
    advancedOnly: true,
    doc: '引文最短字数。1 个字的引文在任何句子里都能找到，等于没有证据。',
  },
  requireToolForDigits: {
    kind: 'boolean',
    default: false,
    doc: '数字的出处来源。关（默认）＝TOOL 与 USER 的逐字引文都算出处，与「证据门控 → digit-source」的 tool-or-user 同口径；开＝只认 TOOL，严格照手册字面。**两种情况都会检查**：正文里的数字必须被引文逐字覆盖，口述数字不会因为关掉它就不用有出处。',
  },
  temperature: {
    kind: 'number',
    default: 0.2,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '采样温度。提炼要稳，不要发挥。',
  },
  maxTokens: {
    kind: 'number',
    default: 1200,
    min: 200,
    max: 8000,
    advancedOnly: true,
    doc: '输出上限 token。8 条事实的 JSON 大约 600–900 token。',
  },
  maxInputChars: {
    kind: 'number',
    default: 12000,
    min: 500,
    max: 200000,
    advancedOnly: true,
    doc: '输入预算（字）。超了从最早的消息开始丢；被丢掉的消息不参与引文校验。',
    unit: '字',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  allowGroup: FIELD_SPECS.allowGroup.default as boolean,
  maxFacts: FIELD_SPECS.maxFacts.default as number,
  maxTextChars: FIELD_SPECS.maxTextChars.default as number,
  maxSummaryChars: FIELD_SPECS.maxSummaryChars.default as number,
  minQuoteChars: FIELD_SPECS.minQuoteChars.default as number,
  requireToolForDigits: FIELD_SPECS.requireToolForDigits.default as boolean,
  temperature: FIELD_SPECS.temperature.default as number,
  maxTokens: FIELD_SPECS.maxTokens.default as number,
  maxInputChars: FIELD_SPECS.maxInputChars.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * 理由同 O-010 / O-035：§8.4 的配置键正则不含大写，而 Cordis 插件实例配置是 camelCase，
 * 同一份配置在两个命名空间里必须有两个合法名字。映射必须双向唯一。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  allowGroup: 'allow-group',
  maxFacts: 'max-facts',
  maxTextChars: 'max-text-chars',
  maxSummaryChars: 'max-summary-chars',
  minQuoteChars: 'min-quote-chars',
  requireToolForDigits: 'require-tool-for-digits',
  temperature: 'temperature',
  maxTokens: 'max-tokens',
  maxInputChars: 'max-input-chars',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆提炼',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-extract',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。未知键原样保留，交给 O-005 报 `unknown-field`。
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

/** 夹一个浮点。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    allowGroup: raw['allowGroup'] === undefined ? DEFAULT_CONFIG.allowGroup : raw['allowGroup'] === true,
    maxFacts: clampInt(raw['maxFacts'], DEFAULT_CONFIG.maxFacts, 1, 64),
    maxTextChars: clampInt(raw['maxTextChars'], DEFAULT_CONFIG.maxTextChars, 20, 2000),
    maxSummaryChars: clampInt(raw['maxSummaryChars'], DEFAULT_CONFIG.maxSummaryChars, 10, 500),
    minQuoteChars: clampInt(raw['minQuoteChars'], DEFAULT_CONFIG.minQuoteChars, 1, 20),
    requireToolForDigits:
      raw['requireToolForDigits'] === undefined
        ? DEFAULT_CONFIG.requireToolForDigits
        : raw['requireToolForDigits'] === true,
    temperature: clampFloat(raw['temperature'], DEFAULT_CONFIG.temperature, 0, 1),
    maxTokens: clampInt(raw['maxTokens'], DEFAULT_CONFIG.maxTokens, 200, 8000),
    maxInputChars: clampInt(raw['maxInputChars'], DEFAULT_CONFIG.maxInputChars, 500, 200000),
  })
}
