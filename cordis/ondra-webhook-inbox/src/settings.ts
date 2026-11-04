/**
 * O-114 `ondra-webhook-inbox` 的配置**单一真源**。
 *
 * 与 O-005 的口径一致：默认值由声明方拥有、全仓只存一份。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 这些数从哪来（**必须写清，否则就是拍脑袋**）
 *
 * master-plan §9 参数速查里**没有**「事件播报」这一组——只有情绪、节奏、主动、语音、
 * 对话、界面六组。故下面十个数值全是**本插件的工程取值**，依据是四条可观察的线：
 *
 * - 64 条队列上限：一天里值得播报的外部事件通常个位数；64 条已经能装下一周的意外。
 *   再大只会让「箱子里堆了 300 条没人取」变成常态，而那种箱子等于没有。
 * - 8 条一批：一次说八件事已经像系统告警而不像有人在说话。超过八条，人只会滑过去。
 * - 12 条一小时：这是「她的话被事件挤满」的上限。超过它，事件播报就从陪伴变成了刷屏。
 * - 24 小时去重窗：一天的周期。同一件事隔天再报一次多数是有意义的（例如每天的健康检查失败），
 *   而一小时内报两次一定没有。
 * - 12 小时超龄：半天以前的 CI 失败、半天以前的订单，现在播报已经没用。
 *
 * ## 刻意没有的配置项（四条）
 *
 * 1. **没有「高优先级是否绕过静默」。** 那是纪律不是偏好：留一个开关，就一定会有一次
 *    「这次比较急」把它打开，然后静默时段变成建议。
 * 2. **没有「存不存原文」。** `InboxEvent` 里 `body` / `raw` / `payload` 的类型是 `never`，
 *    连字段位置都没留。
 * 3. **没有「去重表上限」。** 它由队列上限推导（×8），不需要人来调——调大只是多占内存，
 *    调小则会让已经播过的事件被重播。
 * 4. **没有「消息模板 / 话术 / 通道」。** 本插件不发送，也不生成给人看的句子；
 *    摘要就是调用方给的那一句，原样（压缩后）存下。
 */

import type { FieldSpecLike, InboxPolicy, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不联网、不起服务、只收宿主交进来的事件。 */
  readonly enable: boolean
  /** 队列上限（条）。满了丢最旧的，并且记日志。 */
  readonly queueCap: number
  /** 一批最多投递几条。 */
  readonly maxBatch: number
  /** 每小时最多投递几条（按 `ack()` 计数）。 */
  readonly maxPerHour: number
  /** 去重窗（小时）。同一指纹在此期间只入箱一次。 */
  readonly fingerprintTtlHours: number
  /** 条目最长存活时长（小时）。超龄的直接清掉，不投递。 */
  readonly maxAgeHours: number
  /** 摘要字符上限。 */
  readonly summaryMaxChars: number
  /** 是否启用静默时段。 */
  readonly quietHours: boolean
  /** 静默起点（时，0–23，含）。 */
  readonly quietStartHour: number
  /** 静默终点（时，0–23，不含）。与起点相同视为不设静默。 */
  readonly quietEndHour: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'webhook-inbox'

/** 队列上限的允许区间。 */
export const QUEUE_FLOOR = 8
export const QUEUE_CEILING = 512

/** 一批条数的允许区间。 */
export const BATCH_FLOOR = 1
export const BATCH_CEILING = 32

/** 每小时额度的允许区间。 */
export const RATE_FLOOR = 1
export const RATE_CEILING = 120

/** 去重窗的允许区间（小时）。 */
export const TTL_FLOOR = 1
export const TTL_CEILING = 168

/** 超龄时长的允许区间（小时）。 */
export const AGE_FLOOR = 1
export const AGE_CEILING = 168

/** 摘要长度的允许区间（字符）。低于 20 会截掉关键信息，高于 500 已经是正文了。 */
export const SUMMARY_FLOOR = 20
export const SUMMARY_CEILING = 500

/**
 * 静默时段的默认口径：23:00–08:00。
 *
 * 与 O-042 同口径是刻意的：两处各判一次，宁可重复也不共用一份状态——
 * 共用会让「改一处静默」变成没人敢做的改动。
 */
export const QUIET_START_DEFAULT = 23
export const QUIET_END_DEFAULT = 8

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，ingest() / ack() 抛 disabled，pending() / snapshot() 照常可读。高优先级也不能绕过它。',
  },
  queueCap: {
    kind: 'number',
    default: 64,
    min: QUEUE_FLOOR,
    max: QUEUE_CEILING,
    doc: '队列上限（条）。满了丢最旧的，并在日志里说丢了哪几条——不做静默截断。',
  },
  maxBatch: {
    kind: 'number',
    default: 8,
    min: BATCH_FLOOR,
    max: BATCH_CEILING,
    doc: '一批最多投递几条。一次说八件事已经像告警而不像有人在说话。',
  },
  maxPerHour: {
    kind: 'number',
    default: 12,
    min: RATE_FLOOR,
    max: RATE_CEILING,
    doc: '每小时最多投递几条，按 ack() 的时刻计数。超过这个量，事件播报就变成刷屏。',
  },
  fingerprintTtlHours: {
    kind: 'number',
    default: 24,
    min: TTL_FLOOR,
    max: TTL_CEILING,
    doc: '去重窗（小时）。窗口从第一次见到算，不因重复上报而延长。',
  },
  maxAgeHours: {
    kind: 'number',
    default: 12,
    min: AGE_FLOOR,
    max: AGE_CEILING,
    doc: '条目最长存活时长（小时）。超龄的清理掉、不投递：半天前的 CI 失败现在说已经没用了。',
  },
  summaryMaxChars: {
    kind: 'number',
    default: 140,
    min: SUMMARY_FLOOR,
    max: SUMMARY_CEILING,
    doc: '摘要字符上限。超出截断并加省略号；本插件不判断摘要里有没有敏感信息。',
  },
  quietHours: {
    kind: 'boolean',
    default: true,
    doc: '是否启用静默时段。关掉后半夜也会投递——这是本插件唯一会让「半夜说话」发生的方式。',
  },
  quietStartHour: {
    kind: 'number',
    default: QUIET_START_DEFAULT,
    min: 0,
    max: 23,
    doc: '静默起点（时，含）。默认 23，与 O-042 同口径。',
  },
  quietEndHour: {
    kind: 'number',
    default: QUIET_END_DEFAULT,
    min: 0,
    max: 23,
    doc: '静默终点（时，不含）。默认 8。与起点相同视为不设静默。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
function defaultsOf(): Config {
  return {
    enable: FIELD_SPECS.enable.default === true,
    queueCap: Number(FIELD_SPECS.queueCap.default),
    maxBatch: Number(FIELD_SPECS.maxBatch.default),
    maxPerHour: Number(FIELD_SPECS.maxPerHour.default),
    fingerprintTtlHours: Number(FIELD_SPECS.fingerprintTtlHours.default),
    maxAgeHours: Number(FIELD_SPECS.maxAgeHours.default),
    summaryMaxChars: Number(FIELD_SPECS.summaryMaxChars.default),
    quietHours: FIELD_SPECS.quietHours.default !== false,
    quietStartHour: Number(FIELD_SPECS.quietStartHour.default),
    quietEndHour: Number(FIELD_SPECS.quietEndHour.default),
  }
}

/** 默认配置（只读外观）。 */
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze(defaultsOf())

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  queueCap: 'queue-cap',
  maxBatch: 'max-batch',
  maxPerHour: 'max-per-hour',
  fingerprintTtlHours: 'fingerprint-ttl-hours',
  maxAgeHours: 'max-age-hours',
  summaryMaxChars: 'summary-max-chars',
  quietHours: 'quiet-hours',
  quietStartHour: 'quiet-start-hour',
  quietEndHour: 'quiet-end-hour',
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
  title: '事件播报收件箱',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-webhook-inbox',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把任意值夹到闭区间；非有限数回退默认。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  if (num < min) return min
  if (num > max) return max
  return Math.round(num)
}

