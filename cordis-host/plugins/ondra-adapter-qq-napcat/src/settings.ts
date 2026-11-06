/**
 * 配置的**单一真源**。每个数字都能在手册里找到出处，注释写明出处。
 *
 * ```
 *        FIELD_SPECS（唯一真源：默认值 + 类型 + 边界 + 说明）
 *        ├─→ DEFAULT_CONFIG      运行期默认值（与 FIELD_SPECS.default 逐键同值，自检比对）
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 三件事刻意放在这里，而不是别处
 *
 * 1. **`enable` 默认 false**（手册 §9.11：九个适配器默认全关）。一个高危通道
 *    装上去就以真实 QQ 号的身份说话，那不是功能，是事故。
 * 2. **`confirmed` 默认 false，且只认字面量 `true`**（§16.2-6）。与 `enable`
 *    是两道独立的闸：一个是「我想开」，一个是「我知道风险」。
 * 3. **白名单出厂为空 = 全拒**。高危通道的空名单必须是「谁也不理」，
 *    而不是「谁都理」——后者是这个插件最贵的一次默认值。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  CHUNK_CEIL,
  CHUNK_MAX,
  CHUNK_MIN,
  CONTENT_MAX_LEN,
  DEFAULT_LIST_HOST,
  DEFAULT_LIST_PATH,
  DEFAULT_LIST_PORT,
  QUIET_END,
  QUIET_START,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 第一次确认：我知道这是高危通道（只认字面量 true）。 */
  readonly confirmed: boolean
  /** 是否还要求二次确认档案（默认 true：把「确认」留成一条可追溯的记录）。 */
  readonly requireConfirmRecord: boolean
  /** 确认档案路径；留空则由 `path-layout` 推出 `user/channels/qq-napcat.confirm.json`。 */
  readonly confirmFile: string
  /** 凭据（access token）文件路径；留空则推出 `user/channels/qq-napcat.json`。 */
  readonly tokenFile: string
  /** 闸门状态文件路径；留空则推出 `user/channels/qq-napcat.state.json`。 */
  readonly stateFile: string
  /** 反向 WS 监听地址（NapCat 连入的目标）。默认 `127.0.0.1`。 */
  readonly listHost: string
  /** 反向 WS 监听端口。NapCat 侧填 `ws://<listHost>:<port><path>`。 */
  readonly port: number
  /** 升级路由路径。 */
  readonly path: string
  /** 单条上限（200–2000，默认 1200）。 */
  readonly chunkMax: number
  /** 允许的私聊 QQ 号（空 = 全拒）。 */
  readonly allowUsers: readonly string[]
  /** 允许的群号（空 = 全拒）。 */
  readonly allowGroups: readonly string[]
  /** 群内关键词；空 = 只认 @。 */
  readonly groupKeyword: string
  /** 群内触发后的回复概率（0–1，默认 1）。 */
  readonly groupReplyProbability: number
  /** 内容闸长度（手册 §5.3-1：1800）。 */
  readonly contentMaxLen: number
  /** 内容闸正则（三类：赌博 / 诈骗代办 / 色情）。手册未给原文，出厂为空。 */
  readonly blockPatterns: readonly string[]
  /** 是否启用深夜静默。 */
  readonly quietEnabled: boolean
  /** 静默开始（`HH:MM`，东八区）。 */
  readonly quietStart: string
  /** 静默结束。 */
  readonly quietEnd: string
  /** 重复去重窗口（毫秒，手册 §5.3-3：30 分钟）。 */
  readonly dedupeWindowMs: number
  /** 重复去重最短长度（手册 §5.3-3：`minLen 4`）。 */
  readonly dedupeMinLen: number
  /** 令牌桶：每分钟（手册 §5.3-4：20）。 */
  readonly perMinute: number
  /** 令牌桶：每小时（200）。 */
  readonly perHour: number
  /** 令牌桶：每天（1500）。 */
  readonly perDay: number
  /** 群会话冷却（毫秒，手册 §5.3-5：5 秒）。 */
  readonly cooldownGroupMs: number
  /** 私聊会话冷却（毫秒，3 秒）。 */
  readonly cooldownPrivateMs: number
  /** 发送前随机抖动（毫秒，手册 §5.3-6：400）。 */
  readonly jitterMs: number
  /** 熔断阈值：连续命中风控几次（3）。 */
  readonly circuitStrikes: number
  /** 熔断时长（毫秒，30 分钟）。 */
  readonly circuitCooldownMs: number
  /** 连续失败后停发时长（毫秒，5 分钟）。 */
  readonly failureStopMs: number
  /** 等一次回复的超时（毫秒）。 */
  readonly replyTimeoutMs: number
  /** 闸门状态是否落盘（手册 §5.3-7：重启清零 = 重启绕过防封）。 */
  readonly persist: boolean
  /** 落盘节流（毫秒）。 */
  readonly persistMs: number
  /** 每次发送打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'qq-napcat'

/** 令牌桶下界：1。0 等于关掉通道，那不是配置是开关。 */
export const RATE_FLOOR = 1

