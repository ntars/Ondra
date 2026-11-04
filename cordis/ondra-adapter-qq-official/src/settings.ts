/**
 * 配置的**单一真源**。这里每一个数字都能在手册里找到出处，注释写明出处。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么 `enable` 默认 false
 *
 * 手册 §9.11：九个适配器**默认全部关闭**。一个通道插件装上去就开始连、
 * 就开始以某个真实账号的身份说话，那不是功能，是事故。
 *
 * ## 为什么防封参数写在本插件而不是 O-042
 *
 * O-042 `ondra-proactive-gate` 管的是「主动开口前的时机」（静默时段、日额度、放弃率）。
 * 手册 §5.3 的六道闸是 **QQ 专属的发送侧护栏**：内容正则、QQ 的错误码表、
 * QQ 的令牌桶数值、QQ 的会话冷却。放到通用的主动闸门里，就会出现
 * 「Telegram 被 QQ 的阈值卡住」这种没法解释的现象。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { CHUNK_MAX, CONTENT_MAX_LEN, QUIET_END, QUIET_START } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 凭据文件路径；留空则由 `path-layout` 推出 `user/channels/qq-official.json`。 */
  readonly credentialFile: string
  /** 闸门状态文件路径；留空则推出 `user/channels/qq-official.state.json`。 */
  readonly stateFile: string
  /** 单条上限（1–1200）。平台硬上限 1200，只能往下调。 */
  readonly chunkMax: number
  /** 内容闸长度（手册 §5.3-1：1800）。 */
  readonly contentMaxLen: number
  /** 内容闸正则（手册 §5.3-1 的三类：赌博 / 诈骗代办 / 色情）。出厂为空。 */
  readonly blockPatterns: readonly string[]
  /** 是否启用深夜静默。 */
  readonly quietEnabled: boolean
  /** 静默开始（`HH:MM`，东八区）。 */
  readonly quietStart: string
  /** 静默结束（`HH:MM`，东八区）。 */
  readonly quietEnd: string
  /** 重复去重窗口（毫秒，手册 §5.3-3：30 分钟）。 */
  readonly dedupeWindowMs: number
  /** 重复去重的最短长度（手册 §5.3-3：`minLen 4`）。 */
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
  /** 熔断阈值：连续命中风控几次（手册 §5.3-6：3）。 */
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
export const CONFIG_SECTION_ID = 'qq-official'

/** 单条上限下界：200。再低就成了「一句话拆成五条」，本身就是机器人特征。 */
export const CHUNK_MIN = 200

/** 令牌桶下界：1。0 等于关掉通道，那不是配置是开关。 */
export const RATE_FLOOR = 1

/** 每分钟上界：60。再高在 QQ 上必然被限。 */
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

