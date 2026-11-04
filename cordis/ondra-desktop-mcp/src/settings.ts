/**
 * 配置的**单一真源**。
 *
 * ## 为什么没有 `endpoint`
 *
 * master-plan §9.12 把「desktop-mcp 的 `endpoint`」列为**假字段**：
 * 旧界面让人填一个地址，而源码根本不读它（走本地命令）。
 * 填了地址就以为连上了，是最坏的一种「假开关」：界面绿着，实际什么都没发生。
 *
 * ## 三条手册取舍怎么落到字段上
 *
 * 1. **只读**：字段表里没有任何 `action` / `command` / `write` 类开关。
 *    能力层不可写，就没有「配置写权限」这种需要审计的东西。
 * 2. **限频**：`minIntervalMs` / `sysinfoIntervalMs` / `callsPerMinute` 三个数。
 *    手册原话是「限频」，没给数值——本包的取值是工程判断，已登记待裁决。
 * 3. **不做推断**：没有任何「推断用户在做什么」的开关，也没有 `guess` 类字段。
 *    输出只有事实；解释归 L3 对话层。
 *
 * ## 为什么「文件检索」默认不开
 *
 * 五个能力里，只有它会**走出固定范围去遍历磁盘**。其余四个都是「读一眼当下的状态」。
 * 所以它单独默认关，且必须显式给出根目录（`findRoots` 出厂有值，但工具本身关着）。
 * 这不是过度谨慎——`desktop-find-files` 一次能带回 30 个文件名，那些名字本身就是信息。
 *
 * ## 为什么 `batteryEvents` 默认开
 *
 * 手册 §14 明确点出「缺一条链：低电量时她该有什么反应」，并给了做法：
 * desktop-mcp 输出 `battery` 事件。默认开是让这条链**存在**；
 * 真正决定她怎么反应的仍是消费方（O-048 / L3），本包只说事实。
 */

import type { FieldSpecLike, SectionDeclLike, SortKey, ToolKey } from './types.js'
import {
  CALL_TIMEOUT_MS,
  DEFAULT_LIMIT,
  FILE_DEPTH_CEIL,
  FILE_LIMIT_CEIL,
  LIMIT_CEIL,
  TIMEOUT_CEIL,
  TIMEOUT_FLOOR,
  TOOL_KEYS,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关，手册 §16.3 端侧默认全关）。 */
  readonly enable: boolean
  /** 开着的能力（取值是能力键，不是工具名）。 */
  readonly enabledTools: readonly ToolKey[]
  /** 单次调用超时（毫秒）。 */
  readonly callTimeoutMs: number
  /** 默认条数。 */
  readonly defaultLimit: number
  /** 进程排序。 */
  readonly sort: SortKey
  /** 文件检索的根目录（相对用户主目录，逐项校验）。 */
  readonly findRoots: readonly string[]
  /** 文件检索深度（1–2）。 */
  readonly findDepth: number
  /** 文件检索条数（1–30）。 */
  readonly findLimit: number
  /** 除 sysinfo 外的最小调用间隔（毫秒）。 */
  readonly minIntervalMs: number
  /** sysinfo 的最小调用间隔（毫秒）。 */
  readonly sysinfoIntervalMs: number
  /** 每分钟总调用预算。 */
  readonly callsPerMinute: number
  /** 是否返回窗口标题（关掉则只给应用名）。 */
  readonly includeWindowTitle: boolean
  /** 路径是否脱敏（只给相对路径）。 */
  readonly maskPaths: boolean
  /** 是否发电量事件。 */
  readonly batteryEvents: boolean
  /** 每次调用打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'desktop-mcp'

/** `defaultLimit` 的下界：1。 */
export const LIMIT_FLOOR = 1

/** `minIntervalMs` 的上界：60 秒（再大就等于关掉这个能力）。 */
export const INTERVAL_CEIL = 60_000

/** `sysinfoIntervalMs` 的上界：5 分钟。 */
export const SYSINFO_INTERVAL_CEIL = 300_000

/** `callsPerMinute` 的上界：600（= 每秒 10 次，已是「不是人在用」的量级）。 */
export const PER_MINUTE_CEIL = 600

/** 出厂检索根（相对用户主目录）。 */
export const DEFAULT_ROOTS: readonly string[] = Object.freeze(['Desktop', 'Documents', 'Downloads'])

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  enabledTools: 'enabled-tools',
  callTimeoutMs: 'call-timeout-ms',
  defaultLimit: 'default-limit',
  sort: 'sort',
  findRoots: 'find-roots',
  findDepth: 'find-depth',
  findLimit: 'find-limit',
  minIntervalMs: 'min-interval-ms',
  sysinfoIntervalMs: 'sysinfo-interval-ms',
  callsPerMinute: 'calls-per-minute',
  includeWindowTitle: 'include-window-title',
  maskPaths: 'mask-paths',
  batteryEvents: 'battery-events',
  verbose: 'verbose',
})