/** 每分钟上界：60。 */
export const PER_MINUTE_CEIL = 60

/** 每小时上界：600。 */
export const PER_HOUR_CEIL = 600

/** 每天上界：5000。 */
export const PER_DAY_CEIL = 5000

/** 去重窗口上界：24 小时。 */
export const DEDUPE_CEIL = 86_400_000

/** 冷却上界：60 秒。再长会让正常对话卡住。 */
export const COOLDOWN_CEIL = 60_000

/** 抖动上界：5 秒。 */
export const JITTER_CEIL = 5_000

/** 熔断阈值上界：10。 */
export const STRIKES_CEIL = 10

/** 熔断时长上界：24 小时。 */
export const CIRCUIT_CEIL = 86_400_000

/** 端口下界：1024（不许占用特权端口）。 */
export const PORT_MIN = 1024

/** 端口上界：65535。 */
export const PORT_MAX = 65_535

/** 去重窗口默认值（毫秒）：30 分钟。 */
export const DEDUPE_WINDOW_MS = 1_800_000

/** 去重最短长度默认值：4。 */
export const DEDUPE_MIN_LEN = 4

/** 熔断默认时长（毫秒）：30 分钟。 */
export const CIRCUIT_MS = 1_800_000

/** 连续失败默认停发时长（毫秒）：5 分钟。 */
export const FAILURE_STOP_MS = 300_000

/** 默认回复超时（毫秒）：60 秒。 */
export const REPLY_TIMEOUT_MS = 60_000

/** 默认落盘节流（毫秒）：5 秒。 */
export const PERSIST_MS = 5_000

