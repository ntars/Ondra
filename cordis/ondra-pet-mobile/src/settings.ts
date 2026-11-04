/**
 * 配置的**单一真源**。
 *
 * ## 只有六个字段，为什么
 *
 * 台账给这一项九个字「占位，钉住三端技术前提」，手册里与「手机端 / 三端」相关的
 * 原文只有三处（见 `types.ts` 文件头）。这些原文里**一个可调参数都没有**——
 * 只有链路形状（3000 / 3001 / token）。所以本包只留「这条链路需要用户决定的六件事」，
 * 其余一律不编：
 *
 * - `platforms`：空 = 一个端都不接（与 O-073 的指令白名单同一手法：空表是明确默认）；
 * - `apiPort`：手册语料给的 3000，做成配置是因为它经常被占（其它本地服务抢端口）；
 * - `relayUrl`：空 = 不连。地址由用户自己的中继提供，本包不编；
 * - `allowedOrigins`：空 = 全拒（§9.2）。
 *
 * `apiPort` 默认 3000 是有出处的（语料庚-5/庚-7「HTTP API 监听 3000 端口」）；
 * 其余默认值要么是「空 / 关」，要么是安全侧，没有一个是我拍的数。
 */

import type { FieldSpecLike, MobilePlatform, SectionDeclLike } from './types.js'
import { PLATFORMS, PORT_CEIL, PORT_FLOOR } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 启用哪些端（空 = 一个都不接）。 */
  readonly platforms: readonly MobilePlatform[]
  /** 本机 API 端口（三端读同一份数据的出口）。 */
  readonly apiPort: number
  /** WS 中继地址。空 = 不连。 */
  readonly relayUrl: string
  /** 允许连到中继的来源（Origin）。**空 = 全拒。** */
  readonly allowedOrigins: readonly string[]
  /** 每次操作打一行日志（**不回显地址**）。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'pet-mobile'

/** 本机 API 端口默认值：手册语料的链路原文就是 3000。 */
export const API_PORT = 3000

/** 来源清单条数上限。 */
export const MAX_ORIGINS = 16

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  platforms: 'platforms',
  apiPort: 'api-port',
  relayUrl: 'relay-url',
  allowedOrigins: 'allowed-origins',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '三端互通开关。默认关：它会把同一份记忆接到别的设备上。',
  },
  platforms: {
    kind: 'json',
    default: Object.freeze([] as readonly string[]),
    doc: '启用哪些端：`pet` / `qq` / `wechat`。**空 = 一个都不接**（不是「全接」）。',
  },
  apiPort: {
    kind: 'number',
    default: API_PORT,
    min: PORT_FLOOR,
    max: PORT_CEIL,
    doc: '本机 API 端口（手册语料的链路是 3000）。端口被占时改这里，三端都要跟着改。',
  },
  relayUrl: {
    kind: 'string',
    default: '',
    doc: 'WS 中继地址，形如 `ws://127.0.0.1:3001/...`。**跨设备必须 `wss://`**；空 = 不连。',
  },
  allowedOrigins: {
    kind: 'json',
    default: Object.freeze([] as readonly string[]),
    doc: '允许连到中继的来源。**空 = 全拒**——不填就启动等于不校验 Origin（§9.2 的 CSWSH 教训）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次操作一行日志（不回显中继地址）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  platforms: Object.freeze([] as readonly MobilePlatform[]),
  apiPort: API_PORT,
  relayUrl: '',
  allowedOrigins: Object.freeze([] as readonly string[]),
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 查表版。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '三端互通前提',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-pet-mobile',
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
 * 归一化平台清单。
 *
 * 认三种写法：数组、逗号分隔字符串、单值。**空 = 一个都不接**，不会因为「没填」
 * 就变成「全接」——那是隐私问题，不是便利问题。
 * @param value 原始值。
 * @param onBad 坏条目回调。
 */
function normalizePlatforms(value: unknown, onBad: (text: string) => void): readonly MobilePlatform[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: MobilePlatform[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      onBad(String(item))
      continue
    }
    const text = item.trim().toLowerCase()
    if (text === '') continue
    const hit = PLATFORMS.find(platform => platform === text)
    if (hit === undefined) {
      onBad(item)
      continue
    }
    if (!out.includes(hit)) out.push(hit)
  }
  return Object.freeze(out)
}

/**
 * 归一化来源清单（去空、去重、限条数）。
 *
 * **不判合法性**：合法性归 `checkRelayUrl` / 桥。这里只保证「不会因为一个空字符串
 * 让 `originCount` 看起来像 1」——那条会直接绕过 §9.2 的默认全拒。
 * @param value 原始值。
 * @param onBad 坏条目回调。
 */
function normalizeOrigins(value: unknown, onBad: (text: string) => void): readonly string[] {
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
  if (out.length > MAX_ORIGINS) {
    onBad(`更多 ${out.length - MAX_ORIGINS} 条`)
    return Object.freeze(out.slice(0, MAX_ORIGINS))
  }
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

  const platforms =
    raw['platforms'] === undefined
      ? DEFAULT_CONFIG.platforms
      : normalizePlatforms(raw['platforms'], t => report(t, 'platforms'))
  const origins =
    raw['allowedOrigins'] === undefined
      ? DEFAULT_CONFIG.allowedOrigins
      : normalizeOrigins(raw['allowedOrigins'], t => report(t, 'allowedOrigins'))
  const relayUrl =
    raw['relayUrl'] === undefined ? '' : typeof raw['relayUrl'] === 'string' ? raw['relayUrl'].trim() : ''

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    platforms,
    apiPort: clampInt(raw['apiPort'], DEFAULT_CONFIG.apiPort, PORT_FLOOR, PORT_CEIL),
    relayUrl,
    allowedOrigins: origins,
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

  const givenPort = raw['apiPort']
  if (givenPort !== undefined) {
    if (
      typeof givenPort !== 'number' ||
      !Number.isFinite(givenPort) ||
      givenPort < PORT_FLOOR ||
      givenPort > PORT_CEIL
    ) {
      drift.push('apiPort')
    }
  }

  const givenPlatforms = raw['platforms']
  if (givenPlatforms !== undefined) {
    const list = Array.isArray(givenPlatforms)
      ? givenPlatforms
      : typeof givenPlatforms === 'string'
        ? givenPlatforms.split(',')
        : []
    for (const item of list) {
      if (typeof item !== 'string') continue
      const text = item.trim().toLowerCase()
      if (text === '') continue
      if (!PLATFORMS.some(platform => platform === text)) {
        drift.push('platforms')
        break
      }
    }
  }

  const givenOrigins = raw['allowedOrigins']
  if (Array.isArray(givenOrigins) && givenOrigins.length > MAX_ORIGINS) drift.push('allowedOrigins')

  return drift
}
