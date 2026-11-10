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
 * ## 哪些数不进配置
 *
 * 八块的名字与顺序、行格式、`另有 N 条未展开` 这句话本身，都是**手册规定的形态**。
 * 做成配置项就等于让每台机器的注入格式不一样，而 O-142 的记账键、
 * O-125 的预览、O-133 的自检都只认一个版本。这里只留「这台机器怎么跑」的参数。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`maxPersons`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import type { BlockId, FieldSpecLike, SectionDeclLike } from './types.js'
import { BUDGET_PRESETS } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `render()` 返回空正文并给出原因。 */
  readonly enable: boolean
  /**
   * 预算档位。默认 `standard`（2600 字符，手册 §2.6）。
   *
   * **只是给界面一键填的预设**：`budgetChars` 一旦大于 0，就以它为准。
   */
  readonly budgetPreset: 'small' | 'standard' | 'large'
  /**
   * 预算（字符）。默认 `0` = 用档位预设。
   *
   * 真源只有一个：`budgetOf()`。写死 2600 又留一个档位，就是两个真源。
   */
  readonly budgetChars: number
  /** ① 到期提醒的条数上限。默认 3（**手册未给数**，取 3，见 README 待裁决）。 */
  readonly maxPromises: number
  /** ② 钉住的条数上限。默认 8（手册 §2.6 逐字：≤8）。 */
  readonly maxPinned: number
  /** ③ person 类记忆的条数上限。默认 5（手册 §2.6 逐字：≤5）。 */
  readonly maxPersons: number
  /** ④ 那年今日的条数上限。默认 3（手册 §2.6 逐字：≤3）。 */
  readonly maxAnniversary: number
  /** ⑥ 记下的道理的条数上限。默认 3（手册 §2.6 逐字：≤3）。 */
  readonly maxLessons: number
  /**
   * ④ 那年今日的扫描条数上限。默认 500。
   *
   * 这一块要按 `createdAt` 找整年/整月，而 O-010 的 `listFacts` 没有日期区间条件。
   * 扫描有成本，所以给一个上限；被截断时会在 `degradations` 里报
   * `anniversary-scan-capped`——**不静默漏**。
   */
  readonly anniversaryScanLimit: number
  /** 是否给每段加中文小标题。默认 `true`（段标题是「另有 N 条未展开」的载体）。 */
  readonly includeHeadings: boolean
  /**
   * 是否遵守记忆池的「不参与注入」判定。默认 `true`。
   *
   * 海马体池是**硬性质**（手册 §2.5「永不注入」），没有开关；
   * 这里只是「池服务缺席时不判」的降级开关。
   */
  readonly respectPool: boolean
  /**
   * 是否在记忆行尾带清晰度话术（`，记不太清了`）。默认 `true`。
   *
   * 话术来自 O-013，**本插件不自己写一份**（三档阈值是第二真源）。
   */
  readonly claritySuffix: boolean
  /** ⑦ 水波纹的扩散圈数。默认 1（1–3，多一圈多一份不确定）。 */
  readonly rippleRings: number
  /** 失败与降级时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'prompt-inject'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 render() 返回空正文并说明原因。',
  },
  budgetPreset: {
    kind: 'enum',
    default: 'standard',
    options: ['small', 'standard', 'large'],
    doc: '预算档位预设：small 1200 / standard 2600 / large 24000（手册 §2.6）。budgetChars > 0 时以它为准。',
  },
  budgetChars: {
    kind: 'number',
    default: 0,
    min: 0,
    max: 200000,
    advancedOnly: true,
    doc: '预算（字符）。0 表示用档位预设。真源只有 budgetOf() 一处。',
  },
  maxPromises: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 32,
    advancedOnly: true,
    doc: '① 到期提醒条数上限。手册未给数，取 3。',
  },
  maxPinned: {
    kind: 'number',
    default: 8,
    min: 0,
    max: 32,
    doc: '② 钉住条数上限。手册 §2.6 逐字：≤8。',
  },
  maxPersons: {
    kind: 'number',
    default: 5,
    min: 0,
    max: 32,
    doc: '③ person 类记忆条数上限。手册 §2.6 逐字：≤5。',
  },
  maxAnniversary: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 32,
    doc: '④ 那年今日条数上限。手册 §2.6 逐字：≤3。',
  },
  maxLessons: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 32,
    doc: '⑥ 记下的道理条数上限。手册 §2.6 逐字：≤3。',
  },
  anniversaryScanLimit: {
    kind: 'number',
    default: 500,
    min: 20,
    max: 20000,
    advancedOnly: true,
    doc: '④ 那年今日的扫描条数上限。被截断会报 anniversary-scan-capped。',
  },
  includeHeadings: {
    kind: 'boolean',
    default: true,
    doc: '是否给每段加中文小标题。关掉后「另有 N 条未展开」也随之消失，只在报告里可见。',
  },
  respectPool: {
    kind: 'boolean',
    default: true,
    doc: '是否遵守记忆池的「不参与注入」判定（海马体永不注入）。池服务缺席时不判。',
  },
  claritySuffix: {
    kind: 'boolean',
    default: true,
    doc: '是否在记忆行尾带清晰度话术。话术来自 O-013，本插件不自己写一份。',
  },
  rippleRings: {
    kind: 'number',
    default: 1,
    min: 1,
    max: 3,
    advancedOnly: true,
    doc: '⑦ 水波纹扩散圈数。多一圈多一份「不一定准」。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '失败与降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  budgetPreset: FIELD_SPECS.budgetPreset.default as Config['budgetPreset'],
  budgetChars: FIELD_SPECS.budgetChars.default as number,
  maxPromises: FIELD_SPECS.maxPromises.default as number,
  maxPinned: FIELD_SPECS.maxPinned.default as number,
  maxPersons: FIELD_SPECS.maxPersons.default as number,
  maxAnniversary: FIELD_SPECS.maxAnniversary.default as number,
  maxLessons: FIELD_SPECS.maxLessons.default as number,
  anniversaryScanLimit: FIELD_SPECS.anniversaryScanLimit.default as number,
  includeHeadings: FIELD_SPECS.includeHeadings.default as boolean,
  respectPool: FIELD_SPECS.respectPool.default as boolean,
  claritySuffix: FIELD_SPECS.claritySuffix.default as boolean,
  rippleRings: FIELD_SPECS.rippleRings.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  budgetPreset: 'budget-preset',
  budgetChars: 'budget-chars',
  maxPromises: 'max-promises',
  maxPinned: 'max-pinned',
  maxPersons: 'max-persons',
  maxAnniversary: 'max-anniversary',
  maxLessons: 'max-lessons',
  anniversaryScanLimit: 'anniversary-scan-limit',
  includeHeadings: 'include-headings',
  respectPool: 'respect-pool',
  claritySuffix: 'clarity-suffix',
  rippleRings: 'ripple-rings',
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
  title: '提示词注入',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-prompt-inject',
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

/** 档位合法值。 */
const PRESET_IDS = ['small', 'standard', 'large'] as const

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const presetRaw = raw['budgetPreset']
  const preset =
    typeof presetRaw === 'string' && (PRESET_IDS as readonly string[]).includes(presetRaw)
      ? (presetRaw as Config['budgetPreset'])
      : DEFAULT_CONFIG.budgetPreset
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    budgetPreset: preset,
    budgetChars: clampInt(raw['budgetChars'], DEFAULT_CONFIG.budgetChars, 0, 200000),
    maxPromises: clampInt(raw['maxPromises'], DEFAULT_CONFIG.maxPromises, 0, 32),
    maxPinned: clampInt(raw['maxPinned'], DEFAULT_CONFIG.maxPinned, 0, 32),
    maxPersons: clampInt(raw['maxPersons'], DEFAULT_CONFIG.maxPersons, 0, 32),
    maxAnniversary: clampInt(raw['maxAnniversary'], DEFAULT_CONFIG.maxAnniversary, 0, 32),
    maxLessons: clampInt(raw['maxLessons'], DEFAULT_CONFIG.maxLessons, 0, 32),
    anniversaryScanLimit: clampInt(
      raw['anniversaryScanLimit'],
      DEFAULT_CONFIG.anniversaryScanLimit,
      20,
      20000,
    ),
    includeHeadings:
      raw['includeHeadings'] === undefined
        ? DEFAULT_CONFIG.includeHeadings
        : raw['includeHeadings'] === true,
    respectPool: raw['respectPool'] === undefined ? DEFAULT_CONFIG.respectPool : raw['respectPool'] === true,
    claritySuffix:
      raw['claritySuffix'] === undefined ? DEFAULT_CONFIG.claritySuffix : raw['claritySuffix'] === true,
    rippleRings: clampInt(raw['rippleRings'], DEFAULT_CONFIG.rippleRings, 1, 3),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}