/** Config 键（camel）→ 段字段键（kebab）。O-005 的字段名只认后者。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  confirmed: 'confirmed',
  requireConfirmRecord: 'require-confirm-record',
  confirmFile: 'confirm-file',
  tokenFile: 'token-file',
  stateFile: 'state-file',
  listHost: 'list-host',
  port: 'port',
  path: 'path',
  chunkMax: 'chunk-max',
  allowUsers: 'allow-users',
  allowGroups: 'allow-groups',
  groupKeyword: 'group-keyword',
  groupReplyProbability: 'group-reply-probability',
  contentMaxLen: 'content-max-len',
  blockPatterns: 'block-patterns',
  quietEnabled: 'quiet-enabled',
  quietStart: 'quiet-start',
  quietEnd: 'quiet-end',
  dedupeWindowMs: 'dedupe-window-ms',
  dedupeMinLen: 'dedupe-min-len',
  perMinute: 'per-minute',
  perHour: 'per-hour',
  perDay: 'per-day',
  cooldownGroupMs: 'cooldown-group-ms',
  cooldownPrivateMs: 'cooldown-private-ms',
  jitterMs: 'jitter-ms',
  circuitStrikes: 'circuit-strikes',
  circuitCooldownMs: 'circuit-cooldown-ms',
  failureStopMs: 'failure-stop-ms',
  replyTimeoutMs: 'reply-timeout-ms',
  persist: 'persist',
  persistMs: 'persist-ms',
  verbose: 'verbose',
})

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '通道开关。默认关：高危通道装上去就连，那是事故不是功能。',
  },
  confirmed: {
    kind: 'boolean',
    default: false,
    doc: '第一次确认：我知道用真实 QQ 号跑自动化的风险。只认字面量 true。',
  },
  requireConfirmRecord: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否还要求确认档案（带说明文字的一条记录）。关掉它等于把二次确认降成一次。',
  },
  confirmFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '确认档案绝对路径。留空则用 user/channels/qq-napcat.confirm.json（0600）。',
  },
  tokenFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: 'access token 文件绝对路径。留空则用 user/channels/qq-napcat.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '防封状态文件绝对路径。留空则用 user/channels/qq-napcat.state.json。',
  },
  listHost: {
    kind: 'string',
    default: DEFAULT_LIST_HOST,
    doc: '反向 WS 监听地址。NapCat 在容器/另一台机器时必须填宿主可达地址，此时 127.0.0.1 不成立。',
  },
  port: {
    kind: 'number',
    default: DEFAULT_LIST_PORT,
    min: PORT_MIN,
    max: PORT_MAX,
    doc: '反向 WS 监听端口。这是本端在听的端口，不是 NapCat 的地址——填反了永远连不上。',
  },
  path: {
    kind: 'string',
    default: DEFAULT_LIST_PATH,
    pattern: '^/[A-Za-z0-9._~/-]*$',
    doc: '升级路由路径。NapCat 侧填 ws://<listHost>:<port><path>。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_CEIL,
    doc: '单条上限。手册没给 NapCat 的值，默认取 QQ 官方的 1200。',
  },
  allowUsers: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的私聊 QQ 号。空数组 = 全拒（高危通道的空名单必须是「谁也不理」）。',
  },
  allowGroups: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '允许的群号。与 QQ 号分开配（手册 §6.1：白名单必须区分两类）。空数组 = 全拒。',
  },
  groupKeyword: {
    kind: 'string',
    default: '',
    doc: '群内关键词；留空则只认 @。留空比乱填安全：关键词匹配会让「路过的一句闲聊」也叫她。',
  },
  groupReplyProbability: {
    kind: 'number',
    default: 1,
    min: 0,
    max: 1,
    doc: '群内被触发后的回复概率。1 = 每次都回（最可预期）；调低用于防刷屏。',
  },
  contentMaxLen: {
    kind: 'number',
    default: CONTENT_MAX_LEN,
    min: 200,
    max: 20_000,
    doc: '内容闸长度（手册 §5.3-1 的 1800）。',
  },
  blockPatterns: {
    kind: 'json',
    default: Object.freeze([]) as readonly string[],
    doc: '内容闸正则。手册写了三类但未给原文，编三条出来只是「看起来拦住了」，故出厂为空。',
  },
  quietEnabled: {
    kind: 'boolean',
    default: true,
    doc: '深夜静默。只拦主动发言，被叫要照回。',
  },
  quietStart: {
    kind: 'string',
    default: QUIET_START,
    pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    doc: '静默开始（东八区）。',
  },
  quietEnd: {
    kind: 'string',
    default: QUIET_END,
    pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    doc: '静默结束。',
  },
  dedupeWindowMs: {
    kind: 'number',
    default: DEDUPE_WINDOW_MS,
    min: 1_000,
    max: DEDUPE_CEIL,
    doc: '重复去重窗口（30 分钟）。',
  },
  dedupeMinLen: {
    kind: 'number',
    default: DEDUPE_MIN_LEN,
    min: 1,
    max: 32,
    doc: '去重的最短长度：放过「嗯」「好」「?」这类人类会重复的短回复。',
  },
  perMinute: {
    kind: 'number',
    default: 20,
    min: RATE_FLOOR,
    max: PER_MINUTE_CEIL,
    doc: '令牌桶：每分钟。',
  },
  perHour: {
    kind: 'number',
    default: 200,
    min: RATE_FLOOR,
    max: PER_HOUR_CEIL,
    doc: '令牌桶：每小时。',
  },
  perDay: {
    kind: 'number',
    default: 1500,
    min: RATE_FLOOR,
    max: PER_DAY_CEIL,
    doc: '令牌桶：每天。腾讯看长期曲线，只做时上限是踩过的坑。',
  },
  cooldownGroupMs: {
    kind: 'number',
    default: 5_000,
    min: 0,
    max: COOLDOWN_CEIL,
    doc: '群会话冷却（5 秒）。',
  },
  cooldownPrivateMs: {
    kind: 'number',
    default: 3_000,
    min: 0,
    max: COOLDOWN_CEIL,
    doc: '私聊会话冷却（3 秒）。',
  },
  jitterMs: {
    kind: 'number',
    default: 400,
    min: 0,
    max: JITTER_CEIL,
    doc: '发送前随机抖动。固定节奏本身就是自动化特征。',
  },
  circuitStrikes: {
    kind: 'number',
    default: 3,
    min: RATE_FLOOR,
    max: STRIKES_CEIL,
    doc: '连续命中风控几次后熔断。',
  },
  circuitCooldownMs: {
    kind: 'number',
    default: CIRCUIT_MS,
    min: 60_000,
    max: CIRCUIT_CEIL,
    doc: '熔断时长（30 分钟）。被盯上时唯一正确的做法是完全闭嘴。',
  },
  failureStopMs: {
    kind: 'number',
    default: FAILURE_STOP_MS,
    min: 10_000,
    max: CIRCUIT_CEIL,
    doc: '连续失败 3 次后停发时长（5 分钟）。',
  },
  replyTimeoutMs: {
    kind: 'number',
    default: REPLY_TIMEOUT_MS,
    min: 5_000,
    max: 600_000,
    doc: '等一次人格回复的超时。超时只中止本轮，不换模型不重试。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '闸门状态落盘。重启清零 = 重启绕过防封。',
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

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表，不靠人记）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  confirmed: false,
  requireConfirmRecord: true,
  confirmFile: '',
  tokenFile: '',
  stateFile: '',
  listHost: DEFAULT_LIST_HOST,
  port: DEFAULT_LIST_PORT,
  path: DEFAULT_LIST_PATH,
  chunkMax: CHUNK_MAX,
  allowUsers: Object.freeze([]) as readonly string[],
  allowGroups: Object.freeze([]) as readonly string[],
  groupKeyword: '',
  groupReplyProbability: 1,
  contentMaxLen: CONTENT_MAX_LEN,
  blockPatterns: Object.freeze([]) as readonly string[],
  quietEnabled: true,
  quietStart: QUIET_START,
  quietEnd: QUIET_END,
  dedupeWindowMs: DEDUPE_WINDOW_MS,
  dedupeMinLen: DEDUPE_MIN_LEN,
  perMinute: 20,
  perHour: 200,
  perDay: 1500,
  cooldownGroupMs: 5_000,
  cooldownPrivateMs: 3_000,
  jitterMs: 400,
  circuitStrikes: 3,
  circuitCooldownMs: CIRCUIT_MS,
  failureStopMs: FAILURE_STOP_MS,
  replyTimeoutMs: REPLY_TIMEOUT_MS,
  persist: true,
  persistMs: PERSIST_MS,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: 'QQ（NapCat）',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-qq-napcat',
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
 * 解析 `HH:MM` 成「当天第几分钟」。
 * @param text 文本。
 * @returns 分钟数；不合法返回 `null`。
 */
