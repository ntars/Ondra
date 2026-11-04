/**
 * 配置的**单一真源**。
 *
 * ## 为什么没有 `browserPath` / `cdpEndpoint` / `headless`
 *
 * 那些字段归**宿主 provider**（`@ntars/ondra-experimental-browser-use-playwright-mcp`
 * 的 `mode` / `headless` / `endpoint` / `executablePath`）。本包再存一份就是双真源：
 * 用户在两处都能填，实际生效的只有一处，而界面上两处都「看起来有效」。
 *
 * 本包只声明**宿主管不着的**那一层：拦什么、放什么、裁多少。
 *
 * ## 为什么没有「读/写」二分开关
 *
 * 直觉上该有 `allowWrites`，但本包拿不到工具注册表——只能按工具名猜
 * （含 `click` 就算写、含 `snapshot` 就算读）。猜错的两种结果都很糟：
 * 拦错一半 = 浏览器突然不能用；漏一半 = 用户以为「只读」其实能下单。
 *
 * 所以本包不假装能分类，改按**两类真能判准的边界**：
 * 红线（执行任意代码）与目标（URL 协议 / 主机）。这两条判错也只会「少放一次」，
 * 不会让「只读」变成一句谎话。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  DEFAULT_SCHEMES,
  DEFAULT_SCRIPT_TOOLS,
  DEFAULT_TOOL_PREFIXES,
  TRIM_CHARS,
  TRIM_CHARS_CEIL,
  TRIM_CHARS_FLOOR,
  TRIM_LINES,
  TRIM_LINES_CEIL,
  TRIM_LINES_FLOOR,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 是否允许执行页面脚本（红线，默认禁）。 */
  readonly allowScriptExecution: boolean
  /** 允许的协议。 */
  readonly allowedSchemes: readonly string[]
  /** 是否允许私有/本地主机。 */
  readonly allowPrivateHosts: boolean
  /** 明确拒绝的主机（整名或后缀）。 */
  readonly hostDenyList: readonly string[]
  /** 认作浏览器工具的名字前缀。 */
  readonly toolPrefixes: readonly string[]
  /** 红线工具名单（执行任意代码）。 */
  readonly scriptTools: readonly string[]
  /** 裁剪字符预算。 */
  readonly trimChars: number
  /** 裁剪行预算。 */
  readonly trimLines: number
  /** 每次拦截/裁剪打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'browser'

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  allowScriptExecution: 'allow-script-execution',
  allowedSchemes: 'allowed-schemes',
  allowPrivateHosts: 'allow-private-hosts',
  hostDenyList: 'host-deny-list',
  toolPrefixes: 'tool-prefixes',
  scriptTools: 'script-tools',
  trimChars: 'trim-chars',
  trimLines: 'trim-lines',
  verbose: 'verbose',
})

/** 查表版（理由同其它插件：`Map.get` 天然带 `undefined`）。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '浏览器护栏开关。默认关：关着时本包不拦也不裁，浏览器按宿主的配置照常工作。',
  },
  allowScriptExecution: {
    kind: 'boolean',
    default: false,
    doc: '是否允许 browser_evaluate 这类「在页面里执行任意代码」的工具。默认禁——它能读已登录站点的数据。',
  },
  allowedSchemes: {
    kind: 'json',
    default: DEFAULT_SCHEMES,
    doc: '允许的协议（http / https）。file: / javascript: / data: / chrome: 一律拒。',
  },
  allowPrivateHosts: {
    kind: 'boolean',
    default: false,
    doc: '是否允许 127.0.0.1 / localhost / *.local 等私有目标。默认禁：那后面是用户自己的路由器与内网控制台。',
  },
  hostDenyList: {
    kind: 'json',
    default: Object.freeze([]),
    doc: '明确拒绝的主机（整名或后缀）。比白名单好维护，也不至于让浏览器开箱即不可用。',
  },
  toolPrefixes: {
    kind: 'json',
    default: DEFAULT_TOOL_PREFIXES,
    doc: '认作浏览器工具的名字前缀（browser_ / browser-）。认不出来只是不拦不裁，不影响浏览器工作。',
  },
  scriptTools: {
    kind: 'json',
    default: DEFAULT_SCRIPT_TOOLS,
    doc: '红线工具名单。改它之前先想清楚：这是在决定「要不要给模型一个任意代码执行入口」。',
  },
  trimChars: {
    kind: 'number',
    default: TRIM_CHARS,
    min: TRIM_CHARS_FLOOR,
    max: TRIM_CHARS_CEIL,
    doc: '单次结果进上下文的字符上限（默认 4000）。手册 §10.1：Playwright 快照 315KB → 5.4KB。',
  },
  trimLines: {
    kind: 'number',
    default: TRIM_LINES,
    min: TRIM_LINES_FLOOR,
    max: TRIM_LINES_CEIL,
    doc: '单次结果的行数上限（默认 80）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次拦截/裁剪打一行日志（不含 URL 原文）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  allowScriptExecution: false,
  allowedSchemes: DEFAULT_SCHEMES,
  allowPrivateHosts: false,
  hostDenyList: Object.freeze([]),
  toolPrefixes: DEFAULT_TOOL_PREFIXES,
  scriptTools: DEFAULT_SCRIPT_TOOLS,
  trimChars: TRIM_CHARS,
  trimLines: TRIM_LINES,
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
  title: '浏览器护栏',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-browser',
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
 * 归一化字符串列表（去空白、去重、小写）。
 *
 * 显式给空数组**就是空**：`allowedSchemes: []` 意味着「什么都不许」，
 * 不许"帮忙"补回默认值——那会让一次误配置看起来像没生效。
 * @param value 原始值。
 * @param fallback 缺失时的回退。
 * @param lower 是否转小写。
 */
function listOf(value: unknown, fallback: readonly string[], lower: boolean): readonly string[] {
  if (value === undefined) return fallback
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = (lower ? item.toLowerCase() : item).trim()
    if (text === '') continue
    if (!out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
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

  const schemes = listOf(raw['allowedSchemes'], DEFAULT_CONFIG.allowedSchemes, true).map(item =>
    item.endsWith(':') ? item.slice(0, -1) : item,
  )
  for (const scheme of schemes) {
    if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) report(scheme, 'allowedSchemes')
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    allowScriptExecution: bool('allowScriptExecution', DEFAULT_CONFIG.allowScriptExecution),
    allowedSchemes: Object.freeze(schemes),
    allowPrivateHosts: bool('allowPrivateHosts', DEFAULT_CONFIG.allowPrivateHosts),
    hostDenyList: listOf(raw['hostDenyList'], DEFAULT_CONFIG.hostDenyList, true),
    toolPrefixes: listOf(raw['toolPrefixes'], DEFAULT_CONFIG.toolPrefixes, false),
    scriptTools: listOf(raw['scriptTools'], DEFAULT_CONFIG.scriptTools, true),
    trimChars: clampInt(raw['trimChars'], DEFAULT_CONFIG.trimChars, TRIM_CHARS_FLOOR, TRIM_CHARS_CEIL),
    trimLines: clampInt(raw['trimLines'], DEFAULT_CONFIG.trimLines, TRIM_LINES_FLOOR, TRIM_LINES_CEIL),
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
    ['trimChars', TRIM_CHARS_FLOOR, TRIM_CHARS_CEIL],
    ['trimLines', TRIM_LINES_FLOOR, TRIM_LINES_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  return drift
}
