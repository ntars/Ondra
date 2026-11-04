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
 * ## 哪些数进配置、哪些不进
 *
 * 进配置的是**手册给了数字或给了档位**的那些：口头禅 2 次 / 池 12–20 条 /
 * 不完整句 0.08 / 贴纸间隔 3 条 / 中位 8–12 字。
 *
 * 不进配置的是**形态**：语气词表、可省主语表、标点替换规则。
 * 做成配置项就等于每台机器说的不是同一种中文，而提示词预览
 * 与 O-137 语感统计都只认一个版本。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`habitMaxPerSession`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import {
  HARD_MAX_HABIT_PER_SESSION,
  HARD_MAX_POOL_SIZE,
  HARD_MIN_POOL_SIZE,
  HARD_MIN_STICKER_GAP,
} from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 口头禅默认插入位。手册只说「口头禅」，没说插哪儿。 */
export const HABIT_PLACEMENTS: readonly string[] = Object.freeze(['suffix', 'prefix'])

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，`apply()` 原样返回。 */
  readonly enable: boolean
  /** 是否插口头禅。 */
  readonly habitEnabled: boolean
  /**
   * 单场最多几次。默认 2，**上限也锁 2**（手册原文「单场最多 2 次」）。
   *
   * 调到 3 只认 2：多出来的那一次会和 O-037 的 4-gram 复读检测撞车，
   * 表现为「她一句话被折叠掉一半」。
   */
  readonly habitMaxPerSession: number
  /** 池子够用的下限。默认 12（手册「12–20 条」）。 */
  readonly habitMinPoolSize: number
  /** 池子上限。默认 20（手册「12–20 条」）。 */
  readonly habitMaxPoolSize: number
  /** `placement: 'any'` 的条目插在句尾还是句首。默认句尾。 */
  readonly habitPlacement: string
  /** 是否允许不完整句。 */
  readonly incompleteEnabled: boolean
  /** 不完整句概率。默认 0.08（手册原值）。 */
  readonly incompleteP: number
  /** 是否按 O-031 的语气词档做减法。 */
  readonly particlesEnabled: boolean
  /** 是否按标点习惯塑形。 */
  readonly punctEnabled: boolean
  /** 中位字数下界。默认 8（手册「单条中位 8–12 字」）。 */
  readonly medianMin: number
  /** 中位字数上界。默认 12。 */
  readonly medianMax: number
  /** 贴纸最小间隔（条）。默认 3，**下限也锁 3**。 */
  readonly stickerGap: number
  /** 降级与跳过时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'oral'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，apply() 原样返回。',
  },
  habitEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否插口头禅（池子不够 12 条时自动不插）。',
  },
  habitMaxPerSession: {
    kind: 'number',
    default: HARD_MAX_HABIT_PER_SESSION,
    min: 0,
    max: HARD_MAX_HABIT_PER_SESSION,
    doc: '单场最多几次口头禅。手册 §4.2 原值 2，上限锁 2。',
  },
  habitMinPoolSize: {
    kind: 'number',
    default: HARD_MIN_POOL_SIZE,
    min: HARD_MIN_POOL_SIZE,
    max: HARD_MAX_POOL_SIZE,
    advancedOnly: true,
    doc: '池子够用的下限。手册 §4.2「每人格 12–20 条」。',
  },
  habitMaxPoolSize: {
    kind: 'number',
    default: HARD_MAX_POOL_SIZE,
    min: HARD_MIN_POOL_SIZE,
    max: HARD_MAX_POOL_SIZE,
    advancedOnly: true,
    doc: '池子上限。手册 §4.2「每人格 12–20 条」。',
  },
  habitPlacement: {
    kind: 'enum',
    values: HABIT_PLACEMENTS,
    default: 'suffix',
    doc: 'placement 为 any 的口头禅插在句尾还是句首。',
  },
  incompleteEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否允许不完整句（省略主语或收尾词）。',
  },
  incompleteP: {
    kind: 'number',
    default: 0.08,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '不完整句概率（整轮最多一条）。手册 §4.2 原值 0.08。',
  },
  particlesEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否按 O-031 的语气词档做减法（只减不加，加词归模型）。',
  },
  punctEnabled: {
    kind: 'boolean',
    default: true,
    doc: '是否按标点习惯塑形（不用句号结尾 / 连续问号 / 省略号）。',
  },
  medianMin: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 60,
    advancedOnly: true,
    doc: '中位字数下界。手册 §4.2「单条中位 8–12 字」。',
  },
  medianMax: {
    kind: 'number',
    default: 12,
    min: 1,
    max: 80,
    advancedOnly: true,
    doc: '中位字数上界。手册 §4.2「单条中位 8–12 字」。',
  },
  stickerGap: {
    kind: 'number',
    default: HARD_MIN_STICKER_GAP,
    min: HARD_MIN_STICKER_GAP,
    max: 20,
    advancedOnly: true,
    doc: '贴纸最小间隔（条）。手册 §4.2 原值 3，下限锁 3。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与跳过时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  habitEnabled: FIELD_SPECS.habitEnabled.default as boolean,
  habitMaxPerSession: FIELD_SPECS.habitMaxPerSession.default as number,
  habitMinPoolSize: FIELD_SPECS.habitMinPoolSize.default as number,
  habitMaxPoolSize: FIELD_SPECS.habitMaxPoolSize.default as number,
  habitPlacement: FIELD_SPECS.habitPlacement.default as string,
  incompleteEnabled: FIELD_SPECS.incompleteEnabled.default as boolean,
  incompleteP: FIELD_SPECS.incompleteP.default as number,
  particlesEnabled: FIELD_SPECS.particlesEnabled.default as boolean,
  punctEnabled: FIELD_SPECS.punctEnabled.default as boolean,
  medianMin: FIELD_SPECS.medianMin.default as number,
  medianMax: FIELD_SPECS.medianMax.default as number,
  stickerGap: FIELD_SPECS.stickerGap.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  habitEnabled: 'habit-enabled',
  habitMaxPerSession: 'habit-max-per-session',
  habitMinPoolSize: 'habit-min-pool-size',
  habitMaxPoolSize: 'habit-max-pool-size',
  habitPlacement: 'habit-placement',
  incompleteEnabled: 'incomplete-enabled',
  incompleteP: 'incomplete-p',
  particlesEnabled: 'particles-enabled',
  punctEnabled: 'punct-enabled',
  medianMin: 'median-min',
  medianMax: 'median-max',
  stickerGap: 'sticker-gap',
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
  title: '口语化',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-oral',
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

/** 夹一个浮点数。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 两个数的上下限若写反了就换过来（不报错，静默修正）。 */
function orderPair(low: number, high: number): readonly [number, number] {
  return low <= high ? [low, high] : [high, low]
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const [habitMinPoolSize, habitMaxPoolSize] = orderPair(
    clampInt(raw['habitMinPoolSize'], DEFAULT_CONFIG.habitMinPoolSize, HARD_MIN_POOL_SIZE, HARD_MAX_POOL_SIZE),
    clampInt(raw['habitMaxPoolSize'], DEFAULT_CONFIG.habitMaxPoolSize, HARD_MIN_POOL_SIZE, HARD_MAX_POOL_SIZE),
  )
  const [medianMin, medianMax] = orderPair(
    clampInt(raw['medianMin'], DEFAULT_CONFIG.medianMin, 1, 60),
    clampInt(raw['medianMax'], DEFAULT_CONFIG.medianMax, 1, 80),
  )

  const placement =
    typeof raw['habitPlacement'] === 'string' && HABIT_PLACEMENTS.includes(raw['habitPlacement'])
      ? raw['habitPlacement']
      : DEFAULT_CONFIG.habitPlacement

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    habitEnabled: bool('habitEnabled', DEFAULT_CONFIG.habitEnabled),
    // 上限锁 2：手册原文「单场最多 2 次」。
    habitMaxPerSession: clampInt(
      raw['habitMaxPerSession'],
      DEFAULT_CONFIG.habitMaxPerSession,
      0,
      HARD_MAX_HABIT_PER_SESSION,
    ),
    habitMinPoolSize,
    habitMaxPoolSize,
    habitPlacement: placement,
    incompleteEnabled: bool('incompleteEnabled', DEFAULT_CONFIG.incompleteEnabled),
    incompleteP: clampNumber(raw['incompleteP'], DEFAULT_CONFIG.incompleteP, 0, 1),
    particlesEnabled: bool('particlesEnabled', DEFAULT_CONFIG.particlesEnabled),
    punctEnabled: bool('punctEnabled', DEFAULT_CONFIG.punctEnabled),
    medianMin,
    medianMax,
    // 下限锁 3：手册原文「贴纸触发最小间隔 3 条」。
    stickerGap: clampInt(raw['stickerGap'], DEFAULT_CONFIG.stickerGap, HARD_MIN_STICKER_GAP, 20),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