export function parseClock(text: string): number | null {
  const matched = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text)
  if (matched === null) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return hour * 60 + minute
}

/**
 * 监听地址是否合法：不接受通配地址。
 *
 * 手册 §6.1 说 `listHost` 默认 `127.0.0.1`，容器场景要填宿主可达地址。
 * 反过来最危险的填法是 `0.0.0.0`：那会把一个**只靠 token 鉴权**的 WS 端口
 * 暴露到所有网卡上。宿主自己的 webServer 在加载期就拒绝通配地址，
 * 这里保持同一条纪律（两处一致，不靠人记）。
 * @param host 地址文本。
 */
export function isUsableHost(host: string): boolean {
  const text = host.trim()
  if (text === '') return false
  if (/\s/.test(text)) return false
  const lower = text.toLowerCase()
  if (lower === '0.0.0.0' || lower === '::' || lower === '[::]' || lower === '*') return false
  return true
}

/**
 * 升级路由路径是否合法。
 *
 * 宿主的 `registerUpgrade` 用 pathname 精确匹配、且注释写明「无尾斜杠」，
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
 * 归一化号码名单（QQ 号 / 群号）。
 *
 * 只留纯数字：QQ 号与群号都是十进制，混进昵称或带前缀的写法会让
 * 「白名单里明明有这个号」却永远匹配不上，而症状与「名单没生效」一样。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeIds(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' && typeof item !== 'number') continue
    const text = String(item).trim()
    if (text === '') continue
    if (!/^[1-9][0-9]{3,11}$/.test(text)) {
      onBad(text)
      continue
    }
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
}

/**
 * 归一化内容闸正则。
 *
 * 逐条试编译：写得出来的才留下。一条坏正则（少个括号）会让整表失效，
 * 那等于内容闸被静默关掉，而这正是最不该静默的地方。
 * @param value 原始值。
 * @param onBad 坏正则回调。
 */
