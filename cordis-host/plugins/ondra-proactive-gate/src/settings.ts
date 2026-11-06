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
 * ## 为什么这些参数进配置、另一些不进
 *
 * 进配置的只有**手册给了数值、且不同部署可以不一样**的项（静默窗口、额度、
 * 速率、冷却、抖动、去重窗口）。**形态不进配置**：闸的执行顺序、`drop/defer/send`
 * 的语义、状态文件的形状——做成开关就等于每台机器的「她该不该说话」不一样，
 * 而面板与日志只认一个版本。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`dailyQuota`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import {
  CIRCUIT_HITS,
  CIRCUIT_MS,
  DEDUPE_MIN_LEN,
  DEDUPE_WINDOW_MS,
  GROUP_COOLDOWN_MS,
  HARD_DAILY_QUOTA,
  HARD_PER_DAY,
  HARD_PER_HOUR,
  HARD_PER_MINUTE,
  JITTER_MS,
  PRIVATE_COOLDOWN_MS,
} from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`gate()` 一律 `drop/disabled`。 */
  readonly enable: boolean
  /** 每日主动投递预算（§9.3 原值 3）。只算 `reason=active`。 */
  readonly dailyQuota: number
  /** 产品静默时段起点 `HH:MM`（§9.3 原值 23:00）。只拦主动。 */
  readonly quietStart: string
  /** 产品静默时段终点 `HH:MM`（§9.3 原值 08:00）。 */
  readonly quietEnd: string
  /** 防封深夜窗口起点（§5.3-2 原值 00:30）。拦主动与回话，不拦被叫。 */
  readonly antiBanQuietStart: string
  /** 防封深夜窗口终点（§5.3-2 原值 07:30）。 */
  readonly antiBanQuietEnd: string
  /** 目标会话至少安静多少分钟才允许主动（§9.3 `idleMinutes=25`）。 */
  readonly idleMinutes: number
  /** 每分钟最多几条（§5.3-4）。上限锁 20。 */
  readonly perMinute: number
  /** 每小时最多几条（§5.3-4）。上限锁 200。 */
  readonly perHour: number
  /** 每日最多几条（§5.3-4）。上限锁 1500。 */
  readonly perDay: number
  /** 内容闸的扫描触发长度（§5.3-1 原值 1800）。超过就扫，**不因此拒发**。 */
  readonly maxLen: number
  /** 内容闸的硬拒长度。手册没给，自定并登记待裁决。 */
  readonly hardMaxLen: number
  /** 群聊冷却毫秒（§5.3-5 原值 5000）。 */
  readonly groupCooldownMs: number
  /** 私聊冷却毫秒（§5.3-5 原值 3000）。 */
  readonly privateCooldownMs: number
  /** 去重窗口分钟（§5.3-3 原值 30）。 */
  readonly dedupeMinutes: number
  /** 去重最短长度（§5.3-3 原值 4）。短于此不参与去重。 */
  readonly dedupeMinLen: number
  /** 发送前抖动上限毫秒（§5.3-6 原值 400）。 */
  readonly jitterMs: number
  /** 连续风控命中几次熔断（§5.3-6 原值 3）。 */
  readonly circuitHits: number
  /** 熔断时长分钟（§5.3-6 原值 30）。 */
  readonly circuitMinutes: number
  /**
   * 追加的屏蔽词（**字面量，不是正则**）。
   *
   * 刻意只收字面量：用户填的正则一旦写成 `(a+)+$`，一次恶意长文本就能把
   * 整个门控卡在这里（ReDoS），而闸卡住的表现是「她不说话了」。
   */
  readonly blockWords: readonly string[]
  /** 拒绝与降级时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'proactive-gate'

/** `hardMaxLen` 的下界：不能低于扫描触发线，否则「扫描」这条规则永远不生效。 */
export const MIN_HARD_MAX_LEN = 1800

/** `hardMaxLen` 的上界。 */
export const MAX_HARD_MAX_LEN = 8000

