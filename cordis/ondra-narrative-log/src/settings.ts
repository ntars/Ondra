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
 * ## 为什么「留多久」不做成自动清理
 *
 * `retentionDays` 只在 `prune()` 被显式调用时生效，**没有定时器**。
 * 自动删日志的风险不对称：删对了没人知道，删错了（时区、日期格式、
 * 面板误触）就永久丢掉了唯一的追查线索。所以保留期是一个**动作的参数**，
 * 不是一个后台行为。
 *
 * ## `KEY_PAIRS` 为什么必须有
 *
 * `Config` 是 camelCase，而配置键正则 `^[a-z][a-z0-9_-]{1,63}$` 不认大写。
 * 段声明、用户层归一化、结果回填三处全部由它派生，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`record()` 一律返回 `disabled`。 */
  readonly enable: boolean
  /** 内存环里保留几条（面板翻页用）。 */
  readonly maxEntries: number
  /** 她说出口那段最多留多少字。 */
  readonly maxExcerptChars: number
  /** 一条最多几个因子。 */
  readonly maxFactors: number
  /** 一条最多几道闸。 */
  readonly maxGates: number
  /** 一条最多几个引用 id。 */
  readonly maxRefs: number
  /** 保留多少天（**只在 `prune()` 被调用时生效**）。 */
  readonly retentionDays: number
  /** 是否脱敏（手机号 / 邮箱 / 证件号 / 卡号）。 */
  readonly maskSensitive: boolean
  /** 是否存她说出口的那一段。关掉后只剩结构化因子。 */
  readonly storeExcerpt: boolean
  /** 拒收与写盘失败是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 `^[a-z][a-z0-9_-]{1,63}$`。 */
export const CONFIG_SECTION_ID = 'narrative-log'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，record() 返回 disabled，面板读到的仍是旧记录。',
  },
  maxEntries: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2000,
    doc: '内存环保留几条。取 200 的理由：面板一屏 20 条，翻十页够用；一条约 300 字节，200 条不到 60KB。',
  },
  maxExcerptChars: {
    kind: 'number',
    default: 60,
    min: 0,
    max: 400,
    doc: '她说出口那段留多少字。取 60 的理由：追查要的是「那一句什么调子」，不是整段回复；留全文等于把聊天记录复制进日志。',
  },
  maxFactors: {
    kind: 'number',
    default: 12,
    min: 1,
    max: 64,
    doc: '一条最多几个因子。取 12 的理由：一次回复真正起作用的判定不会超过十条；超出的多半是同义重复。',
  },
  maxGates: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 32,
    doc: '一条最多几道闸。九步过滤加证据门控与主动门控，八道够覆盖。',
  },
  maxRefs: {
    kind: 'number',
    default: 12,
    min: 0,
    max: 64,
    doc: '一条最多几个引用 id。只记 id 不记正文，所以宽一点也无妨。',
  },
  retentionDays: {
    kind: 'number',
    default: 14,
    min: 1,
    max: 365,
    doc: '保留多少天。取 14 的理由：追查通常发生在「昨天/上周」；再久的问题该看记忆审计（O-027）而不是决策日志。只在 prune() 被调用时生效。',
  },
  maskSensitive: {
    kind: 'boolean',
    default: true,
    doc: '是否脱敏手机号、邮箱、证件号、卡号。默认开：这些与「为什么这么回」无关，留在日志里只是风险。',
  },
  storeExcerpt: {
    kind: 'boolean',
    default: true,
    doc: '是否存她说出口的那一段（已脱敏、已截断）。关掉后只剩结构化因子，追查时看不到「她当时到底说了什么」。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '拒收与写盘失败是否逐条打日志。只影响噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxEntries: FIELD_SPECS.maxEntries.default as number,
  maxExcerptChars: FIELD_SPECS.maxExcerptChars.default as number,
  maxFactors: FIELD_SPECS.maxFactors.default as number,
  maxGates: FIELD_SPECS.maxGates.default as number,
  maxRefs: FIELD_SPECS.maxRefs.default as number,
  retentionDays: FIELD_SPECS.retentionDays.default as number,
  maskSensitive: FIELD_SPECS.maskSensitive.default as boolean,
  storeExcerpt: FIELD_SPECS.storeExcerpt.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须双向唯一，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxEntries: 'max-entries',
  maxExcerptChars: 'max-excerpt-chars',
  maxFactors: 'max-factors',
  maxGates: 'max-gates',
  maxRefs: 'max-refs',
  retentionDays: 'retention-days',
  maskSensitive: 'mask-sensitive',
  storeExcerpt: 'store-excerpt',
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
  title: '回复决策日志',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-narrative-log',
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

/** 读一个布尔。**只有 `true` 才算真**。 */
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
    maxEntries: intIn(raw['maxEntries'], DEFAULT_CONFIG.maxEntries, 20, 2000),
    maxExcerptChars: intIn(raw['maxExcerptChars'], DEFAULT_CONFIG.maxExcerptChars, 0, 400),
    maxFactors: intIn(raw['maxFactors'], DEFAULT_CONFIG.maxFactors, 1, 64),
    maxGates: intIn(raw['maxGates'], DEFAULT_CONFIG.maxGates, 1, 32),
    maxRefs: intIn(raw['maxRefs'], DEFAULT_CONFIG.maxRefs, 0, 64),
    retentionDays: intIn(raw['retentionDays'], DEFAULT_CONFIG.retentionDays, 1, 365),
    maskSensitive: boolOf(raw['maskSensitive'], DEFAULT_CONFIG.maskSensitive),
    storeExcerpt: boolOf(raw['storeExcerpt'], DEFAULT_CONFIG.storeExcerpt),
    verbose: boolOf(raw['verbose'], DEFAULT_CONFIG.verbose),
  })
}
