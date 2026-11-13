/**
 * O-119 `ondra-sandbox` 的配置**单一真源**。
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
 * ## 默认值从哪来
 *
 * 手册与本仓台账都**没有**给票据期限——这套东西是本包先落地的。故下面六个数字
 * 全是**本插件的工程取值**，依据是「一张票在什么时间尺度上还有意义」：
 *
 * - 24 小时：一个自然日。跨夜之后世界通常已经变了，昨天批的 `act` 今天不该继续有效；
 * - 168 小时（7 天）：最长的合理期限。再长的票等于把「限期」这个名字取消了；
 * - 8 次：一次认真干活大概会踩这么多次。再多就说明该按动作单独签，而不是签一张大票；
 * - 100 次：单票的次数天花板。到这一步票已经等于「长期授权」，该走人工；
 * - 128 张：票据档的容量。每张票约 300 字节，128 张不到 40KB，读一次盘不会卡。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「spend 要不要二次确认」。** 那是纪律不是偏好。做成开关就等于允许
 *    「这次先不确认」，而那个开关只会在赶时间时被关掉。
 * 2. **没有「没票时默认放行」。** default-deny 是本包的定义，不是它的默认值。
 * 3. **没有「记不记调用内容」。** 盘上只有票据，没有参数与返回值；这一条不该可配。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不联网、不发消息，只做判定与记账。 */
  readonly enable: boolean
  /** 默认票期（小时）。 */
  readonly defaultTtlHours: number
  /** 票期上限（小时）。请求超过它会被夹到它。 */
  readonly maxTtlHours: number
  /** 默认次数上限。 */
  readonly defaultUses: number
  /** 单票次数上限。请求超过它会被夹到它。 */
  readonly maxUses: number
  /** 票据档最多保留多少张（含已终态的）。 */
  readonly maxTickets: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'sandbox'

/** 票期上下界（小时）。下界 1 小时：比一小时更短的票不如不要。 */
export const TTL_FLOOR_HOURS = 1
export const TTL_CEILING_HOURS = 8760

/** 次数上下界。 */
export const USES_FLOOR = 1
export const USES_CEILING = 10_000

/** 票据档容量上下界。下界 8：容不下 8 张票的档，连「按动作签票」都做不到。 */
export const TICKETS_FLOOR = 8
export const TICKETS_CEILING = 4096

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，grant() / check() / revoke() 抛 disabled，snapshot() 照常可读。',
  },
  defaultTtlHours: {
    kind: 'number',
    default: 24,
    min: TTL_FLOOR_HOURS,
    max: TTL_CEILING_HOURS,
    doc: '默认票期（小时）。默认 24：跨夜之后世界通常已经变了。',
    unit: '小时',
  },
  maxTtlHours: {
    kind: 'number',
    default: 168,
    min: TTL_FLOOR_HOURS,
    max: TTL_CEILING_HOURS,
    doc: '票期上限（小时）。默认 168（7 天）。再长的票等于取消了「限期」这个名字。',
    unit: '小时',
  },
  defaultUses: {
    kind: 'number',
    default: 8,
    min: USES_FLOOR,
    max: USES_CEILING,
    doc: '默认次数上限。默认 8：再多就该按动作单独签票，而不是签一张大票。',
  },
  maxUses: {
    kind: 'number',
    default: 100,
    min: USES_FLOOR,
    max: USES_CEILING,
    doc: '单票次数上限。默认 100。到这一步票已等于长期授权，该走人工。',
  },
  maxTickets: {
    kind: 'number',
    default: 128,
    min: TICKETS_FLOOR,
    max: TICKETS_CEILING,
    advancedOnly: true,
    doc: '票据档容量（含已终态的票）。满了先回收最老的终态票，回收不动才拒签。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  defaultTtlHours: FIELD_SPECS.defaultTtlHours.default as number,
  maxTtlHours: FIELD_SPECS.maxTtlHours.default as number,
  defaultUses: FIELD_SPECS.defaultUses.default as number,
  maxUses: FIELD_SPECS.maxUses.default as number,
  maxTickets: FIELD_SPECS.maxTickets.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  defaultTtlHours: 'default-ttl-hours',
  maxTtlHours: 'max-ttl-hours',
  defaultUses: 'default-uses',
  maxUses: 'max-uses',
  maxTickets: 'max-tickets',
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
  title: '能力分级沙箱',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-sandbox',
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
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 *
 * 唯一的跨字段修正：两个上限必须不小于各自对应的默认值。
 * 顺序写反时（`maxTtlHours < defaultTtlHours`），默认票期会超过上限，
 * 于是「夹到上限」这条规则会在每一张票上都触发，而调用方看不出为什么。
 * 修正方式是**把上限抬到不低于默认值**，而不是把默认值压下来——
 * 压低默认值等于悄悄缩短所有票的期限，那是更危险的方向。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const num = (key: keyof Config, fallback: number, min: number, max: number): number => {
    const given = raw[key]
    if (typeof given !== 'number' || !Number.isFinite(given)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(given)))
  }

  const defaultTtlHours = num(
    'defaultTtlHours',
    DEFAULT_CONFIG.defaultTtlHours,
    TTL_FLOOR_HOURS,
    TTL_CEILING_HOURS,
  )
  const maxTtlRaw = num('maxTtlHours', DEFAULT_CONFIG.maxTtlHours, TTL_FLOOR_HOURS, TTL_CEILING_HOURS)
  const maxTtlHours = maxTtlRaw >= defaultTtlHours ? maxTtlRaw : Math.min(TTL_CEILING_HOURS, defaultTtlHours)

  const defaultUses = num('defaultUses', DEFAULT_CONFIG.defaultUses, USES_FLOOR, USES_CEILING)
  const maxUsesRaw = num('maxUses', DEFAULT_CONFIG.maxUses, USES_FLOOR, USES_CEILING)
  const maxUses = maxUsesRaw >= defaultUses ? maxUsesRaw : Math.min(USES_CEILING, defaultUses)

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    defaultTtlHours,
    maxTtlHours,
    defaultUses,
    maxUses,
    maxTickets: num('maxTickets', DEFAULT_CONFIG.maxTickets, TICKETS_FLOOR, TICKETS_CEILING),
  })
}
