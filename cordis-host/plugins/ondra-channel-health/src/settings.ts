/**
 * 配置的**单一真源**（探针的时间尺度）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么「期望间隔」是用户配置，而不是适配器上报的
 *
 * 让适配器在 `report()` 里带 `expectMs` 最省事，但那就把判定权交给了被观测方：
 * 一个刚崩过一次、心跳写成 10 秒的适配器，会把自己伪装成「一直很健康」；
 * 一个没实现心跳的适配器，会让所有探针永远 `stale`。
 * 时间尺度归用户（`expectMs` 全局 + `intervals` 按通道覆盖），
 * 是唯一不会随适配器实现漂移的选择。**没配就取全局默认，不留空洞**。
 *
 * ## 为什么 `persist` 默认开
 *
 * 上一轮才定过一条纪律：`source` 是一等公民。重启后如果探针从零开始，
 * 面板只能显示 `unknown`，用户看到的是「所有通道都没数据」——
 * 与「真的一个都没跑过」完全同形。落一份极小的记录（最后活动时刻 + 计数），
 * 重启后至少能说「它最后一次有动静是 16:20，之后就没有了」。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`probe()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 心跳期望间隔（毫秒）。超过 `expectMs × staleFactor` 没有任何证据即判 `stale`。 */
  readonly expectMs: number
  /** `stale` 阈值倍率。 */
  readonly staleFactor: number
  /** 错误影响窗口（毫秒）：窗口内的错判 `degraded`，过了就当历史。 */
  readonly errorWindowMs: number
  /** 窗口内重连几次算「重连风暴」。 */
  readonly reconnectLimit: number
  /** 同一时刻最多盯多少个通道。 */
  readonly maxChannels: number
  /** 按通道覆盖 `expectMs`（键为通道 id）。没配的用全局值。 */
  readonly intervals: Readonly<Record<string, number>>
  /** 是否把记录落盘（重启后能说「上次活到几时」）。 */
  readonly persist: boolean
  /** 落盘节流间隔（毫秒）。 */
  readonly flushMs: number
  /** 每次上报打一行日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'channel-health'

/** 心跳间隔下界：5 秒。再密就是刷日志了。 */
export const EXPECT_MS_FLOOR = 5_000

/** 心跳间隔上界：1 小时。再稀疏就分不清「夜里没人说话」与「已经死了」。 */
export const EXPECT_MS_CEIL = 3_600_000

/** 倍率下界：1（等于不放大，任何一次超期都算 `stale`）。 */
export const STALE_FACTOR_FLOOR = 1

/** 倍率上界：20。再大就变成「怎么都不报警」。 */
export const STALE_FACTOR_CEIL = 20

/** 错误窗口下界：10 秒。 */
export const ERROR_WINDOW_FLOOR = 10_000

/** 错误窗口上界：1 小时。 */
export const ERROR_WINDOW_CEIL = 3_600_000

/** 重连次数下界：1。 */
export const RECONNECT_LIMIT_FLOOR = 1

/** 重连次数上界：10。再多说明它根本连不上，`closed` 更准确。 */
export const RECONNECT_LIMIT_CEIL = 10

/** 通道数下界：1。 */
export const MAX_CHANNELS_FLOOR = 1

/** 通道数上界：512。9 个通道 × 多账号也不到 100，512 是「别把内存交给别人填」的兜底。 */
export const MAX_CHANNELS_CEIL = 512

/** 落盘节流下界：1 秒。 */
export const FLUSH_MS_FLOOR = 1_000

/** 落盘节流上界：60 秒。 */
export const FLUSH_MS_CEIL = 60_000