/**
 * 生效预算（字符）—— **唯一解析点**。
 *
 * `budgetChars > 0` 用它，否则用档位预设。两处都判一遍会让
 * 「界面显示 2600、实际装 1200」这种问题永远查不出来。
 * @param settings 配置。
 */
export function budgetOf(settings: Config): number {
  if (settings.budgetChars > 0) return settings.budgetChars
  const hit = BUDGET_PRESETS.find(preset => preset.id === settings.budgetPreset)
  return hit === undefined ? 2600 : hit.chars
}

/**
 * 每块生效的条数上限。核心段的 ① ② 也走同一张表，只是它们不参与装箱。
 * @param settings 配置。
 */
export function capsOf(settings: Config): Readonly<Record<BlockId, number>> {
  // 类型上 `Record<BlockId, number>` 已强制八块全给（漏一块编译期就报），
  // 所以这里不再做「缺键兜底」——那种兜底在无 noUncheckedIndexedAccess 时
  // 永远走不到，写了只会让人以为有空档。
  const out: Record<BlockId, number> = {
    promises: settings.maxPromises,
    pinned: settings.maxPinned,
    persons: settings.maxPersons,
    anniversary: settings.maxAnniversary,
    recall: 0,
    lessons: settings.maxLessons,
    ripple: 0,
    resurface: 1,
  }
  return Object.freeze(out)
}
