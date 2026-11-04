/**
 * 配置的**单一真源**。
 *
 * 一张声明表，三处消费（与 O-035 同口径）。
 *
 * ## 三个开关的层级关系（这里最容易做错）
 *
 * ```
 * enabled          插件总开关：关掉 = 连渠道清单都不提供
 *   └─ freeLanes   免密车道总开关：关掉 = 不发任何出站请求（默认关）
 *        └─ laneIds 具体哪几条车道可用
 *   └─ channels    聚合渠道白名单：只有列出来的才会生成 profile
 * ```
 *
 * 三者**不合并成一个**。合成一个「启用」布尔之后，「装了但我不想知道它存在」
 * 和「装了、我知道、但我不用免费额度」就分不开了——前者要求零出站，
 * 后者允许探测聚合渠道。这两种状态在真实使用里都存在。
 */

import { FREE_LANES } from './lanes.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 插件总开关。关掉后服务不注册、渠道清单不加载。 */
  readonly enabled: boolean
  /** 免密车道总开关。**默认 false**：打开前不产生任何出站请求。 */
  readonly freeLanes: boolean
  /** 允许使用的免密车道 id 清单。空数组表示「一条都不许」。 */
  readonly laneIds: readonly string[]
  /** 聚合渠道白名单。只有列出的渠道才会生成 profile。 */
  readonly channels: readonly string[]
  /** 启动时是否探测一次模型清单。默认 false，避免开机就打第三方接口。 */
  readonly probeOnStart: boolean
  /** 探测间隔（分钟）。0 表示不定时探测。 */
  readonly probeIntervalMinutes: number
  /** 单次探测超时（毫秒）。 */
  readonly probeTimeoutMs: number
}

/** 字段声明（O-005 结构对位）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** 段声明（O-005 结构对位）。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** 解析结果（O-005 结构对位）。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** 配置真源服务（O-005 结构对位）。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}

/** 全部车道 id（用于校验用户写的 laneIds）。 */
const ALL_LANE_IDS: readonly string[] = FREE_LANES.map(lane => lane.id)

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enabled: {
    kind: 'boolean',
    default: true,
    doc: '插件总开关。关掉后不加载渠道清单、不注册服务。',
  },
  freeLanes: {
    kind: 'boolean',
    default: false,
    doc: '免密车道总开关。默认关闭：打开之前本插件不发任何出站请求。开启后对话内容会发往第三方网关。',
  },
  laneIds: {
    kind: 'json',
    default: ALL_LANE_IDS,
    advancedOnly: true,
    doc: `允许使用的免密车道，可选 ${ALL_LANE_IDS.join(' / ')}。只在免密车道总开关打开时生效。`,
  },
  channels: {
    kind: 'json',
    default: [],
    advancedOnly: true,
    doc: '聚合渠道白名单。写入渠道键（如 "openrouter"）后，该渠道才会生成可用 profile；空数组表示一家都不启用。',
  },
  probeOnStart: {
    kind: 'boolean',
    default: false,
    doc: '启动时探测一次模型清单。会向已启用渠道的 /models 发请求，默认关闭。',
  },
  probeIntervalMinutes: {
    kind: 'number',
    default: 30,
    min: 0,
    max: 1440,
    doc: '定时探测间隔（分钟）。0 表示不自动探测。',
  },
  probeTimeoutMs: {
    kind: 'number',
    default: 5000,
    min: 1000,
    max: 60000,
    doc: '单次探测超时（毫秒）。',
  },
})

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'our-free-model'

/** Config 键（camelCase）→ 段字段键（kebab-case）的唯一映射。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enabled: 'enabled',
  freeLanes: 'free-lanes',
  laneIds: 'lane-ids',
  channels: 'channels',
  probeOnStart: 'probe-on-start',
  probeIntervalMinutes: 'probe-interval-minutes',
  probeTimeoutMs: 'probe-timeout-ms',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '免费模型',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-our-free-model',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * @param raw 原始配置对象。
 * @returns 键已归一化的普通对象。
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
 * 把 O-005 的解析结果回填成 Config 形状。
 * @param values 解析结果的 `values`。
 * @returns Config 形状的普通对象。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_KEYS[key] ?? key] = value
  }
  return out
}

/** 夹一个数字。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 把未知值读成去重后的字符串数组；非数组返回 `undefined`。 */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const key = item.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * 补全并校验配置。
 * @param raw 原始配置。
 * @returns 补全后的配置与问题列表。
 */
export function completeConfig(raw: unknown): { config: Config; issues: readonly { field: string; message: string }[] } {
  const issues: { field: string; message: string }[] = []
  const source = isRecord(raw) ? raw : {}

  const bool = (key: keyof Config, fallback: boolean): boolean => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value === 'boolean') return value
    issues.push({ field: key, message: `${key} 不是布尔值，已回退 ${String(fallback)}` })
    return fallback
  }

  const enabled = bool('enabled', true)
  const freeLanes = bool('freeLanes', false)
  const probeOnStart = bool('probeOnStart', false)

  let laneIds: readonly string[] = ALL_LANE_IDS
  const lanesRaw = stringList(source['laneIds'])
  if (source['laneIds'] !== undefined) {
    if (lanesRaw === undefined) {
      issues.push({ field: 'laneIds', message: 'laneIds 不是数组，已回退全部车道' })
    } else {
      const unknown = lanesRaw.filter(id => !ALL_LANE_IDS.includes(id))
      if (unknown.length > 0) {
        issues.push({ field: 'laneIds', message: `laneIds 里有不存在的车道：${unknown.join(', ')}，已忽略` })
      }
      laneIds = lanesRaw.filter(id => ALL_LANE_IDS.includes(id))
    }
  }

  let channels: readonly string[] = []
  const channelsRaw = stringList(source['channels'])
  if (source['channels'] !== undefined) {
    if (channelsRaw === undefined) {
      issues.push({ field: 'channels', message: 'channels 不是数组，已回退空清单' })
    } else {
      channels = channelsRaw
    }
  }

  const probeIntervalMinutes = clampNumber(source['probeIntervalMinutes'], 30, 0, 1440)
  const probeTimeoutMs = clampNumber(source['probeTimeoutMs'], 5000, 1000, 60000)

  return {
    config: { enabled, freeLanes, laneIds, channels, probeOnStart, probeIntervalMinutes, probeTimeoutMs },
    issues,
  }
}