/** 状态文件名后缀。 */
export const STATE_FILE_SUFFIX = '.state.json'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '通道开关。默认关：一个通道装上去就连、就以真实账号的身份说话，那是事故不是功能。',
  },
  credentialFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '凭据文件绝对路径。留空则用数据目录下的 user/channels/qq-official.json（0600）。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '防封状态文件绝对路径。留空则用 user/channels/qq-official.state.json。重启清零等于给防封开后门。',
  },
  chunkMax: {
    kind: 'number',
    default: CHUNK_MAX,
    min: CHUNK_MIN,
    max: CHUNK_MAX,
    advancedOnly: true,
    doc: `单条正文上限（${CHUNK_MIN}–${CHUNK_MAX}）。平台硬上限 1200，只能往下调。`,
  },
  contentMaxLen: {
    kind: 'number',
    default: CONTENT_MAX_LEN,
    min: 200,
    max: 20_000,
    advancedOnly: true,
    doc: '内容闸长度（手册 §5.3-1：1800）。超过直接不发——超长正文最容易被判定为机器生成。',
  },
  blockPatterns: {
    kind: 'json',
    default: [],
    advancedOnly: true,
    doc: '内容闸正则数组（手册 §5.3-1 的三类：赌博 / 诈骗代办 / 色情）。出厂为空：手册未给正则原文，不编造；填错的正则会逐条丢弃并提示。',
  },
  quietEnabled: {
    kind: 'boolean',
    default: true,
    doc: '深夜静默开关（手册 §5.3-2：00:30–07:30）。**只拦主动发言**，被叫照回。',
  },
  quietStart: {
    kind: 'string',
    default: QUIET_START,
    pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    advancedOnly: true,
    doc: '静默开始（HH:MM，东八区）。',
  },
  quietEnd: {
    kind: 'string',
    default: QUIET_END,
    pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    advancedOnly: true,
    doc: '静默结束（HH:MM，东八区）。',
  },
  dedupeWindowMs: {
    kind: 'number',
    default: 1_800_000,
    min: 1_000,
    max: DEDUPE_CEIL,
    advancedOnly: true,
    doc: '重复去重窗口（毫秒）。手册 §5.3-3 取 30 分钟。',
  },
  dedupeMinLen: {
    kind: 'number',
    default: 4,
    min: 1,
    max: 32,
    advancedOnly: true,
    doc: '参与去重的最短长度（手册 §5.3-3：4）。放过「嗯」「好」这类人类会重复的短回复。',
  },
  perMinute: {
    kind: 'number',
    default: 20,
    min: RATE_FLOOR,
    max: PER_MINUTE_CEIL,
    doc: '令牌桶：每分钟上限（手册 §5.3-4：20）。',
  },
  perHour: {
    kind: 'number',
    default: 200,
    min: RATE_FLOOR,
    max: PER_HOUR_CEIL,
    advancedOnly: true,
    doc: '令牌桶：每小时上限（200）。只做分钟上限是踩过的坑。',
  },
  perDay: {
    kind: 'number',
    default: 1500,
    min: RATE_FLOOR,
    max: PER_DAY_CEIL,
    advancedOnly: true,
    doc: '令牌桶：每天上限（1500）。腾讯看长期曲线。',
  },
  cooldownGroupMs: {
    kind: 'number',
    default: 5_000,
    min: 0,
    max: COOLDOWN_CEIL,
    advancedOnly: true,
    doc: '群会话冷却（毫秒，手册 §5.3-5：5 秒）。',
  },
  cooldownPrivateMs: {
    kind: 'number',
    default: 3_000,
    min: 0,
    max: COOLDOWN_CEIL,
    advancedOnly: true,
    doc: '私聊会话冷却（毫秒，3 秒）。',
  },
  jitterMs: {
    kind: 'number',
    default: 400,
    min: 0,
    max: JITTER_CEIL,
    advancedOnly: true,
    doc: '发送前随机抖动（毫秒，手册 §5.3-6：400）。固定节奏本身就是自动化特征。',
  },
  circuitStrikes: {
    kind: 'number',
    default: 3,
    min: RATE_FLOOR,
    max: STRIKES_CEIL,
    advancedOnly: true,
    doc: '连续命中风控几次就熔断（手册 §5.3-6：3）。',
  },
  circuitCooldownMs: {
    kind: 'number',
    default: 1_800_000,
    min: 60_000,
    max: CIRCUIT_CEIL,
    advancedOnly: true,
    doc: '熔断时长（毫秒，30 分钟）。被盯上时唯一正确的做法是完全闭嘴。',
  },
  failureStopMs: {
    kind: 'number',
    default: 300_000,
    min: 10_000,
    max: CIRCUIT_CEIL,
    advancedOnly: true,
    doc: '连续失败 3 次后停发多久（毫秒，5 分钟）。',
  },
  replyTimeoutMs: {
    kind: 'number',
    default: 60_000,
    min: 5_000,
    max: 600_000,
    advancedOnly: true,
    doc: '等一次人格回复的超时（毫秒）。超时按半句话处理：不默认发出去。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '闸门状态是否落盘（手册 §5.3-7）。关掉后重启会清零，等于给防封开后门。',
  },
  persistMs: {
    kind: 'number',
    default: 5_000,
    min: 1_000,
    max: 60_000,
    advancedOnly: true,
    doc: '状态落盘节流（毫秒）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次发送打一行日志。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  credentialFile: FIELD_SPECS.credentialFile.default as string,
  stateFile: FIELD_SPECS.stateFile.default as string,
  chunkMax: FIELD_SPECS.chunkMax.default as number,
  contentMaxLen: FIELD_SPECS.contentMaxLen.default as number,
  blockPatterns: Object.freeze([]) as readonly string[],
  quietEnabled: FIELD_SPECS.quietEnabled.default as boolean,
  quietStart: FIELD_SPECS.quietStart.default as string,
  quietEnd: FIELD_SPECS.quietEnd.default as string,
  dedupeWindowMs: FIELD_SPECS.dedupeWindowMs.default as number,
  dedupeMinLen: FIELD_SPECS.dedupeMinLen.default as number,
  perMinute: FIELD_SPECS.perMinute.default as number,
  perHour: FIELD_SPECS.perHour.default as number,
  perDay: FIELD_SPECS.perDay.default as number,
  cooldownGroupMs: FIELD_SPECS.cooldownGroupMs.default as number,
  cooldownPrivateMs: FIELD_SPECS.cooldownPrivateMs.default as number,
  jitterMs: FIELD_SPECS.jitterMs.default as number,
  circuitStrikes: FIELD_SPECS.circuitStrikes.default as number,
  circuitCooldownMs: FIELD_SPECS.circuitCooldownMs.default as number,
  failureStopMs: FIELD_SPECS.failureStopMs.default as number,
  replyTimeoutMs: FIELD_SPECS.replyTimeoutMs.default as number,
  persist: FIELD_SPECS.persist.default as boolean,
  persistMs: FIELD_SPECS.persistMs.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  credentialFile: 'credential-file',
  stateFile: 'state-file',
  chunkMax: 'chunk-max',
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

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: 'QQ（官方机器人）',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adapter-qq-official',
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
 * 归一化内容闸正则。
 *
 * 逐条校验：写得出来的正则才留下，写不出来的丢掉并计数——
 * 一条坏正则（少个括号）会让 `new RegExp` 抛错，如果整表因此失效，
 * 内容闸就等于静默关掉了，而这正是最不该静默的地方。
 * @param value 原始值。
 * @param onBad 有坏正则时的回调（参数为原文）。
 */
function normalizePatterns(value: unknown, onBad: (text: string) => void): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    try {
      // 只试编译，不用它匹配：编译期就失败的正则，运行期一定失败。
      new RegExp(text)
      out.push(text)
    } catch {
      onBad(text)
    }
  }
  return Object.freeze(out)
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBadPattern 坏正则回调（可选）。
 */