function normalizePatterns(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    try {
      new RegExp(text)
      out.push(text)
    } catch {
      onBad(text)
    }
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
 * 夹一个小数（概率）。
 * @param value 待夹的值。
 * @param fallback 非法时的回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 有坏条目时的回调（参数为原文与类别）。
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
  const clock = (key: keyof Config, fallback: string): string => {
    const given = str(key, fallback)
    return parseClock(given) === null ? fallback : given
  }

  const host = str('listHost', DEFAULT_CONFIG.listHost).trim()
  const path = str('path', DEFAULT_CONFIG.path).trim()

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    // 只认字面量 true：字符串 'true' 不算（配置文件里写 'true' 是常见手滑）。
    confirmed: bool('confirmed', DEFAULT_CONFIG.confirmed),
    requireConfirmRecord: bool('requireConfirmRecord', DEFAULT_CONFIG.requireConfirmRecord),
    confirmFile: str('confirmFile', DEFAULT_CONFIG.confirmFile).trim(),
    tokenFile: str('tokenFile', DEFAULT_CONFIG.tokenFile).trim(),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile).trim(),
    // 非法地址回退默认而不是留着：坏地址会让 start() 永远失败，而失败理由看起来像「端口被占」。
    listHost: isUsableHost(host) ? host : DEFAULT_CONFIG.listHost,
    port: clampInt(raw['port'], DEFAULT_CONFIG.port, PORT_MIN, PORT_MAX),
    path: isUsablePath(path) ? path : DEFAULT_CONFIG.path,
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_CEIL),
    allowUsers: normalizeIds(raw['allowUsers'], text => report(text, 'allowUsers')),
    allowGroups: normalizeIds(raw['allowGroups'], text => report(text, 'allowGroups')),
    groupKeyword: str('groupKeyword', DEFAULT_CONFIG.groupKeyword).trim(),
    groupReplyProbability: clampFloat(
      raw['groupReplyProbability'],
      DEFAULT_CONFIG.groupReplyProbability,
      0,
      1,
    ),
    contentMaxLen: clampInt(raw['contentMaxLen'], DEFAULT_CONFIG.contentMaxLen, 200, 20_000),
    blockPatterns: normalizePatterns(raw['blockPatterns'], text => report(text, 'blockPatterns')),
    quietEnabled: bool('quietEnabled', DEFAULT_CONFIG.quietEnabled),
    quietStart: clock('quietStart', DEFAULT_CONFIG.quietStart),
    quietEnd: clock('quietEnd', DEFAULT_CONFIG.quietEnd),
    dedupeWindowMs: clampInt(raw['dedupeWindowMs'], DEFAULT_CONFIG.dedupeWindowMs, 1_000, DEDUPE_CEIL),
    dedupeMinLen: clampInt(raw['dedupeMinLen'], DEFAULT_CONFIG.dedupeMinLen, 1, 32),
    perMinute: clampInt(raw['perMinute'], DEFAULT_CONFIG.perMinute, RATE_FLOOR, PER_MINUTE_CEIL),
    perHour: clampInt(raw['perHour'], DEFAULT_CONFIG.perHour, RATE_FLOOR, PER_HOUR_CEIL),
    perDay: clampInt(raw['perDay'], DEFAULT_CONFIG.perDay, RATE_FLOOR, PER_DAY_CEIL),
    cooldownGroupMs: clampInt(raw['cooldownGroupMs'], DEFAULT_CONFIG.cooldownGroupMs, 0, COOLDOWN_CEIL),
    cooldownPrivateMs: clampInt(raw['cooldownPrivateMs'], DEFAULT_CONFIG.cooldownPrivateMs, 0, COOLDOWN_CEIL),
    jitterMs: clampInt(raw['jitterMs'], DEFAULT_CONFIG.jitterMs, 0, JITTER_CEIL),
    circuitStrikes: clampInt(raw['circuitStrikes'], DEFAULT_CONFIG.circuitStrikes, RATE_FLOOR, STRIKES_CEIL),
    circuitCooldownMs: clampInt(
      raw['circuitCooldownMs'],
      DEFAULT_CONFIG.circuitCooldownMs,
      60_000,
      CIRCUIT_CEIL,
    ),
    failureStopMs: clampInt(raw['failureStopMs'], DEFAULT_CONFIG.failureStopMs, 10_000, CIRCUIT_CEIL),
    replyTimeoutMs: clampInt(raw['replyTimeoutMs'], DEFAULT_CONFIG.replyTimeoutMs, 5_000, 600_000),
    persist: bool('persist', DEFAULT_CONFIG.persist),
    persistMs: clampInt(raw['persistMs'], DEFAULT_CONFIG.persistMs, 1_000, 60_000),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 * @returns 被改过或非法的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['port', PORT_MIN, PORT_MAX],
    ['chunkMax', CHUNK_MIN, CHUNK_CEIL],
    ['groupReplyProbability', 0, 1],
    ['perMinute', RATE_FLOOR, PER_MINUTE_CEIL],
    ['perHour', RATE_FLOOR, PER_HOUR_CEIL],
    ['perDay', RATE_FLOOR, PER_DAY_CEIL],
    ['cooldownGroupMs', 0, COOLDOWN_CEIL],
    ['cooldownPrivateMs', 0, COOLDOWN_CEIL],
    ['jitterMs', 0, JITTER_CEIL],
    ['circuitStrikes', RATE_FLOOR, STRIKES_CEIL],
    ['dedupeWindowMs', 1_000, DEDUPE_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  for (const key of ['quietStart', 'quietEnd'] as const) {
    const given = raw[key]
    if (typeof given === 'string' && parseClock(given) === null) drift.push(key)
  }

  const host = raw['listHost']
  if (typeof host === 'string' && !isUsableHost(host)) drift.push('listHost')

  const path = raw['path']
  if (typeof path === 'string' && !isUsablePath(path)) drift.push('path')

  return drift
}
