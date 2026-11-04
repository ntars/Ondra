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
 * ## 为什么这些字段有默认值却没有手册出处
 *
 * 台账只写「最近 300 条 / 注入约 130 字」，master-plan §9 没有语感这一节。
 * 其余七个值全部是**本包自定的工程值**，已在 README「待裁决」里逐条登记，
 * 依据写在每个 `doc` 里，便于主人一眼否掉。
 *
 * ## `KEY_PAIRS` 为什么必须有
 *
 * `Config` 是 camelCase，而配置键正则 `^[a-z][a-z0-9_-]{1,63}$` 不认大写。
 * 段声明、用户层归一化、结果回填三处全部由它派生，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`compose()` 一律返回空段。 */
  readonly enable: boolean
  /** 样本窗口条数（台账 300）。 */
  readonly windowSize: number
  /** 少于多少条就不出段。 */
  readonly minSamples: number
  /** 注入正文的字数上限（台账「约 130 字」）。 */
  readonly maxChars: number
  /** 正文里最多报几个语气词。 */
  readonly topParticles: number
  /** 是否只统计主人本人的消息。 */
  readonly ownerOnly: boolean
  /** 样本最大年龄（小时）。0 表示不按时间淘汰。 */
  readonly maxAgeHours: number
  /** 是否把形状落盘。 */
  readonly persist: boolean
  /** 每收多少条写一次盘。 */
  readonly flushEvery: number
  /** 拒收是否逐条打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 `^[a-z][a-z0-9_-]{1,63}$`。 */
export const CONFIG_SECTION_ID = 'lexicon'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，compose() 返回 disabled 的空段，不静默继续。',
  },
  windowSize: {
    kind: 'number',
    default: 300,
    min: 50,
    max: 1000,
    doc: '样本窗口条数。取 300 的理由是台账原文；下限 50 是「少于 50 条算不出稳定中位数」的经验值。',
  },
  minSamples: {
    kind: 'number',
    default: 30,
    min: 5,
    max: 300,
    doc: '少于多少条就不出段。取 30 的理由：30 条里通常有 60 句以上，中位数才开始稳定；再少就是「拿两句话概括一个人」。',
  },
  maxChars: {
    kind: 'number',
    default: 130,
    min: 40,
    max: 400,
    doc: '注入正文字数上限。取 130 是台账原文「约 130 字」；实际正文约 55 字，这个上限是护栏不是目标。',
  },
  topParticles: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 6,
    doc: '正文里最多报几个语气词。取 3 的理由：四个以上会变成清单，而这段的作用是让她顺口带一个。',
  },
  ownerOnly: {
    kind: 'boolean',
    default: true,
    doc: '只统计主人本人的消息。默认开：群聊里别人的话也是「真人消息」，但不是主人的语感，混进来会让她学错人。',
  },
  maxAgeHours: {
    kind: 'number',
    default: 720,
    min: 0,
    max: 8760,
    doc: '样本最大年龄。取 720（30 天）的理由：语感会变，一个月前的句子不该继续代表现在。0 表示不按时间淘汰。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '是否把形状落盘。关掉后每次重启都要重新攒够样本，症状是「语感时有时无」且不报错。存档里只有形状，没有原话。',
  },
  flushEvery: {
    kind: 'number',
    default: 20,
    min: 1,
    max: 300,
    advancedOnly: true,
    doc: '每收多少条写一次盘。取 20 的理由：写盘是同步 IO，逐条写会在每条消息上多一次 fsync；20 条一次，崩了最多丢 20 条形状。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '拒收是否逐条打日志。只影响噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  windowSize: FIELD_SPECS.windowSize.default as number,
  minSamples: FIELD_SPECS.minSamples.default as number,
  maxChars: FIELD_SPECS.maxChars.default as number,
  topParticles: FIELD_SPECS.topParticles.default as number,
  ownerOnly: FIELD_SPECS.ownerOnly.default as boolean,
  maxAgeHours: FIELD_SPECS.maxAgeHours.default as number,
  persist: FIELD_SPECS.persist.default as boolean,
  flushEvery: FIELD_SPECS.flushEvery.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须双向唯一，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  windowSize: 'window-size',
  minSamples: 'min-samples',
  maxChars: 'max-chars',
  topParticles: 'top-particles',
  ownerOnly: 'owner-only',
  maxAgeHours: 'max-age-hours',
  persist: 'persist',
  flushEvery: 'flush-every',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '语感',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-lexicon',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * 未知键**原样保留**，交给 O-005 报 `unknown-field`。
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

/** 读一个夹紧的整数。非法值回退默认，再夹进区间。 */
function intIn(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, raw))
}

/** 读一个布尔。**只有 `true` 才算真**：字符串 `"false"` 不该被当成真。 */
function boolOf(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === true
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: boolOf(raw['enable'], DEFAULT_CONFIG.enable),
    windowSize: intIn(raw['windowSize'], DEFAULT_CONFIG.windowSize, 50, 1000),
    minSamples: intIn(raw['minSamples'], DEFAULT_CONFIG.minSamples, 5, 300),
    maxChars: intIn(raw['maxChars'], DEFAULT_CONFIG.maxChars, 40, 400),
    topParticles: intIn(raw['topParticles'], DEFAULT_CONFIG.topParticles, 1, 6),
    ownerOnly: boolOf(raw['ownerOnly'], DEFAULT_CONFIG.ownerOnly),
    maxAgeHours: intIn(raw['maxAgeHours'], DEFAULT_CONFIG.maxAgeHours, 0, 8760),
    persist: boolOf(raw['persist'], DEFAULT_CONFIG.persist),
    flushEvery: intIn(raw['flushEvery'], DEFAULT_CONFIG.flushEvery, 1, 300),
    verbose: boolOf(raw['verbose'], DEFAULT_CONFIG.verbose),
  })
}
