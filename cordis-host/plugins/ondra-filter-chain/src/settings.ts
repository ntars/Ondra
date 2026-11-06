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
 * ## 哪些数不进配置
 *
 * 九步的名字与顺序、句边界的分隔符集合、`hardCut` 的省略号，都是**形态**，
 * 做成配置项就等于让每台机器的过滤链不一样，而 提示词预览只认一个版本。
 *
 * ## 阈值为什么都标「自定」
 *
 * 手册 §4.1 只给九个名字与顺序，**一个正则、一个阈值都没给**。
 * 所以这里每个数字都是自定的，逐条写进 README「待裁决」。
 * 把它们写进配置而不是散在代码里，是因为主人一句话就能改回来。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`repeatThreshold`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `run()` 原样返回正文。 */
  readonly enable: boolean
  /**
   * 回复长度上限（字符）。默认 400。
   *
   * 手册没给这个数（只给「单条中位 8–12 字」）。取 400 的理由：
   * 一条正常的陪伴回复通常 1–5 句，400 字已经足够长；超过它的多半是
   * 「分析 + 列举 + 总结」的客服式长文，正是本链要削的东西。
   */
  readonly maxChars: number
  /** 过滤后少于多少字就判「说没了」，整段拒收。默认 2。 */
  readonly minChars: number
  /** 复读判定的 n-gram 长度。默认 4（手册原文就叫 4-gram）。 */
  readonly repeatNgram: number
  /** 复读判定的重合度阈值 0–1。默认 0.6。 */
  readonly repeatThreshold: number
  /** 跨轮复读要比较最近几条。默认 3。 */
  readonly repeatRecentCount: number
  /** 是否启用硬红线（O-021 `boundaries(hard)`）。默认 `true`。 */
  readonly hardRedline: boolean
  /** 是否启用关系越线（O-021 `variant(cautions)`）。默认 `true`。 */
  readonly relationGuard: boolean
  /** 是否启用阶段越线（内置 7 条表）。默认 `true`。 */
  readonly stageGuard: boolean
  /** 是否摘掉第三人称旁白。默认 `true`。 */
  readonly stripParenthetical: boolean
  /** 是否把「您」改成「你」。默认 `true`（客服腔最明显的一个字）。 */
  readonly youFormal: boolean
  /** 额外硬红线字面（作者补充，命中即摘整句）。默认空。 */
  readonly redlinePatterns: readonly string[]
  /** 额外关系越线字面。默认空。 */
  readonly relationPatterns: readonly string[]
  /**
   * 是否按情绪收紧长度上限。默认 `true`。
   *
   * 困（`silenceBias`）与炸毛（`proactivePaused`）时话说得更短。
   * 系数（0.6 / 0.7）手册没给，自定，见 README 待裁决。
   */
  readonly emotionShrink: boolean
  /** 是否启用事后评审。默认 `true`。 */
  readonly reviewEnabled: boolean
  /** 评审及格线（1–100）。默认 70。 */
  readonly reviewThreshold: number
  /** 每轮最多评几次。默认 2（手册 §1.7「每轮最多 2 轮」）。 */
  readonly reviewMaxRounds: number
  /** 评审指定来源 id（留空 = 按网关优先级选）。 */
  readonly reviewSource: string
  /** 评审温度。默认 0.2（打分要稳，不要发挥）。 */
  readonly reviewTemperature: number
  /** 失败与降级时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'filter-chain'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 run() 原样返回正文。',
  },
  maxChars: {
    kind: 'number',
    default: 400,
    min: 20,
    max: 8000,
    doc: '回复长度上限。手册未给，取 400（超过它多半是客服式长文）。',
  },
  minChars: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 200,
    advancedOnly: true,
    doc: '过滤后少于这么多字就判「说没了」，整段拒收（不编一句假的顶上）。',
  },
  repeatNgram: {
    kind: 'number',
    default: 4,
    min: 2,
    max: 8,
    advancedOnly: true,
    doc: '复读判定的 n-gram 长度。手册原文叫 4-gram。',
  },
  repeatThreshold: {
    kind: 'number',
    default: 0.6,
    min: 0.2,
    max: 1,
    advancedOnly: true,
    doc: '复读重合度阈值。自定（手册未给）。',
  },
  repeatRecentCount: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 20,
    advancedOnly: true,
    doc: '跨轮复读比较最近几条。0 = 只判段内复读。',
  },
  hardRedline: {
    kind: 'boolean',
    default: true,
    doc: '是否启用硬红线（来自 O-021 的硬约束条目）。',
  },
  relationGuard: {
    kind: 'boolean',
    default: true,
    doc: '是否启用关系越线（来自当前关系的 cautions）。',
  },
  stageGuard: {
    kind: 'boolean',
    default: true,
    doc: '是否启用阶段越线（内置 7 条表，登记待裁决）。',
  },
  stripParenthetical: {
    kind: 'boolean',
    default: true,
    doc: '是否摘掉第三人称旁白。短的第一人称动作（呼吸感）始终保留。',
  },
  youFormal: {
    kind: 'boolean',
    default: true,
    doc: '是否把「您」改成「你」。',
  },
  redlinePatterns: {
    kind: 'json',
    default: [],
    advancedOnly: true,
    doc: '额外硬红线字面（数组）。命中即摘整句。',
  },
  relationPatterns: {
    kind: 'json',
    default: [],
    advancedOnly: true,
    doc: '额外关系越线字面（数组）。',
  },
  emotionShrink: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '困 / 炸毛时收紧长度上限（系数自定：0.6 / 0.7）。',
  },
  reviewEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否启用事后评审（独立模型 1–100 分）。',
  },
  reviewThreshold: {
    kind: 'number',
    default: 70,
    min: 1,
    max: 100,
    doc: '评审及格线。自定（手册只说「低于阈值带反馈 steer 回去」）。',
  },
  reviewMaxRounds: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 4,
    doc: '每轮最多评几次。手册 §1.7 逐字：每轮最多 2 轮。',
  },
  reviewSource: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '评审指定来源 id（留空 = 按网关优先级选）。要「独立模型」就在这里指定另一条来源。',
  },
  reviewTemperature: {
    kind: 'number',
    default: 0.2,
    min: 0,
    max: 1.5,
    advancedOnly: true,
    doc: '评审温度。打分要稳，默认 0.2。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '失败与降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxChars: FIELD_SPECS.maxChars.default as number,
  minChars: FIELD_SPECS.minChars.default as number,
  repeatNgram: FIELD_SPECS.repeatNgram.default as number,
  repeatThreshold: FIELD_SPECS.repeatThreshold.default as number,
  repeatRecentCount: FIELD_SPECS.repeatRecentCount.default as number,
  hardRedline: FIELD_SPECS.hardRedline.default as boolean,
  relationGuard: FIELD_SPECS.relationGuard.default as boolean,
  stageGuard: FIELD_SPECS.stageGuard.default as boolean,
  stripParenthetical: FIELD_SPECS.stripParenthetical.default as boolean,
  youFormal: FIELD_SPECS.youFormal.default as boolean,
  redlinePatterns: FIELD_SPECS.redlinePatterns.default as readonly string[],
  relationPatterns: FIELD_SPECS.relationPatterns.default as readonly string[],
  emotionShrink: FIELD_SPECS.emotionShrink.default as boolean,
  reviewEnabled: FIELD_SPECS.reviewEnabled.default as boolean,
  reviewThreshold: FIELD_SPECS.reviewThreshold.default as number,
  reviewMaxRounds: FIELD_SPECS.reviewMaxRounds.default as number,
  reviewSource: FIELD_SPECS.reviewSource.default as string,
  reviewTemperature: FIELD_SPECS.reviewTemperature.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxChars: 'max-chars',
  minChars: 'min-chars',
  repeatNgram: 'repeat-ngram',
  repeatThreshold: 'repeat-threshold',
  repeatRecentCount: 'repeat-recent-count',
  hardRedline: 'hard-redline',
  relationGuard: 'relation-guard',
  stageGuard: 'stage-guard',
  stripParenthetical: 'strip-parenthetical',
  youFormal: 'you-formal',
  redlinePatterns: 'redline-patterns',
  relationPatterns: 'relation-patterns',
  emotionShrink: 'emotion-shrink',
  reviewEnabled: 'review-enabled',
  reviewThreshold: 'review-threshold',
  reviewMaxRounds: 'review-max-rounds',
  reviewSource: 'review-source',
  reviewTemperature: 'review-temperature',
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
  title: '输出过滤',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-filter-chain',
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

/** 夹一个浮点数。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 取一个字符串数组（非法元素丢弃，不整体回退）。 */
function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    out.push(trimmed)
  }
  return Object.freeze(out)
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
    maxChars: clampInt(raw['maxChars'], DEFAULT_CONFIG.maxChars, 20, 8000),
    minChars: clampInt(raw['minChars'], DEFAULT_CONFIG.minChars, 1, 200),
    repeatNgram: clampInt(raw['repeatNgram'], DEFAULT_CONFIG.repeatNgram, 2, 8),
    repeatThreshold: clampNumber(raw['repeatThreshold'], DEFAULT_CONFIG.repeatThreshold, 0.2, 1),
    repeatRecentCount: clampInt(raw['repeatRecentCount'], DEFAULT_CONFIG.repeatRecentCount, 0, 20),
    hardRedline: bool('hardRedline', DEFAULT_CONFIG.hardRedline),
    relationGuard: bool('relationGuard', DEFAULT_CONFIG.relationGuard),
    stageGuard: bool('stageGuard', DEFAULT_CONFIG.stageGuard),
    stripParenthetical: bool('stripParenthetical', DEFAULT_CONFIG.stripParenthetical),
    youFormal: bool('youFormal', DEFAULT_CONFIG.youFormal),
    redlinePatterns: stringArray(raw['redlinePatterns'], DEFAULT_CONFIG.redlinePatterns),
    relationPatterns: stringArray(raw['relationPatterns'], DEFAULT_CONFIG.relationPatterns),
    emotionShrink: bool('emotionShrink', DEFAULT_CONFIG.emotionShrink),
    reviewEnabled: bool('reviewEnabled', DEFAULT_CONFIG.reviewEnabled),
    reviewThreshold: clampInt(raw['reviewThreshold'], DEFAULT_CONFIG.reviewThreshold, 1, 100),
    reviewMaxRounds: clampInt(raw['reviewMaxRounds'], DEFAULT_CONFIG.reviewMaxRounds, 1, 4),
    reviewSource: typeof raw['reviewSource'] === 'string' ? raw['reviewSource'].trim() : DEFAULT_CONFIG.reviewSource,
    reviewTemperature: clampNumber(
      raw['reviewTemperature'],
      DEFAULT_CONFIG.reviewTemperature,
      0,
      1.5,
    ),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
