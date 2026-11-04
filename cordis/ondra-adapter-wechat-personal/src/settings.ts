/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 「仅回环」不在这里，它写死在代码里
 *
 * 别把安全边界做成配置项。宿主的 `webServer` 可以绑到具体网卡地址，
 * 所以「只在本机」必须靠请求层的 `remoteAddress` 判定；
 * 一旦它是一个 `loopbackOnly: boolean`，就会有人在排查「桥接端连不上」时把它关掉，
 * 然后把一个没有鉴权的通道开到局域网上——而这一整套双闸门就白做了。
 *
 * ## 为什么没有六道闸
 *
 * 手册 §5.3 的六道闸是 **QQ 防封控**：它压的是「主动发言频率」。
 * 个人号的真实风险是**账号被封**（§6.2：刚注册的小号基本秒风控），
 * 而这一点不是靠本插件限流能解决的——它是「只能用养过一段时间的号」这条前置事实。
 * 本插件因此只保留三样与个人号语义对齐的东西：
 *
 * 1. **双闸门**（`enable` + 确认档案）——防「不知情地开了」；
 * 2. **白名单**（空 = 全拒，§6.2「白名单外不发信息」）——防「对陌生人说话」；
 * 3. **冷却**（默认 1.2 秒，推断值）——防「同一个人连发时被答成刷屏」。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  CHUNK_MAX,
  CHUNK_MIN,
  COOLDOWN_MAX,
  COOLDOWN_MIN,
  COOLDOWN_MS,
  DEFAULT_REPLY_BUDGET_MS,
  DEFAULT_ROUTE_PATH,
  REPLY_BUDGET_MAX,
  REPLY_BUDGET_MIN,
} from './types.js'

/** 回复出口。 */
export type ReplyMode = 'sync' | 'webhook'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关，且单独开还不够：还要二次确认）。 */
  readonly enable: boolean
  /** 二次确认（只认字面量 `true`，且必须有确认档案）。 */
  readonly confirmed: boolean
  /** 入站路径（挂在宿主 webServer 上的绝对 pathname）。 */
  readonly routePath: string
  /** 单条上限（100–1000，默认 1000：平台实测值）。 */
  readonly chunkMax: number
  /** 同一会话两次回答的最小间隔（毫秒，0 = 关闭）。 */
  readonly cooldownMs: number
  /** 同步等待预算（毫秒）。超了就换成推迟出口。 */
  readonly replyBudgetMs: number
  /** 并发上限（同时跑几个回合）。 */
  readonly maxConcurrent: number
  /** 允许的联系人（**空 = 全拒**，手册 §6.2「白名单外不发信息」）。 */
  readonly allowContacts: readonly string[]
  /** 屏蔽的联系人（优先于白名单）。 */
  readonly blockContacts: readonly string[]
  /** 是否回群消息（默认 false：群聊不主动）。 */
  readonly allowGroups: boolean
  /** 回复出口：`sync`（写进响应）或 `webhook`（推到用户地址）。 */
  readonly replyMode: ReplyMode
  /** 出站 webhook 地址（`replyMode=webhook` 或超预算时用）。 */
  readonly outboundWebhook: string
  /** 单次 HTTP 请求超时（毫秒）。 */
  readonly requestTimeoutMs: number
  /** 确认档案路径；留空则由 `path-layout` 推出。 */
  readonly confirmFile: string
  /** 冷却表状态文件路径；留空则推出。 */
  readonly stateFile: string
  /** 冷却表是否落盘。 */
  readonly persist: boolean
  /** 落盘节流（毫秒）。 */
  readonly persistMs: number
  /** 每次发送打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'wechat-personal'

/** 并发上限的上界：8。再多只是把模型打成 429。 */
export const CONCURRENCY_CEIL = 8

/** 请求超时的上界。 */
export const REQUEST_TIMEOUT_CEIL = 60_000

