/**
 * O-082 的配置**单一真源**。
 *
 * ## 为什么只有四个字段
 *
 * 首启引导的「规格」全在手册里写死了：状态行两句、标题形状、首条消息由人设发出。
 * 把这些做成配置项，等于允许把验收基线改掉——那验收就没有意义了
 * （§12.3「定案规格不开放配置」）。所以这里只留四个**环境相关**的开关：
 * 开关、状态目录、Node 要求、日志详细度。
 *
 * ## `requiredNodeMajor` 为什么可配
 *
 * 手册 §6.4 写「检查 Node≥20」。20 会过时，而一个过时的硬编码会让所有人都在
 * 升级 Node 之后收到一条「版本太低」——那比不检查更糟。默认仍取 20。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。关掉后所有推进都报 `disabled`。 */
  readonly enable: boolean
  /** 状态目录；空 = `user/onboarding`。 */
  readonly stateDir: string
  /** 要求的 Node 主版本（手册 §6.4：≥20）。 */
  readonly requiredNodeMajor: number
  /** 每次推进一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'onboarding'

/** 手册 §6.4 的要求值。 */
export const DEFAULT_REQUIRED_NODE_MAJOR = 20

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  stateDir: 'state-dir',
  requiredNodeMajor: 'required-node-major',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '首启引导开关。关掉后 `begin()` / `advance()` 一律返回 `disabled`。',
  },
  stateDir: {
    kind: 'string',
    default: '',
    doc: '状态目录。空 = `user/onboarding`（走 O-002，0600 原子写）。',
  },
  requiredNodeMajor: {
    kind: 'number',
    default: DEFAULT_REQUIRED_NODE_MAJOR,
    min: 16,
    max: 40,
    advancedOnly: true,
    doc: '要求的 Node 主版本。手册写 ≥20；可配是因为 20 会过时，硬编码会让升级后的人白挨一条「版本太低」。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次推进一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  stateDir: '',
  requiredNodeMajor: DEFAULT_REQUIRED_NODE_MAJOR,
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
  title: '首启引导',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-onboarding',
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
 * 补全并夹紧配置。**永不抛**。
 * @param value 原始配置。
 * @param onBad 坏条目回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const givenStateDir = raw['stateDir']
  let stateDir = DEFAULT_CONFIG.stateDir
  if (givenStateDir !== undefined) {
    if (typeof givenStateDir === 'string') stateDir = givenStateDir.trim()
    else report(String(givenStateDir), 'stateDir')
  }

  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    stateDir,
    requiredNodeMajor: clampInt(raw['requiredNodeMajor'], DEFAULT_CONFIG.requiredNodeMajor, 16, 40),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}

/**
 * 配置有没有被悄悄改过（类型不对被丢弃）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []
  if (raw['stateDir'] !== undefined && typeof raw['stateDir'] !== 'string') drift.push('stateDir')
  const major = raw['requiredNodeMajor']
  if (major !== undefined && (typeof major !== 'number' || !Number.isFinite(major))) {
    drift.push('requiredNodeMajor')
  }
  return drift
}
