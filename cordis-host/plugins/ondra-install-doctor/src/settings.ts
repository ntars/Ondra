/**
 * O-133 配置的**单一真源**。
 *
 * ## 三个刻意的默认值
 *
 * 1. **`profile-path` 默认空 = 什么都不扫。** 猜一个路径会让报告对着错的目录跑出
 *    「全部通过」——那是假的安全感，比没有报告坏。空着就如实报 `no-profile`。
 * 2. **`max-file-bytes` 默认 256 KiB**：本仓最大的 `cordis.patch.yml` 在 4 KB 量级，
 *    256 KiB 是「绝不会误伤、也绝不会读到 100 MB 日志」的折中。
 * 3. **`user-layer` 默认 true**：profile 自己的 `cordis.patch.yml` 是真实生效的最后一层，
 *    不算进去就会漏报「用户在 profile 里把这个包 disable 了」。
 */

import type { Config } from './types.js'

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'install-doctor'

/** 配置类型即 `types.ts` 的 `Config`（单一真源，不另立一套）。 */
export type Settings = Config

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Settings, string>> = Object.freeze({
  enable: 'enable',
  profilePath: 'profile-path',
  userLayer: 'user-layer',
  maxFileBytes: 'max-file-bytes',
  verbose: 'verbose',
  ttlMs: 'ttl-ms',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 单文件上限：256 KiB。 */
export const MAX_FILE_BYTES = 256 * 1024

/** 报告缓存有效期：30 秒。**不做定时器**，TTL 在读取时比对。 */
export const DEFAULT_TTL_MS = 30_000

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Settings, {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly advancedOnly?: boolean
  readonly doc: string
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
}>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '体检开关。关掉只是不查，不影响任何插件加载（本包**只判定不拦启动**）。',
  },
  profilePath: {
    kind: 'string',
    default: '',
    doc: 'profile 目录的绝对路径。**空 = 不扫**，`reason` 会如实报 `no-profile`（不猜路径）。',
  },
  userLayer: {
    kind: 'boolean',
    default: true,
    doc: '是否把 profile 自己的 `cordis.patch.yml` 当作最后一层。',
  },
  maxFileBytes: {
    kind: 'number',
    default: MAX_FILE_BYTES,
    min: 1024,
    max: 4 * 1024 * 1024,
    advancedOnly: true,
    doc: '单文件最大字节数；超过按「太大，判不了」处理，不硬读。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每条告警一行日志。',
  },
  ttlMs: {
    kind: 'number',
    default: DEFAULT_TTL_MS,
    min: 0,
    max: 600_000,
    advancedOnly: true,
    doc: '报告缓存有效期（毫秒），0 = 每次都重读磁盘。',
    unit: '毫秒',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Settings = Object.freeze({
  enable: true,
  profilePath: '',
  userLayer: true,
  maxFileBytes: MAX_FILE_BYTES,
  verbose: false,
  ttlMs: DEFAULT_TTL_MS,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Settings>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Settings]),
  ),
)

/** 查表版。 */
const SECTION_MAP: ReadonlyMap<string, keyof Settings> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Settings])[],
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '安装自检',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Settings)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, (typeof FIELD_SPECS)[keyof Settings]>>,
  owner: 'ondra-install-doctor',
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
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Settings {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const bool = (key: keyof Settings, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    profilePath: typeof raw['profilePath'] === 'string' ? raw['profilePath'].trim() : '',
    userLayer: bool('userLayer', DEFAULT_CONFIG.userLayer),
    maxFileBytes: clampInt(raw['maxFileBytes'], DEFAULT_CONFIG.maxFileBytes, 1024, 4 * 1024 * 1024),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
    ttlMs: clampInt(raw['ttlMs'], DEFAULT_CONFIG.ttlMs, 0, 600_000),
  })
}

/**
 * 配置有没有被悄悄改过。
 *
 * `completeConfig` 永不抛错，所以「你填了但没生效」这条路完全静默。这一项把它摊到日志上。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []
  const path = raw['profilePath']
  if (path !== undefined && typeof path !== 'string') drift.push('profilePath')
  for (const key of ['maxFileBytes', 'ttlMs'] as const) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item)) drift.push(key)
  }
  return Object.freeze(drift)
}
