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
 * ## 哪些是手册参数，哪些是本项目自定
 *
 * | 字段 | 出处 |
 * |---|---|
 * | 能量速率 / 自然上限 / 分段 5 分钟 / 2000 段 / 睡醒 15 分钟 | 手册 §3.3 + master-plan §9.13（**手册参数，不可改**） |
 * | `exploreRate=0.1` | 手册 §3.7「10% 概率探索新兴趣」 |
 * | `activityEveryMinutes=45` | 自定。手册只说「随机」，没给间隔；45 分钟 ≈ 一天 20 次，像个人 |
 * | `interestDecayHours=72` | 自定。手册只说「长时间没碰衰减」；3 天半衰，一周没碰就退到三成 |
 * | `restStart` / `restEnd` | 自定。手册只给「深夜 0–6 点回血」，没说几点不活动 |
 *
 * 自定的三项都写进 README「待裁决」，不假装是手册值。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`plan()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 两次活动之间的最小间隔（分钟）。 */
  readonly activityEveryMinutes: number
  /** 探索新兴趣的概率（0–1）。 */
  readonly exploreRate: number
  /** 兴趣权重半衰期（小时）。 */
  readonly interestDecayHours: number
  /** 心情低到什么程度算「差」（0–1，越低越差）。 */
  readonly moodLowThreshold: number
  /** 休息时段起点 `HH:MM`（这段时间不活动）。 */
  readonly restStart: string
  /** 休息时段终点 `HH:MM`（左闭右开，可跨零点）。 */
  readonly restEnd: string
  /** 内存里最多留几条笔记。 */
  readonly maxNotes: number
  /** 能量系统总开关（关掉后只做生活层）。 */
  readonly enableEnergy: boolean
  /** 降级是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'life-rhythm'

/** `HH:MM` 的形状。 */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 间隔下限：10 分钟。再密就不是「她有自己的生活」，是刷屏。 */
export const EVERY_MIN = 10

/** 间隔上限：3 小时。再稀就一天只有三四件事，读起来像编的。 */
export const EVERY_MAX = 180

/** 半衰期下限。 */
export const DECAY_MIN = 6

/** 半衰期上限：30 天。 */
export const DECAY_MAX = 720

/** 笔记上限下限。 */
export const NOTES_MIN = 6

/** 笔记上限上限：96 条 ≈ 两天的活动量，再多面板读不动。 */
export const NOTES_MAX = 96

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，plan() 一律 disabled。',
  },
  activityEveryMinutes: {
    kind: 'number',
    default: 45,
    min: EVERY_MIN,
    max: EVERY_MAX,
    doc: `两次活动的最小间隔（分钟，${EVERY_MIN}–${EVERY_MAX}）。自定值，手册只说「随机」。`,
  },
  exploreRate: {
    kind: 'number',
    default: 0.1,
    min: 0,
    max: 1,
    doc: '探索新兴趣的概率（手册 §3.7 的 10%）。确定性抽取：同一时间槽恒定。',
  },
  interestDecayHours: {
    kind: 'number',
    default: 72,
    min: DECAY_MIN,
    max: DECAY_MAX,
    advancedOnly: true,
    doc: `兴趣权重半衰期（小时，${DECAY_MIN}–${DECAY_MAX}）。自定值。`,
  },
  moodLowThreshold: {
    kind: 'number',
    default: 0.35,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '心情低于此值（0–1）时优先放松型兴趣。读数来自 ondra-emotion-core，缺席则视为中性。',
  },
  restStart: {
    kind: 'string',
    default: '23:30',
    pattern: HHMM_RE.source,
    doc: '休息时段起点。这段时间不安排活动（深夜只回血）。',
  },
  restEnd: {
    kind: 'string',
    default: '07:00',
    pattern: HHMM_RE.source,
    doc: '休息时段终点（左闭右开，可跨零点）。',
  },
  maxNotes: {
    kind: 'number',
    default: 24,
    min: NOTES_MIN,
    max: NOTES_MAX,
    advancedOnly: true,
    doc: `内存里保留的笔记条数（${NOTES_MIN}–${NOTES_MAX}）。只影响注入素材多少。`,
  },
  enableEnergy: {
    kind: 'boolean',
    default: true,
    doc: '能量系统开关。关掉后只做生活层，energy() 恒返回关闭时的读数。',
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
  activityEveryMinutes: FIELD_SPECS.activityEveryMinutes.default as number,
  exploreRate: FIELD_SPECS.exploreRate.default as number,
  interestDecayHours: FIELD_SPECS.interestDecayHours.default as number,
  moodLowThreshold: FIELD_SPECS.moodLowThreshold.default as number,
  restStart: FIELD_SPECS.restStart.default as string,
  restEnd: FIELD_SPECS.restEnd.default as string,
  maxNotes: FIELD_SPECS.maxNotes.default as number,
  enableEnergy: FIELD_SPECS.enableEnergy.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  activityEveryMinutes: 'activity-every-minutes',
  exploreRate: 'explore-rate',
  interestDecayHours: 'interest-decay-hours',
  moodLowThreshold: 'mood-low-threshold',
  restStart: 'rest-start',
  restEnd: 'rest-end',
  maxNotes: 'max-notes',
  enableEnergy: 'enable-energy',
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
  title: '生活与作息',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-life-rhythm',
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

/** 夹一个浮点数（保留三位小数，配置里不需要更高精度）。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(max, Math.max(min, value)) * 1000) / 1000
}

/** 归一化钟点。非法值回退默认，**绝不因为一个写错的钟点让插件不加载**。 */
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
    activityEveryMinutes: clampInt(raw['activityEveryMinutes'], DEFAULT_CONFIG.activityEveryMinutes, EVERY_MIN, EVERY_MAX),
    exploreRate: clampFloat(raw['exploreRate'], DEFAULT_CONFIG.exploreRate, 0, 1),
    interestDecayHours: clampInt(raw['interestDecayHours'], DEFAULT_CONFIG.interestDecayHours, DECAY_MIN, DECAY_MAX),
    moodLowThreshold: clampFloat(raw['moodLowThreshold'], DEFAULT_CONFIG.moodLowThreshold, 0, 1),
    restStart: hhmmOf(raw['restStart'], DEFAULT_CONFIG.restStart),
    restEnd: hhmmOf(raw['restEnd'], DEFAULT_CONFIG.restEnd),
    maxNotes: clampInt(raw['maxNotes'], DEFAULT_CONFIG.maxNotes, NOTES_MIN, NOTES_MAX),
    enableEnergy: bool('enableEnergy', DEFAULT_CONFIG.enableEnergy),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 *
 * `completeConfig()` 拿到的已经是回退后的值，它自己不知道「刚才那串不是钟点」。
 * @param value 原始配置。
 * @returns 被回退或夹紧的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []
  for (const key of ['restStart', 'restEnd'] as const) {
    const given = raw[key]
    if (given !== undefined && (typeof given !== 'string' || !HHMM_RE.test(given.trim()))) {
      drift.push(key)
    }
  }
  for (const key of ['activityEveryMinutes', 'interestDecayHours', 'maxNotes'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    const bounds =
      key === 'activityEveryMinutes'
        ? [EVERY_MIN, EVERY_MAX]
        : key === 'interestDecayHours'
          ? [DECAY_MIN, DECAY_MAX]
          : [NOTES_MIN, NOTES_MAX]
    if (typeof given !== 'number' || !Number.isFinite(given) || given < bounds[0] || given > bounds[1]) {
      drift.push(key)
    }
  }
  for (const key of ['exploreRate', 'moodLowThreshold'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < 0 || given > 1) drift.push(key)
  }
  return drift
}