/** 屏蔽词最多几条（防一份配置把内容闸变成全文匹配）。 */
export const MAX_BLOCK_WORDS = 50

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，gate() 一律 drop/disabled。',
  },
  dailyQuota: {
    kind: 'number',
    default: 3,
    min: 0,
    max: HARD_DAILY_QUOTA,
    doc: '每日主动投递预算（§9.3 原值 3）。只算主动，不算回话。',
  },
  quietStart: {
    kind: 'string',
    default: '23:00',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    doc: '产品静默时段起点（§9.3 原值 23:00）。只拦主动。',
  },
  quietEnd: {
    kind: 'string',
    default: '08:00',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    doc: '产品静默时段终点（§9.3 原值 08:00）。',
  },
  antiBanQuietStart: {
    kind: 'string',
    default: '00:30',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    advancedOnly: true,
    doc: '防封深夜窗口起点（§5.3-2 原值 00:30）。拦主动与回话，不拦被叫。',
  },
  antiBanQuietEnd: {
    kind: 'string',
    default: '07:30',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    advancedOnly: true,
    doc: '防封深夜窗口终点（§5.3-2 原值 07:30）。',
  },
  idleMinutes: {
    kind: 'number',
    default: 25,
    min: 0,
    max: 1440,
    doc: '目标会话至少安静多少分钟才允许主动（§9.3 idleMinutes=25）。',
  },
  perMinute: {
    kind: 'number',
    default: HARD_PER_MINUTE,
    min: 1,
    max: HARD_PER_MINUTE,
    advancedOnly: true,
    doc: '每分钟最多几条（§5.3-4）。上限锁 20：调大不是更活泼，是吃掉余量。',
  },
  perHour: {
    kind: 'number',
    default: HARD_PER_HOUR,
    min: 1,
    max: HARD_PER_HOUR,
    advancedOnly: true,
    doc: '每小时最多几条（§5.3-4）。上限锁 200。',
  },
  perDay: {
    kind: 'number',
    default: HARD_PER_DAY,
    min: 1,
    max: HARD_PER_DAY,
    advancedOnly: true,
    doc: '每日最多几条（§5.3-4）。上限锁 1500：腾讯看长期曲线。',
  },
  maxLen: {
    kind: 'number',
    default: 1800,
    min: 200,
    max: 4000,
    advancedOnly: true,
    doc: '内容闸的扫描触发长度（§5.3-1 原值 1800）。超过就扫，不因此拒发。',
  },
  hardMaxLen: {
    kind: 'number',
    default: 3000,
    min: MIN_HARD_MAX_LEN,
    max: MAX_HARD_MAX_LEN,
    advancedOnly: true,
    doc: '内容闸的硬拒长度（手册未给，自定）。',
  },
  groupCooldownMs: {
    kind: 'number',
    default: GROUP_COOLDOWN_MS,
    min: 0,
    max: 60_000,
    advancedOnly: true,
    doc: '群聊同会话冷却毫秒（§5.3-5 原值 5000）。',
  },
  privateCooldownMs: {
    kind: 'number',
    default: PRIVATE_COOLDOWN_MS,
    min: 0,
    max: 60_000,
    advancedOnly: true,
    doc: '私聊同会话冷却毫秒（§5.3-5 原值 3000）。',
  },
  dedupeMinutes: {
    kind: 'number',
    default: DEDUPE_WINDOW_MS / 60_000,
    min: 1,
    max: 720,
    advancedOnly: true,
    doc: '去重窗口分钟（§5.3-3 原值 30）。',
  },
  dedupeMinLen: {
    kind: 'number',
    default: DEDUPE_MIN_LEN,
    min: 0,
    max: 40,
    advancedOnly: true,
    doc: '去重最短长度（§5.3-3 原值 4）。短于此不参与去重。',
  },
  jitterMs: {
    kind: 'number',
    default: JITTER_MS,
    min: 0,
    max: 5000,
    advancedOnly: true,
    doc: '发送前抖动上限毫秒（§5.3-6 原值 400）。固定节奏本身就是自动化特征。',
  },
  circuitHits: {
    kind: 'number',
    default: CIRCUIT_HITS,
    min: 1,
    max: 10,
    advancedOnly: true,
    doc: '连续风控命中几次熔断（§5.3-6 原值 3）。',
  },
  circuitMinutes: {
    kind: 'number',
    default: CIRCUIT_MS / 60_000,
    min: 1,
    max: 240,
    advancedOnly: true,
    doc: '熔断时长分钟（§5.3-6 原值 30）。',
  },
  blockWords: {
    kind: 'json',
    default: Object.freeze([]),
    advancedOnly: true,
    doc: '追加的屏蔽词（字面量，最多 ' + String(MAX_BLOCK_WORDS) + ' 条）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '拒绝与降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  dailyQuota: FIELD_SPECS.dailyQuota.default as number,
  quietStart: FIELD_SPECS.quietStart.default as string,
  quietEnd: FIELD_SPECS.quietEnd.default as string,
  antiBanQuietStart: FIELD_SPECS.antiBanQuietStart.default as string,
  antiBanQuietEnd: FIELD_SPECS.antiBanQuietEnd.default as string,
  idleMinutes: FIELD_SPECS.idleMinutes.default as number,
  perMinute: FIELD_SPECS.perMinute.default as number,
  perHour: FIELD_SPECS.perHour.default as number,
  perDay: FIELD_SPECS.perDay.default as number,
  maxLen: FIELD_SPECS.maxLen.default as number,
  hardMaxLen: FIELD_SPECS.hardMaxLen.default as number,
  groupCooldownMs: FIELD_SPECS.groupCooldownMs.default as number,
  privateCooldownMs: FIELD_SPECS.privateCooldownMs.default as number,
  dedupeMinutes: FIELD_SPECS.dedupeMinutes.default as number,
  dedupeMinLen: FIELD_SPECS.dedupeMinLen.default as number,
  jitterMs: FIELD_SPECS.jitterMs.default as number,
  circuitHits: FIELD_SPECS.circuitHits.default as number,
  circuitMinutes: FIELD_SPECS.circuitMinutes.default as number,
  blockWords: FIELD_SPECS.blockWords.default as readonly string[],
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  dailyQuota: 'daily-quota',
  quietStart: 'quiet-start',
  quietEnd: 'quiet-end',
  antiBanQuietStart: 'anti-ban-quiet-start',
  antiBanQuietEnd: 'anti-ban-quiet-end',
  idleMinutes: 'idle-minutes',
  perMinute: 'per-minute',
  perHour: 'per-hour',
  perDay: 'per-day',
  maxLen: 'max-len',
  hardMaxLen: 'hard-max-len',
  groupCooldownMs: 'group-cooldown-ms',
  privateCooldownMs: 'private-cooldown-ms',
  dedupeMinutes: 'dedupe-minutes',
  dedupeMinLen: 'dedupe-min-len',
  jitterMs: 'jitter-ms',
  circuitHits: 'circuit-hits',
  circuitMinutes: 'circuit-minutes',
  blockWords: 'block-words',
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
  title: '主动门控',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-proactive-gate',
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

/** `HH:MM` 的形状。 */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 归一化时刻字符串。非法值回退默认。
 * @param value 原始值。
 * @param fallback 默认值。
 */
function hhmm(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return HHMM_RE.test(text) ? text : fallback
}

/**
 * 归一化屏蔽词表：只留非空字符串、去重、截到上限。
 * @param value 原始值（可能是任意 JSON）。
 */
function normalizeWords(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (out.includes(text)) continue
    out.push(text)
    if (out.length >= MAX_BLOCK_WORDS) break
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

  const maxLen = clampInt(raw['maxLen'], DEFAULT_CONFIG.maxLen, 200, 4000)
  // 硬拒线不能低于扫描线：低于的话「超过 maxLen 才扫」这条规则永远不生效。
  const hardMaxLen = clampInt(raw['hardMaxLen'], DEFAULT_CONFIG.hardMaxLen, MIN_HARD_MAX_LEN, MAX_HARD_MAX_LEN)

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    // 上限锁 20：见 HARD_DAILY_QUOTA 的注释。
    dailyQuota: clampInt(raw['dailyQuota'], DEFAULT_CONFIG.dailyQuota, 0, HARD_DAILY_QUOTA),
    quietStart: hhmm(raw['quietStart'], DEFAULT_CONFIG.quietStart),
    quietEnd: hhmm(raw['quietEnd'], DEFAULT_CONFIG.quietEnd),
    antiBanQuietStart: hhmm(raw['antiBanQuietStart'], DEFAULT_CONFIG.antiBanQuietStart),
    antiBanQuietEnd: hhmm(raw['antiBanQuietEnd'], DEFAULT_CONFIG.antiBanQuietEnd),
    idleMinutes: clampInt(raw['idleMinutes'], DEFAULT_CONFIG.idleMinutes, 0, 1440),
    perMinute: clampInt(raw['perMinute'], DEFAULT_CONFIG.perMinute, 1, HARD_PER_MINUTE),
    perHour: clampInt(raw['perHour'], DEFAULT_CONFIG.perHour, 1, HARD_PER_HOUR),
    perDay: clampInt(raw['perDay'], DEFAULT_CONFIG.perDay, 1, HARD_PER_DAY),
    maxLen,
    hardMaxLen: Math.max(maxLen, hardMaxLen),
    groupCooldownMs: clampInt(raw['groupCooldownMs'], DEFAULT_CONFIG.groupCooldownMs, 0, 60_000),
    privateCooldownMs: clampInt(raw['privateCooldownMs'], DEFAULT_CONFIG.privateCooldownMs, 0, 60_000),
    dedupeMinutes: clampInt(raw['dedupeMinutes'], DEFAULT_CONFIG.dedupeMinutes, 1, 720),
    dedupeMinLen: clampInt(raw['dedupeMinLen'], DEFAULT_CONFIG.dedupeMinLen, 0, 40),
    jitterMs: clampInt(raw['jitterMs'], DEFAULT_CONFIG.jitterMs, 0, 5000),
    circuitHits: clampInt(raw['circuitHits'], DEFAULT_CONFIG.circuitHits, 1, 10),
    circuitMinutes: clampInt(raw['circuitMinutes'], DEFAULT_CONFIG.circuitMinutes, 1, 240),
    blockWords: normalizeWords(raw['blockWords']),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
