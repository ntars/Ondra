/**
 * O-144 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * ## 十二个值里只有两个是手册给的
 *
 * `reflex-threshold = 3` 与 `chain-min-steps = 3` 是手册逐字（「同工具×同因失败 3 次」、
 * 「跨器官 ≥3 步成功链」）。其余十个是工程取值：
 * `max-reflexes 128` / `chain-min-tools 2` / `chain-repeats 2` / `chain-gap-ms 600000` /
 * `max-chain-steps 8` / `signature-steps 6` / `max-candidates 64` / `enable true` /
 * `persist true` / `verbose false`。
 *
 * **不要把工程取值写成「手册规定」**——那会让下一个人以为改不了。
 *
 * ## `chain-repeats = 2` 的依据不在 O-144 那一条里
 *
 * 手册 §2.A 把「跨工具成功链重复 ≥2」写成 playbook 的判据（agent-body 的五类卡片）。
 * O-144 那一行只说「≥3 步成功链固化为 skill」，没说重复几次。一次就走通的链，
 * 很可能只是巧合（用户第一次碰巧按那个顺序问）；所以按 playbook 的口径要求重复 2 次，
 * 并把 `chain-repeats` 留成可配（设 1 就是「走一遍就固化」）。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `available=false`，不再写反射与候选。 */
  readonly enable: boolean
  /** 同工具×同因失败几次成反射。手册逐字 3。 */
  readonly reflexThreshold: number
  /** 反射条数上限。满了拒收新规则，**不淘汰旧的**。 */
  readonly maxReflexes: number
  /** 一条链至少几步。手册逐字 3。 */
  readonly chainMinSteps: number
  /** 一条链至少跨几个工具（「跨器官」的代理指标）。 */
  readonly chainMinTools: number
  /** 同一条链走通几次才结晶。 */
  readonly chainRepeats: number
  /** 相邻两步的最大间隔（毫秒）；超了就当前一条链结束。 */
  readonly chainGapMs: number
  /** 一条链最多几步；到了就结算并重开，防止长会话里一条链无限长。 */
  readonly maxChainSteps: number
  /** 签名取前几步。签名太长会让「同一条链」判不出来。 */
  readonly signatureSteps: number
  /** skill 候选上限。 */
  readonly maxCandidates: number
  /** 是否落盘（有存储后端时）。 */
  readonly persist: boolean
  /** 每次成型一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'reflex'

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  reflexThreshold: 'reflex-threshold',
  maxReflexes: 'max-reflexes',
  chainMinSteps: 'chain-min-steps',
  chainMinTools: 'chain-min-tools',
  chainRepeats: 'chain-repeats',
  chainGapMs: 'chain-gap-ms',
  maxChainSteps: 'max-chain-steps',
  signatureSteps: 'signature-steps',
  maxCandidates: 'max-candidates',
  persist: 'persist',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册（`available=false`），反射与候选仍可查（只是不再增长）。',
  },
  reflexThreshold: {
    kind: 'number',
    default: 3,
    min: 2,
    max: 32,
    doc: '同工具×同因失败几次成反射。**手册逐字 3**。',
  },
  maxReflexes: {
    kind: 'number',
    default: 128,
    min: 8,
    max: 4_096,
    advancedOnly: true,
    doc: '反射条数上限。满了拒收并计数，**不淘汰旧的**（淘汰会让一条长期有效的规则悄悄消失）。',
  },
  chainMinSteps: {
    kind: 'number',
    default: 3,
    min: 2,
    max: 32,
    doc: '一条链至少几步。**手册逐字 3**。',
  },
  chainMinTools: {
    kind: 'number',
    default: 2,
    min: 2,
    max: 32,
    doc: '一条链至少跨几个工具（「跨器官」的代理指标）。设 1 等于允许单工具重复固化成 skill。',
  },
  chainRepeats: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 32,
    doc: '同一条链走通几次才结晶。手册 §2.A 的 playbook 口径是 2；设 1 就是走一遍就固化。',
  },
  chainGapMs: {
    kind: 'number',
    default: 600_000,
    min: 10_000,
    max: 86_400_000,
    advancedOnly: true,
    doc: '相邻两步的最大间隔。超了就当上一条链已结束——否则隔天再走一遍会被算成同一条。',
  },
  maxChainSteps: {
    kind: 'number',
    default: 8,
    min: 3,
    max: 64,
    advancedOnly: true,
    doc: '一条链最多几步；到了就结算并重开。不设上限会让一条长链一直挂着，既不结算也不释放。',
  },
  signatureSteps: {
    kind: 'number',
    default: 6,
    min: 3,
    max: 16,
    advancedOnly: true,
    doc: '签名取前几步。取全部会让「八步链」与「十步链」永远不是同一条。',
  },
  maxCandidates: {
    kind: 'number',
    default: 64,
    min: 4,
    max: 1_024,
    advancedOnly: true,
    doc: 'skill 候选上限。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '是否落盘。有存储后端时关掉重启即从零开始数，`stats().persisted` 会明说。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次成型一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  reflexThreshold: 3,
  maxReflexes: 128,
  chainMinSteps: 3,
  chainMinTools: 2,
  chainRepeats: 2,
  chainGapMs: 600_000,
  maxChainSteps: 8,
  signatureSteps: 6,
  maxCandidates: 64,
  persist: true,
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
  title: '反射弧与链路结晶',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-reflex',
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
    reflexThreshold: Math.trunc(clampNum(raw['reflexThreshold'], DEFAULT_CONFIG.reflexThreshold, 2, 32)),
    maxReflexes: Math.trunc(clampNum(raw['maxReflexes'], DEFAULT_CONFIG.maxReflexes, 8, 4_096)),
    chainMinSteps: Math.trunc(clampNum(raw['chainMinSteps'], DEFAULT_CONFIG.chainMinSteps, 2, 32)),
    chainMinTools: Math.trunc(clampNum(raw['chainMinTools'], DEFAULT_CONFIG.chainMinTools, 2, 32)),
    chainRepeats: Math.trunc(clampNum(raw['chainRepeats'], DEFAULT_CONFIG.chainRepeats, 1, 32)),
    chainGapMs: Math.trunc(clampNum(raw['chainGapMs'], DEFAULT_CONFIG.chainGapMs, 10_000, 86_400_000)),
    maxChainSteps: Math.trunc(clampNum(raw['maxChainSteps'], DEFAULT_CONFIG.maxChainSteps, 3, 64)),
    signatureSteps: Math.trunc(clampNum(raw['signatureSteps'], DEFAULT_CONFIG.signatureSteps, 3, 16)),
    maxCandidates: Math.trunc(clampNum(raw['maxCandidates'], DEFAULT_CONFIG.maxCandidates, 4, 1_024)),
    persist: bool('persist', DEFAULT_CONFIG.persist),
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
    'reflexThreshold',
    'maxReflexes',
    'chainMinSteps',
    'chainMinTools',
    'chainRepeats',
    'chainGapMs',
    'maxChainSteps',
    'signatureSteps',
    'maxCandidates',
  ]
  for (const key of numeric) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item)) drift.push(key)
  }
  return Object.freeze(drift)
}
