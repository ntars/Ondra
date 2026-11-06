/**
 * O-106 `ondra-crisis` 的配置**单一真源**。
 *
 * 与 O-005 的口径一致：默认值由声明方拥有、全仓只存一份。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么 `hotlines` 默认是空数组
 *
 * 这是本插件**最重要的一个默认值决定**。热线号码有地区差异（中国大陆、
 * 港台、海外各不相同），也会变更；写死一个号码，在危机时刻拨过去是空号，
 * 比不给号码更糟——它会把「有人能帮我」这个最后的念头也打掉。
 *
 * 故：不内置任何号码，由部署方填入；没填时 `resources().guidance` 仍然给出
 * 不依赖号码的一句指引（联系身边能到场的人 / 当地急救）。README §9 已写明。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「关掉某一类信号」的勾选。** 关掉「告别」类之后，
 *    那一类表达就成了唯一没有护栏的形态——而它恰恰最需要被接住。
 * 2. **没有「敏感度 / 阈值」滑块。** 一个滑块能调到「什么都不报」，
 *    等于给了一个「眼不见为净」的开关，而且调完之后界面看起来很干净。
 * 3. **没有「自动通知紧急联系人」。** 那需要把联系方式与判定结果送出进程，
 *    属于本插件不该拥有的能力；要不要通知、通知谁，必须由人当场决定。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 一条号码。 */
export interface HotlineConfig {
  /** 名称。 */
  readonly label: string
  /** 号码。 */
  readonly number: string
}

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：纯判定，不发网络、不落盘。 */
  readonly enable: boolean
  /** 求助号码列表。**默认为空**：号码由部署方填。 */
  readonly hotlines: readonly HotlineConfig[]
  /** 追加在兜底指引后面的一句话（例如本地机构名）。 */
  readonly extraGuidance: string
  /** 单次扫描的最大字符数。超出截断并标 `truncated`。 */
  readonly scanChars: number
  /** 判定对象是别人时，是否也给求助资源。 */
  readonly thirdPartyResources: boolean
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'crisis'

/** 单次扫描的硬上限。**再大也只是正则成本，但截断必须说出来。** */
export const MAX_SCAN_CHARS = 20_000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，assess() 抛 disabled——不会静默返回 none。',
  },
  hotlines: {
    kind: 'json',
    default: Object.freeze([]),
    doc: '求助号码列表，每项 { label, number }。默认为空：号码有地区差异且会变更，本插件刻意不内置。',
  },
  extraGuidance: {
    kind: 'string',
    default: '',
    doc: '追加在兜底指引后面的一句话（例如本地机构名）。留空则只用内置指引。',
  },
  scanChars: {
    kind: 'number',
    default: 4000,
    min: 200,
    max: MAX_SCAN_CHARS,
    advancedOnly: true,
    doc: '单次扫描最大字符数。一条消息超过它就会被截断，并在 flags.truncated 里说出来。',
  },
  thirdPartyResources: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '说的是别人（朋友/家人）时是否也给求助资源。默认给——「帮朋友问」常常是本人。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  hotlines: Object.freeze([]) as readonly HotlineConfig[],
  extraGuidance: FIELD_SPECS.extraGuidance.default as string,
  scanChars: FIELD_SPECS.scanChars.default as number,
  thirdPartyResources: FIELD_SPECS.thirdPartyResources.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  hotlines: 'hotlines',
  extraGuidance: 'extra-guidance',
  scanChars: 'scan-chars',
  thirdPartyResources: 'third-party-resources',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '危机干预分级',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-crisis',
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
    out[KEY_PAIRS[key as keyof Config] ?? key] = value
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
    out[SECTION_KEYS[key] ?? key] = value
  }
  return out
}

/**
 * 归一化号码表。**坏一条丢一条，不丢整表**：
 * 一个填错的号码不该让另外三个能用的号码一起失效。
 * @param raw 原始值。
 */
export function normalizeHotlines(raw: unknown): readonly HotlineConfig[] {
  if (!Array.isArray(raw)) return Object.freeze([])
  const out: HotlineConfig[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const number = typeof item['number'] === 'string' ? item['number'].trim() : ''
    if (number === '') continue
    if (seen.has(number)) continue
    const label = typeof item['label'] === 'string' && item['label'].trim() !== '' ? item['label'].trim() : '求助热线'
    seen.add(number)
    out.push(Object.freeze({ label, number }))
    if (out.length >= 8) break
  }
  return Object.freeze(out)
}

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const text = (key: keyof Config, fallback: string, max: number): string => {
    const given = raw[key]
    if (typeof given !== 'string') return fallback
    return given.slice(0, max)
  }
  const count = (key: keyof Config, fallback: number, min: number, max: number): number => {
    const given = raw[key]
    if (typeof given !== 'number' || !Number.isFinite(given)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(given)))
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    hotlines: normalizeHotlines(raw['hotlines']),
    extraGuidance: text('extraGuidance', DEFAULT_CONFIG.extraGuidance, 200).trim(),
    scanChars: count('scanChars', DEFAULT_CONFIG.scanChars, 200, MAX_SCAN_CHARS),
    thirdPartyResources: bool('thirdPartyResources', DEFAULT_CONFIG.thirdPartyResources),
  })
}
