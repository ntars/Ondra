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
 * ## 为什么只有七个字段
 *
 * 手册给本插件的只有两句话：「呼吸感动作单日 ≤2 次」与「『正在输入』」。
 * 其余全是形态：哪个阶段显示、哪些动作可发、跨零点怎么算。
 * **形态不进配置**——做成配置项就等于每台机器的「正在输入」行为不一样，
 * 而面板与调试工具只认一个版本。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`sameActionOncePerDay`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import { HARD_DAILY_CAP, HARD_MAX_ACTIONS } from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，`presence()` 返回不显示、`take()` 返回 `disabled`。 */
  readonly enable: boolean
  /** 是否回答「正在输入」。关掉只影响 `presence()` 与 `subscribe()`。 */
  readonly presenceEnabled: boolean
  /** 是否允许呼吸感动作。 */
  readonly breathEnabled: boolean
  /** 单日上限。默认 2，**上限也锁 2**（手册原文「单日 ≤2 次」）。 */
  readonly dailyCap: number
  /**
   * 同一个动作一天最多一次。默认开。
   *
   * 池子只有一条手册动作时，这条把实际用量压到 1 次/天——
   * 一天伸两次懒腰本身就可疑，而「明显重复」比「少一次」更像 bug。
   */
  readonly sameActionOncePerDay: boolean
  /** 追加的动作（不含手册那一条）。字符串数组，最多 11 条。 */
  readonly extraActions: readonly string[]
  /** 降级与拒绝时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'breath'

/** 附加动作最多几条（手册那条占一个位）。 */
export const MAX_EXTRA_ACTIONS = HARD_MAX_ACTIONS - 1

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，presence() 不显示、take() 返回 disabled。',
  },
  presenceEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否回答「正在输入」（只出判定，不画界面）。',
  },
  breathEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否允许呼吸感动作（单日 ≤2 次）。',
  },
  dailyCap: {
    kind: 'number',
    default: HARD_DAILY_CAP,
    min: 0,
    max: HARD_DAILY_CAP,
    doc: '单日呼吸感动作上限。手册 §4.2 原值 2，上限锁 2。',
  },
  sameActionOncePerDay: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '同一个动作一天最多一次（防「一天伸两次懒腰」）。',
  },
  extraActions: {
    kind: 'json',
    default: Object.freeze([]),
    advancedOnly: true,
    doc: '追加的呼吸感动作（全角括号，最多 ' + String(MAX_EXTRA_ACTIONS) + ' 条）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与拒绝时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  presenceEnabled: FIELD_SPECS.presenceEnabled.default as boolean,
  breathEnabled: FIELD_SPECS.breathEnabled.default as boolean,
  dailyCap: FIELD_SPECS.dailyCap.default as number,
  sameActionOncePerDay: FIELD_SPECS.sameActionOncePerDay.default as boolean,
  extraActions: FIELD_SPECS.extraActions.default as readonly string[],
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  presenceEnabled: 'presence-enabled',
  breathEnabled: 'breath-enabled',
  dailyCap: 'daily-cap',
  sameActionOncePerDay: 'same-action-once-per-day',
  extraActions: 'extra-actions',
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
  title: '呼吸感',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-breath',
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
 * 归一化动作表：只留非空字符串、去重、截到上限。
 * @param value 原始值（可能是任意 JSON）。
 */
function normalizeActions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (out.includes(text)) continue
    out.push(text)
    if (out.length >= MAX_EXTRA_ACTIONS) break
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
    presenceEnabled: bool('presenceEnabled', DEFAULT_CONFIG.presenceEnabled),
    breathEnabled: bool('breathEnabled', DEFAULT_CONFIG.breathEnabled),
    // 上限锁 2：手册原文「单日 ≤2 次」。
    dailyCap: clampInt(raw['dailyCap'], DEFAULT_CONFIG.dailyCap, 0, HARD_DAILY_CAP),
    sameActionOncePerDay: bool('sameActionOncePerDay', DEFAULT_CONFIG.sameActionOncePerDay),
    extraActions: normalizeActions(raw['extraActions']),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
