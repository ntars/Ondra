/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 为什么这里的默认值和 QQ 那两路完全不一样
 *
 * 手册 §5.3 的六道闸标题写的是「QQ 防封控」：令牌桶 20/200/1500、会话冷却 5s/3s、
 * 深夜静默——它们解决的是「主动发言太频繁」这件事。公众号**没有主动发言能力**：
 * 48 小时窗口之外发不出去，窗口之内也只能对刚刚说过话的人回。
 *
 * 把 QQ 的阈值搬过来，得到的不是更安全，而是「微信这边莫名其妙被限流」；
 * 而真正会出事的两个数（**5 秒硬限**、**48 小时窗口**）反倒容易被忽略。
 * 所以本插件的配置只压这两件事，外加一个并发上限（防一次涌进 100 条时开 100 个模型请求）。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  CHUNK_MAX,
  CHUNK_MIN,
  DEFAULT_API_BASE,
  DEFAULT_REPLY_BUDGET_MS,
  DEFAULT_ROUTE_PATH,
  MESSAGE_WINDOW_HOURS,
  REPLY_BUDGET_MAX,
  REPLY_BUDGET_MIN,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 路由路径（挂在宿主 webServer 上的绝对 pathname）。 */
  readonly routePath: string
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/wechat-official.json`。 */
  readonly credentialFile: string
  /** 状态文件路径（48h 窗口 + 去重表）；留空则推出 `…wechat-official.state.json`。 */
  readonly stateFile: string
  /** 单条上限（100–800，默认 800：平台硬上限）。 */
  readonly chunkMax: number
  /** 允许的 openid（空 = 不限，所有关注者都能触发）。 */
  readonly allowOpenIds: readonly string[]
  /** 屏蔽的 openid（优先于白名单）。 */
  readonly blockOpenIds: readonly string[]
  /** 5 秒超时时回的那句话。 */
  readonly degradeText: string
  /** 回复预算（毫秒，默认 4400：硬限 5000 留 600ms 写响应）。 */
  readonly replyBudgetMs: number
  /** 等一次人格回复的超时（毫秒）。排队消息没有 5 秒硬限，走这个值。 */
  readonly replyTimeoutMs: number
  /** 客服消息窗口（小时，默认 48）。 */
  readonly windowHours: number
  /** 去重窗口（毫秒）：微信在 5 秒内没收到响应会重试三次。 */
  readonly dedupeWindowMs: number
  /** 并发上限（同时跑几个回合）。 */
  readonly maxConcurrent: number
  /** 单次 HTTP 请求超时（毫秒）。 */
  readonly requestTimeoutMs: number
  /** 微信接口基址（换代理/网关时改这里）。 */
  readonly apiBase: string
  /** 窗口与去重状态是否落盘。 */
  readonly persist: boolean
  /** 落盘节流（毫秒）。 */
  readonly persistMs: number
  /** 每次发送打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'wechat-official'

/** 去重窗口上界：24 小时。 */
export const DEDUPE_CEIL = 86_400_000

/** 去重窗口下界：1 分钟（再短挡不住微信的重试）。 */
export const DEDUPE_FLOOR = 60_000

/** 并发上限上界：16。再多也只是把模型打成 429。 */
export const CONCURRENCY_CEIL = 16

/** 请求超时上界：60 秒。 */
export const REQUEST_TIMEOUT_CEIL = 60_000

/** 窗口小时数的下界：1。 */
export const WINDOW_MIN = 1

/** 窗口小时数的上界：72（公众号是 48，留出余量给别的号型）。 */
export const WINDOW_MAX = 72

/** 落盘节流默认值（毫秒）。 */
export const PERSIST_MS = 5_000

/** 排队消息等人格回复的超时默认值（毫秒）。与 QQ 两路同口径：60 秒。 */
export const REPLY_TIMEOUT_MS = 60_000

/** 默认降级话术。 */
export const DEFAULT_DEGRADE_TEXT = '我在呢，等我一下下。'

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  routePath: 'route-path',
  credentialFile: 'credential-file',
  stateFile: 'state-file',
  chunkMax: 'chunk-max',
  allowOpenIds: 'allow-open-ids',
  blockOpenIds: 'block-open-ids',
  degradeText: 'degrade-text',
  replyBudgetMs: 'reply-budget-ms',
  replyTimeoutMs: 'reply-timeout-ms',
  windowHours: 'window-hours',
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
    doc: '通道开关。默认关：一个公众号装上去就开始回应关注者，那是事故不是功能。',
  },
  routePath: {
    kind: 'string',
    default: DEFAULT_ROUTE_PATH,
    pattern: '^/[A-Za-z0-9._~/-]*$',
    doc: '挂在宿主 webServer 上的路径。公众号后台「服务器地址」填 https://<你的域名><routePath>。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用 user/channels/wechat-official.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '窗口与去重状态文件绝对路径。留空则用 user/channels/wechat-official.state.json。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（手册 §9.11 实测 800）。这是平台硬上限，只能往下调。',
  },
  allowOpenIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的 openid。空数组 = 不限（所有关注者都能触发她）——公众号是公开入口，请想清楚再留空。',
  },
  blockOpenIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '屏蔽的 openid。优先于白名单：拉黑的人即使在白名单里也不回。',
  },
  degradeText: {
    kind: 'string',
    default: DEFAULT_DEGRADE_TEXT,
    doc: '5 秒超时时先回的那句话。它必须短、必须像人话、不能承诺具体时间。',
  },
  replyBudgetMs: {
    kind: 'number',
    default: DEFAULT_REPLY_BUDGET_MS,
    min: REPLY_BUDGET_MIN,
    max: REPLY_BUDGET_MAX,
    doc: '回复预算。硬限 5000ms，这里最多 4900：5 秒是从收到请求开始算的。',
  },
  replyTimeoutMs: {
    kind: 'number',
    default: REPLY_TIMEOUT_MS,
    min: 5_000,
    max: 600_000,
    advancedOnly: true,
    doc: '等一次人格回复的超时（排队消息用，没有 5 秒硬限）。超时只中止本轮，不换模型不重试。',
  },
  windowHours: {
    kind: 'number',
    default: MESSAGE_WINDOW_HOURS,
    min: WINDOW_MIN,
    max: WINDOW_MAX,
    doc: '客服消息窗口（手册 §9.11：48 小时）。窗口外平台会拒，所以先在本端拒。',
  },
  dedupeWindowMs: {
    kind: 'number',
    default: 1_800_000,
    min: DEDUPE_FLOOR,
    max: DEDUPE_CEIL,
    doc: '去重窗口。微信没在 5 秒内收到响应会重试三次，不认出来就会答三遍。',
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
    min: 1_000,
    max: REQUEST_TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '单次 HTTP 请求超时。',
  },
  apiBase: {
    kind: 'string',
    default: DEFAULT_API_BASE,
    advancedOnly: true,
    doc: '微信接口基址。走代理或企业网关时改这里，不改代码。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '窗口与去重状态落盘。不落盘的话重启后「刚说过话的人」会被当成窗口外。',
  },
  persistMs: {
    kind: 'number',
    default: PERSIST_MS,
    min: 1_000,
    max: 60_000,
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
  allowOpenIds: Object.freeze([]) as readonly string[],
  blockOpenIds: Object.freeze([]) as readonly string[],
  degradeText: DEFAULT_DEGRADE_TEXT,
  replyBudgetMs: DEFAULT_REPLY_BUDGET_MS,
  replyTimeoutMs: REPLY_TIMEOUT_MS,
  windowHours: MESSAGE_WINDOW_HOURS,
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
  title: '微信公众号',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-wechat-official',
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
 * 带了尾斜杠就是另一条路由，症状是「注册成功、微信请求 404」。
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
 * 归一化 openid 名单。
 *
 * openid 是 28 位左右的大小写敏感字符串（含 `-` 与 `_`），**不做大小写折叠**：
 * 折叠会让两个不同的人塌成同一条记录，症状是「拉黑了一个人，另一个人也不回了」。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeOpenIds(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (text.length < 8 || text.length > 64 || /\s/.test(text)) {
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
  const raw = isRecord(value) ? value : {}
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
  const degradeText = str('degradeText', DEFAULT_CONFIG.degradeText).trim()
  const apiBase = str('apiBase', DEFAULT_CONFIG.apiBase).trim()

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    routePath: isUsablePath(routePath) ? routePath : DEFAULT_CONFIG.routePath,
    credentialFile: str('credentialFile', DEFAULT_CONFIG.credentialFile).trim(),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile).trim(),
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_MAX),
    allowOpenIds: normalizeOpenIds(raw['allowOpenIds'], text => report(text, 'allowOpenIds')),
    blockOpenIds: normalizeOpenIds(raw['blockOpenIds'], text => report(text, 'blockOpenIds')),
    // 空话术回退默认：5 秒超时时回一个空 body，微信会当成「没收到」继续重试。
    degradeText: degradeText === '' ? DEFAULT_CONFIG.degradeText : degradeText,
    replyBudgetMs: clampInt(raw['replyBudgetMs'], DEFAULT_CONFIG.replyBudgetMs, REPLY_BUDGET_MIN, REPLY_BUDGET_MAX),
    replyTimeoutMs: clampInt(raw['replyTimeoutMs'], DEFAULT_CONFIG.replyTimeoutMs, 5_000, 600_000),
    windowHours: clampInt(raw['windowHours'], DEFAULT_CONFIG.windowHours, WINDOW_MIN, WINDOW_MAX),
    dedupeWindowMs: clampInt(raw['dedupeWindowMs'], DEFAULT_CONFIG.dedupeWindowMs, DEDUPE_FLOOR, DEDUPE_CEIL),
    maxConcurrent: clampInt(raw['maxConcurrent'], DEFAULT_CONFIG.maxConcurrent, 1, CONCURRENCY_CEIL),
    requestTimeoutMs: clampInt(raw['requestTimeoutMs'], DEFAULT_CONFIG.requestTimeoutMs, 1_000, REQUEST_TIMEOUT_CEIL),
    apiBase: apiBase === '' ? DEFAULT_CONFIG.apiBase : apiBase.replace(/\/+$/, ''),
    persist: bool('persist', DEFAULT_CONFIG.persist),
    persistMs: clampInt(raw['persistMs'], DEFAULT_CONFIG.persistMs, 1_000, 60_000),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['chunkMax', CHUNK_MIN, CHUNK_MAX],
    ['replyBudgetMs', REPLY_BUDGET_MIN, REPLY_BUDGET_MAX],
    ['windowHours', WINDOW_MIN, WINDOW_MAX],
    ['dedupeWindowMs', DEDUPE_FLOOR, DEDUPE_CEIL],
    ['maxConcurrent', 1, CONCURRENCY_CEIL],
    ['requestTimeoutMs', 1_000, REQUEST_TIMEOUT_CEIL],
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

  const degradeText = raw['degradeText']
  if (typeof degradeText === 'string' && degradeText.trim() === '') drift.push('degradeText')

  return drift
}
