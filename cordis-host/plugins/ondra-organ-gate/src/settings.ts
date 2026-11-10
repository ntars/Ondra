/**
 * O-138 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * ## 为什么没有 `enable`
 *
 * 别的插件是「开关 + 模式」两个字段（例如 O-132 的 `enable` + `chargeMode`），
 * 因为那两件事是**两个轴**：装不装、以及装了什么之后怎么算。本包不是——
 * `mode` 里的 `off` 就是关。再给一个 `enable` 会出现「enable=true 但 mode=off」
 * 这种两个字段打架的配置，而且谁赢要靠读代码才知道。
 * **一个开关只有一个意思。**
 *
 * ## 为什么默认 `observe` 而不是 `enforce`
 *
 * 手册那个 84.7% 是 agent-body 在它自己的 48 条命令上量的，规则表也是它自己写的。
 * 本包的默认规则表是照着上游**真实存在**的工具名（`read` / `edit` / `write` /
 * `glob` / `grep` / `bash` / `pwsh` / `terminal_*`）写的，但它没有在真实会话里
 * 跑过——本轮禁止实装运行，这一点必须诚实。
 *
 * 门控错了的代价不对称：多花 token 只是贵，摘错工具会让模型以为「我没这个能力」，
 * 然后编一个替代路径出来（手册 §8.6 原话：Agent 犯错是结构性的，脑子里缺信息）。
 * 所以先 observe 跑一段，看报告里的 `matched` 与 `denied` 合不合常理，再翻 enforce。
 * 这与 O-132 的 shadow 计费是同一套迁移纪律：**先记账，再真扣。**
 *
 * ## 三个熔断阈值都是工程取值
 *
 * 手册只给了「按需暴露」四个字，没给比例。`min-tools-to-gate 8` /
 * `min-keep-tools 4` / `max-deny-ratio 0.9` 是本包补的，已在 README 标「待裁决」。
 * 它们的共同作用是：**任何一次门控都不许把工具摘到危险区。**
 * 比例上限故意留得宽（0.9）：手册那个 84.7% 的目标本身就要摘掉八成半，
 * 把上限压到 0.75 等于让本包永远达不到它存在的理由。真正防「摘空」的是
 * 绝对下限 `min-keep-tools`。
 */

import type { GateMode } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 模式：off / observe（默认）/ enforce。 */
  readonly mode: GateMode
  /** 可见工具少于这个数就不门控（没什么可省的，风险却是实的）。 */
  readonly minToolsToGate: number
  /** 门控后至少要剩下这么多工具，否则整轮放弃。 */
  readonly minKeepTools: number
  /** 要摘掉的比例超过它，整轮放弃。 */
  readonly maxDenyRatio: number
  /** 码位 → token 的估算除数。只用于报告，不参与决策。 */
  readonly charsPerToken: number
  /** 留痕条数上限。 */
  readonly reportLimit: number
  /** 额外硬保护的工具名（叠加在内置的 `run_code` 之上）。 */
  readonly neverDeny: readonly string[]
  /** 取用户原话时最多看多少码位。 */
  readonly intentChars: number
  /** 每步一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'organ-gate'

/** 模式候选值。 */
export const GATE_MODES: readonly GateMode[] = Object.freeze(['off', 'observe', 'enforce'])

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  mode: 'mode',
  minToolsToGate: 'min-tools-to-gate',
  minKeepTools: 'min-keep-tools',
  maxDenyRatio: 'max-deny-ratio',
  charsPerToken: 'chars-per-token',
  reportLimit: 'report-limit',
  neverDeny: 'never-deny',
  intentChars: 'intent-chars',
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
  mode: {
    kind: 'enum',
    values: GATE_MODES,
    default: 'observe',
    doc: '`off` 不做事 / `observe` 只算不拦（默认，先看报告）/ `enforce` 真摘。',
  },
  minToolsToGate: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 256,
    advancedOnly: true,
    doc: '可见工具少于这个数就不门控。**8 是工程取值**，手册没给数字。',
  },
  minKeepTools: {
    kind: 'number',
    default: 4,
    min: 1,
    max: 128,
    advancedOnly: true,
    doc: '门控后至少剩下这么多工具，否则整轮放弃。**4 是工程取值**。',
  },
  maxDenyRatio: {
    kind: 'number',
    default: 0.9,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '要摘掉的比例超过它整轮放弃。**0.9 是工程取值**：它只拦「几乎全摘」的极端情况，真正的兜底是 `minKeepTools`。',
  },
  charsPerToken: {
    kind: 'number',
    default: 4,
    min: 1,
    max: 16,
    advancedOnly: true,
    doc: '码位 → token 的估算除数。只影响报告里的估算值，不影响摘谁。',
  },
  reportLimit: {
    kind: 'number',
    default: 50,
    min: 1,
    max: 500,
    advancedOnly: true,
    doc: '决策留痕条数上限（只在内存）。',
  },
  neverDeny: {
    kind: 'json',
    default: Object.freeze([] as readonly string[]),
    advancedOnly: true,
    doc: '额外硬保护的工具名。内置的 `run_code` 不在此列，它永远不可摘。',
  },
  intentChars: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2_000,
    advancedOnly: true,
    doc: '取用户原话时最多看多少码位。越长误命中越多（长文里必然出现「文件」「代码」）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每步一行日志（命中规则、摘几个、省多少）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  mode: 'observe',
  minToolsToGate: 8,
  minKeepTools: 4,
  maxDenyRatio: 0.9,
  charsPerToken: 4,
  reportLimit: 50,
  neverDeny: Object.freeze([] as readonly string[]),
  intentChars: 200,
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
  title: '工具门控',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, (typeof FIELD_SPECS)[keyof Config]>>,
  owner: 'ondra-organ-gate',
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
 * 归一化工具名白名单：只留合规名、去重、去空。
 * @param value 原始值。
 * @param onBad 坏条目回调。
 */