/** 落盘节流默认值（毫秒）。 */
export const PERSIST_MS = 5_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  confirmed: 'confirmed',
  routePath: 'route-path',
  chunkMax: 'chunk-max',
  cooldownMs: 'cooldown-ms',
  replyBudgetMs: 'reply-budget-ms',
  maxConcurrent: 'max-concurrent',
  allowContacts: 'allow-contacts',
  blockContacts: 'block-contacts',
  allowGroups: 'allow-groups',
  replyMode: 'reply-mode',
  outboundWebhook: 'outbound-webhook',
  requestTimeoutMs: 'request-timeout-ms',
  confirmFile: 'confirm-file',
  stateFile: 'state-file',
  persist: 'persist',
  persistMs: 'persist-ms',
  verbose: 'verbose',
})

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '通道开关。**单独打开它不会回话**：还需要 confirmed 与一份确认档案（双闸门）。',
  },
  confirmed: {
    kind: 'boolean',
    default: false,
    doc: '二次确认。只认字面量 true，且必须同时有 user/channels/wechat-personal.confirm.json。'
      + '理由：个人号自动化有封号风险，误点一次开关的代价是一次不可逆的账号处罚。',
  },
  routePath: {
    kind: 'string',
    default: DEFAULT_ROUTE_PATH,
    pattern: '^/[A-Za-z0-9._~/-]*$',
    doc: '入站路径。桥接端 POST 到这里；只接受回环请求（这一条不可配置）。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    doc: '单条上限（手册 §9.11 实测 1000）。只能往下调。',
  },
  cooldownMs: {
    kind: 'number',
    default: COOLDOWN_MS,
    min: COOLDOWN_MIN,
    max: COOLDOWN_MAX,
    doc: '同一会话两次回答的最小间隔。默认 1200ms 是推断值（手册未给个人号频控数字）。',
  },
  replyBudgetMs: {
    kind: 'number',
    default: DEFAULT_REPLY_BUDGET_MS,
    min: REPLY_BUDGET_MIN,
    max: REPLY_BUDGET_MAX,
    doc: '同步等待预算。超了就返回 deferred，真回复走 webhook（配了才有）。'
      + '这不是平台硬限，只是不让桥接端干等。',
  },
  maxConcurrent: {
    kind: 'number',
    default: 2,
    min: 1,
    max: CONCURRENCY_CEIL,
    advancedOnly: true,
    doc: '同时跑几个回合。个人号的消息量不该需要更多；调高只是把封号风险也调高。',
  },
  allowContacts: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的联系人（微信显示名）。**空数组 = 全拒**——手册 §6.2：白名单外不发信息。',
  },
  blockContacts: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '屏蔽的联系人。优先于白名单。',
  },
  allowGroups: {
    kind: 'boolean',
    default: false,
    doc: '是否回群消息。默认否：群聊不主动（手册 §1.7 节制条款）。',
  },
  replyMode: {
    kind: 'enum',
    values: Object.freeze(['sync', 'webhook']),
    default: 'sync',
    doc: '回复出口。sync = 写进 HTTP 响应（零配置）；webhook = 先 ack 再推到 outbound-webhook。',
  },
  outboundWebhook: {
    kind: 'string',
    default: '',
    doc: '出站地址（http/https）。留空则只能走 sync；超预算的那条回复会被丢弃并留日志。',
  },
  requestTimeoutMs: {
    kind: 'number',
    default: 8_000,
    min: 1_000,
    max: REQUEST_TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '单次出站请求超时。',
  },
  confirmFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '确认档案绝对路径。留空则用 user/channels/wechat-personal.confirm.json。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '冷却表状态文件绝对路径。留空则用 user/channels/wechat-personal.state.json。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '冷却表落盘。不落盘则重启后冷却清零（影响很小，但仍如实标出）。',
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
  confirmed: false,
  routePath: DEFAULT_ROUTE_PATH,
  chunkMax: CHUNK_MAX,
  cooldownMs: COOLDOWN_MS,
  replyBudgetMs: DEFAULT_REPLY_BUDGET_MS,
  maxConcurrent: 2,
  allowContacts: Object.freeze([]) as readonly string[],
  blockContacts: Object.freeze([]) as readonly string[],
  allowGroups: false,
  replyMode: 'sync',
  outboundWebhook: '',
  requestTimeoutMs: 8_000,
  confirmFile: '',
  stateFile: '',
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
  title: '微信（个人号 · 高危）',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-wechat-personal',
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
 * 路由路径是否可用。
 *
 * 宿主 `register` 用 pathname 精确匹配、注释写明「无尾斜杠」，
 * 所以这里也拒尾斜杠：带了尾斜杠就是另一条路由，症状是「注册成功、请求 404」。
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
 * 出站地址是否可用。**只接受 http/https**：
 * 留一个 `file:` 或 `data:` 的地址进来，等于把「发消息」变成「写本地文件」。
 * @param url 地址文本。
 */
