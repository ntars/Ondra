/**
 * 配置的**单一真源**（对端历史上限 + 单轮超时）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么 `maxPeerHistory` 的上界就是 12
 *
 * 手册 §9.11 与 master-plan §16.2-4 都写「上限 12 条」。做成可调但**夹在 1–12**：
 * 允许往下调（省内存、省上下文），不允许往上调——往上调就是悄悄改掉一条
 * 已写死在上位规范里的上限，而症状是「通道历史越用越长，最后把她的话顶掉」。
 *
 * ## 为什么没有「分条上限」这一项
 *
 * 手册 §9.11 的九个上限是**各通道的属性**，真源在各适配器的 `Config`。
 * 这里再放一个「默认 4000」，就是把微信的 800 撑成 4000，
 * 而症状是消息被平台静默截断——查不出跟谁有关。所以：`chunk()` 的 `max`
 * 必须由调用方给，本插件**不设默认**。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { PEER_HISTORY_LIMIT } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`callPersona()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 对端历史保留几条（1–12）。 */
  readonly maxPeerHistory: number
  /** 单轮问人格的超时（毫秒）。 */
  readonly callTimeoutMs: number
  /** 每次调用打一行日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'channel-kit'

/** 对端历史下界。 */
export const PEER_HISTORY_FLOOR = 1

/** 超时下界：5 秒。再短就该直接报错，而不是等一个注定超时的请求。 */
export const CALL_TIMEOUT_FLOOR = 5_000

/**
 * 超时上界：300 秒。
 *
 * 手册没给超时值（§9.11 只给了 `maxTokens 800` 与各通道的时长）。
 * 取 300 秒的理由：模型的块间隔靠对话链与网关自己的闸挡，
 * 这里只是「整轮别无限挂着」的兜底。再长就该由用户取消，而不是等。
 */
export const CALL_TIMEOUT_CEIL = 300_000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后一律不代问（服务照常注册，面板能看见「已关闭」）。',
  },
  maxPeerHistory: {
    kind: 'number',
    default: PEER_HISTORY_LIMIT,
    min: PEER_HISTORY_FLOOR,
    max: PEER_HISTORY_LIMIT,
    doc: `对端历史保留几条（${PEER_HISTORY_FLOOR}–${PEER_HISTORY_LIMIT}）。上限 12 来自手册 §9.11 与 master-plan §16.2-4，只许往下调。`,
  },
  callTimeoutMs: {
    kind: 'number',
    default: 60_000,
    min: CALL_TIMEOUT_FLOOR,
    max: CALL_TIMEOUT_CEIL,
    advancedOnly: true,
    doc: `单轮问人格的超时（${CALL_TIMEOUT_FLOOR}–${CALL_TIMEOUT_CEIL} 毫秒）。超时只中止这一轮，不换模型、不重试。`,
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '每次调用打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxPeerHistory: FIELD_SPECS.maxPeerHistory.default as number,
  callTimeoutMs: FIELD_SPECS.callTimeoutMs.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxPeerHistory: 'max-peer-history',
  callTimeoutMs: 'call-timeout-ms',
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
  title: '通道公共段',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-channel-kit',
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
 * 夹一个整数。
 * @param value 待夹的值。
 * @param fallback 非法时的回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    maxPeerHistory: clampInt(
      raw['maxPeerHistory'],
      DEFAULT_CONFIG.maxPeerHistory,
      PEER_HISTORY_FLOOR,
      PEER_HISTORY_LIMIT,
    ),
    callTimeoutMs: clampInt(
      raw['callTimeoutMs'],
      DEFAULT_CONFIG.callTimeoutMs,
      CALL_TIMEOUT_FLOOR,
      CALL_TIMEOUT_CEIL,
    ),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 * @returns 被改过的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly [string, number, number][] = [
    ['maxPeerHistory', PEER_HISTORY_FLOOR, PEER_HISTORY_LIMIT],
    ['callTimeoutMs', CALL_TIMEOUT_FLOOR, CALL_TIMEOUT_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }
  return drift
}
