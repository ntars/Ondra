/**
 * 配置的**单一真源**。
 *
 * ## 出厂值为什么这么保守
 *
 * 1. `enable=false`：§16.3 端侧默认全关。
 * 2. `enabledTools=['status']`：**出厂只允许读状态**。
 *    进服之后她能说话、能发指令——那两条都是「以她的名义对别人产生影响」，
 *    不该在装上的那一刻就具备。
 * 3. `commandAllowList=[]`：**空 = 一个指令都不许**。`/` 开头是服务器管理员接口，
 *    一条 `/kill`、`/op`、`/givemoney` 都可能毁掉别人的存档。
 * 4. `chatMax=256`：Minecraft 协议自己的字符串上限，超过即断连。
 *
 * ## 为什么没有「自动重连」
 *
 * 自动重连看着贴心，实际是两个坑：①账号在别人的服务器上反复上下线，
 * 最容易被判异常；②重连窗口里她能收到什么、错过什么完全不可知。
 * 连接由调用方显式发起，本包不替你决定「再试一次」。
 *
 * ## 为什么 server 只有一个
 *
 * 手册没给「多服务器切换」。一个字段一个坏法：多服务器配置必然出现
 * 「A 服务器在线、B 服务器也在线」，而消息该发到哪儿没有任何判据。
 */

