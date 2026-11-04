/**
 * 配置的**单一真源**。
 *
 * ## `mode` 为什么默认封闭
 *
 * 手册 §7.4-⑩ 的原话：「插件市场：与 `ondra-market` 同型但**封闭**——只显示认可的插件，
 * 也支持用户上传自定义（官方组合包）」。默认开放就等于把这句话反着做。
 *
 * 但「封闭」有个坏形态：清单为空时市场一片空白，人会以为坏了。所以
 * `status()` 报 `allowCount`，界面能说「认可清单是空的」——**不假装是开放市场**。
 *
 * ## `builtin` 为什么不是空的
 *
 * 手册 §9.11 给了旧项目市场的实测清单：两个包
 * （`xia-ningqi-complete` / `xia-ningqi-light`）。这是**唯一有出处的一组包名**，
 * 所以拿来当内置清单，并在 README 里标明「旧项目实证值，不是新体系的官方清单」。
 *
 * 空着更「干净」，但一个装好就空的封闭市场，用户第一件事是去关掉它。
 *
 * ## `language` 为什么要可配
 *
 * 上游条目是多语言 `string | { en, ... }`。挑哪一条是**展示**问题，不是逻辑问题，
 * 所以做成配置而不是写死 `zh-CN`。
 */

import type { FieldSpecLike, MarketMode, MarketSortKind, SectionDeclLike } from './types.js'
import { MARKET_MODES, SORT_KINDS } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。程序化调用照常；关掉只是不再查上游。 */
  readonly enable: boolean
  /** 市场形态。 */
  readonly mode: MarketMode
  /** 内置认可清单（包名）。 */
  readonly builtin: readonly string[]
  /** 每页条数（上游上限 100）。 */
  readonly pageSize: number
  /** 排序口径。 */
  readonly sort: MarketSortKind
  /** 最多查几个索引源。 */
  readonly maxIndexes: number
  /** 认可清单落盘（`user/market/approved.json`，0600）。 */
  readonly persist: boolean
  /** 展示语言。 */
  readonly language: string
  /** 每次查询一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'market'

/**
 * 内置认可清单默认值。
 *
 * 出处：手册 §9.11「market：清单实为 2 个包（`xia-ningqi-complete` / `xia-ningqi-light`）」。
 * **旧项目实证值**，不是新体系的官方清单——新体系的组合包还没定，所以它可配。
 */
export const DEFAULT_BUILTIN: readonly string[] = Object.freeze([
  'xia-ningqi-complete',
  'xia-ningqi-light',
])

/** 每页默认条数。上游 `MAX_LIMIT = 100`。 */
export const DEFAULT_PAGE_SIZE = 40

/** 上游单页硬上限（`src/index.ts` 的 `MAX_LIMIT`）。 */
export const MAX_PAGE_SIZE = 100

/** 默认最多查几个索引源。 */
export const DEFAULT_MAX_INDEXES = 8

/** 认可清单文件（相对 `user` 区域）。 */
export const APPROVED_FILE = Object.freeze(['market', 'approved.json'])

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  mode: 'mode',
  builtin: 'builtin',
  pageSize: 'page-size',
  sort: 'sort',
  maxIndexes: 'max-indexes',
  persist: 'persist',
  language: 'language',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '市场开关。关掉只是不再查上游；本地认可清单与 `plan()` 照常可用。',
  },
  mode: {
    kind: 'enum',
    values: MARKET_MODES,
    default: 'closed',
    doc: '封闭（只显示认可的）/ 开放（全显示，认可的打标）。手册 §7.4-⑩ 要求封闭。',
  },
  builtin: {
    kind: 'json',
    default: DEFAULT_BUILTIN,
    advancedOnly: true,
    doc: '内置认可清单（包名）。默认取手册 §9.11 的旧项目实证两个包，不是新体系官方清单。',
  },
  pageSize: {
    kind: 'number',
    default: DEFAULT_PAGE_SIZE,
    min: 1,
    max: MAX_PAGE_SIZE,
    advancedOnly: true,
    doc: '每页条数。上游上限 100，超过会被夹紧。',
  },
  sort: {
    kind: 'enum',
    values: SORT_KINDS,
    default: 'index',
    advancedOnly: true,
    doc: '排序。`index` = 索引自身顺序（官方排列）；`relevance` = 按文本匹配度。',
  },
  maxIndexes: {
    kind: 'number',
    default: DEFAULT_MAX_INDEXES,
    min: 1,
    max: 32,
    advancedOnly: true,
    doc: '最多查几个索引源。配了很多索引时防止一次查询打十几个请求。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc: '认可清单落盘到 `user/market/approved.json`（0600）。关掉则只在内存。',
  },
  language: {
    kind: 'string',
    default: 'zh-CN',
    advancedOnly: true,
    doc: '展示语言。多语言条目按它挑一条，缺了退到前缀，再缺退到 en，再缺任取。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次查询一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  mode: 'closed',
  builtin: DEFAULT_BUILTIN,
  pageSize: DEFAULT_PAGE_SIZE,
  sort: 'index',
  maxIndexes: DEFAULT_MAX_INDEXES,
  persist: true,
  language: 'zh-CN',
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
  title: '插件市场',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-market',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 包名形状检查。
 *
 * 上游条目的 `name` 是 npm 包名（可带 scope），服务键那套 `^[a-z][a-z0-9_-]{1,63}$`
 * **不适用**——拿它判包名会把 `@scope/pkg` 全判成非法。所以只挡三类明显垃圾：
 * 空串、含空白、超长。
 * @param value 待判值。
 */
export function isPackageName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '' || text.length > 214) return false
  if (/\s/u.test(text)) return false
  return true
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
 * 归一化包名清单（去空、去重、保序）。
 * @param value 原始值。
 * @param onBad 坏条目回调。
 */
function normalizeNames(value: unknown, onBad: (text: string) => void): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (!isPackageName(item)) {
      onBad(String(item))
      continue
    }
    const text = item.trim()
    if (!out.includes(text)) out.push(text)
  }
  // 清空清单是明确选择（「一个都不认可」），不强行塞回默认值。
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

  const mode = raw['mode']
  const sort = raw['sort']

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    mode: MARKET_MODES.includes(mode as MarketMode) ? (mode as MarketMode) : DEFAULT_CONFIG.mode,
    builtin:
      raw['builtin'] === undefined
        ? DEFAULT_CONFIG.builtin
        : normalizeNames(raw['builtin'], text => report(text, 'builtin')),
    pageSize: clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 1, MAX_PAGE_SIZE),
    sort: SORT_KINDS.includes(sort as MarketSortKind) ? (sort as MarketSortKind) : DEFAULT_CONFIG.sort,
    maxIndexes: clampInt(raw['maxIndexes'], DEFAULT_CONFIG.maxIndexes, 1, 32),
    persist: bool('persist', DEFAULT_CONFIG.persist),
    language:
      typeof raw['language'] === 'string' && raw['language'].trim() !== ''
        ? raw['language'].trim()
        : DEFAULT_CONFIG.language,
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（夹紧或丢弃）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const mode = raw['mode']
  if (mode !== undefined && !MARKET_MODES.includes(mode as MarketMode)) drift.push('mode')

  const sort = raw['sort']
  if (sort !== undefined && !SORT_KINDS.includes(sort as MarketSortKind)) drift.push('sort')

  for (const key of ['pageSize', 'maxIndexes'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given)) drift.push(key)
  }

  const builtin = raw['builtin']
  if (builtin !== undefined && !Array.isArray(builtin) && typeof builtin !== 'string') drift.push('builtin')

  return drift
}