export function isUsableWebhook(url: string): boolean {
  const text = url.trim()
  if (text === '') return true
  // 用前缀判断而不是正则：这条规则太重要，不该藏在转义里
  // （`/^https?:\/\//` 里那一串斜杠还会把顺手写的括号检查器骗成注释）。
  const lower = text.toLowerCase()
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false
  try {
    return new URL(text).host !== ''
  } catch {
    return false
  }
}

/**
 * 归一化联系人名单。
 *
 * 微信显示名**大小写敏感、可能含空格与表情**，所以这里只做 trim，
 * 不做大小写折叠、不拒空格——折叠会让「小明」和「小明 」塌成同一个人，
 * 而拒空格会让一堆正常的中文名填不进来。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeContacts(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (text.length > 128) {
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
 *
 * 注意 `confirmed` 的读法：`=== true` 才算真。
 * 字符串 `"true"`、数字 `1`、`"yes"` 一律判否——这个开关的价值全在「不容错」上。
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
  const webhook = str('outboundWebhook', DEFAULT_CONFIG.outboundWebhook).trim()
  const replyMode = str('replyMode', DEFAULT_CONFIG.replyMode)

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    // 只认字面量 true：这个开关不容错，容错就等于可以被字符串意外打开。
    confirmed: raw['confirmed'] === true,
    routePath: isUsablePath(routePath) ? routePath : DEFAULT_CONFIG.routePath,
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_MAX),
    cooldownMs: clampInt(raw['cooldownMs'], DEFAULT_CONFIG.cooldownMs, COOLDOWN_MIN, COOLDOWN_MAX),
    replyBudgetMs: clampInt(raw['replyBudgetMs'], DEFAULT_CONFIG.replyBudgetMs, REPLY_BUDGET_MIN, REPLY_BUDGET_MAX),
    maxConcurrent: clampInt(raw['maxConcurrent'], DEFAULT_CONFIG.maxConcurrent, 1, CONCURRENCY_CEIL),
    allowContacts: normalizeContacts(raw['allowContacts'], text => report(text, 'allowContacts')),
    blockContacts: normalizeContacts(raw['blockContacts'], text => report(text, 'blockContacts')),
    allowGroups: bool('allowGroups', DEFAULT_CONFIG.allowGroups),
    replyMode: replyMode === 'webhook' ? 'webhook' : 'sync',
    outboundWebhook: isUsableWebhook(webhook) ? webhook : '',
    requestTimeoutMs: clampInt(raw['requestTimeoutMs'], DEFAULT_CONFIG.requestTimeoutMs, 1_000, REQUEST_TIMEOUT_CEIL),
    confirmFile: str('confirmFile', DEFAULT_CONFIG.confirmFile).trim(),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile).trim(),
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
    ['cooldownMs', COOLDOWN_MIN, COOLDOWN_MAX],
    ['replyBudgetMs', REPLY_BUDGET_MIN, REPLY_BUDGET_MAX],
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

  const webhook = raw['outboundWebhook']
  if (typeof webhook === 'string' && !isUsableWebhook(webhook)) drift.push('outboundWebhook')

  const replyMode = raw['replyMode']
  if (replyMode !== undefined && replyMode !== 'sync' && replyMode !== 'webhook') drift.push('replyMode')

  return drift
}
