/**
 * 配置的**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * 本插件**没有一个「必须由用户填」的字段**（§3.3-2）。衰减是后台机制，
 * 它一旦要求用户先配三个数才生效，就等于把「她会忘」变成一道调参题。
 *
 * 刻意**不放进配置**的两组值：
 * - **艾宾浩斯八档**（5min/30min/12h/1d/2d/4d/7d/15d）是手册 §2.4 的原表，
 *   放在 `sm2.ts` 里当常量。做成可调就等于承认它可以被随手改，
 *   而它一旦被改，「复习节拍」这个产品行为就没有依据了。
 * - **EF 上下限**（1.3 / 2.8）是 SM-2 的标准下限 + 本项目补的上限，同理。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 「清晰」的强度下界。默认 0.7（手册 §2.6）。 */
  readonly clearAbove: number
  /** 「模糊」的强度下界。默认 0.4（手册 §2.6）。低于它只剩个影子。 */
  readonly fadedAbove: number
  /** 单次 `dueForReview()` 最多返回几条。默认 100。 */
  readonly maxReviewBatch: number
  /** 单次扫描最多看多少条活跃记忆。默认 3000。 */
  readonly maxScanRows: number
  /** 单次扫描最多为多少条新建复习计划。默认 50。 */
  readonly maxInitPerScan: number
  /** SM-2 间隔上限（天）。默认 365。 */
  readonly maxIntervalDays: number
  /**
   * 是否自己起定时器做周期扫描。默认 **false**。
   *
   * 默认关的理由：插件装载顺序不确定，定时器跑在第几个插件之后是运气；
   * 而扫描会调 `archiveDue()`——**那是一次写操作**。把写操作交给一个
   * 「不知道什么时候开始跑」的定时器，排查成本远高于收益。
   * 扫描时机应由 O-019 夜巡 / O-033 回合边界 / O-077 自检显式调用。
   */
  readonly autoScan: boolean
  /** 自动扫描的间隔（分钟）。默认 360（6 小时）。仅 `autoScan=true` 时生效。 */
  readonly scanIntervalMinutes: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-decay'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归 O-092。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不扫描、不排复习；O-010 的强度计算不受影响（它本来就不依赖本插件）。',
  },
  clearAbove: {
    kind: 'number',
    default: 0.7,
    min: 0.05,
    max: 1,
    doc: '「清晰」的强度下界（手册 §2.6）。高于它，注入时行尾不加任何话术。',
  },
  fadedAbove: {
    kind: 'number',
    default: 0.4,
    min: 0.01,
    max: 0.99,
    doc: '「模糊」的强度下界（手册 §2.6）。低于它只剩个影子，注入时行尾带「，只剩个模糊的影子」。',
  },
  maxReviewBatch: {
    kind: 'number',
    default: 100,
    min: 1,
    max: 1000,
    doc: '单次取待复习清单的上限。复习是给人看的，一次列一千条没人看得完。',
  },
  maxScanRows: {
    kind: 'number',
    default: 3000,
    min: 20,
    max: 20000,
    advancedOnly: true,
    doc: '单次扫描最多看多少条活跃记忆。超出的下一轮接着扫（报告里 truncated=true）。',
  },
  maxInitPerScan: {
    kind: 'number',
    default: 50,
    min: 1,
    max: 1000,
    advancedOnly: true,
    doc: '单次最多为多少条新建复习计划。存量库第一次扫描时会一次性全到期，必须限流。',
  },
  maxIntervalDays: {
    kind: 'number',
    default: 365,
    min: 1,
    max: 3650,
    advancedOnly: true,
    doc: 'SM-2 间隔上限（天）。没有上限时 EF 连续走高会把下次复习推到几年后，等于永不复习。',
    unit: '天',
  },
  autoScan: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '是否自己起定时器周期扫描。默认关：扫描会触发沉底（写操作），时机应由夜巡/回合边界决定。',
  },
  scanIntervalMinutes: {
    kind: 'number',
    default: 360,
    min: 5,
    max: 10080,
    advancedOnly: true,
    doc: '自动扫描间隔（分钟）。仅 autoScan=true 时生效。',
    unit: '分钟',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  clearAbove: FIELD_SPECS.clearAbove.default as number,
  fadedAbove: FIELD_SPECS.fadedAbove.default as number,
  maxReviewBatch: FIELD_SPECS.maxReviewBatch.default as number,
  maxScanRows: FIELD_SPECS.maxScanRows.default as number,
  maxInitPerScan: FIELD_SPECS.maxInitPerScan.default as number,
  maxIntervalDays: FIELD_SPECS.maxIntervalDays.default as number,
  autoScan: FIELD_SPECS.autoScan.default as boolean,
  scanIntervalMinutes: FIELD_SPECS.scanIntervalMinutes.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），而 Cordis 插件实例
 * 配置历来是 camelCase。映射必须**双向唯一**，否则两个字段会抢同一个段键，
 * 表现是「改 A 生效在 B 上」——比报错难查十倍。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  clearAbove: 'clear-above',
  fadedAbove: 'faded-above',
  maxReviewBatch: 'max-review-batch',
  maxScanRows: 'max-scan-rows',
  maxInitPerScan: 'max-init-per-scan',
  maxIntervalDays: 'max-interval-days',
  autoScan: 'auto-scan',
  scanIntervalMinutes: 'scan-interval-minutes',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆衰减',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-decay',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**，交给 O-005 报 `unknown-field`——在这里悄悄吞掉，
 * 用户就只会看到「我填了怎么没生效」。
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

/** 夹一个浮点。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const clearAbove = clampFloat(raw['clearAbove'], DEFAULT_CONFIG.clearAbove, 0.05, 1)
  // 两档有先后关系：`fadedAbove` 高于 `clearAbove` 会让「模糊」比「清晰」还严，
  // 结果是一半记忆永远显示「记不太清了」。这里做一次保序，而不是报错。
  const fadedAbove = Math.min(
    clearAbove,
    clampFloat(raw['fadedAbove'], DEFAULT_CONFIG.fadedAbove, 0.01, 0.99),
  )

  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    clearAbove,
    fadedAbove,
    maxReviewBatch: clampInt(raw['maxReviewBatch'], DEFAULT_CONFIG.maxReviewBatch, 1, 1000),
    maxScanRows: clampInt(raw['maxScanRows'], DEFAULT_CONFIG.maxScanRows, 20, 20000),
    maxInitPerScan: clampInt(raw['maxInitPerScan'], DEFAULT_CONFIG.maxInitPerScan, 1, 1000),
    maxIntervalDays: clampInt(raw['maxIntervalDays'], DEFAULT_CONFIG.maxIntervalDays, 1, 3650),
    autoScan: raw['autoScan'] === undefined ? DEFAULT_CONFIG.autoScan : raw['autoScan'] === true,
    scanIntervalMinutes: clampInt(raw['scanIntervalMinutes'], DEFAULT_CONFIG.scanIntervalMinutes, 5, 10080),
  })
}
