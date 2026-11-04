/**
 * O-139 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * ## 四个数里只有一个是手册给的
 *
 * `chronic-after-ms = 300000`（5 分钟）是手册逐字。其余三个是工程取值：
 * `max-open-wounds 256` / `max-healed-history 100` / `max-text-chars 500`。
 * 已在 README「待裁决」列出。**不要把工程取值写成「手册规定」**——
 * 那会让下一个人以为改不了。
 *
 * ## `max-retries` 只管两类
 *
 * 只有 `timeout` 与 `network` 会用到它（`unknown` 恒 1 次，其余五类恒 0 次）。
 * 它**管不到 `arg_error`**：那条铁律写在 `prescribe.ts` 的 `retryBudget()` 第一行，
 * 在查表之前。配置改不动它，这是刻意的。
 *
 * ## `feed-host` 为什么要给开关
 *
 * 本包会把每个工具结果喂给 O-132 的器官宿主（`host.toolResult()`），
 * 这是 `onToolResult` 唯一的喂食来源——O-132 自己不装监听器（它连定时器都不装）。
 * 但「唯一喂食者」是个**约定**，不是结构保证：若将来有第二个喂食者，
 * 器官会收到两份同样的结果。所以给一个能关的开关，并把约定写进 README。
 */

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `available=false`，且不喂宿主。 */
  readonly enable: boolean
  /** 伤口多久没闭合标 chronic（毫秒）。手册逐字 5 分钟。 */
  readonly chronicAfterMs: number
  /** 未闭合伤口上限。满了拒绝新伤口，**不淘汰旧的**。 */
  readonly maxOpenWounds: number
  /** 已闭合历史保留条数。 */
  readonly maxHealedHistory: number
  /** 喂给器官宿主的正文最多多少码位。 */
  readonly maxTextChars: number
  /** 可重试类（超时 / 网络）最多重试几次。 */
  readonly maxRetries: number
  /** 是否把工具结果喂给 O-132 的器官宿主。 */
  readonly feedHost: boolean
  /** 每次归因一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'failure-attrib'

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  chronicAfterMs: 'chronic-after-ms',
  maxOpenWounds: 'max-open-wounds',
  maxHealedHistory: 'max-healed-history',
  maxTextChars: 'max-text-chars',
  maxRetries: 'max-retries',
  feedHost: 'feed-host',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly advancedOnly?: boolean
  readonly doc: string
}>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册（`available=false`），也不喂器官宿主。',
  },
  chronicAfterMs: {
    kind: 'number',
    default: 300_000,
    min: 10_000,
    max: 3_600_000,
    doc: '伤口多久没闭合标 chronic。**手册逐字 5 分钟**（300000）。',
  },
  maxOpenWounds: {
    kind: 'number',
    default: 256,
    min: 8,
    max: 4_096,
    advancedOnly: true,
    doc: '未闭合伤口上限。满了拒绝新伤口并计数，**不淘汰旧的**（淘汰会让 chronic 悄悄消失）。',
  },
  maxHealedHistory: {
    kind: 'number',
    default: 100,
    min: 8,
    max: 2_000,
    advancedOnly: true,
    doc: '已闭合历史保留条数（只在内存）。',
  },
  maxTextChars: {
    kind: 'number',
    default: 500,
    min: 0,
    max: 4_000,
    advancedOnly: true,
    doc: '喂给器官宿主的正文最多多少码位。器官不需要全文。',
  },
  maxRetries: {
    kind: 'number',
    default: 2,
    min: 0,
    max: 5,
    advancedOnly: true,
    doc: '超时 / 网络类最多重试几次。**管不到 `arg_error`**（铁律恒 0）。',
  },
  feedHost: {
    kind: 'boolean',
    default: true,
    doc: '是否把工具结果喂给 O-132 的器官宿主。本包是 `onToolResult` 的唯一喂食者。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次归因一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  chronicAfterMs: 300_000,
  maxOpenWounds: 256,
  maxHealedHistory: 100,
  maxTextChars: 500,
  maxRetries: 2,
  feedHost: true,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 查表版。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '失败归因',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, (typeof FIELD_SPECS)[keyof Config]>>,
  owner: 'ondra-failure-attrib',
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
 * 把 O-005 的解析结果回填成 Config 形状。
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
 * 夹一个数字。
 * @param value 待夹值。
 * @param fallback 回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    chronicAfterMs: Math.trunc(clampNum(raw['chronicAfterMs'], DEFAULT_CONFIG.chronicAfterMs, 10_000, 3_600_000)),
    maxOpenWounds: Math.trunc(clampNum(raw['maxOpenWounds'], DEFAULT_CONFIG.maxOpenWounds, 8, 4_096)),
    maxHealedHistory: Math.trunc(clampNum(raw['maxHealedHistory'], DEFAULT_CONFIG.maxHealedHistory, 8, 2_000)),
    maxTextChars: Math.trunc(clampNum(raw['maxTextChars'], DEFAULT_CONFIG.maxTextChars, 0, 4_000)),
    maxRetries: Math.trunc(clampNum(raw['maxRetries'], DEFAULT_CONFIG.maxRetries, 0, 5)),
    feedHost: bool('feedHost', DEFAULT_CONFIG.feedHost),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（夹紧、丢弃）。
 *
 * `completeConfig` 永不抛错，所以「你填了但没生效」是完全静默的。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []
  const numeric: readonly (keyof Config)[] = [
    'chronicAfterMs',
    'maxOpenWounds',
    'maxHealedHistory',
    'maxTextChars',
    'maxRetries',
  ]
  for (const key of numeric) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item)) drift.push(key)
  }
  return Object.freeze(drift)
}
