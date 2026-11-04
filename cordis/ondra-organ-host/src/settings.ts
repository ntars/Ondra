/**
 * O-132 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * 四条口径：
 *
 * 1. **`chargeMode` 默认 `shadow`**（手册 §8.2 迁移期双模式）。默认就真扣的后果是
 *    「第一次装上，所有器官一起抢能量，她当场蔫掉」；而 shadow 跑一周能拿到真实
 *    成本分布，再逐个翻 `additive`。**任何一步都能回滚**。
 * 2. **`enforceReceipt` 默认 true**。它是 C2 唯一的牙齿：关掉之后 `consume()` 变成
 *    装饰，器官可以不付钱随便看。允许关，是为了迁移期能先跑通，不是为了常态关。
 * 3. **`minConfidence` 的 0.2 与 `maxFragments` 的 64 是工程取值**，手册只说
 *    「过滤低置信度」与「按 order 排序」，没给数字。已在 README 标「待裁决」。
 * 4. **`deniedCapabilities` 是策略层**，与清单声明叠加（声明了也可能被拒）。
 *    这条让运维能在不改器官代码的前提下，全局关掉某一类能力（例如 `tool.register`）。
 */

import type { Capability, ChargeMode } from './types.js'
import { CAPABILITY_SET } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。关掉后 `register()` 一律拒绝（`reason:'disabled'`）。 */
  readonly enable: boolean
  /** 计费模式。默认 `shadow`。 */
  readonly chargeMode: ChargeMode
  /** 最低置信度（0–1），低于它的片段不注入。 */
  readonly minConfidence: number
  /** 回执有效期（毫秒）。 */
  readonly receiptTtlMs: number
  /** 一次拼装最多采纳几片。 */
  readonly maxFragments: number
  /** 单片正文最大码位数。 */
  readonly maxCharsPerFragment: number
  /** 每个器官键值空间的条目上限。 */
  readonly kvLimit: number
  /** 待提交提议队列上限（条）。 */
  readonly maxPending: number
  /** 全局拒绝的能力（叠加在清单声明之上）。 */
  readonly deniedCapabilities: readonly string[]
  /** 是否强制「先 consume 再 state」。 */
  readonly enforceReceipt: boolean
  /** 每次拼装一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'organ-host'

/** 计费模式候选值。 */
export const CHARGE_MODES: readonly ChargeMode[] = Object.freeze(['shadow', 'additive'])

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  chargeMode: 'charge-mode',
  minConfidence: 'min-confidence',
  receiptTtlMs: 'receipt-ttl-ms',
  maxFragments: 'max-fragments',
  maxCharsPerFragment: 'max-chars-per-fragment',
  kvLimit: 'kv-limit',
  maxPending: 'max-pending',
  deniedCapabilities: 'denied-capabilities',
  enforceReceipt: 'enforce-receipt',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly advancedOnly?: boolean
  readonly doc: string
}>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '器官宿主总开关。关掉后所有 `register()` 一律拒绝，`reason` 为 `disabled`。',
  },
  chargeMode: {
    kind: 'enum',
    values: CHARGE_MODES,
    default: 'shadow',
    doc: '计费模式。`shadow` 只记账不真扣（默认），`additive` 真扣。迁移期先跑 shadow 一周。',
  },
  minConfidence: {
    kind: 'number',
    default: 0.2,
    min: 0,
    max: 1,
    doc: '片段最低置信度；低于它的不注入。**0.2 是工程取值**，手册没给数字。',
  },
  receiptTtlMs: {
    kind: 'number',
    default: 30_000,
    min: 1_000,
    max: 600_000,
    advancedOnly: true,
    doc: '能量回执有效期。过期后要重新 `consume()` 才能读状态。',
  },
  maxFragments: {
    kind: 'number',
    default: 64,
    min: 1,
    max: 512,
    advancedOnly: true,
    doc: '一次拼装最多采纳几片（按 order 升序取前 N）。**64 是工程取值**。',
  },
  maxCharsPerFragment: {
    kind: 'number',
    default: 2_000,
    min: 64,
    max: 20_000,
    advancedOnly: true,
    doc: '单片正文最大码位数；超过整片拒收（截断会让语义半句，比不要更糟）。',
  },
  kvLimit: {
    kind: 'number',
    default: 200,
    min: 8,
    max: 4_096,
    advancedOnly: true,
    doc: '每个器官键值空间的条目上限；到顶后 `set()` 返回 false，**不淘汰别人的键**。',
  },
  maxPending: {
    kind: 'number',
    default: 512,
    min: 16,
    max: 8_192,
    advancedOnly: true,
    doc: '待提交提议队列上限；到顶后新提议被拒并计数（`queue-full`）。',
  },
  deniedCapabilities: {
    kind: 'json',
    default: Object.freeze([] as readonly string[]),
    advancedOnly: true,
    doc: '全局拒绝的能力名（叠加在器官清单声明之上）。默认空。',
  },
  enforceReceipt: {
    kind: 'boolean',
    default: true,
    doc: '是否强制「先 `consume()` 再 `state()`」。**这是 C2 唯一的牙齿**，别常态关。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次拼装打一行日志（片段数、丢弃数、字数）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  chargeMode: 'shadow',
  minConfidence: 0.2,
  receiptTtlMs: 30_000,
  maxFragments: 64,
  maxCharsPerFragment: 2_000,
  kvLimit: 200,
  maxPending: 512,
  deniedCapabilities: Object.freeze([] as readonly string[]),
  enforceReceipt: true,
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
  title: '器官宿主',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, (typeof FIELD_SPECS)[keyof Config]>>,
  owner: 'ondra-organ-host',
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
 * 归一化能力黑名单：只留白名单内、去重、去空。
 * @param value 原始值。
 * @param onBad 坏条目回调。
 */
function normalizeDenied(
  value: unknown,
  onBad: (text: string, kind: string) => void,
): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      onBad(String(item), 'deniedCapabilities')
      continue
    }
    const text = item.trim()
    if (text === '') continue
    // 白名单外的名字没有意义：既不可能被授予，也不可能被拒。直接丢弃并报出来。
    if (!CAPABILITY_SET.has(text)) {
      onBad(text, 'deniedCapabilities')
      continue
    }
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 坏条目回调。
 */
