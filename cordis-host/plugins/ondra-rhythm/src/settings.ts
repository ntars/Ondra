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
 * 分条算法（怎么切句、怎么装箱、合并哪几条）、`PUNCT_SPECS` 的字符集，
 * 都是**形态**。做成配置项就等于每台机器的分条结果不一样，而 O-039 的执行层
 * 与面板预览都只认一个版本。
 *
 * ## 哪些数是「手册给定值」
 *
 * `maxMessages 4` / `maxCharsPerMessage 40` / `charsPerSecond 6` /
 * 标点附加 300·500·150 / `minDelayMs 300` / `maxDelayMs 6000` /
 * `firstDelay 800–2000` / `longPauseP 0.20` / `longPause 3000–9000` /
 * `selfCorrectP 0.05` / `nightFactor 1.6`——这些是手册与源码实读的**原值**，
 * 默认值照抄，不做「优化」。改它们等于改口径，登记在 README「待裁决」。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`maxCharsPerMessage`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `plan()` 退回一次性整段发出。 */
  readonly enable: boolean
  /**
   * 分条上限。默认 4。
   *
   * **上限也锁在 4**：手册 §9.2 原文「官方 QQ 5 次留 1 次余量」。
   * 调大不是「更活泼」，是吃掉防封余量。
   */
  readonly maxMessages: number
  /** 单条字数上限。默认 40。 */
  readonly maxCharsPerMessage: number
  /** 字速（字/秒）。默认 6。 */
  readonly charsPerSecond: number
  /** 单条等待下限（毫秒）。默认 300。 */
  readonly minDelayMs: number
  /** 单条等待上限（毫秒）。默认 6000。 */
  readonly maxDelayMs: number
  /** 首字延迟下限。默认 800。 */
  readonly firstDelayMinMs: number
  /** 首字延迟上限。默认 2000。 */
  readonly firstDelayMaxMs: number
  /** 长停顿概率。默认 0.20。 */
  readonly longPauseP: number
  /** 长停顿时长下限。默认 3000。 */
  readonly longPauseMinMs: number
  /** 长停顿时长上限。默认 9000。 */
  readonly longPauseMaxMs: number
  /** 是否启用自我修正。默认 `false`（手册原文「默认不自动插入」）。 */
  readonly selfCorrectEnabled: boolean
  /** 自我修正概率。默认 0.05。 */
  readonly selfCorrectP: number
  /** 是否启用深夜放大。默认 `true`。 */
  readonly nightEnabled: boolean
  /** 深夜系数。默认 1.6。 */
  readonly nightFactor: number
  /** 深夜起点（HH:MM）。默认 23:00。 */
  readonly nightStart: string
  /** 深夜终点（HH:MM）。默认 06:00。 */
  readonly nightEnd: string
  /** 句末标点附加（毫秒）。默认 300。 */
  readonly pausePeriodMs: number
  /** 省略号/破折号附加（毫秒）。默认 500。 */
  readonly pauseEllipsisMs: number
  /** 句中逗号/分号附加（毫秒）。默认 150。 */
  readonly pauseCommaMs: number
  /**
   * 是否跟随 O-031 的表达档调整语速与句形。默认 `true`。
   *
   * 只调「怎么分、多快」；不调「说什么」。六态判定归 O-031，本插件只消费。
   */
  readonly emotionAdjust: boolean
  /** 失败与降级时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'rhythm'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 plan() 退回一次性整段发出。',
  },
  maxMessages: {
    kind: 'number',
    default: 4,
    min: 1,
    max: 4,
    doc: '分条上限。手册 §9.2：官方 QQ 5 次留 1 次余量，上限锁 4。',
  },
  maxCharsPerMessage: {
    kind: 'number',
    default: 40,
    min: 10,
    max: 120,
    doc: '单条字数上限。手册 §9.2 原值 40。',
  },
  charsPerSecond: {
    kind: 'number',
    default: 6,
    min: 2,
    max: 20,
    doc: '字速（字/秒）。手册 §9.2 原值 6。',
    unit: '字/秒',
  },
  minDelayMs: {
    kind: 'number',
    default: 300,
    min: 50,
    max: 5000,
    advancedOnly: true,
    doc: '单条等待下限。手册 §9.2 原值 300。',
  },
  maxDelayMs: {
    kind: 'number',
    default: 6000,
    min: 500,
    max: 20000,
    advancedOnly: true,
    doc: '单条等待上限。手册 §9.2 原值 6000。',
  },
  firstDelayMinMs: {
    kind: 'number',
    default: 800,
    min: 0,
    max: 10000,
    advancedOnly: true,
    doc: '首字延迟下限。手册 §3.3 原值 800。',
  },
  firstDelayMaxMs: {
    kind: 'number',
    default: 2000,
    min: 0,
    max: 20000,
    advancedOnly: true,
    doc: '首字延迟上限。手册 §3.3 原值 2000。',
  },
  longPauseP: {
    kind: 'number',
    default: 0.2,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '长停顿概率。手册 §3.3 原值 0.20。',
  },
  longPauseMinMs: {
    kind: 'number',
    default: 3000,
    min: 500,
    max: 30000,
    advancedOnly: true,
    doc: '长停顿下限。手册 §3.3 原值 3000。',
  },
  longPauseMaxMs: {
    kind: 'number',
    default: 9000,
    min: 500,
    max: 60000,
    advancedOnly: true,
    doc: '长停顿上限。手册 §3.3 原值 9000。',
  },
  selfCorrectEnabled: {
    kind: 'boolean',
    default: false,
    doc: '是否启用自我修正。手册原文「默认不自动插入」，故默认关。',
  },
  selfCorrectP: {
    kind: 'number',
    default: 0.05,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '自我修正概率。手册 §3.3 原值 0.05。',
  },
  nightEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否启用深夜放大。',
  },
  nightFactor: {
    kind: 'number',
    default: 1.6,
    min: 1,
    max: 3,
    advancedOnly: true,
    doc: '深夜系数。手册 §3.3 原值 1.6，乘在卡限之后。',
  },
  nightStart: {
    kind: 'string',
    default: '23:00',
    advancedOnly: true,
    doc: '深夜起点（HH:MM）。手册 §9.2 原值 23:00。',
  },
  nightEnd: {
    kind: 'string',
    default: '06:00',
    advancedOnly: true,
    doc: '深夜终点（HH:MM）。手册 §9.2 原值 06:00。',
  },
  pausePeriodMs: {
    kind: 'number',
    default: 300,
    min: 0,
    max: 2000,
    advancedOnly: true,
    doc: '句末标点附加。手册 §9.2 原值 300。',
  },
  pauseEllipsisMs: {
    kind: 'number',
    default: 500,
    min: 0,
    max: 3000,
    advancedOnly: true,
    doc: '省略号/破折号附加（一串算一次）。手册 §9.2 原值 500。',
  },
  pauseCommaMs: {
    kind: 'number',
    default: 150,
    min: 0,
    max: 2000,
    advancedOnly: true,
    doc: '句中逗号/分号附加。手册 §9.2 原值 150。',
  },
  emotionAdjust: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否跟随 O-031 的表达档调整语速与句形（只调快慢与长短，不改内容）。',
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
  maxMessages: FIELD_SPECS.maxMessages.default as number,
  maxCharsPerMessage: FIELD_SPECS.maxCharsPerMessage.default as number,
  charsPerSecond: FIELD_SPECS.charsPerSecond.default as number,
  minDelayMs: FIELD_SPECS.minDelayMs.default as number,
  maxDelayMs: FIELD_SPECS.maxDelayMs.default as number,
  firstDelayMinMs: FIELD_SPECS.firstDelayMinMs.default as number,
  firstDelayMaxMs: FIELD_SPECS.firstDelayMaxMs.default as number,
  longPauseP: FIELD_SPECS.longPauseP.default as number,
  longPauseMinMs: FIELD_SPECS.longPauseMinMs.default as number,
  longPauseMaxMs: FIELD_SPECS.longPauseMaxMs.default as number,
  selfCorrectEnabled: FIELD_SPECS.selfCorrectEnabled.default as boolean,
  selfCorrectP: FIELD_SPECS.selfCorrectP.default as number,
  nightEnabled: FIELD_SPECS.nightEnabled.default as boolean,
  nightFactor: FIELD_SPECS.nightFactor.default as number,
  nightStart: FIELD_SPECS.nightStart.default as string,
  nightEnd: FIELD_SPECS.nightEnd.default as string,
  pausePeriodMs: FIELD_SPECS.pausePeriodMs.default as number,
  pauseEllipsisMs: FIELD_SPECS.pauseEllipsisMs.default as number,
  pauseCommaMs: FIELD_SPECS.pauseCommaMs.default as number,
  emotionAdjust: FIELD_SPECS.emotionAdjust.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxMessages: 'max-messages',
  maxCharsPerMessage: 'max-chars-per-message',
  charsPerSecond: 'chars-per-second',
  minDelayMs: 'min-delay-ms',
  maxDelayMs: 'max-delay-ms',
  firstDelayMinMs: 'first-delay-min-ms',
  firstDelayMaxMs: 'first-delay-max-ms',
  longPauseP: 'long-pause-p',
  longPauseMinMs: 'long-pause-min-ms',
  longPauseMaxMs: 'long-pause-max-ms',
  selfCorrectEnabled: 'self-correct-enabled',
  selfCorrectP: 'self-correct-p',
  nightEnabled: 'night-enabled',
  nightFactor: 'night-factor',
  nightStart: 'night-start',
  nightEnd: 'night-end',
  pausePeriodMs: 'pause-period-ms',
  pauseEllipsisMs: 'pause-ellipsis-ms',
  pauseCommaMs: 'pause-comma-ms',
  emotionAdjust: 'emotion-adjust',
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
  title: '分条与停顿',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-rhythm',
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

/** 校验 HH:MM；不合法返回 undefined（不抛）。 */
export function parseHhmm(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 两个数的上下限若写反了就换过来（不报错，静默修正）。 */
function orderPair(low: number, high: number): readonly [number, number] {
  return low <= high ? [low, high] : [high, low]
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 *
 * 三对上下限（`minDelay/maxDelay`、`firstDelayMin/Max`、`longPauseMin/Max`）
 * 写反时静默交换——写反的人想要的是「这个区间」，不是「报错」。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const [minDelayMs, maxDelayMs] = orderPair(
    clampInt(raw['minDelayMs'], DEFAULT_CONFIG.minDelayMs, 50, 5000),
    clampInt(raw['maxDelayMs'], DEFAULT_CONFIG.maxDelayMs, 500, 20000),
  )
  const [firstDelayMinMs, firstDelayMaxMs] = orderPair(
    clampInt(raw['firstDelayMinMs'], DEFAULT_CONFIG.firstDelayMinMs, 0, 10000),
    clampInt(raw['firstDelayMaxMs'], DEFAULT_CONFIG.firstDelayMaxMs, 0, 20000),
  )
  const [longPauseMinMs, longPauseMaxMs] = orderPair(
    clampInt(raw['longPauseMinMs'], DEFAULT_CONFIG.longPauseMinMs, 500, 30000),
    clampInt(raw['longPauseMaxMs'], DEFAULT_CONFIG.longPauseMaxMs, 500, 60000),
  )

  const nightStart = typeof raw['nightStart'] === 'string' && parseHhmm(raw['nightStart']) !== undefined
    ? String(raw['nightStart']).trim()
    : DEFAULT_CONFIG.nightStart
  const nightEnd = typeof raw['nightEnd'] === 'string' && parseHhmm(raw['nightEnd']) !== undefined
    ? String(raw['nightEnd']).trim()
    : DEFAULT_CONFIG.nightEnd

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    // 上限锁 4：手册的防封余量，配置写 8 也只认 4。
    maxMessages: clampInt(raw['maxMessages'], DEFAULT_CONFIG.maxMessages, 1, 4),
    maxCharsPerMessage: clampInt(raw['maxCharsPerMessage'], DEFAULT_CONFIG.maxCharsPerMessage, 10, 120),
    charsPerSecond: clampNumber(raw['charsPerSecond'], DEFAULT_CONFIG.charsPerSecond, 2, 20),
    minDelayMs,
    maxDelayMs,
    firstDelayMinMs,
    firstDelayMaxMs,
    longPauseP: clampNumber(raw['longPauseP'], DEFAULT_CONFIG.longPauseP, 0, 1),
    longPauseMinMs,
    longPauseMaxMs,
    selfCorrectEnabled: bool('selfCorrectEnabled', DEFAULT_CONFIG.selfCorrectEnabled),
    selfCorrectP: clampNumber(raw['selfCorrectP'], DEFAULT_CONFIG.selfCorrectP, 0, 1),
    nightEnabled: bool('nightEnabled', DEFAULT_CONFIG.nightEnabled),
    nightFactor: clampNumber(raw['nightFactor'], DEFAULT_CONFIG.nightFactor, 1, 3),
    nightStart,
    nightEnd,
    pausePeriodMs: clampInt(raw['pausePeriodMs'], DEFAULT_CONFIG.pausePeriodMs, 0, 2000),
    pauseEllipsisMs: clampInt(raw['pauseEllipsisMs'], DEFAULT_CONFIG.pauseEllipsisMs, 0, 3000),
    pauseCommaMs: clampInt(raw['pauseCommaMs'], DEFAULT_CONFIG.pauseCommaMs, 0, 2000),
    emotionAdjust: bool('emotionAdjust', DEFAULT_CONFIG.emotionAdjust),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
