/**
 * 配置的**单一真源**。
 *
 * 一张声明表，三处消费（与 O-035 同口径）：
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ CONFIG_SECTION      交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么这里没有「邀请码」字段
 *
 * 主人要求链接不能改。邀请码一旦成为配置项，它就从「常量」变成「可编辑值」，
 * 一条被改过的配置就能把归因指向别人，而且**没有任何报错**。
 * 所以它硬编码在 `types.ts` 的 `AFFILIATE_CODE` 里，配置面不暴露。
 *
 * ## 为什么 `siteBaseUrl` 可配
 *
 * 北辰换域名时，改一个配置比发一版应用快。但它不是「链接」——用户改它
 * 只能改目的地，改不了归因，最坏结果是打开一个错误站点，而不是把佣金送给别人。
 */

import {
  DEFAULT_REGISTER_PATH,
  DEFAULT_SITE_BASE_URL,
  DEFAULT_TTL_MINUTES,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。关掉后路由不注册，服务仍注册（面板能回答「它存在但关着」）。 */
  readonly enabled: boolean
  /** 令牌有效期（分钟）。范围 1–1440。 */
  readonly ttlMinutes: number
  /** 北辰站点根地址，不含尾部斜杠。 */
  readonly siteBaseUrl: string
  /** 注册页路径。 */
  readonly registerPath: string
  /** 是否请求内置浏览器打开入口页。关掉则只返回入口地址，由调用方决定怎么开。 */
  readonly openInPane: boolean
}

/** 字段声明（O-005 结构对位）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** 段声明（O-005 结构对位）。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** 解析结果（O-005 结构对位）。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** 配置真源服务（O-005 结构对位）。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。顺序即界面渲染顺序。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enabled: {
    kind: 'boolean',
    default: true,
    doc: '北辰入口总开关。关掉后本地入口页与跳转路由都不注册。',
  },
  ttlMinutes: {
    kind: 'number',
    default: DEFAULT_TTL_MINUTES,
    min: 1,
    max: 1440,
    doc: '入口令牌有效期（分钟）。过期后入口页会提示重新点一次。',
  },
  siteBaseUrl: {
    kind: 'string',
    default: DEFAULT_SITE_BASE_URL,
    pattern: '^https://',
    doc: '北辰站点根地址，不含尾部斜杠。只影响目的地，不影响邀请码。',
  },
  registerPath: {
    kind: 'string',
    default: DEFAULT_REGISTER_PATH,
    pattern: '^/',
    doc: '注册页路径，必须以斜杠开头。',
  },
  openInPane: {
    kind: 'boolean',
    default: true,
    doc: '是否请求内置浏览器窗口打开入口页。关掉时只返回地址，由调用方自己处理。',
  },
})

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'beichen'

/** Config 键（camelCase）→ 段字段键（kebab-case）的唯一映射。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enabled: 'enabled',
  ttlMinutes: 'ttl-minutes',
  siteBaseUrl: 'site-base-url',
  registerPath: 'register-path',
  openInPane: 'open-in-pane',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '北辰入口',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-beichen-api',
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enabled: FIELD_SPECS.enabled.default as boolean,
  ttlMinutes: FIELD_SPECS.ttlMinutes.default as number,
  siteBaseUrl: FIELD_SPECS.siteBaseUrl.default as string,
  registerPath: FIELD_SPECS.registerPath.default as string,
  openInPane: FIELD_SPECS.openInPane.default as boolean,
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * @param raw 原始配置对象。
 * @returns 键已归一化的普通对象；未知键原样保留交给 O-005 报错。
 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_PAIRS[key as keyof Config] ?? key] = value
  }
  return out
}

/**
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状（camel 键）。
 * @param values 解析结果的 `values`。
 * @returns Config 形状的普通对象。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_KEYS[key] ?? key] = value
  }
  return out
}

/** 夹一个数字。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 去掉尾部斜杠。 */
function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/**
 * 补全并校验配置。**能补的全补，补不了的才报问题**。
 * @param raw 原始配置。
 * @returns 补全后的配置与问题列表。
 */
export function completeConfig(raw: unknown): { config: Config; issues: readonly { field: string; message: string }[] } {
  const issues: { field: string; message: string }[] = []
  const source = isRecord(raw) ? raw : {}

  const enabled = typeof source['enabled'] === 'boolean'
    ? source['enabled']
    : (issues.push({ field: 'enabled', message: 'enabled 不是布尔值，已回退 true' }), true)

  const ttlMinutes = clampNumber(source['ttlMinutes'], DEFAULT_TTL_MINUTES, 1, 1440)

  let siteBaseUrl = DEFAULT_SITE_BASE_URL
  const siteRaw = source['siteBaseUrl']
  if (siteRaw !== undefined) {
    if (typeof siteRaw === 'string' && siteRaw.startsWith('https://') && siteRaw.length > 10) {
      siteBaseUrl = trimTrailingSlash(siteRaw)
    } else {
      issues.push({ field: 'siteBaseUrl', message: 'siteBaseUrl 必须是 https:// 开头的地址，已回退默认值' })
    }
  }

  let registerPath = DEFAULT_REGISTER_PATH
  const pathRaw = source['registerPath']
  if (pathRaw !== undefined) {
    if (typeof pathRaw === 'string' && pathRaw.startsWith('/') && pathRaw.length > 1 && !pathRaw.endsWith('/')) {
      registerPath = pathRaw
    } else {
      issues.push({ field: 'registerPath', message: 'registerPath 必须是以斜杠开头且不以斜杠结尾的路径，已回退默认值' })
    }
  }

  const openInPane = typeof source['openInPane'] === 'boolean'
    ? source['openInPane']
    : (source['openInPane'] === undefined
      ? true
      : (issues.push({ field: 'openInPane', message: 'openInPane 不是布尔值，已回退 true' }), true))

  return { config: { enabled, ttlMinutes, siteBaseUrl, registerPath, openInPane }, issues }
}
