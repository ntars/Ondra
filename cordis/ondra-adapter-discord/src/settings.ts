/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 为什么这里有 `requestTimeoutMs`（而 Telegram 没有）
 *
 * O-066 那边刻意**不**给独立的 HTTP 超时字段，只给「附加余量」，
 * 因为长轮询的请求会故意挂住 50 秒，独立超时必然被填成 8000 → 每轮都超时。
 *
 * Discord 的 REST 是一次普通 HTTP，**不会故意挂住**，所以这里独立给
 * `requestTimeoutMs` 是对的。判定规则只有一句：
 *
 * > **这个请求会不会故意挂住？会 → 超时由别的参数派生；不会 → 独立给值。**
 *
 * 照抄 O-066 的「余量式」会得到一个 5 秒的 HTTP 超时（没有轮询超时可加），
 * 发长消息必然失败；照抄本包的「独立式」到 Telegram 会得到每轮超时。
 * 两个方向都试过，所以这条规则写在这里而不是各包各记一句。
 *
 * ## 为什么 `stopOnCodes` 是名单而不是内置表
 *
 * 手册只点名了 `4004`（鉴权失败）一个「停止重连」码。Discord 另有一组
 * 4010–4014（参数/分片/版本错）同样不可重连，但**仓内无依据**，不写死。
 * 名单由用户追加，缺省为空——这个方向的错更安全：
 * 「本该停的还在重连」会在面板上表现为持续重连（看得见），
 * 「本该连的停了」表现为安静（看不见）。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  AUTH_CLOSE_CODE,
  CHUNK_MAX,
  CHUNK_MIN,
  CONCURRENCY_CEIL,
  DEFAULT_API_BASE,
  RECONNECT_CEIL,
  RECONNECT_FLOOR,
  RECONNECT_MS,
  REQUEST_CEIL,
  REQUEST_FLOOR,
  REQUEST_TIMEOUT_MS,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/discord.json`。 */
  readonly credentialFile: string
  /** 单条上限（100–1900，默认 1900）。 */
  readonly chunkMax: number
  /** REST 基址（换代理时改这里，不改代码）。 */
  readonly apiBase: string
  /** REST 超时（毫秒，默认 15000）。 */
  readonly requestTimeoutMs: number
  /** 重连间隔（毫秒，默认 5000）。 */
  readonly reconnectMs: number
  /** 除 4004 之外「不再重连」的关闭码名单。 */
  readonly stopOnCodes: readonly number[]
  /** 并发上限（同时跑几个回合）。 */
  readonly maxConcurrent: number
  /** 允许的发信人 id（空 = 不限）。 */
  readonly allowSenderIds: readonly string[]
  /** 屏蔽的发信人 id（优先于白名单）。 */
  readonly blockSenderIds: readonly string[]
  /** 静默窗口时长（毫秒）：排队超过它的消息直接丢弃。 */
  readonly queueTtlMs: number
  /** 每次发送打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'discord'

/** 落盘节流上界（毫秒）。本插件不落盘，此常量只用于 `queueTtlMs` 上界。 */
export const QUEUE_TTL_CEIL = 3_600_000

/** `queueTtlMs` 下界（毫秒）：30 秒。低于它就是「刚排队就过期」。 */
export const QUEUE_TTL_FLOOR = 30_000

/** 排队的默认存活时长（毫秒）：5 分钟。 */
export const QUEUE_TTL_MS = 300_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  credentialFile: 'credential-file',
  chunkMax: 'chunk-max',
  apiBase: 'api-base',
  requestTimeoutMs: 'request-timeout-ms',
  reconnectMs: 'reconnect-ms',
  stopOnCodes: 'stop-on-codes',
  maxConcurrent: 'max-concurrent',
  allowSenderIds: 'allow-sender-ids',
  blockSenderIds: 'block-sender-ids',
  queueTtlMs: 'queue-ttl-ms',
  verbose: 'verbose',
})

/**
 * 查表版。用 `Map` 而不是直接下标：`KEY_PAIRS[key]` 的类型是 `string`，
 * 后面接 `?? key` 会被 TS 判成「右操作数不可达」；`Map.get()` 天然带 `undefined`。
 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '通道开关。默认关：装上就连 WS 并回消息，那是事故不是功能。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用 user/channels/discord.json（0600）。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（master-plan §9.11 实测 1900）。只能往下调。',
  },
  apiBase: {
    kind: 'string',
    default: DEFAULT_API_BASE,
    advancedOnly: true,
    doc: 'REST 基址（Discord API v10）。走代理时改这里。',
  },
  requestTimeoutMs: {
    kind: 'number',
    default: REQUEST_TIMEOUT_MS,
    min: REQUEST_FLOOR,
    max: REQUEST_CEIL,
    advancedOnly: true,
    doc: 'REST 超时。Discord 的 REST 不会故意挂住，所以独立给值（与长轮询相反）。',
  },
  reconnectMs: {
    kind: 'number',
    default: RECONNECT_MS,
    min: RECONNECT_FLOOR,
    max: RECONNECT_CEIL,
    doc: '重连间隔（§9.11 原话「其余 5s」）。固定值，不做指数——指数会让一次抖动变成几分钟沉默。',
  },
  stopOnCodes: {
    kind: 'json',
    default: Object.freeze([]) as readonly number[],
    advancedOnly: true,
    doc: '除 4004 外「不再重连」的关闭码。手册只点名 4004，其余码无依据，故出厂为空。',
  },
  maxConcurrent: {
    kind: 'number',
    default: 3,
    min: 1,
    max: CONCURRENCY_CEIL,
    doc: '并发上限。一次涌进几十条时不该开几十个模型请求。',
  },
  allowSenderIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的发信人 id（Discord 用户 id 是雪花号，十进制字符串）。空数组 = 不限。',
  },
  blockSenderIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '屏蔽的发信人。优先于白名单。',
  },
  queueTtlMs: {
    kind: 'number',
    default: QUEUE_TTL_MS,
    min: QUEUE_TTL_FLOOR,
    max: QUEUE_TTL_CEIL,
    advancedOnly: true,
    doc: '排队的存活时长。超过就丢——五分钟后才答的那句话已经不是回答。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每条事件打一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  credentialFile: '',
  chunkMax: CHUNK_MAX,
  apiBase: DEFAULT_API_BASE,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  reconnectMs: RECONNECT_MS,
  stopOnCodes: Object.freeze([]) as readonly number[],
  maxConcurrent: 3,
  allowSenderIds: Object.freeze([]) as readonly string[],
  blockSenderIds: Object.freeze([]) as readonly string[],
  queueTtlMs: QUEUE_TTL_MS,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 查表版。理由同 `KEY_MAP`。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: 'Discord',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-discord',
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
 * 归一化 id 名单。
 *
 * Discord 的雪花 id 是 17–20 位十进制数，常被人当数字填、也会被表格软件
 * 转成浮点（精度丢在末位）。两种都收，但浮点输入直接丢弃并报告——
 * 悄悄截断会得到一个「永远匹配不上」的白名单，比报错更难查。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeIds(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'number') {
      // 超过 2^53 的数字在 JS 里已经不是原值了，收了也是错的。
      if (!Number.isSafeInteger(item) || item <= 0) {
        onBad(String(item))
        continue
      }
      const text = String(item)
      if (!out.includes(text)) out.push(text)
      continue
    }
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (!/^\d{1,20}$/.test(text)) {
      onBad(text)
      continue
    }
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
}

/**
 * 归一化关闭码名单。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeCodes(value: unknown, onBad: (text: string) => void): readonly number[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1000 || item > 9999) {
      onBad(String(item))
      continue
    }
    if (item === AUTH_CLOSE_CODE) continue
    if (!out.includes(item)) out.push(item)
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

  const apiBase = str('apiBase', DEFAULT_CONFIG.apiBase).trim()

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    credentialFile: str('credentialFile', DEFAULT_CONFIG.credentialFile).trim(),
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_MAX),
    apiBase: apiBase === '' ? DEFAULT_CONFIG.apiBase : apiBase.replace(/\/+$/, ''),
    requestTimeoutMs: clampInt(raw['requestTimeoutMs'], DEFAULT_CONFIG.requestTimeoutMs, REQUEST_FLOOR, REQUEST_CEIL),
    reconnectMs: clampInt(raw['reconnectMs'], DEFAULT_CONFIG.reconnectMs, RECONNECT_FLOOR, RECONNECT_CEIL),
    stopOnCodes: normalizeCodes(raw['stopOnCodes'], text => report(text, 'stopOnCodes')),
    maxConcurrent: clampInt(raw['maxConcurrent'], DEFAULT_CONFIG.maxConcurrent, 1, CONCURRENCY_CEIL),
    allowSenderIds: normalizeIds(raw['allowSenderIds'], text => report(text, 'allowSenderIds')),
    blockSenderIds: normalizeIds(raw['blockSenderIds'], text => report(text, 'blockSenderIds')),
    queueTtlMs: clampInt(raw['queueTtlMs'], DEFAULT_CONFIG.queueTtlMs, QUEUE_TTL_FLOOR, QUEUE_TTL_CEIL),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（越界值被夹紧）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['chunkMax', CHUNK_MIN, CHUNK_MAX],
    ['requestTimeoutMs', REQUEST_FLOOR, REQUEST_CEIL],
    ['reconnectMs', RECONNECT_FLOOR, RECONNECT_CEIL],
    ['maxConcurrent', 1, CONCURRENCY_CEIL],
    ['queueTtlMs', QUEUE_TTL_FLOOR, QUEUE_TTL_CEIL],
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
