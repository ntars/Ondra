/**
 * 配置的**单一真源**。
 *
 * ## 为什么 `dryRun` 默认 `true`
 *
 * 安装器会写盘、改名、动别人的目录。master-plan §12 定的优先级是
 * 「正确 > 稳定 > 可维护 > 省资源」。一个默认就真落盘的安装器，第一次跑错
 * 的代价是用户重装整个应用；默认演练的代价只是多点一次开关。
 *
 * 所以 `dryRun: true` **不是**保守，是把不可逆操作放到明确的第二次确认之后。
 *
 * ## 为什么三个路径都默认空
 *
 * 安装源、清单、目标三者都不可能「猜」：
 *
 * - 猜清单 → 对着错的清单装出一套错的组件；
 * - 猜来源 → 装到另一个版本的运行时；
 * - 猜目标 → 在用户的目录里凭空长出一棵 `runtime/`。
 *
 * 空着就如实报 `no-manifest` / `no-source` / `no-dest`。这与 O-077 的 `root` 默认空
 * 是同一条纪律：**假的安全感比没有更坏**。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 演练模式：算出全部步骤与结论，但**不写一个字节**。 */
  readonly dryRun: boolean
  /** 清单文件绝对路径。 */
  readonly manifestPath: string
  /** 组件来源目录（组件文件的父目录）。 */
  readonly sourceDir: string
  /** 安装目标目录。 */
  readonly destDir: string
  /** 记账文件路径；空 = `user/.ondra-bootstrap.json`。 */
  readonly ledgerPath: string
  /** 最多接受多少组件。 */
  readonly maxComponents: number
  /** 单组件最大字节数（超过直接判失败，不硬读）。 */
  readonly maxComponentBytes: number
  /** 落盘后再算一次哈希（防写坏）。 */
  readonly verifyAfterCopy: boolean
  /** 允许覆盖「账本里没有记录、但目标位置已有同名文件」的东西。 */
  readonly allowOverwrite: boolean
  /** 每次装完一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'installer'

/** 记账文件名（`user` 区域下）。手册 §4.6 的原话就叫 `.ondra-bootstrap.json`。 */
export const LEDGER_FILE = '.ondra-bootstrap.json'

/** 组件数上限。 */
export const MAX_COMPONENTS = 256

/** 单组件上限：256 MiB。运行时压缩包在 100 MB 量级，留足余量。 */
export const MAX_COMPONENT_BYTES = 256 * 1024 * 1024

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  dryRun: 'dry-run',
  manifestPath: 'manifest-path',
  sourceDir: 'source-dir',
  destDir: 'dest-dir',
  ledgerPath: 'ledger-path',
  maxComponents: 'max-components',
  maxComponentBytes: 'max-component-bytes',
  verifyAfterCopy: 'verify-after-copy',
  allowOverwrite: 'allow-overwrite',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '安装器开关。关掉后 `run()` 直接拒绝，`verify()` 仍可读账本。',
  },
  dryRun: {
    kind: 'boolean',
    default: true,
    doc: '**默认演练**：算出九步结论但不写一个字节。确认无误后再关掉它。',
  },
  manifestPath: {
    kind: 'string',
    default: '',
    doc: '清单文件绝对路径。**空 = 不装**（如实报 `no-manifest`，不猜）。',
  },
  sourceDir: {
    kind: 'string',
    default: '',
    doc: '组件来源目录。**空 = 不装**（如实报 `no-source`）。',
  },
  destDir: {
    kind: 'string',
    default: '',
    doc: '安装目标目录。**空 = 不装**（如实报 `no-dest`）。由壳/引导页在首启时写入。',
  },
  ledgerPath: {
    kind: 'string',
    default: '',
    doc: '记账文件路径。空 = `user/.ondra-bootstrap.json`（0600）。',
  },
  maxComponents: {
    kind: 'number',
    default: MAX_COMPONENTS,
    min: 1,
    max: 4096,
    advancedOnly: true,
    doc: '组件数上限。防一份写坏的清单把安装拖死。',
  },
  maxComponentBytes: {
    kind: 'number',
    default: MAX_COMPONENT_BYTES,
    min: 1024,
    max: 4 * 1024 * 1024 * 1024,
    advancedOnly: true,
    doc: '单组件最大字节数；超过判失败（不硬读，也不半读）。',
  },
  verifyAfterCopy: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '落盘后再算一次哈希再改名。关掉能省一次全文件读，但写坏了查不出来。',
  },
  allowOverwrite: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '允许覆盖「账本里没有记录、但目标位置已有同名文件」的东西。默认拒绝——那种文件不是我装的，删了找不回来。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每一步一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  dryRun: true,
  manifestPath: '',
  sourceDir: '',
  destDir: '',
  ledgerPath: '',
  maxComponents: MAX_COMPONENTS,
  maxComponentBytes: MAX_COMPONENT_BYTES,
  verifyAfterCopy: true,
  allowOverwrite: false,
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
  title: '安装器',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-installer',
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

  const text = (key: keyof Config, fallback: string): string => {
    const given = raw[key]
    if (given === undefined) return fallback
    if (typeof given !== 'string') {
      report(String(given), key)
      return fallback
    }
    return given.trim()
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    dryRun: bool('dryRun', DEFAULT_CONFIG.dryRun),
    manifestPath: text('manifestPath', DEFAULT_CONFIG.manifestPath),
    sourceDir: text('sourceDir', DEFAULT_CONFIG.sourceDir),
    destDir: text('destDir', DEFAULT_CONFIG.destDir),
    ledgerPath: text('ledgerPath', DEFAULT_CONFIG.ledgerPath),
    maxComponents: clampInt(raw['maxComponents'], DEFAULT_CONFIG.maxComponents, 1, 4096),
    maxComponentBytes: clampInt(
      raw['maxComponentBytes'],
      DEFAULT_CONFIG.maxComponentBytes,
      1024,
      4 * 1024 * 1024 * 1024,
    ),
    verifyAfterCopy: bool('verifyAfterCopy', DEFAULT_CONFIG.verifyAfterCopy),
    allowOverwrite: bool('allowOverwrite', DEFAULT_CONFIG.allowOverwrite),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（类型不对被丢弃）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  for (const key of ['manifestPath', 'sourceDir', 'destDir', 'ledgerPath'] as const) {
    const given = raw[key]
    if (given !== undefined && typeof given !== 'string') drift.push(key)
  }

  for (const key of ['maxComponents', 'maxComponentBytes'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given)) drift.push(key)
  }

  return drift
}