export function completeConfig(
  value: unknown,
  onBad?: (text: string, kind: string) => void,
): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const mode: ChargeMode =
    raw['chargeMode'] === 'additive' ? 'additive' : raw['chargeMode'] === 'shadow' ? 'shadow' : DEFAULT_CONFIG.chargeMode

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    chargeMode: mode,
    minConfidence: clampNum(raw['minConfidence'], DEFAULT_CONFIG.minConfidence, 0, 1),
    receiptTtlMs: Math.trunc(clampNum(raw['receiptTtlMs'], DEFAULT_CONFIG.receiptTtlMs, 1_000, 600_000)),
    maxFragments: Math.trunc(clampNum(raw['maxFragments'], DEFAULT_CONFIG.maxFragments, 1, 512)),
    maxCharsPerFragment: Math.trunc(
      clampNum(raw['maxCharsPerFragment'], DEFAULT_CONFIG.maxCharsPerFragment, 64, 20_000),
    ),
    kvLimit: Math.trunc(clampNum(raw['kvLimit'], DEFAULT_CONFIG.kvLimit, 8, 4_096)),
    maxPending: Math.trunc(clampNum(raw['maxPending'], DEFAULT_CONFIG.maxPending, 16, 8_192)),
    deniedCapabilities:
      raw['deniedCapabilities'] === undefined
        ? DEFAULT_CONFIG.deniedCapabilities
        : normalizeDenied(raw['deniedCapabilities'], report),
    enforceReceipt: bool('enforceReceipt', DEFAULT_CONFIG.enforceReceipt),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 把黑名单折成 `Capability[]`（已保证都在白名单内）。
 * @param values 配置里的字符串数组。
 */
export function deniedCapabilitiesOf(values: readonly string[]): readonly Capability[] {
  const out: Capability[] = []
  for (const item of values) {
    if (CAPABILITY_SET.has(item)) out.push(item as Capability)
  }
  return Object.freeze(out)
}

/**
 * 配置有没有被悄悄改过（夹紧、丢弃、枚举回退）。
 *
 * 存在的理由：`completeConfig` **永不抛错**，所以「你填了但没生效」这条路是
 * 完全静默的。这一项把它摊到日志上——不是报错，是告诉你「这三个值我改过」。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const given = raw['chargeMode']
  if (given !== undefined && given !== 'shadow' && given !== 'additive') drift.push('chargeMode')

  const numeric: readonly (keyof Config)[] = [
    'minConfidence',
    'receiptTtlMs',
    'maxFragments',
    'maxCharsPerFragment',
    'kvLimit',
    'maxPending',
  ]
  for (const key of numeric) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item)) drift.push(key)
  }

  const denied = raw['deniedCapabilities']
  if (denied !== undefined) {
    const list = Array.isArray(denied) ? denied : typeof denied === 'string' ? denied.split(',') : []
    if (!Array.isArray(denied) && typeof denied !== 'string') {
      drift.push('deniedCapabilities')
    } else if (list.some(item => typeof item === 'string' && item.trim() !== '' && !CAPABILITY_SET.has(item.trim()))) {
      // 白名单外的能力名被丢掉了：这一定会让人以为「我关掉了它」。
      drift.push('deniedCapabilities')
    }
  }

  return Object.freeze(drift)
}