/** 查表版（理由同其它插件：`Map.get` 天然带 `undefined`）。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/**
 * 出厂默认开的能力。
 *
 * **不含 `findFiles`**：见文件头。其余四个都是「读一眼当下状态」，不遍历磁盘。
 */
export const DEFAULT_TOOLS: readonly ToolKey[] = Object.freeze(['processes', 'foreground', 'clipboard', 'sysinfo'])

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '电脑只读能力开关。默认关：装上就能读这台机器的进程与窗口，那是事故不是功能。',
  },
  enabledTools: {
    kind: 'json',
    default: DEFAULT_TOOLS,
    doc: '开着的能力：processes / foreground / clipboard / findFiles / sysinfo。**文件检索默认关**。',
  },
  callTimeoutMs: {
    kind: 'number',
    default: CALL_TIMEOUT_MS,
    min: TIMEOUT_FLOOR,
    max: TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '单次调用超时（§9.11 实测 5 秒，比手机侧 8 秒短）。超时结果会被丢弃并标 late。',
  },
  defaultLimit: {
    kind: 'number',
    default: DEFAULT_LIMIT,
    min: LIMIT_FLOOR,
    max: LIMIT_CEIL,
    doc: '不传 limit 时的条数（进程）。',
  },
  sort: {
    kind: 'enum',
    default: 'cpu',
    values: Object.freeze(['cpu', 'mem', 'name']),
    doc: '进程排序：cpu / mem / name。',
  },
  findRoots: {
    kind: 'json',
    default: DEFAULT_ROOTS,
    doc: '文件检索根目录，**相对用户主目录**（如 Desktop、Documents/工作）。不接受绝对路径与 ..。',
  },
  findDepth: {
    kind: 'number',
    default: 1,
    min: 1,
    max: FILE_DEPTH_CEIL,
    doc: '检索深度（§9.11 上限 2 层）。',
  },
  findLimit: {
    kind: 'number',
    default: 20,
    min: LIMIT_FLOOR,
    max: FILE_LIMIT_CEIL,
    doc: '检索条数（§9.11 上限 30 条）。',
  },
  minIntervalMs: {
    kind: 'number',
    default: 2_000,
    min: 0,
    max: INTERVAL_CEIL,
    advancedOnly: true,
    doc: '同一工具的最小调用间隔（毫秒）。0 = 不限。',
  },
  sysinfoIntervalMs: {
    kind: 'number',
    default: 5_000,
    min: 0,
    max: SYSINFO_INTERVAL_CEIL,
    advancedOnly: true,
    doc: 'sysinfo 的最小调用间隔（毫秒）。它最常被轮询，所以单独放宽。',
  },
  callsPerMinute: {
    kind: 'number',
    default: 30,
    min: LIMIT_FLOOR,
    max: PER_MINUTE_CEIL,
    advancedOnly: true,
    doc: '每分钟总调用预算。超了返回 rate-limited，并告诉你还要等多久。',
  },
  includeWindowTitle: {
    kind: 'boolean',
    default: true,
    doc: '是否返回窗口标题。关掉只给应用名——标题里常有文档名与网址。',
  },
  maskPaths: {
    kind: 'boolean',
    default: true,
    doc: '路径脱敏：只给相对根目录的路径（不带用户名）。关掉才返回绝对路径。',
  },
  batteryEvents: {
    kind: 'boolean',
    default: true,
    doc: '是否发电量事件（手册 §14 缺口链的产出端：低电量时她该有反应）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次调用打一行日志（不含窗口标题与路径）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  enabledTools: DEFAULT_TOOLS,
  callTimeoutMs: CALL_TIMEOUT_MS,
  defaultLimit: DEFAULT_LIMIT,
  sort: 'cpu',
  findRoots: DEFAULT_ROOTS,
  findDepth: 1,
  findLimit: 20,
  minIntervalMs: 2_000,
  sysinfoIntervalMs: 5_000,
  callsPerMinute: 30,
  includeWindowTitle: true,
  maskPaths: true,
  batteryEvents: true,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 查表版。理由同 `KEY_MAP`。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '电脑只读能力',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-desktop-mcp',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * @param raw 原始配置对象。
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
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状（camel 键）。
 * @param values 解析结果的 `values`。
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
 * @param value 待夹的值。
 * @param fallback 非法时的回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 归一化能力名单。
 *
 * 认三种写法：能力键（`processes`）、工具名（`desktop-processes`）、
 * 手册里的点号写法（`desktop.processes`）。第三种**只接受读入**、不向外发布——
 * 它不符合 §8.4，但人手里的旧配置可能就长那样。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeTools(value: unknown, onBad: (text: string) => void): readonly ToolKey[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: ToolKey[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim().toLowerCase()
    if (text === '') continue
    const bare = text.startsWith('desktop.')
      ? text.slice('desktop.'.length)
      : text.startsWith('desktop-')
        ? text.slice('desktop-'.length)
        : text
    const key = TOOL_KEYS.find(candidate => candidate === bare)
    if (key === undefined) {
      onBad(item)
      continue
    }
    if (!out.includes(key)) out.push(key)
  }
  return Object.freeze(out)
}

/**
 * 归一化检索根。
 *
 * 只接受**相对用户主目录**的写法。拒绝绝对路径、`..`、空串与过长的段——
 * 这三条合起来保证「检索不会跑出用户主目录」，而不是靠调用方自觉。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeRoots(value: unknown, onBad: (text: string) => void): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim().replace(/^\.\//, '').replace(/\/+$/, '')
    if (text === '') continue
    if (text.startsWith('/') || text.startsWith('~') || text.includes('..') || text.length > 64) {
      onBad(item)
      continue
    }
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
}

/**
 * 归一化排序键。
 * @param value 原始值。
 * @param fallback 非法时的回退值。
 */
function normalizeSort(value: unknown, fallback: SortKey): SortKey {
  if (value === 'cpu' || value === 'mem' || value === 'name') return value
  return fallback
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 有坏条目时的回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  // `enabledTools` 缺失时才用默认表；显式给了空数组**就是空**（用户全关，不许"帮忙"打开）。
  const tools =
    raw['enabledTools'] === undefined
      ? DEFAULT_TOOLS
      : normalizeTools(raw['enabledTools'], text => report(text, 'enabledTools'))

  // 根目录同理：缺失才用出厂值，显式给空数组就是「不检索」。
  const roots =
    raw['findRoots'] === undefined
      ? DEFAULT_ROOTS
      : normalizeRoots(raw['findRoots'], text => report(text, 'findRoots'))

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    enabledTools: tools,
    callTimeoutMs: clampInt(raw['callTimeoutMs'], DEFAULT_CONFIG.callTimeoutMs, TIMEOUT_FLOOR, TIMEOUT_CEIL),
    defaultLimit: clampInt(raw['defaultLimit'], DEFAULT_CONFIG.defaultLimit, LIMIT_FLOOR, LIMIT_CEIL),
    sort: normalizeSort(raw['sort'], DEFAULT_CONFIG.sort),
    findRoots: roots,
    findDepth: clampInt(raw['findDepth'], DEFAULT_CONFIG.findDepth, 1, FILE_DEPTH_CEIL),
    findLimit: clampInt(raw['findLimit'], DEFAULT_CONFIG.findLimit, LIMIT_FLOOR, FILE_LIMIT_CEIL),
    minIntervalMs: clampInt(raw['minIntervalMs'], DEFAULT_CONFIG.minIntervalMs, 0, INTERVAL_CEIL),
    sysinfoIntervalMs: clampInt(
      raw['sysinfoIntervalMs'],
      DEFAULT_CONFIG.sysinfoIntervalMs,
      0,
      SYSINFO_INTERVAL_CEIL,
    ),
    callsPerMinute: clampInt(raw['callsPerMinute'], DEFAULT_CONFIG.callsPerMinute, LIMIT_FLOOR, PER_MINUTE_CEIL),
    includeWindowTitle: bool('includeWindowTitle', DEFAULT_CONFIG.includeWindowTitle),
    maskPaths: bool('maskPaths', DEFAULT_CONFIG.maskPaths),
    batteryEvents: bool('batteryEvents', DEFAULT_CONFIG.batteryEvents),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（越界值被夹紧、坏条目被丢）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['callTimeoutMs', TIMEOUT_FLOOR, TIMEOUT_CEIL],
    ['defaultLimit', LIMIT_FLOOR, LIMIT_CEIL],
    ['findDepth', 1, FILE_DEPTH_CEIL],
    ['findLimit', LIMIT_FLOOR, FILE_LIMIT_CEIL],
    ['minIntervalMs', 0, INTERVAL_CEIL],
    ['sysinfoIntervalMs', 0, SYSINFO_INTERVAL_CEIL],
    ['callsPerMinute', LIMIT_FLOOR, PER_MINUTE_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  const givenSort = raw['sort']
  if (givenSort !== undefined) {
    const legal = givenSort === 'cpu' || givenSort === 'mem' || givenSort === 'name'
    if (!legal) drift.push('sort')
  }

  return drift
}