/** 记录文件名。放在 `user/channels/health/` 下，一通道一份。 */
export const RECORD_DIR_SEGMENTS = ['channels', 'health'] as const

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，所有通道一律报「探针已关闭」。',
  },
  expectMs: {
    kind: 'number',
    default: 60_000,
    min: EXPECT_MS_FLOOR,
    max: EXPECT_MS_CEIL,
    doc: `心跳期望间隔（毫秒）。适配器该按这个节奏报 \`heartbeat\`；超过「间隔 × 倍率」没有任何证据即判「很久没有动静」。默认 60000（1 分钟）。`,
  },
  staleFactor: {
    kind: 'number',
    default: 3,
    min: STALE_FACTOR_FLOOR,
    max: STALE_FACTOR_CEIL,
    advancedOnly: true,
    doc: '判「很久没有动静」的倍率。默认 3：连续三次心跳都没来才算。',
  },
  errorWindowMs: {
    kind: 'number',
    default: 300_000,
    min: ERROR_WINDOW_FLOOR,
    max: ERROR_WINDOW_CEIL,
    advancedOnly: true,
    doc: '错误影响窗口（毫秒）。窗口内的错才判「最近出过错」，过了当历史。默认 5 分钟。',
  },
  reconnectLimit: {
    kind: 'number',
    default: 3,
    min: RECONNECT_LIMIT_FLOOR,
    max: RECONNECT_LIMIT_CEIL,
    advancedOnly: true,
    doc: '窗口内重连几次算「一直在重连」。默认 3 次。',
  },
  maxChannels: {
    kind: 'number',
    default: 64,
    min: MAX_CHANNELS_FLOOR,
    max: MAX_CHANNELS_CEIL,
    advancedOnly: true,
    doc: `最多同时盯几个通道（${MAX_CHANNELS_FLOOR}–${MAX_CHANNELS_CEIL}）。超了淘汰最久没动静的那个，并记一行日志。`,
  },
  intervals: {
    kind: 'json',
    default: {},
    advancedOnly: true,
    doc: '按通道覆盖心跳间隔，例如 {"telegram": 120000}。没配的通道用全局 expectMs。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '把「最后活动时刻 + 计数」落盘，重启后仍能说清上次活到几时。关掉则只在内存里。',
  },
  flushMs: {
    kind: 'number',
    default: 5_000,
    min: FLUSH_MS_FLOOR,
    max: FLUSH_MS_CEIL,
    advancedOnly: true,
    doc: '落盘节流（毫秒）。默认 5 秒：心跳每秒都写盘，会把磁盘磨出声音。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次上报打一行日志。通道多时噪声很大，默认关。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  expectMs: FIELD_SPECS.expectMs.default as number,
  staleFactor: FIELD_SPECS.staleFactor.default as number,
  errorWindowMs: FIELD_SPECS.errorWindowMs.default as number,
  reconnectLimit: FIELD_SPECS.reconnectLimit.default as number,
  maxChannels: FIELD_SPECS.maxChannels.default as number,
  intervals: Object.freeze({}) as Readonly<Record<string, number>>,
  persist: FIELD_SPECS.persist.default as boolean,
  flushMs: FIELD_SPECS.flushMs.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  expectMs: 'expect-ms',
  staleFactor: 'stale-factor',
  errorWindowMs: 'error-window-ms',
  reconnectLimit: 'reconnect-limit',
  maxChannels: 'max-channels',
  intervals: 'intervals',
  persist: 'persist',
  flushMs: 'flush-ms',
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
  title: '通道探针',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-channel-health',
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
 * 归一化「按通道覆盖」表。
 *
 * 非法项**逐项丢弃**而不是整表回退：一个通道的间隔写错，
 * 不该把其他九个通道的覆盖一起清掉。
 * @param value 原始值。
 */
function normalizeIntervals(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return Object.freeze({})
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const ms = Math.trunc(raw)
    if (ms < EXPECT_MS_FLOOR || ms > EXPECT_MS_CEIL) continue
    out[key] = ms
  }
  return Object.freeze(out)
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
    expectMs: clampInt(raw['expectMs'], DEFAULT_CONFIG.expectMs, EXPECT_MS_FLOOR, EXPECT_MS_CEIL),
    staleFactor: clampInt(
      raw['staleFactor'],
      DEFAULT_CONFIG.staleFactor,
      STALE_FACTOR_FLOOR,
      STALE_FACTOR_CEIL,
    ),
    errorWindowMs: clampInt(
      raw['errorWindowMs'],
      DEFAULT_CONFIG.errorWindowMs,
      ERROR_WINDOW_FLOOR,
      ERROR_WINDOW_CEIL,
    ),
    reconnectLimit: clampInt(
      raw['reconnectLimit'],
      DEFAULT_CONFIG.reconnectLimit,
      RECONNECT_LIMIT_FLOOR,
      RECONNECT_LIMIT_CEIL,
    ),
    maxChannels: clampInt(
      raw['maxChannels'],
      DEFAULT_CONFIG.maxChannels,
      MAX_CHANNELS_FLOOR,
      MAX_CHANNELS_CEIL,
    ),
    intervals: normalizeIntervals(raw['intervals']),
    persist: bool('persist', DEFAULT_CONFIG.persist),
    flushMs: clampInt(raw['flushMs'], DEFAULT_CONFIG.flushMs, FLUSH_MS_FLOOR, FLUSH_MS_CEIL),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 某个通道的心跳期望间隔。
 * @param config 已补全配置。
 * @param channelId 通道 id。
 */
export function expectMsOf(config: Config, channelId: string): number {
  const override = config.intervals[channelId]
  return override === undefined ? config.expectMs : override
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 * @returns 被改过的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['expectMs', EXPECT_MS_FLOOR, EXPECT_MS_CEIL],
    ['staleFactor', STALE_FACTOR_FLOOR, STALE_FACTOR_CEIL],
    ['errorWindowMs', ERROR_WINDOW_FLOOR, ERROR_WINDOW_CEIL],
    ['reconnectLimit', RECONNECT_LIMIT_FLOOR, RECONNECT_LIMIT_CEIL],
    ['maxChannels', MAX_CHANNELS_FLOOR, MAX_CHANNELS_CEIL],
    ['flushMs', FLUSH_MS_FLOOR, FLUSH_MS_CEIL],
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