/** 把小时数规整到 0–23 的整数。 */
function clampHour(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  const hour = Math.round(num)
  if (hour < 0) return 0
  if (hour > 23) return 23
  return hour
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * @param raw 原始配置对象。
 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    // 只认已知键：陌生键不进段，否则 O-005 的字段表会与配置对不上。
    const mapped = KEY_PAIRS[key as keyof Config]
    if (mapped !== undefined) out[mapped] = value
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
 * 补全配置。**永不抛错**：配置错不该让插件不加载。
 *
 * 唯一的跨字段修正：`maxBatch` 不能超过 `queueCap`。超过时**向下压**，
 * 因为「一批取 32 条」在只有 8 条的箱子里只是一个永远取不满的上限，
 * 而反过来（上限比队列大）会让调用方以为自己配错了。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const base = defaultsOf()

  const queueCap = clampNumber(raw.queueCap, base.queueCap, QUEUE_FLOOR, QUEUE_CEILING)
  const batchRaw = clampNumber(raw.maxBatch, base.maxBatch, BATCH_FLOOR, BATCH_CEILING)
  const maxBatch = batchRaw > queueCap ? queueCap : batchRaw

  return Object.freeze({
    enable: raw.enable === undefined ? base.enable : raw.enable !== false,
    queueCap,
    maxBatch,
    maxPerHour: clampNumber(raw.maxPerHour, base.maxPerHour, RATE_FLOOR, RATE_CEILING),
    fingerprintTtlHours: clampNumber(
      raw.fingerprintTtlHours,
      base.fingerprintTtlHours,
      TTL_FLOOR,
      TTL_CEILING,
    ),
    maxAgeHours: clampNumber(raw.maxAgeHours, base.maxAgeHours, AGE_FLOOR, AGE_CEILING),
    summaryMaxChars: clampNumber(
      raw.summaryMaxChars,
      base.summaryMaxChars,
      SUMMARY_FLOOR,
      SUMMARY_CEILING,
    ),
    quietHours: raw.quietHours === undefined ? base.quietHours : raw.quietHours !== false,
    quietStartHour: clampHour(raw.quietStartHour, base.quietStartHour),
    quietEndHour: clampHour(raw.quietEndHour, base.quietEndHour),
  })
}

/**
 * 配置 → 判定口径（毫秒 / 条）。换算只在这里做一次。
 * @param config 合法配置。
 * @returns 判定口径。
 */
export function policyOf(config: Config): InboxPolicy {
  // 去重表上限由队列上限推导：一条活着的条目配 8 条指纹的余量，
  // 低于 64 条时仍然给 64（一天的事件源数量远小于这个数）。
  const derived = config.queueCap * 8
  const fingerprintCap = derived < 64 ? 64 : derived > 4096 ? 4096 : derived
  return {
    queueCap: config.queueCap,
    maxBatch: config.maxBatch,
    maxPerHour: config.maxPerHour,
    fingerprintTtlMs: config.fingerprintTtlHours * 3_600_000,
    fingerprintCap,
    maxAgeMs: config.maxAgeHours * 3_600_000,
    summaryMaxChars: config.summaryMaxChars,
    quietEnabled: config.quietHours,
    quietStartHour: config.quietStartHour,
    quietEndHour: config.quietEndHour,
  }
}
