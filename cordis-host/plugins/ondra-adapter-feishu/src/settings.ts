/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 为什么去重窗口默认 65 分钟（而不是像微信那样 30 分钟）
 *
 * 飞书在没收到成功响应时会**重投同一条事件**，官方口径是三档：约 15 秒、约 5 分钟、约 1 小时。
 * 前两档用 30 分钟窗口就能吃掉，但**第三档要 1 小时**——窗口设 30 分钟的话，
 * 第三次重投会被当成新消息再答一遍，用户看到的是「一小时后她又回了我一遍同一句话」。
 * 所以默认 3900_000ms（65 分钟），刚好盖住第三档；上界给到 24 小时。
 *
 * ## 为什么没有「群里是否要 @」的开关
 *
 * 事件订阅里，群消息**默认只在机器人被 @ 时才投递**——这是平台行为，不是插件选择。
 * 给一个 `requireMention` 开关，等于给用户一个「看起来能调、其实调不动」的假开关。
 * 本插件只做一件事：把 `@_user_N` 占位符剥掉，并把这次触发标成 `mention`。
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
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/feishu.json`。 */
  readonly credentialFile: string
  /** 状态文件路径（去重表）；留空则推出 `…feishu.state.json`。 */
  readonly stateFile: string
  /** 单条上限（100–4000，默认 4000：平台硬上限）。 */
  readonly chunkMax: number
  /** 允许的发信人 id（空 = 不限）。 */
  readonly allowSenderIds: readonly string[]
  /** 屏蔽的发信人 id（优先于白名单）。 */
  readonly blockSenderIds: readonly string[]
  /** 去重窗口（毫秒，默认 65 分钟：盖住飞书第三档重投）。 */
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
export const CONFIG_SECTION_ID = 'feishu'

/** 去重窗口下界：1 分钟。 */
export const DEDUPE_FLOOR = 60_000

/** 去重窗口上界：24 小时。 */
export const DEDUPE_CEIL = 86_400_000

/** 去重窗口默认值：65 分钟（盖住飞书第三档重投）。 */
export const DEDUPE_DEFAULT = 3_900_000

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
  allowSenderIds: 'allow-sender-ids',
  blockSenderIds: 'block-sender-ids',
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
    doc: '通道开关。默认关：一个飞书应用装上去就开始回消息，那是事故不是功能。',
  },
  routePath: {
    kind: 'string',
    default: DEFAULT_ROUTE_PATH,
    pattern: '^/[A-Za-z0-9._~/-]*$',
    doc: '挂在宿主 webServer 上的路径。飞书开发者后台「事件订阅 → 请求地址」填 https://<你的域名><routePath>。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用 user/channels/feishu.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '去重状态文件绝对路径。留空则用 user/channels/feishu.state.json。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（master-plan §9.11 实测 4000）。这是平台硬上限，只能往下调。',
  },
  allowSenderIds: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的发信人 open_id / user_id。空数组 = 不限（应用可见范围内谁都能触发她）。',
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
    doc: '去重窗口。飞书重投三档约 15s / 5min / 1h，默认 65 分钟刚好盖住第三档。',
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
  allowSenderIds: Object.freeze([]) as readonly string[],
  blockSenderIds: Object.freeze([]) as readonly string[],
  dedupeWindowMs: DEDUPE_DEFAULT,
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
  title: '飞书',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-feishu',
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
 * 带了尾斜杠就是另一条路由，症状是「注册成功、飞书请求 404」。
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
 * 飞书的 `open_id` 形如 `ou_` + 32 位十六进制，`user_id` 形如 `on_` / 自定义，
 * **都不做大小写折叠**：折叠会让两个不同的人塌成同一条记录。
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
    if (text.length < 3 || text.length > 64 || /\s/.test(text)) {
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
