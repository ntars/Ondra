/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 为什么这一路只有「四个数」值得配
 *
 * 企业微信的风险结构与 QQ 完全不同（§5.3 那六道闸的标题写的就是「QQ 防封控」）：
 * 它是**企业内部**应用，收信只来自本企业成员，发信走官方 API、有平台自己的频控。
 * 真正会出事的是四个数：
 *
 * 1. **单条 2000**（master-plan §9.11）——超了平台直接拒收，而错误信息只说「参数错误」；
 * 2. **去重窗口**——没在 5 秒内响应时企业微信会重试，认不出来就会答两遍；
 * 3. **并发上限**——一次涌进 100 条时不该开 100 个模型请求；
 * 4. **白名单**——不填就是「全企业成员都能触发她」，这是需要人点头的决定。
 *
 * 令牌桶 / 深夜静默 / 熔断那套搬过来，得到的不是更安全，而是「莫名其妙被限流」——
 * 而且会掩盖上面四个真正的数字。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  CHUNK_MAX,
  CHUNK_MIN,
  DEFAULT_API_BASE,
  DEFAULT_ROUTE_PATH,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 路由路径（挂在宿主 webServer 上的绝对 pathname）。 */
  readonly routePath: string
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/wecom.json`。 */
  readonly credentialFile: string
  /** 状态文件路径（去重表）；留空则推出 `…wecom.state.json`。 */
  readonly stateFile: string
  /** 单条上限（100–2000，默认 2000：平台硬上限）。 */
  readonly chunkMax: number
  /** 允许的成员 UserID（空 = 不限，全企业成员都能触发）。 */
  readonly allowUserIds: readonly string[]
  /** 屏蔽的成员 UserID（优先于白名单）。 */
  readonly blockUserIds: readonly string[]
  /** 去重窗口（毫秒）：企业微信在没及时收到响应时会重试。 */
  readonly dedupeWindowMs: number
  /** 并发上限（同时跑几个回合）。 */
  readonly maxConcurrent: number
  /** 单次 HTTP 请求超时（毫秒）。 */
  readonly requestTimeoutMs: number
  /** 接口基址（换代理/内网网关时改这里）。 */
  readonly apiBase: string
  /** 去重状态是否落盘。 */
  readonly persist: boolean
  /** 落盘节流（毫秒）。 */
  readonly persistMs: number
  /** 每次发送打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'wecom'

/** 去重窗口下界：1 分钟（再短挡不住企业微信的重试）。 */
export const DEDUPE_FLOOR = 60_000

/** 去重窗口上界：24 小时。 */
export const DEDUPE_CEIL = 86_400_000

/** 并发上限上界：16。再多也只是把模型打成 429。 */
export const CONCURRENCY_CEIL = 16

/** 请求超时上界：60 秒。 */
export const REQUEST_TIMEOUT_CEIL = 60_000

/** 请求超时下界：1 秒。 */
export const REQUEST_TIMEOUT_FLOOR = 1_000

/** 落盘节流默认值（毫秒）。 */
export const PERSIST_MS = 5_000

/** 落盘节流上界（毫秒）。 */
export const PERSIST_CEIL = 60_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  routePath: 'route-path',
  credentialFile: 'credential-file',
  stateFile: 'state-file',
  chunkMax: 'chunk-max',
  allowUserIds: 'allow-user-ids',
  blockUserIds: 'block-user-ids',
  dedupeWindowMs: 'dedupe-window-ms',
  maxConcurrent: 'max-concurrent',
  requestTimeoutMs: 'request-timeout-ms',
  apiBase: 'api-base',
  persist: 'persist',
  persistMs: 'persist-ms',
  verbose: 'verbose',
})

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '通道开关。默认关：一个企业应用装上去就开始回成员消息，那是事故不是功能。',
  },
  routePath: {
    kind: 'string',
    default: DEFAULT_ROUTE_PATH,
    pattern: '^/[A-Za-z0-9._~/-]*$',
    doc: '挂在宿主 webServer 上的路径。企业微信后台「接收消息服务器配置」填 https://<你的域名><routePath>。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用 user/channels/wecom.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '去重状态文件绝对路径。留空则用 user/channels/wecom.state.json。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（master-plan §9.11 实测 2000）。这是平台硬上限，只能往下调。',
  },
  allowUserIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的成员 UserID。空数组 = 不限（全企业成员都能触发她）——企业应用里这是可见性决定，请想清楚再留空。',
  },
  blockUserIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '屏蔽的成员 UserID。优先于白名单。',
  },
  dedupeWindowMs: {
    kind: 'number',
    default: 1_800_000,
    min: DEDUPE_FLOOR,
    max: DEDUPE_CEIL,
    doc: '去重窗口。企业微信没及时收到响应会重试，不认出来就会答同一句话两遍。',
  },
  maxConcurrent: {
    kind: 'number',
    default: 3,
    min: 1,
    max: CONCURRENCY_CEIL,
    doc: '并发上限。一次涌进 100 条时不该开 100 个模型请求。',
  },
  requestTimeoutMs: {
    kind: 'number',
    default: 8_000,
    min: REQUEST_TIMEOUT_FLOOR,
    max: REQUEST_TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '单次 HTTP 请求超时。',
  },
  apiBase: {
    kind: 'string',
    default: DEFAULT_API_BASE,
    advancedOnly: true,
    doc: '接口基址。走代理或企业内网关时改这里，不改代码。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '去重状态落盘。不落盘的话重启后「刚说过的话」会被再答一遍。',
  },
  persistMs: {
    kind: 'number',
    default: PERSIST_MS,
    min: 1_000,
    max: PERSIST_CEIL,
    advancedOnly: true,
    doc: '落盘节流。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次发送打一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  routePath: DEFAULT_ROUTE_PATH,
  credentialFile: '',
  stateFile: '',
  chunkMax: CHUNK_MAX,
  allowUserIds: Object.freeze([]) as readonly string[],
  blockUserIds: Object.freeze([]) as readonly string[],
  dedupeWindowMs: 1_800_000,
  maxConcurrent: 3,
  requestTimeoutMs: 8_000,
  apiBase: DEFAULT_API_BASE,
  persist: true,
  persistMs: PERSIST_MS,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '企业微信',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-wecom',
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
 * 路由路径是否合法。
 *
 * 宿主 `register` 用 pathname 精确匹配、注释写明「无尾斜杠」，所以这里也拒尾斜杠：
 * 带了尾斜杠就是另一条路由，症状是「注册成功、企业微信请求 404」。
 * @param path 路径文本。
 */
export function isUsablePath(path: string): boolean {
  const text = path.trim()
  if (!text.startsWith('/')) return false
  if (text.length > 1 && text.endsWith('/')) return false
  if (text.includes('?') || text.includes('#')) return false
  return /^\/[A-Za-z0-9._~/-]*$/.test(text)
}

/**
 * 归一化 UserID 名单。
 *
 * 企业微信的 UserID 是管理员自己定的（常见是工号或英文名），**不做大小写折叠**：
 * 折叠会让 `ZhangSan` 与 `zhangsan` 塌成同一个人，症状是「拉黑了一个人，另一个人也不回了」。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeUserIds(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (text.length < 2 || text.length > 64 || /\s/.test(text)) {
      onBad(text)
      continue
    }
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
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
 * @param onBad 有坏条目时的回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const str = (key: keyof Config, fallback: string): string => {
    const given = raw[key]
    return typeof given === 'string' ? given : fallback
  }

  const routePath = str('routePath', DEFAULT_CONFIG.routePath).trim()
  const apiBase = str('apiBase', DEFAULT_CONFIG.apiBase).trim()

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    routePath: isUsablePath(routePath) ? routePath : DEFAULT_CONFIG.routePath,
    credentialFile: str('credentialFile', DEFAULT_CONFIG.credentialFile).trim(),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile).trim(),
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_MAX),
    allowUserIds: normalizeUserIds(raw['allowUserIds'], text => report(text, 'allowUserIds')),
    blockUserIds: normalizeUserIds(raw['blockUserIds'], text => report(text, 'blockUserIds')),
    dedupeWindowMs: clampInt(raw['dedupeWindowMs'], DEFAULT_CONFIG.dedupeWindowMs, DEDUPE_FLOOR, DEDUPE_CEIL),
    maxConcurrent: clampInt(raw['maxConcurrent'], DEFAULT_CONFIG.maxConcurrent, 1, CONCURRENCY_CEIL),
    requestTimeoutMs: clampInt(
      raw['requestTimeoutMs'],
      DEFAULT_CONFIG.requestTimeoutMs,
      REQUEST_TIMEOUT_FLOOR,
      REQUEST_TIMEOUT_CEIL,
    ),
    apiBase: apiBase === '' ? DEFAULT_CONFIG.apiBase : apiBase.replace(/\/+$/, ''),
    persist: bool('persist', DEFAULT_CONFIG.persist),
    persistMs: clampInt(raw['persistMs'], DEFAULT_CONFIG.persistMs, 1_000, PERSIST_CEIL),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（越界值被夹紧、路径被回退）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['chunkMax', CHUNK_MIN, CHUNK_MAX],
    ['dedupeWindowMs', DEDUPE_FLOOR, DEDUPE_CEIL],
    ['maxConcurrent', 1, CONCURRENCY_CEIL],
    ['requestTimeoutMs', REQUEST_TIMEOUT_FLOOR, REQUEST_TIMEOUT_CEIL],
    ['persistMs', 1_000, PERSIST_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  const routePath = raw['routePath']
  if (typeof routePath === 'string' && !isUsablePath(routePath)) drift.push('routePath')

  return drift
}