function normalizeNames(
  value: unknown,
  onBad: (text: string, kind: string) => void,
): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      onBad(String(item), 'neverDeny')
      continue
    }
    const text = item.trim()
    if (text === '') continue
    // 工具名不合规（§8.4）说明它一定不存在：留着一个永远匹配不到的名字，
    // 只会让人以为「我已经保护了它」。
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(text)) {
      onBad(text, 'neverDeny')
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
  const mode: GateMode =
    raw['mode'] === 'off' || raw['mode'] === 'enforce' || raw['mode'] === 'observe'
      ? raw['mode']
      : DEFAULT_CONFIG.mode

  return Object.freeze({
    mode,
    minToolsToGate: Math.trunc(clampNum(raw['minToolsToGate'], DEFAULT_CONFIG.minToolsToGate, 1, 256)),
    minKeepTools: Math.trunc(clampNum(raw['minKeepTools'], DEFAULT_CONFIG.minKeepTools, 1, 128)),
    maxDenyRatio: clampNum(raw['maxDenyRatio'], DEFAULT_CONFIG.maxDenyRatio, 0, 1),
    charsPerToken: clampNum(raw['charsPerToken'], DEFAULT_CONFIG.charsPerToken, 1, 16),
    reportLimit: Math.trunc(clampNum(raw['reportLimit'], DEFAULT_CONFIG.reportLimit, 1, 500)),
    neverDeny:
      raw['neverDeny'] === undefined
        ? DEFAULT_CONFIG.neverDeny
        : normalizeNames(raw['neverDeny'], report),
    intentChars: Math.trunc(clampNum(raw['intentChars'], DEFAULT_CONFIG.intentChars, 20, 2_000)),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}

/**
 * 配置有没有被悄悄改过（夹紧、丢弃、枚举回退）。
 *
 * 存在的理由：`completeConfig` **永不抛错**，所以「你填了但没生效」这条路是
 * 完全静默的。这一项把它摊到日志上。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const given = raw['mode']
  if (given !== undefined && given !== 'off' && given !== 'observe' && given !== 'enforce') {
    drift.push('mode')
  }

  const numeric: readonly (keyof Config)[] = [
    'minToolsToGate',
    'minKeepTools',
    'maxDenyRatio',
    'charsPerToken',
    'reportLimit',
    'intentChars',
  ]
  for (const key of numeric) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item)) drift.push(key)
  }

  const never = raw['neverDeny']
  if (never !== undefined) {
    const list = Array.isArray(never) ? never : typeof never === 'string' ? never.split(',') : []
    if (!Array.isArray(never) && typeof never !== 'string') {
      drift.push('neverDeny')
    } else if (list.some(item => typeof item === 'string' && item.trim() !== '' && !/^[a-z][a-z0-9_-]{1,63}$/.test(item.trim()))) {
      // 不合规的工具名被丢掉了：这一定会让人以为「我保护了它」。
      drift.push('neverDeny')
    }
  }

  return Object.freeze(drift)
}
