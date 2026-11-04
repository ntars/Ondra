/**
 * O-143 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * ## 七个值里只有一个是手册给的
 *
 * `requireDurable = true` 是手册原话「压缩前状态先写 SQLite」的直接推论——
 * 它不是一个数，而是一条顺序约束，所以它落在布尔位上。
 *
 * 其余六个都是工程取值：`maxSpanChars 4000` / `minSavingsChars 64` /
 * `maxRecords 512` / `verifyOnRecall true` / `mode observe` / `verbose false`。
 * **不要把它们写成「手册规定」**——那会让下一个人以为改不了。
 *
 * ## 为什么默认是 `observe` 而不是 `compact`
 *
 * 零常驻的收益（少 token）与代价（前缀换一次、多条恢复路径）不在同一个量级上：
 * 省错了只是多花字，压错了是**内容消失**。所以第一版默认只算不干，
 * 先把 `fast()` 与 `ledger()` 的数看一遍，再翻 `compact`。与 O-138 同一套纪律。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 三档模式：off / observe / compact。 */
  readonly mode: 'off' | 'observe' | 'compact'
  /** 单条记录最多多少字符；超了就在安全边界切开，切成多条。 */
  readonly maxSpanChars: number
  /** 省下的字符少于这个数就不压（指针本身也要占字）。 */
  readonly minSavingsChars: number
  /** 账本条数上限。满了拒收新记录，**不淘汰旧的**。 */
  readonly maxRecords: number
  /** 是否要求「先落盘再交指针」。手册逐条要求，默认开。 */
  readonly requireDurable: boolean
  /** 恢复时是否校验长度与指纹。 */
  readonly verifyOnRecall: boolean
  /** 每次压缩一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'zero-residence'

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  mode: 'mode',
  maxSpanChars: 'max-span-chars',
  minSavingsChars: 'min-savings-chars',
  maxRecords: 'max-records',
  requireDurable: 'require-durable',
  verifyOnRecall: 'verify-on-recall',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 三档取值（顺序即文档顺序）。 */
export const ZR_MODES: readonly Config['mode'][] = Object.freeze(['off', 'observe', 'compact'])

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  mode: {
    kind: 'enum',
    default: 'observe',
    options: ZR_MODES,
    doc: '三档：off 什么都不算；observe 只算不写（**默认**）；compact 真写盘真发指针。',
  },
  maxSpanChars: {
    kind: 'number',
    default: 4_000,
    min: 200,
    max: 100_000,
    advancedOnly: true,
    doc: '单条记录最多多少字符。超了在段落 / 空行 / 句号 / 空格处切开，切成多条。',
  },
  minSavingsChars: {
    kind: 'number',
    default: 64,
    min: 0,
    max: 100_000,
    advancedOnly: true,
    doc: '省下的字不够这个数就不压：一条指针约 20 字，省 30 字不值一次账本查询。',
  },
  maxRecords: {
    kind: 'number',
    default: 512,
    min: 8,
    max: 16_384,
    advancedOnly: true,
    doc: '账本条数上限。满了拒收并计数，**不淘汰旧的**（淘汰等于删证据）。',
  },
  requireDurable: {
    kind: 'boolean',
    default: true,
    doc: '要求「先落盘再交指针」。手册逐条：压缩前状态先写 SQLite。关掉后没有存储也能压，但重启即丢。',
  },
  verifyOnRecall: {
    kind: 'boolean',
    default: true,
    doc: '恢复时校验长度与指纹。关掉只影响「可信」标记，不影响能不能取到。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次压缩一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  mode: 'observe',
  maxSpanChars: 4_000,
  minSavingsChars: 64,
  maxRecords: 512,
  requireDurable: true,
  verifyOnRecall: true,
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
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '零常驻上下文',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-zero-residence',
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
  const mode = raw['mode']
  return Object.freeze({
    mode: typeof mode === 'string' && (ZR_MODES as readonly string[]).includes(mode)
      ? (mode as Config['mode'])
      : DEFAULT_CONFIG.mode,
    maxSpanChars: Math.trunc(clampNum(raw['maxSpanChars'], DEFAULT_CONFIG.maxSpanChars, 200, 100_000)),
    minSavingsChars: Math.trunc(clampNum(raw['minSavingsChars'], DEFAULT_CONFIG.minSavingsChars, 0, 100_000)),
    maxRecords: Math.trunc(clampNum(raw['maxRecords'], DEFAULT_CONFIG.maxRecords, 8, 16_384)),
    requireDurable: raw['requireDurable'] === undefined ? DEFAULT_CONFIG.requireDurable : raw['requireDurable'] === true,
    verifyOnRecall: raw['verifyOnRecall'] === undefined ? DEFAULT_CONFIG.verifyOnRecall : raw['verifyOnRecall'] === true,
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
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
  const numeric: readonly (keyof Config)[] = ['maxSpanChars', 'minSavingsChars', 'maxRecords']
  for (const key of numeric) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item)) drift.push(key)
  }
  const mode = raw['mode']
  if (mode !== undefined && !(typeof mode === 'string' && (ZR_MODES as readonly string[]).includes(mode))) {
    drift.push('mode')
  }
  return Object.freeze(drift)
}