import type { FieldSpecLike, SectionDeclLike, ServerTarget, ToolKey } from './types.js'
import {
  CHAT_CEIL,
  CHAT_FLOOR,
  CHAT_MAX,
  CONNECT_TIMEOUT_MS,
  HOST_MAX,
  INTERVAL_CEIL,
  NAME_RE,
  PER_MINUTE,
  PER_MINUTE_CEIL,
  SEND_INTERVAL_MS,
  TIMEOUT_CEIL,
  TIMEOUT_FLOOR,
  TOOL_KEYS,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 开着的能力。 */
  readonly enabledTools: readonly ToolKey[]
  /** 服务器地址（`host` 或 `host:port`）。 */
  readonly server: string
  /** 端口（server 里没写端口时用它）。 */
  readonly port: number
  /** 用户名（离线模式）。 */
  readonly username: string
  /** 版本（`auto` = 驱动自己探测）。 */
  readonly version: string
  /** 允许的指令名（小写，不含 `/`）。空 = 一个都不许。 */
  readonly commandAllowList: readonly string[]
  /** 两次发送的最小间隔（毫秒）。 */
  readonly minSendIntervalMs: number
  /** 每分钟消息预算（条）。 */
  readonly maxPerMinute: number
  /** 单条聊天字符上限。 */
  readonly chatMax: number
  /** 连接超时（毫秒）。 */
  readonly connectTimeoutMs: number
  /** 最近聊天保留条数。 */
  readonly recentChatKeep: number
  /** 每次发送打一行日志（**不含正文**）。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'minecraft'

/** 出厂工具：**只有读状态**。 */
export const DEFAULT_TOOLS: readonly ToolKey[] = Object.freeze(['status'])

/** 端口下界 / 上界。 */
export const PORT_FLOOR = 1

/** 端口上界。 */
export const PORT_CEIL = 65_535

/** 最近聊天保留条数默认值。 */
export const RECENT_KEEP = 20

/** 最近聊天保留条数上界。 */
export const RECENT_KEEP_CEIL = 200

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  enabledTools: 'enabled-tools',
  server: 'server',
  port: 'port',
  username: 'username',
  version: 'version',
  commandAllowList: 'command-allow-list',
  minSendIntervalMs: 'min-send-interval-ms',
  maxPerMinute: 'max-per-minute',
  chatMax: 'chat-max',
  connectTimeoutMs: 'connect-timeout-ms',
  recentChatKeep: 'recent-chat-keep',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: 'Minecraft 接入开关。默认关：它要连一个外部服务器，且会以她的名义说话。',
  },
  enabledTools: {
    kind: 'json',
    default: DEFAULT_TOOLS,
    doc: '开着的能力：status / chat / command。**出厂只有 status**——先让她能看见，再决定让不让她说话。',
  },
  server: {
    kind: 'string',
    default: '',
    pattern: '^(|[a-z0-9._-]{1,128}(:[0-9]{1,5})?)$',
    doc: '服务器地址：`host` 或 `host:port`。**不接受 URL、不接受带协议的写法。** 空 = 不连。',
  },
  port: {
    kind: 'number',
    default: 25_565,
    min: PORT_FLOOR,
    max: PORT_CEIL,
    doc: '端口。server 里已经写了端口时以 server 为准。',
  },
  username: {
    kind: 'string',
    default: '',
    pattern: '^[A-Za-z0-9_]{0,16}$',
    doc: '离线模式用户名（正版认证归驱动实现方）。空 = 不连。',
  },
  version: {
    kind: 'string',
    default: 'auto',
    doc: '协议版本。`auto` 让驱动自己探测；写死版本号只在服务端拒绝握手时才需要。',
  },
  commandAllowList: {
    kind: 'json',
    default: Object.freeze([] as readonly string[]),
    doc: '允许发出的指令名（小写、不含 `/`），例如 `list`、`tps`。**空 = 一个指令都不许发**——`/` 是服务器管理员接口。',
  },
  minSendIntervalMs: {
    kind: 'number',
    default: SEND_INTERVAL_MS,
    min: 0,
    max: INTERVAL_CEIL,
    advancedOnly: true,
    doc: '两次发送的最小间隔（毫秒）。多数服务端把 1 秒内的连续消息判为刷屏。',
  },
  maxPerMinute: {
    kind: 'number',
    default: PER_MINUTE,
    min: 1,
    max: PER_MINUTE_CEIL,
    advancedOnly: true,
    doc: '每分钟消息预算（条）。',
  },
  chatMax: {
    kind: 'number',
    default: CHAT_MAX,
    min: CHAT_FLOOR,
    max: CHAT_CEIL,
    doc: '单条聊天字符上限。**协议上限是 256**，超过会被服务端直接断开（不是报错，是掉线）。',
  },
  connectTimeoutMs: {
    kind: 'number',
    default: CONNECT_TIMEOUT_MS,
    min: TIMEOUT_FLOOR,
    max: TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '连接超时（毫秒）。进服要走三段握手，10 秒是宽松值。',
  },
  recentChatKeep: {
    kind: 'number',
    default: RECENT_KEEP,
    min: 1,
    max: RECENT_KEEP_CEIL,
    advancedOnly: true,
    doc: '状态里带多少条最近聊天。带得越多，上下文越贵。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次发送打一行日志（**不含正文**，只记长度与结果码）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  enabledTools: DEFAULT_TOOLS,
  server: '',
  port: 25_565,
  username: '',
  version: 'auto',
  commandAllowList: Object.freeze([] as readonly string[]),
  minSendIntervalMs: SEND_INTERVAL_MS,
  maxPerMinute: PER_MINUTE,
  chatMax: CHAT_MAX,
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  recentChatKeep: RECENT_KEEP,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 查表版。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: 'Minecraft 接入',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-minecraft',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键。
 * @param raw 原始配置。
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
 * 把 O-005 的结果回填成 Config 形状。
 * @param values 解析结果 `values`。
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
 * 夹一个整数。
 * @param value 待夹值。
 * @param fallback 回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 归一化能力名单。
 * @param value 原始值。
 * @param onBad 被丢弃条目回调。
 */
function normalizeTools(value: unknown, onBad: (text: string) => void): readonly ToolKey[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: ToolKey[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim().toLowerCase()
    if (text === '') continue
    const bare = text.startsWith('minecraft.')
      ? text.slice('minecraft.'.length)
      : text.startsWith('minecraft-')
        ? text.slice('minecraft-'.length)
        : text
    const key = TOOL_KEYS.find(candidate => candidate === bare)
    if (key === undefined) {
      onBad(item)
      continue
    }
    if (!out.includes(key)) out.push(key)
  }
  return Object.freeze(out)
}

/**
 * 归一化指令白名单。
 *
 * 只收「裸指令名」：小写、数字、连字符、下划线，1–32 字。
 * **强制剥掉开头的 `/`**：用户写 `/list` 与 `list` 都应被接受，
 * 但存进去的一律不带 `/` —— 否则「带不带斜杠」会变成两套相等的配置。
 * @param value 原始值。
 * @param onBad 被丢弃条目回调。
 */
function normalizeCommands(value: unknown, onBad: (text: string) => void): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim().replace(/^\/+/, '').toLowerCase()
    if (text === '') continue
    if (!NAME_RE.test(text) || text.length > 32) {
      onBad(item)
      continue
    }
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
}

/**
 * 归一化服务器地址。
 *
 * 只认 `host` 或 `host:port`。带 `://`、带路径、带空格的写法一律丢弃——
 * 那些是 URL 的形状，而被要求的是「一个主机名」，两者混淆的表现是
 * 「填了 `minecraft://host` 之后永远连不上，且日志里看不出哪里错」。
 * @param value 原始值。
 * @param onBad 被丢弃回调。
 */