export function completeConfig(value: unknown, onBadPattern?: (text: string) => void): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const str = (key: keyof Config, fallback: string): string => {
    const given = raw[key]
    return typeof given === 'string' ? given : fallback
  }
  const clock = (key: keyof Config, fallback: string): string => {
    const given = str(key, fallback)
    // 不合法就回退默认，而不是留一个「静默时段永远不生效」的坏值。
    return parseClock(given) === null ? fallback : given
  }

  const quietStart = clock('quietStart', DEFAULT_CONFIG.quietStart)
  const quietEnd = clock('quietEnd', DEFAULT_CONFIG.quietEnd)

  const reportBad = (text: string): void => {
    if (onBadPattern !== undefined) onBadPattern(text)
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    credentialFile: str('credentialFile', DEFAULT_CONFIG.credentialFile).trim(),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile).trim(),
    chunkMax: clampInt(raw['chunkMax'], DEFAULT_CONFIG.chunkMax, CHUNK_MIN, CHUNK_MAX),
    contentMaxLen: clampInt(raw['contentMaxLen'], DEFAULT_CONFIG.contentMaxLen, 200, 20_000),
    blockPatterns: normalizePatterns(raw['blockPatterns'], reportBad),
    quietEnabled: bool('quietEnabled', DEFAULT_CONFIG.quietEnabled),
    quietStart,
    quietEnd,
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
 * @returns 被改过的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['chunkMax', CHUNK_MIN, CHUNK_MAX],
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
  return drift
}
