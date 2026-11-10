/**
 * 配置的**单一真源**。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## `provider` 为什么有 `auto`
 *
 * 手册要求「双分支直接复用对拍」，但用户不该需要知道两个包名才用得上农历。
 * 默认 `auto`：装了就接、没装就只剩公历，**永远不因为缺一个可选包而不工作**。
 * 想强制某一条（对拍、排障）时才写死包名。
 *
 * ## 为什么没有「农历显示格式」这类开关
 *
 * 格式一处（`service.text()`），想改就改那一处。多一个开关就多一种「配置了但没生效」
 * 的可能，而这个功能每天被读到的次数屈指可数，排障成本远高于收益。
 */

import type { FieldSpecLike, ProviderChoice, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`facts()` 仍可算（纯日期数学），但面板应显示已关闭。 */
  readonly enable: boolean
  /** 历法分支选择。 */
  readonly provider: ProviderChoice
  /** 启动时是否对拍一次（两条分支都在位才有意义）。 */
  readonly crosscheckOnStart: boolean
  /** `upcoming()` 的默认天数。 */
  readonly upcomingDays: number
  /** 事实缓存的日数上限（超过就整个清空，不做 LRU）。 */
  readonly cacheDays: number
  /** 降级是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'live'

/** 日期事实缓存上限的下界：一天至少要能缓存「今天 + 未来一周」。 */
export const CACHE_FLOOR = 16

/** 日期事实缓存上限的上界。再大就是拿内存换几次纯计算，不划算。 */
export const CACHE_CEIL = 1000

/** `upcoming()` 默认未来几天。 */
export const DEFAULT_UPCOMING_DAYS = 7

/** 未来最多看几天（再多就是「节日日历」，那是另一个界面）。 */
export const UPCOMING_CEIL = 60

/** 分支取值（与 `ProviderChoice` 同源，供段声明用）。 */
export const PROVIDER_VALUES: readonly string[] = Object.freeze([
  'auto',
  'lunar-js',
  'tyme4ts',
  'solar-only',
])

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后事实仍可算（纯日期数学），但界面应显示已关闭。',
  },
  provider: {
    kind: 'enum',
    default: 'auto',
    values: PROVIDER_VALUES,
    doc: '历法分支：auto（有农历包就用，没有就公历）· lunar-js · tyme4ts · solar-only。',
  },
  crosscheckOnStart: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '启动时对拍一次（两条农历分支都在位才有意义）。差异只记日志，不自动改选。',
  },
  upcomingDays: {
    kind: 'number',
    default: DEFAULT_UPCOMING_DAYS,
    min: 0,
    max: UPCOMING_CEIL,
    advancedOnly: true,
    doc: 'upcoming() 默认往后看几天。',
  },
  cacheDays: {
    kind: 'number',
    default: 200,
    min: CACHE_FLOOR,
    max: CACHE_CEIL,
    advancedOnly: true,
    doc: '日期事实缓存的日数上限。超过就整体清空（不做 LRU：这个缓存重建一整天只要一次计算）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  provider: FIELD_SPECS.provider.default as ProviderChoice,
  crosscheckOnStart: FIELD_SPECS.crosscheckOnStart.default as boolean,
  upcomingDays: FIELD_SPECS.upcomingDays.default as number,
  cacheDays: FIELD_SPECS.cacheDays.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  provider: 'provider',
  crosscheckOnStart: 'crosscheck-on-start',
  upcomingDays: 'upcoming-days',
  cacheDays: 'cache-days',
  verbose: 'verbose',
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
  title: '日期事实',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-live',
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

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 归一化分支名。非法值回退 `auto`（**不是回退 solar-only**：
 * 写错一个分支名不该让农历整块消失）。
 * @param value 原始值。
 * @param fallback 默认值。
 */
function providerOf(value: unknown, fallback: ProviderChoice): ProviderChoice {
  if (value === 'auto' || value === 'lunar-js' || value === 'tyme4ts' || value === 'solar-only') return value
  return fallback
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    provider: providerOf(raw['provider'], DEFAULT_CONFIG.provider),
    crosscheckOnStart: bool('crosscheckOnStart', DEFAULT_CONFIG.crosscheckOnStart),
    upcomingDays: clampInt(raw['upcomingDays'], DEFAULT_CONFIG.upcomingDays, 0, UPCOMING_CEIL),
    cacheDays: clampInt(raw['cacheDays'], DEFAULT_CONFIG.cacheDays, CACHE_FLOOR, CACHE_CEIL),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
