/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 为什么去重窗口默认 10 分钟
 *
 * 钉钉在没收到 2xx 响应时会重投同一条消息，但**重投档位在仓内查不到依据**
 * （手册没有钉钉专章，master-plan §9.11 只给了「先回 empty」四个字）。
 * 既然我们一律回 200 空体，重投本来就极罕见；10 分钟足以覆盖「响应丢了、
 * 平台又重发了一次」这种情形，同时不会让 `seen` 表在一天里涨到几万条。
 * 若真实重投间隔更长，改这一个数即可。**这条已登记待裁决。**
 *
 * ## 为什么 `replyVia` 默认 `auto`
 *
 * `sessionWebhook` 是最快、最省事的出口（不用换 token），但它**有有效期**。
 * 写死 `session` 会让「回复慢了一点」变成「发不出去」；写死 `active` 则
 * 每句话都要多换一次 token，且要求填 `appKey`。`auto` 才是产品要的行为：
 * 没过期就走快速的，过期了就换另一条。两个显式值留给排查用。
 *
 * ## 为什么 `signSkewMs` 要暴露出来
 *
 * 时间戳容差是「防重放」与「容忍时钟漂移」之间的一根杠杆：给得太小，
 * 对方服务器慢两分钟就全被判伪；给得太大，重放窗口就跟着变大。
 * 1 小时是公开文档口径，但机器时钟没对时的情况真实存在，所以做成配置。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  CHUNK_MAX,
  CHUNK_MIN,
  DEFAULT_API_BASE,
  DEFAULT_ROUTE_PATH,
  SIGN_SKEW_MS,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 路由路径（挂在宿主 webServer 上的绝对 pathname）。 */
  readonly routePath: string
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/dingtalk.json`。 */
  readonly credentialFile: string
  /** 状态文件路径；留空则推出 `…dingtalk.state.json`。 */
  readonly stateFile: string
  /** 单条上限（100–4000，默认 4000：平台实测值）。 */
  readonly chunkMax: number
  /** 允许的发信人 id（空 = 不限）。 */
  readonly allowSenderIds: readonly string[]
  /** 屏蔽的发信人 id（优先于白名单）。 */
  readonly blockSenderIds: readonly string[]
  /** 去重窗口（毫秒，默认 10 分钟）。 */
  readonly dedupeWindowMs: number
  /** 并发上限（同时跑几个回合）。 */
  readonly maxConcurrent: number
  /** 单次 HTTP 请求超时（毫秒）。 */
  readonly requestTimeoutMs: number
  /** 接口基址（换代理/内网网关时改这里）。 */
  readonly apiBase: string
  /** 回信走哪条出口。 */
  readonly replyVia: 'auto' | 'session' | 'active'
  /** 验签的时间戳容差（毫秒）。 */
  readonly signSkewMs: number
  /** 去重状态是否落盘。 */
  readonly persist: boolean
  /** 落盘节流（毫秒）。 */
  readonly persistMs: number
  /** 每次发送打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'dingtalk'

/** 去重窗口下界：1 分钟。 */
export const DEDUPE_FLOOR = 60_000

/** 去重窗口上界：24 小时。 */
export const DEDUPE_CEIL = 86_400_000

/** 去重窗口默认值：10 分钟。 */
export const DEDUPE_DEFAULT = 600_000

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

/** 时间戳容差下界：1 分钟。 */
export const SKEW_FLOOR = 60_000

/** 时间戳容差上界：24 小时。 */
export const SKEW_CEIL = 86_400_000

/** 三种出口取值（枚举字段的唯一真源）。 */
export const REPLY_VIA_VALUES = ['auto', 'session', 'active'] as const

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  routePath: 'route-path',
  credentialFile: 'credential-file',
  stateFile: 'state-file',
  chunkMax: 'chunk-max',
  allowSenderIds: 'allow-sender-ids',
  blockSenderIds: 'block-sender-ids',
  dedupeWindowMs: 'dedupe-window-ms',
  maxConcurrent: 'max-concurrent',
  requestTimeoutMs: 'request-timeout-ms',
  apiBase: 'api-base',
  replyVia: 'reply-via',
  signSkewMs: 'sign-skew-ms',
  persist: 'persist',
  persistMs: 'persist-ms',
  verbose: 'verbose',
})

/**
 * Config 键（camel）→ 段字段键（kebab）的查表版。
 *
 * 用 `Map` 而不是直接下标：`KEY_PAIRS[key]` 的类型是 `string`（不是 `string | undefined`），
 * 后面接 `?? key` 会被 TS 判成「右操作数不可达」。`Map.get()` 天然带 `undefined`，
 * 这一处差别决定了要不要为了一行代码去改编译选项。
 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '通道开关。默认关：一个钉钉机器人装上去就开始回消息，那是事故不是功能。',
  },
  routePath: {
    kind: 'string',
    default: DEFAULT_ROUTE_PATH,
    pattern: '^/[A-Za-z0-9._~/-]*$',
    doc: '挂在宿主 webServer 上的路径。钉钉开发者后台「机器人 → 消息接收模式 → HTTP 推送」填 https://<你的域名><routePath>。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用 user/channels/dingtalk.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '去重状态文件绝对路径。留空则用 user/channels/dingtalk.state.json。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（master-plan §9.11 实测 4000）。这是平台实测上限，只能往下调。',
  },
  allowSenderIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的发信人 staffId / senderId。空数组 = 不限（组织内谁都能触发她）。',
  },
  blockSenderIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '屏蔽的发信人。优先于白名单。',
  },
  dedupeWindowMs: {
    kind: 'number',
    default: DEDUPE_DEFAULT,
    min: DEDUPE_FLOOR,
    max: DEDUPE_CEIL,
    doc: '去重窗口。回 200 空体之后平台重投极罕见，10 分钟够用；真实档位仓内无依据。',
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
  replyVia: {
    kind: 'enum',
    values: REPLY_VIA_VALUES,
    default: 'auto',
    doc: '回信出口：auto=先试 sessionWebhook、过期走主动接口；session=只走第一条；active=只走主动接口（排查用）。',
  },
  signSkewMs: {
    kind: 'number',
    default: SIGN_SKEW_MS,
    min: SKEW_FLOOR,
    max: SKEW_CEIL,
    advancedOnly: true,
    doc: '验签的时间戳容差。机器时钟没对时会全被判伪——那时把这里放大。',
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
  allowSenderIds: Object.freeze([]) as readonly string[],
  blockSenderIds: Object.freeze([]) as readonly string[],
  dedupeWindowMs: DEDUPE_DEFAULT,
  maxConcurrent: 3,
  requestTimeoutMs: 8_000,
  apiBase: DEFAULT_API_BASE,
  replyVia: 'auto',
  signSkewMs: SIGN_SKEW_MS,
  persist: true,
  persistMs: PERSIST_MS,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 段字段键（kebab）→ Config 键（camel）的查表版。理由同 `KEY_MAP`。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '钉钉',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-dingtalk',
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
    out[KEY_MAP.get(key) ?? key] = value
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
    out[SECTION_MAP.get(key) ?? key] = value
  }
  return out
}

/**
 * 路由路径是否合法。
 *
 * 宿主 `register` 用 pathname 精确匹配、且注释写明「无尾斜杠」，所以这里也拒尾斜杠：
 * 带了尾斜杠就是另一条路由，症状是「注册成功、钉钉请求 404」。
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
 * 归一化发信人名单。
 *
 * `staffId` 与 `senderId`（`$:LWCP_v1:$…`）**都不做大小写折叠**：
 * 折叠会让两个不同的人塌成同一条记录。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeIds(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (text.length < 3 || text.length > 96 || /\s/.test(text)) {
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
 * 把任意值归一成三种出口之一。
 * @param value 原始值。
 */
export function replyViaOf(value: unknown): 'auto' | 'session' | 'active' {
  return value === 'session' || value === 'active' || value === 'auto' ? value : 'auto'
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
    allowSenderIds: normalizeIds(raw['allowSenderIds'], text => report(text, 'allowSenderIds')),
    blockSenderIds: normalizeIds(raw['blockSenderIds'], text => report(text, 'blockSenderIds')),
    dedupeWindowMs: clampInt(raw['dedupeWindowMs'], DEFAULT_CONFIG.dedupeWindowMs, DEDUPE_FLOOR, DEDUPE_CEIL),
    maxConcurrent: clampInt(raw['maxConcurrent'], DEFAULT_CONFIG.maxConcurrent, 1, CONCURRENCY_CEIL),
    requestTimeoutMs: clampInt(
      raw['requestTimeoutMs'],
      DEFAULT_CONFIG.requestTimeoutMs,
      REQUEST_TIMEOUT_FLOOR,
      REQUEST_TIMEOUT_CEIL,
    ),
    apiBase: apiBase === '' ? DEFAULT_CONFIG.apiBase : apiBase.replace(/\/+$/, ''),
    replyVia: replyViaOf(raw['replyVia']),
    signSkewMs: clampInt(raw['signSkewMs'], DEFAULT_CONFIG.signSkewMs, SKEW_FLOOR, SKEW_CEIL),
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
    ['signSkewMs', SKEW_FLOOR, SKEW_CEIL],
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

  const via = raw['replyVia']
  if (via !== undefined && !REPLY_VIA_VALUES.includes(via as 'auto' | 'session' | 'active')) {
    drift.push('replyVia')
  }

  return drift
}