function normalizeServer(value: unknown, onBad: (text: string) => void): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  if (text.length > HOST_MAX || text.includes('://') || text.includes('/') || /\s/.test(text)) {
    onBad(value)
    return ''
  }
  const [host, portText, ...rest] = text.split(':')
  if (host === undefined || rest.length > 0) {
    onBad(value)
    return ''
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(host)) {
    onBad(value)
    return ''
  }
  if (portText !== undefined) {
    const port = Number(portText)
    if (!Number.isInteger(port) || port < PORT_FLOOR || port > PORT_CEIL) {
      onBad(value)
      return ''
    }
  }
  return text
}

/**
 * 归一化用户名（离线模式）。
 * @param value 原始值。
 * @param onBad 被丢弃回调。
 */
function normalizeUsername(value: unknown, onBad: (text: string) => void): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  if (!/^[A-Za-z0-9_]{1,16}$/.test(text)) {
    onBad(value)
    return ''
  }
  return text
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 坏条目回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  // 三个 json/string 字段同一口径：缺失用出厂值，显式给空就是空。
  const tools =
    raw['enabledTools'] === undefined
      ? DEFAULT_TOOLS
      : normalizeTools(raw['enabledTools'], text => report(text, 'enabledTools'))
  const commands =
    raw['commandAllowList'] === undefined
      ? DEFAULT_CONFIG.commandAllowList
      : normalizeCommands(raw['commandAllowList'], text => report(text, 'commandAllowList'))
  const server =
    raw['server'] === undefined ? DEFAULT_CONFIG.server : normalizeServer(raw['server'], text => report(text, 'server'))
  const username =
    raw['username'] === undefined
      ? DEFAULT_CONFIG.username
      : normalizeUsername(raw['username'], text => report(text, 'username'))
  const version =
    raw['version'] === undefined
      ? DEFAULT_CONFIG.version
      : typeof raw['version'] === 'string' && raw['version'].trim() !== ''
        ? raw['version'].trim()
        : DEFAULT_CONFIG.version

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    enabledTools: tools,
    server,
    port: clampInt(raw['port'], DEFAULT_CONFIG.port, PORT_FLOOR, PORT_CEIL),
    username,
    version,
    commandAllowList: commands,
    minSendIntervalMs: clampInt(raw['minSendIntervalMs'], DEFAULT_CONFIG.minSendIntervalMs, 0, INTERVAL_CEIL),
    maxPerMinute: clampInt(raw['maxPerMinute'], DEFAULT_CONFIG.maxPerMinute, 1, PER_MINUTE_CEIL),
    chatMax: clampInt(raw['chatMax'], DEFAULT_CONFIG.chatMax, CHAT_FLOOR, CHAT_CEIL),
    connectTimeoutMs: clampInt(
      raw['connectTimeoutMs'],
      DEFAULT_CONFIG.connectTimeoutMs,
      TIMEOUT_FLOOR,
      TIMEOUT_CEIL,
    ),
    recentChatKeep: clampInt(raw['recentChatKeep'], DEFAULT_CONFIG.recentChatKeep, 1, RECENT_KEEP_CEIL),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 把配置拼成连接目标。**地址或用户名为空时返回 `null`**（不猜）。
 * @param config 配置。
 */
export function targetOf(config: Config): ServerTarget | null {
  if (config.server === '' || config.username === '') return null
  const parts = config.server.split(':')
  const host = parts[0]
  if (host === undefined || host === '') return null
  const port = parts.length > 1 ? Number(parts[1]) : config.port
  return { host, port, username: config.username, version: config.version }
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['port', PORT_FLOOR, PORT_CEIL],
    ['minSendIntervalMs', 0, INTERVAL_CEIL],
    ['maxPerMinute', 1, PER_MINUTE_CEIL],
    ['chatMax', CHAT_FLOOR, CHAT_CEIL],
    ['connectTimeoutMs', TIMEOUT_FLOOR, TIMEOUT_CEIL],
    ['recentChatKeep', 1, RECENT_KEEP_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) drift.push(key)
  }

  const givenServer = raw['server']
  if (typeof givenServer === 'string' && givenServer.trim() !== '') {
    if (normalizeServer(givenServer, () => undefined) === '') drift.push('server')
  }
  const givenUser = raw['username']
  if (typeof givenUser === 'string' && givenUser.trim() !== '') {
    if (normalizeUsername(givenUser, () => undefined) === '') drift.push('username')
  }

  return drift
}
