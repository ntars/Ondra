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
 * ## 为什么窗口是「两个钟点」而不是「一个时刻」
 *
 * 手册 §11.8-4 的教训是「日记曾连续两天掉线没写成」。一个时刻（23:05）配一次重试，
 * 只要那一刻电脑关着、或模型正忙，这一天就没了——**补也补不回来，因为你不知道
 * 「哪一刻算错过」**。写成 02:00–04:00 的窗口后，「错过」变成一个有边界的事件：
 * 窗口内还可以退避重试，窗口外由看门狗按「文件在不在」补，判据始终是文件而不是时刻。
 *
 * ## `backfillDays` 为什么必须是个小数字
 *
 * 补写要调模型。放成 30，某次重装/搬家就会一次性打 30 次调用，产出 30 篇
 * 「AI 现在编的 30 天前」——比空着更糟。默认 3 天，且**超出的不进模型**。
 */

import {
  DEFAULT_WINDOW_END,
  DEFAULT_WINDOW_START,
  DAY_KEY_RE,
} from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`ensure()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 写入窗口起点 `HH:MM`。 */
  readonly windowStart: string
  /** 写入窗口终点 `HH:MM`（左闭右开）。 */
  readonly windowEnd: string
  /** 窗口内重试间隔（分钟）。 */
  readonly retryMinutes: number
  /** 一天之内最多尝试几次模型（含首次）。 */
  readonly maxAttempts: number
  /** 最多往前补几天（超出的不补，也不调模型）。 */
  readonly backfillDays: number
  /** 单篇正文字数上限（超出按句界截断）。 */
  readonly maxChars: number
  /** 模型不可用时是否用模板写满一篇（手册 §11.8-4 的「程序兜底」）。 */
  readonly templateFallback: boolean
  /** 降级与跳过是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'diary'

/** `HH:MM` 的形状。窗口两端都用它校验，非法一律回退默认。 */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 正文字数下限：再少就不像一篇日记了，模板兜底至少写这么多字。 */
export const MIN_CHARS = 60

/** 正文字数上限：一篇日记写成两千字没人读，且会挤占落盘与读取时间。 */
export const MAX_CHARS = 2000

/** 补写上限：手册没给，自定 7 天并登记待裁决。 */
export const BACKFILL_CEIL = 7

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，ensure() 一律 disabled。',
  },
  windowStart: {
    kind: 'string',
    default: DEFAULT_WINDOW_START,
    pattern: HHMM_RE.source,
    doc: '写入窗口起点（台账值 02:00）。手册另给 23:05 的来源值，可按关机时间改。',
  },
  windowEnd: {
    kind: 'string',
    default: DEFAULT_WINDOW_END,
    pattern: HHMM_RE.source,
    doc: '写入窗口终点（左闭右开）。到点还没写成，今天就算错过，交给看门狗补。',
  },
  retryMinutes: {
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    doc: '窗口内重试间隔（分钟）。窗口 2 小时、间隔 10 分钟，最多能试十来次。',
  },
  maxAttempts: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 10,
    doc: '一天之内最多尝试几次模型。用尽后走模板兜底，不再打扰模型。',
  },
  backfillDays: {
    kind: 'number',
    default: 3,
    min: 0,
    max: BACKFILL_CEIL,
    advancedOnly: true,
    doc: `最多往前补几天（上界 ${BACKFILL_CEIL}）。补写要调模型，数字放大等于一次性烧钱。`,
  },
  maxChars: {
    kind: 'number',
    default: 400,
    min: MIN_CHARS,
    max: MAX_CHARS,
    doc: '单篇正文字数上限。超出按句界截断，不留半句。',
  },
  templateFallback: {
    kind: 'boolean',
    default: true,
    doc: '模型不可用时是否用模板写满一篇（手册「程序兜底」那一层）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与跳过时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  windowStart: FIELD_SPECS.windowStart.default as string,
  windowEnd: FIELD_SPECS.windowEnd.default as string,
  retryMinutes: FIELD_SPECS.retryMinutes.default as number,
  maxAttempts: FIELD_SPECS.maxAttempts.default as number,
  backfillDays: FIELD_SPECS.backfillDays.default as number,
  maxChars: FIELD_SPECS.maxChars.default as number,
  templateFallback: FIELD_SPECS.templateFallback.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  windowStart: 'window-start',
  windowEnd: 'window-end',
  retryMinutes: 'retry-minutes',
  maxAttempts: 'max-attempts',
  backfillDays: 'backfill-days',
  maxChars: 'max-chars',
  templateFallback: 'template-fallback',
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
  title: '日记',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-diary',
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

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 归一化钟点。非法值回退默认，**绝不因为一个写错的钟点让插件不加载**。
 * 写入窗口写错的下场不是崩溃，而是「永远不写」——所以必须能看出来，
 * 由 `apply()` 打一行 warn。
 * @param value 原始值。
 * @param fallback 默认值。
 * @returns 合法钟点与「是否发生了回退」。
 */
function hhmmOf(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return HHMM_RE.test(text) ? text : fallback
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
    windowStart: hhmmOf(raw['windowStart'], DEFAULT_CONFIG.windowStart),
    windowEnd: hhmmOf(raw['windowEnd'], DEFAULT_CONFIG.windowEnd),
    retryMinutes: clampInt(raw['retryMinutes'], DEFAULT_CONFIG.retryMinutes, 1, 120),
    maxAttempts: clampInt(raw['maxAttempts'], DEFAULT_CONFIG.maxAttempts, 1, 10),
    backfillDays: clampInt(raw['backfillDays'], DEFAULT_CONFIG.backfillDays, 0, BACKFILL_CEIL),
    maxChars: clampInt(raw['maxChars'], DEFAULT_CONFIG.maxChars, MIN_CHARS, MAX_CHARS),
    templateFallback: bool('templateFallback', DEFAULT_CONFIG.templateFallback),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（窗口非法回退）。
 *
 * 单独给一个函数，是因为这件事只能靠对比原文与结果发现：
 * `completeConfig()` 拿到的已经是回退后的值，它自己不知道「刚才那串不是钟点」。
 * @param value 原始配置。
 * @returns 被回退的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []
  for (const key of ['windowStart', 'windowEnd'] as const) {
    const given = raw[key]
    if (given !== undefined && (typeof given !== 'string' || !HHMM_RE.test(given.trim()))) {
      drift.push(key)
    }
  }
  return drift
}

/** 日期键是否合法（补写与面板入参都过这一关）。 */
export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY_RE.test(value)
}
