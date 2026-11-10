/**
 * 配置的**单一真源**。
 *
 * ## 为什么必须有 `root`
 *
 * 本包要读的是**插件包目录**（`package.json` / `cordis.patch.yml` / `src/*.ts`），
 * 而不是用户数据。这类目录在开发仓里，在装好的 app 里则在 `node_modules` 下，
 * 两种形态不可能靠猜。所以 `root` 默认空 = **什么都不扫**，并在 `status().reason`
 * 里如实报 `no-root`。
 *
 * 空默认不是偷懒：一个「猜出来的根」会让自检对着错的目录跑出「全过」，
 * 那比不检查更坏——它给出的是假的安全感。
 *
 * ## `hostKeys` 为什么要可配
 *
 * 「依赖可解析」这一项要区分两种键：本仓插件提供的（能索引到）、上游宿主提供的
 * （`llm` / `credentials` / `browserUse` / `webServer`——全仓 `ctx.get()` 里实际
 * 出现的四个非 `ondra-` 键，来源是 grep 而不是手册）。宿主键清单不可能穷尽，
 * 也不可能由本包固定：所以做成配置，默认给这四个，多一个键就加一个。
 *
 * 硬编码的后果是：将来某个插件用了第五个宿主键，自检会把它报成「悬空依赖」，
 * 而人会去改那个本来正确的插件。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 扫描根（插件包所在的父目录）；空 = 不扫。 */
  readonly root: string
  /** 单包最多读多少个文件。 */
  readonly maxFilesPerPackage: number
  /** 单文件最大字节数（超过按「太大」处理，不读）。 */
  readonly maxFileBytes: number
  /** 最多扫多少个包。 */
  readonly maxPackages: number
  /** 上游宿主服务键（不算悬空）。 */
  readonly hostKeys: readonly string[]
  /** 启动时跑一次自己的第十项并打日志。 */
  readonly selfCheck: boolean
  /** 每次检查一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'startup-check'

/**
 * 上游宿主键默认值。
 *
 * 来源：`grep -rho "ctx.get('[^']*'" cordis/` 里**实际出现过**的非 `ondra-` 键，
 * 共四个。**不是**从手册抄的（手册没给这张表），所以它是可配的。
 */
export const DEFAULT_HOST_KEYS: readonly string[] = Object.freeze([
  'browserUse',
  'credentials',
  'llm',
  'webServer',
])

/** 单文件上限：256 KiB。本仓最大的 `src/*.ts` 在 40 KB 量级，留足余量。 */
export const MAX_FILE_BYTES = 256 * 1024

/** 单包文件上限。 */
export const MAX_FILES = 400

/** 包数上限。 */
export const MAX_PACKAGES = 200

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  root: 'root',
  maxFilesPerPackage: 'max-files',
  maxFileBytes: 'max-file-bytes',
  maxPackages: 'max-packages',
  hostKeys: 'host-keys',
  selfCheck: 'self-check',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '自检开关。**只判定不拦启动**：关掉只是不查，不影响任何插件加载。',
  },
  root: {
    kind: 'string',
    default: '',
    doc: '插件包所在的父目录（开发仓里是 `cordis/`）。**空 = 不扫**，`status()` 会如实报 `no-root`。',
  },
  maxFilesPerPackage: {
    kind: 'number',
    default: MAX_FILES,
    min: 10,
    max: 2000,
    advancedOnly: true,
    doc: '单包最多读多少个文件。',
  },
  maxFileBytes: {
    kind: 'number',
    default: MAX_FILE_BYTES,
    min: 1024,
    max: 4 * 1024 * 1024,
    advancedOnly: true,
    doc: '单文件最大字节数；超过按「太大」处理（判不了，不硬读）。',
  },
  maxPackages: {
    kind: 'number',
    default: MAX_PACKAGES,
    min: 1,
    max: 1000,
    advancedOnly: true,
    doc: '最多扫多少个包。',
  },
  hostKeys: {
    kind: 'json',
    default: DEFAULT_HOST_KEYS,
    advancedOnly: true,
    doc: '上游宿主服务键（不算悬空依赖）。默认是全仓实际出现的四个。',
  },
  selfCheck: {
    kind: 'boolean',
    default: true,
    doc: '启动时跑一次自己的第十项（宿主会不会加载我）并打日志。**只打日志，不拦启动**。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次检查一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  root: '',
  maxFilesPerPackage: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxPackages: MAX_PACKAGES,
  hostKeys: DEFAULT_HOST_KEYS,
  selfCheck: true,
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
  title: '加载自检',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-startup-check',
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
 * 归一化宿主键清单（去空、去重、限条数）。
 * @param value 原始值。
 * @param onBad 坏条目回调。
 */
function normalizeHostKeys(value: unknown, onBad: (text: string) => void): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      onBad(String(item))
      continue
    }
    const text = item.trim()
    if (text === '') continue
    if (!out.includes(text)) out.push(text)
  }
  // 清空清单是明确选择（「一个宿主键都不认」），不强行塞回默认值。
  return Object.freeze(out)
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

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    root: raw['root'] === undefined ? '' : typeof raw['root'] === 'string' ? raw['root'].trim() : '',
    maxFilesPerPackage: clampInt(raw['maxFilesPerPackage'], DEFAULT_CONFIG.maxFilesPerPackage, 10, 2000),
    maxFileBytes: clampInt(raw['maxFileBytes'], DEFAULT_CONFIG.maxFileBytes, 1024, 4 * 1024 * 1024),
    maxPackages: clampInt(raw['maxPackages'], DEFAULT_CONFIG.maxPackages, 1, 1000),
    hostKeys:
      raw['hostKeys'] === undefined
        ? DEFAULT_CONFIG.hostKeys
        : normalizeHostKeys(raw['hostKeys'], text => report(text, 'hostKeys')),
    selfCheck: bool('selfCheck', DEFAULT_CONFIG.selfCheck),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const givenRoot = raw['root']
  if (givenRoot !== undefined && typeof givenRoot !== 'string') drift.push('root')

  for (const key of ['maxFilesPerPackage', 'maxFileBytes', 'maxPackages'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given)) drift.push(key)
  }

  return drift
}
