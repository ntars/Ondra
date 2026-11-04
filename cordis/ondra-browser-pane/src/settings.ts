/**
 * 配置的**单一真源**。
 *
 * 只有两项，且都刻意保守：
 *
 * - `enabled`：总开关。
 * - `extraHosts`：额外放行的域名。**默认空**，因为它会削弱白名单；
 *   真要加，必须由用户明确写出来，而不是由某个插件顺手追加。
 *
 * 之所以不提供「允许任意 https」这种开关：一个能打开任意网页的容器，
 * 其用途由当时页面上的链接决定，而不是由设计意图决定。
 */

/** 本插件配置。 */
export interface Config {
  /** 总开关。关掉后不注册路由、不提供服务。 */
  readonly enabled: boolean
  /** 额外放行的外部域名（含子域）。默认空数组。 */
  readonly extraHosts: readonly string[]
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

/** 字段声明表。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enabled: {
    kind: 'boolean',
    default: true,
    doc: '内置浏览器总开关。关掉后不注册路由，其他插件也无法登记页面。',
  },
  extraHosts: {
    kind: 'json',
    default: [],
    advancedOnly: true,
    doc: '额外放行的外部域名（含子域，如 "example.com"）。默认空；每加一条都会扩大面板能打开的范围。',
  },
})

/** 段键。 */
export const CONFIG_SECTION_ID = 'browser-pane'

/** Config 键 → 段字段键。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enabled: 'enabled',
  extraHosts: 'extra-hosts',
})

/** 段字段键 → Config 键。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '内置浏览器',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-browser-pane',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 用户层归一化。 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_PAIRS[key as keyof Config] ?? key] = value
  }
  return out
}

/** 解析结果回填成 Config 形状。 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_KEYS[key] ?? key] = value
  }
  return out
}

/** 域名形状：小写字母、数字、点、连字符，至少含一个点。 */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/**
 * 补全并校验配置。
 * @param raw 原始配置。
 * @returns 配置与问题列表。
 */
export function completeConfig(raw: unknown): { config: Config; issues: readonly { field: string; message: string }[] } {
  const issues: { field: string; message: string }[] = []
  const source = isRecord(raw) ? raw : {}

  let enabled = true
  const enabledRaw = source['enabled']
  if (enabledRaw !== undefined) {
    if (typeof enabledRaw === 'boolean') enabled = enabledRaw
    else issues.push({ field: 'enabled', message: 'enabled 不是布尔值，已回退 true' })
  }

  const extraHosts: string[] = []
  const hostsRaw = source['extraHosts']
  if (hostsRaw !== undefined) {
    if (!Array.isArray(hostsRaw)) {
      issues.push({ field: 'extraHosts', message: 'extraHosts 不是数组，已回退空清单' })
    } else {
      for (const item of hostsRaw) {
        if (typeof item !== 'string') {
          issues.push({ field: 'extraHosts', message: 'extraHosts 里有非字符串项，已忽略' })
          continue
        }
        const host = item.trim().toLowerCase()
        if (!HOST_RE.test(host)) {
          issues.push({ field: 'extraHosts', message: `${item} 不是合法域名，已忽略（不要带协议与路径）` })
          continue
        }
        extraHosts.push(host)
      }
    }
  }

  return { config: { enabled, extraHosts }, issues }
}
