/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 为什么 `requestPaddingMs` 是「附加余量」而不是「总超时」
 *
 * 长轮询的请求会**故意挂住 `pollTimeoutSec` 秒**。如果 `requestTimeoutMs` 写成一个
 * 独立的值，用户很自然地填 8000（跟别的通道一样），于是每一轮都在第 8 秒
 * 被自己掐断——面板上全是 `timeout`，看起来像「Telegram 挂了」。
 *
 * 所以这里**没有** `requestTimeoutMs` 字段，只有 `requestPaddingMs`：
 * 实际超时 = `pollTimeoutSec × 1000 + requestPaddingMs`，由
 * `requestTimeoutOf()` **一处**算出。两个数之间的关系写进类型，而不是写进文档。
 *
 * ## 为什么退避是固定 3 秒（`backoffMs` 可配但不做指数）
 *
 * master-plan §9.11 的原话是「失败 3s 退避」。长轮询本身已经是一个 50 秒的慢循环，
 * 失败时的 3 秒只是「别把对方打爆」的礼貌间隔。做成指数退避会让一次网络抖动
 * 之后通道安静几分钟——用户看到的是「她突然不理我了」，而不是「网络不好」。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  BACKOFF_CEIL,
  BACKOFF_FLOOR,
  BACKOFF_MS,
  CHUNK_MAX,
  CHUNK_MIN,
  DEFAULT_API_BASE,
  POLL_TIMEOUT_CEIL,
  POLL_TIMEOUT_FLOOR,
  POLL_TIMEOUT_SEC,
  REQUEST_PADDING_MS,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/telegram.json`。 */
  readonly credentialFile: string
  /** 状态文件路径（offset + 兜底去重表）；留空则推出 `…telegram.state.json`。 */
  readonly stateFile: string
  /** 单条上限（100–4000，默认 4000）。 */
  readonly chunkMax: number
  /** 长轮询超时（秒，1–50，默认 50）。 */
  readonly pollTimeoutSec: number
  /** 失败退避（毫秒，默认 3000）。 */
  readonly backoffMs: number
  /** 并发上限（同时跑几个回合）。 */
  readonly maxConcurrent: number
  /** 请求超时的附加余量（毫秒）：实际超时 = 轮询超时 + 它。 */
  readonly requestPaddingMs: number
  /** 接口基址（换代理/内网网关时改这里）。 */
  readonly apiBase: string
  /** 允许的发信人 id（空 = 不限）。 */
  readonly allowSenderIds: readonly string[]
  /** 屏蔽的发信人 id（优先于白名单）。 */
  readonly blockSenderIds: readonly string[]
  /** 状态是否落盘。 */
  readonly persist: boolean
  /** 落盘节流（毫秒）。 */
  readonly persistMs: number
  /** 每次发送打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'telegram'

/** 并发上限上界：16。再多也只是把模型打成 429。 */
export const CONCURRENCY_CEIL = 16

/** 附加余量的下界（毫秒）：5 秒。 */
export const PADDING_FLOOR = 5_000

/** 附加余量的上界（毫秒）：60 秒。 */
export const PADDING_CEIL = 60_000

/** 落盘节流默认值（毫秒）。 */
export const PERSIST_MS = 5_000

/** 落盘节流上界（毫秒）。 */
export const PERSIST_CEIL = 60_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  credentialFile: 'credential-file',
  stateFile: 'state-file',
  chunkMax: 'chunk-max',
  pollTimeoutSec: 'poll-timeout-sec',
  backoffMs: 'backoff-ms',
  maxConcurrent: 'max-concurrent',
  requestPaddingMs: 'request-padding-ms',
  apiBase: 'api-base',
  allowSenderIds: 'allow-sender-ids',
  blockSenderIds: 'block-sender-ids',
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
    doc: '通道开关。默认关：装上就开始轮询并回消息，那是事故不是功能。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用 user/channels/telegram.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '状态文件绝对路径（offset 与兜底去重表）。留空则用 user/channels/telegram.state.json。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（master-plan §9.11 实测 4000）。只能往下调。',
  },
  pollTimeoutSec: {
    kind: 'number',
    default: POLL_TIMEOUT_SEC,
    min: POLL_TIMEOUT_FLOOR,
    max: POLL_TIMEOUT_CEIL,
    doc: '长轮询超时（§9.11 原话 timeout 50）。Telegram 官方上限就是 50，往上调没有意义。',
  },
  backoffMs: {
    kind: 'number',
    default: BACKOFF_MS,
    min: BACKOFF_FLOOR,
    max: BACKOFF_CEIL,
    doc: '失败退避（§9.11 原话 3 秒）。固定值，不做指数——指数会让一次抖动变成几分钟的沉默。',
  },
  maxConcurrent: {
    kind: 'number',
    default: 3,
    min: 1,
    max: CONCURRENCY_CEIL,
    doc: '并发上限。一次涌进 100 条时不该开 100 个模型请求。',
  },
  requestPaddingMs: {
    kind: 'number',
    default: REQUEST_PADDING_MS,
    min: PADDING_FLOOR,
    max: PADDING_CEIL,
    advancedOnly: true,
    doc: 'HTTP 超时的附加余量：实际超时 = 轮询超时 + 它。填小了会每轮都超时。',
  },
  apiBase: {
    kind: 'string',
    default: DEFAULT_API_BASE,
    advancedOnly: true,
    doc: '接口基址。走代理或内网网关时改这里，不改代码。',
  },
  allowSenderIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的发信人 id（Telegram 用户 id 的十进制字符串）。空数组 = 不限。',
  },
  blockSenderIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '屏蔽的发信人。优先于白名单。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '状态落盘。不落盘的话重启会从「最早的更新」重新拉一遍——那是一场灾难。',
  },
  persistMs: {
    kind: 'number',
    default: PERSIST_MS,
    min: 1_000,
    max: PERSIST_CEIL,
    advancedOnly: true,
    doc: '落盘节流。offset 变化后会立刻写一次，这个只管家跳。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每轮拉取打一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  credentialFile: '',
  stateFile: '',
  chunkMax: CHUNK_MAX,
  pollTimeoutSec: POLL_TIMEOUT_SEC,
  backoffMs: BACKOFF_MS,
  maxConcurrent: 3,
  requestPaddingMs: REQUEST_PADDING_MS,
  apiBase: DEFAULT_API_BASE,
  allowSenderIds: Object.freeze([]) as readonly string[],
  blockSenderIds: Object.freeze([]) as readonly string[],
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
  title: 'Telegram',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-telegram',
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
 * 归一化发信人名单。
 *
 * Telegram 的用户 id 是十进制数字字符串，也可能被人填成数字——两种都收，
 * 统一成字符串（否则 `123` 与 `"123"` 会被当成两个人）。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeIds(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    const text = typeof item === 'number' && Number.isFinite(item) ? String(item) : typeof item === 'string' ? item.trim() : ''
    if (text === '') continue
    if (!/^-?\d{1,20}$/.test(text)) {
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

  const apiBase = str('apiBase', DEFAULT_CONFIG.apiBase).trim()

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    credentialFile: str('credentialFile', DEFAULT_CONFIG.credentialFile).trim(),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile).trim(),
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_MAX),
    pollTimeoutSec: clampInt(raw['pollTimeoutSec'], DEFAULT_CONFIG.pollTimeoutSec, POLL_TIMEOUT_FLOOR, POLL_TIMEOUT_CEIL),
    backoffMs: clampInt(raw['backoffMs'], DEFAULT_CONFIG.backoffMs, BACKOFF_FLOOR, BACKOFF_CEIL),
    maxConcurrent: clampInt(raw['maxConcurrent'], DEFAULT_CONFIG.maxConcurrent, 1, CONCURRENCY_CEIL),
    requestPaddingMs: clampInt(raw['requestPaddingMs'], DEFAULT_CONFIG.requestPaddingMs, PADDING_FLOOR, PADDING_CEIL),
    apiBase: apiBase === '' ? DEFAULT_CONFIG.apiBase : apiBase.replace(/\/+$/, ''),
    allowSenderIds: normalizeIds(raw['allowSenderIds'], text => report(text, 'allowSenderIds')),
    blockSenderIds: normalizeIds(raw['blockSenderIds'], text => report(text, 'blockSenderIds')),
    persist: bool('persist', DEFAULT_CONFIG.persist),
    persistMs: clampInt(raw['persistMs'], DEFAULT_CONFIG.persistMs, 1_000, PERSIST_CEIL),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 实际 HTTP 超时 = 轮询超时 + 附加余量。**只在这里算一次。**
 *
 * 两处各算一次的代价：一处改了、另一处没改，于是「拉取永远超时」，
 * 而配置界面上一片正常。
 * @param settings 配置。
 */
export function requestTimeoutOf(settings: Config): number {
  return settings.pollTimeoutSec * 1000 + settings.requestPaddingMs
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
    ['pollTimeoutSec', POLL_TIMEOUT_FLOOR, POLL_TIMEOUT_CEIL],
    ['backoffMs', BACKOFF_FLOOR, BACKOFF_CEIL],
    ['maxConcurrent', 1, CONCURRENCY_CEIL],
    ['requestPaddingMs', PADDING_FLOOR, PADDING_CEIL],
    ['persistMs', 1_000, PERSIST_CEIL],
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
