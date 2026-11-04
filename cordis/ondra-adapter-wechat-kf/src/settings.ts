/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 为什么这里没有「降级话术」「去重窗口」「5 秒预算」
 *
 * 那三样是 O-060（公众号）为「微信打过来、5 秒必须应答」这条链路准备的。
 * 客服是拉取式：没有人掐着秒表等我，所以
 *
 * - 不需要 `degradeText`（没有「先回一句」的场合）；
 * - 不需要 `dedupeWindowMs`（游标天然只给一次，重复批次用 `seen` 兜底，随本轮清）；
 * - 不需要 `replyBudgetMs`（拉取轮次自己会让位，见 `pollMs`）。
 *
 * 留一份「看起来一样」的配置在这里，只会让调参的人以为它管用。
 *
 * ## 为什么 `callbackPath` 默认是空串
 *
 * 拉取式**不需要公网回调**——这正是客服比公众号好落地的原因。
 * 默认挂一条路由等于凭空要求用户开放端口，还多一个「忘记验签」的攻击面。
 * 只有用户明确要收事件（`enter_session` 之类）时才填它，填了才会挂路由、
 * 才会用上 `token` 做 sha1 验签。空串 = 不挂，不是「没配好」。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  CALLBACK_ROUTE_HINT,
  CHUNK_MAX,
  CHUNK_MIN,
  DEFAULT_API_BASE,
  DEFAULT_ROUTE_PATH,
  MAX_ROUNDS,
  ORIGIN_CUSTOMER,
  ORIGIN_MAX,
  ORIGIN_MIN,
  PAGE_LIMIT,
  PAGE_LIMIT_MAX,
  PERSONA_TIMEOUT_MAX,
  PERSONA_TIMEOUT_MIN,
  PERSONA_TIMEOUT_MS,
  POLL_MAX,
  POLL_MIN,
  POLL_MS,
  WINDOW_HOURS,
  WINDOW_MAX,
  WINDOW_MIN,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 拉取间隔（毫秒，默认 5000）。 */
  readonly pollMs: number
  /** 单批条数（默认 100）。 */
  readonly pageLimit: number
  /** 一轮最多连拉几批（默认 5）。 */
  readonly maxRounds: number
  /** 单条上限（100–800，默认 800：平台硬上限）。 */
  readonly chunkMax: number
  /** 会话窗口（小时，默认 48）。 */
  readonly windowHours: number
  /** 允许的外部联系人（空 = 不限）。 */
  readonly allowExternalUserIds: readonly string[]
  /** 屏蔽的外部联系人（优先于白名单）。 */
  readonly blockExternalUserIds: readonly string[]
  /** 允许的客服号 id（空 = 不限；一个企业多个客服号时用它限定）。 */
  readonly allowOpenKfIds: readonly string[]
  /** 回哪些来源码的消息（默认只回 3 = 微信客户）。 */
  readonly respondOrigins: readonly number[]
  /** 并发上限（同一批里同时跑几个回合）。 */
  readonly maxConcurrent: number
  /** 人格调用预算（毫秒）。卡住的一轮会让整条拉取链路停在 busy。 */
  readonly personaTimeoutMs: number
  /** 单次 HTTP 请求超时（毫秒）。 */
  readonly requestTimeoutMs: number
  /** 接口基址（换代理/网关时改这里）。 */
  readonly apiBase: string
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/wechat-kf.json`。 */
  readonly credentialFile: string
  /** 状态文件路径（游标 + seen + 窗口）；留空则推出 `…wechat-kf.state.json`。 */
  readonly stateFile: string
  /** 回调路径。**空串 = 不挂回调**（拉取式默认如此）。 */
  readonly callbackPath: string
  /** 游标与窗口状态是否落盘。 */
  readonly persist: boolean
  /** 落盘节流（毫秒）。 */
  readonly persistMs: number
  /** 每次拉取打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'wechat-kf'

/** 并发上限的上界：8。再多只是把模型打成 429。 */
export const CONCURRENCY_CEIL = 8

/** 一轮连拉批数的上界。 */
export const MAX_ROUNDS_CEIL = 20

/** 请求超时的上界。 */
export const REQUEST_TIMEOUT_CEIL = 60_000

/** 落盘节流默认值（毫秒）。 */
export const PERSIST_MS = 5_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  pollMs: 'poll-ms',
  pageLimit: 'page-limit',
  maxRounds: 'max-rounds',
  chunkMax: 'chunk-max',
  windowHours: 'window-hours',
  allowExternalUserIds: 'allow-external-user-ids',
  blockExternalUserIds: 'block-external-user-ids',
  allowOpenKfIds: 'allow-open-kf-ids',
  respondOrigins: 'respond-origins',
  maxConcurrent: 'max-concurrent',
  personaTimeoutMs: 'persona-timeout-ms',
  requestTimeoutMs: 'request-timeout-ms',
  apiBase: 'api-base',
  credentialFile: 'credential-file',
  stateFile: 'state-file',
  callbackPath: 'callback-path',
  persist: 'persist',
  persistMs: 'persist-ms',
  verbose: 'verbose',
})

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '通道开关。默认关：装上去就开始自动回复外部联系人，那是事故不是功能。',
  },
  pollMs: {
    kind: 'number',
    default: POLL_MS,
    min: POLL_MIN,
    max: POLL_MAX,
    doc: '拉取间隔（毫秒）。手册 §9.11 实测 5 秒；调小是在刷平台接口。',
  },
  pageLimit: {
    kind: 'number',
    default: PAGE_LIMIT,
    min: 1,
    max: PAGE_LIMIT_MAX,
    advancedOnly: true,
    doc: '单批条数。平台上限 1000，默认 100：一次拉太多会让一轮拖得很长。',
  },
  maxRounds: {
    kind: 'number',
    default: MAX_ROUNDS,
    min: 1,
    max: MAX_ROUNDS_CEIL,
    advancedOnly: true,
    doc: '一轮最多连拉几批。平台说「还有」时继续拉，但要有上限，否则积压会把一轮拖死。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（手册 §9.11 实测 800）。这是平台硬上限，只能往下调。',
  },
  windowHours: {
    kind: 'number',
    default: WINDOW_HOURS,
    min: WINDOW_MIN,
    max: WINDOW_MAX,
    doc: '会话窗口（小时）。窗口外主动发消息平台会拒，所以先在本端拒。',
  },
  allowExternalUserIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的外部联系人 id。空数组 = 不限。客服号是对外服务入口，留空等于谁都能触发她。',
  },
  blockExternalUserIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '屏蔽的外部联系人 id。优先于白名单：拉黑的人即使在白名单里也不回。',
  },
  allowOpenKfIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的客服号 id（wk...）。空数组 = 不限。一个企业挂多个客服号时用它限定只接哪一个。',
  },
  respondOrigins: {
    kind: 'json',
    default: Object.freeze([ORIGIN_CUSTOMER]) as readonly number[],
    doc: '回哪些来源码的消息。默认只回 3（微信客户）：不过滤就会回答接待人员自己的回复。',
  },
  maxConcurrent: {
    kind: 'number',
    default: 3,
    min: 1,
    max: CONCURRENCY_CEIL,
    advancedOnly: true,
    doc: '同一批里同时跑几个回合。同一会话永远串行，这个上限只管「不同的人」。',
  },
  personaTimeoutMs: {
    kind: 'number',
    default: PERSONA_TIMEOUT_MS,
    min: PERSONA_TIMEOUT_MIN,
    max: PERSONA_TIMEOUT_MAX,
    advancedOnly: true,
    doc: '人格调用预算。超时就取消这一条并继续下一批——卡住的一整轮会让拉取停在 busy。',
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
    doc: '接口基址。走代理或企业网关时改这里，不改代码。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用 user/channels/wechat-kf.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '游标与窗口状态文件绝对路径。留空则用 user/channels/wechat-kf.state.json。',
  },
  callbackPath: {
    kind: 'string',
    default: DEFAULT_ROUTE_PATH,
    pattern: '^(/[A-Za-z0-9._~/-]*)?$',
    advancedOnly: true,
    doc: '回调路径，例 ' + CALLBACK_ROUTE_HINT + '。留空 = 不挂回调（拉取式不需要公网，这是默认）。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '游标与窗口状态落盘。不落盘的话每次重启都会从头拉一遍（或漏掉整段）。',
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
    doc: '每次拉取打一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  pollMs: POLL_MS,
  pageLimit: PAGE_LIMIT,
  maxRounds: MAX_ROUNDS,
  chunkMax: CHUNK_MAX,
  windowHours: WINDOW_HOURS,
  allowExternalUserIds: Object.freeze([]) as readonly string[],
  blockExternalUserIds: Object.freeze([]) as readonly string[],
  allowOpenKfIds: Object.freeze([]) as readonly string[],
  respondOrigins: Object.freeze([ORIGIN_CUSTOMER]) as readonly number[],
  maxConcurrent: 3,
  personaTimeoutMs: PERSONA_TIMEOUT_MS,
  requestTimeoutMs: 8_000,
  apiBase: DEFAULT_API_BASE,
  credentialFile: '',
  stateFile: '',
  callbackPath: DEFAULT_ROUTE_PATH,
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
  title: '微信客服',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-wechat-kf',
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
 * 回调路径是否可用。**空串是合法值**（= 不挂回调）。
 *
 * 宿主 `register` 用 pathname 精确匹配、注释写明「无尾斜杠」，
 * 所以这里也拒尾斜杠：带了尾斜杠就是另一条路由，症状是「注册成功、请求 404」。
 * @param path 路径文本。
 */
export function isUsablePath(path: string): boolean {
  const text = path.trim()
  if (text === '') return true
  if (!text.startsWith('/')) return false
  if (text.length > 1 && text.endsWith('/')) return false
  if (text.includes('?') || text.includes('#')) return false
  return /^\/[A-Za-z0-9._~/-]*$/.test(text)
}

/**
 * 归一化 id 名单（外部联系人 / 客服号共用）。
 *
 * 这两个 id 都是大小写敏感的不透明串，**不做大小写折叠**：
 * 折叠会让两个不同的人塌成同一条记录，症状是「拉黑了一个人，另一个人也不回了」。
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
    if (text.length < 4 || text.length > 96 || /\s/.test(text)) {
      onBad(text)
      continue
    }
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
}

/**
 * 归一化来源码表。
 *
 * 空表不是一个可用的状态（谁都不回 = 通道装了个寂寞），所以空表回退默认值。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeOrigins(value: unknown, onBad: (text: string) => void): readonly number[] {
  if (!Array.isArray(value)) return Object.freeze([ORIGIN_CUSTOMER])
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      onBad(String(item))
      continue
    }
    const code = Math.trunc(item)
    if (code < ORIGIN_MIN || code > ORIGIN_MAX) {
      onBad(String(item))
      continue
    }
    if (!out.includes(code)) out.push(code)
  }
  if (out.length === 0) return Object.freeze([ORIGIN_CUSTOMER])
  return Object.freeze(out.sort((left, right) => left - right))
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

  const callbackPath = str('callbackPath', DEFAULT_CONFIG.callbackPath).trim()
  const apiBase = str('apiBase', DEFAULT_CONFIG.apiBase).trim()

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    pollMs: clampInt(raw['pollMs'], DEFAULT_CONFIG.pollMs, POLL_MIN, POLL_MAX),
    pageLimit: clampInt(raw['pageLimit'], DEFAULT_CONFIG.pageLimit, 1, PAGE_LIMIT_MAX),
    maxRounds: clampInt(raw['maxRounds'], DEFAULT_CONFIG.maxRounds, 1, MAX_ROUNDS_CEIL),
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_MAX),
    windowHours: clampInt(raw['windowHours'], DEFAULT_CONFIG.windowHours, WINDOW_MIN, WINDOW_MAX),
    allowExternalUserIds: normalizeIds(raw['allowExternalUserIds'], text => report(text, 'allowExternalUserIds')),
    blockExternalUserIds: normalizeIds(raw['blockExternalUserIds'], text => report(text, 'blockExternalUserIds')),
    allowOpenKfIds: normalizeIds(raw['allowOpenKfIds'], text => report(text, 'allowOpenKfIds')),
    respondOrigins: normalizeOrigins(raw['respondOrigins'], text => report(text, 'respondOrigins')),
    maxConcurrent: clampInt(raw['maxConcurrent'], DEFAULT_CONFIG.maxConcurrent, 1, CONCURRENCY_CEIL),
    personaTimeoutMs: clampInt(
      raw['personaTimeoutMs'],
      DEFAULT_CONFIG.personaTimeoutMs,
      PERSONA_TIMEOUT_MIN,
      PERSONA_TIMEOUT_MAX,
    ),
    requestTimeoutMs: clampInt(raw['requestTimeoutMs'], DEFAULT_CONFIG.requestTimeoutMs, 1_000, REQUEST_TIMEOUT_CEIL),
    apiBase: apiBase === '' ? DEFAULT_CONFIG.apiBase : apiBase.replace(/\/+$/, ''),
    credentialFile: str('credentialFile', DEFAULT_CONFIG.credentialFile).trim(),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile).trim(),
    callbackPath: isUsablePath(callbackPath) ? callbackPath : DEFAULT_CONFIG.callbackPath,
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
    ['pollMs', POLL_MIN, POLL_MAX],
    ['pageLimit', 1, PAGE_LIMIT_MAX],
    ['maxRounds', 1, MAX_ROUNDS_CEIL],
    ['chunkMax', CHUNK_MIN, CHUNK_MAX],
    ['windowHours', WINDOW_MIN, WINDOW_MAX],
    ['maxConcurrent', 1, CONCURRENCY_CEIL],
    ['personaTimeoutMs', PERSONA_TIMEOUT_MIN, PERSONA_TIMEOUT_MAX],
    ['requestTimeoutMs', 1_000, REQUEST_TIMEOUT_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  const callbackPath = raw['callbackPath']
  if (typeof callbackPath === 'string' && !isUsablePath(callbackPath)) drift.push('callbackPath')

  return drift
}
