/**
 * O-113 `ondra-weekly` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 刻意没有的配置项（三条，都写清理由）
 *
 * 1. **没有「周报模板 / 语气 / 称呼」。** 那是成稿的事，归应用外壳与人格层。
 *    一旦这里能配模板，本插件就同时成了文案生成器——而它只该出骨架。
 * 2. **没有「出报时间」。** 装定时器就得有个到点触发，而「什么时候适合看这一周」
 *    是人的选择。本插件**不装定时器**，什么时候调 `draft()` 由外壳决定。
 * 3. **没有「隐藏某一段」。** 藏起来等于让人以为「这周只剩这些」。真要少看，
 *    看的时候跳过即可（与 O-100 / O-102 同一条理由）。
 */

import { MAX_WINDOW_DAYS, MIN_WINDOW_DAYS } from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：纯只读，开着没有副作用。 */
  readonly enable: boolean
  /** 窗口天数（滚动窗口，含今天）。 */
  readonly windowDays: number
  /** 每段最多几条素材。骨架不是清单，超过这个数就不像骨架了。 */
  readonly maxItemsPerSection: number
  /** 单次向上游扫描的最大条数。**这是内存保护，不是统计口径**。 */
  readonly scanLimit: number
  /** 降级与缺席时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致（去掉 `ondra-` 前缀），符合 §8.4。 */
export const CONFIG_SECTION_ID = 'weekly'

/** 每段素材条数下限。1 条也能说明这段有材料。 */
export const MIN_ITEMS = 1

/** 每段素材条数上限。再多就该让人自己去看原表了。 */
export const MAX_ITEMS = 20

/** 扫描下限。低于 50 条时「本周新增」几乎必然被截断。 */
export const MIN_SCAN = 50

/** 扫描上限。再大就把整库拉进内存，而周报只需要最近这一周。 */
export const MAX_SCAN = 2000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。纯只读，关掉后服务仍注册但 available=false，draft() 抛 disabled。',
  },
  windowDays: {
    kind: 'number',
    default: 7,
    min: MIN_WINDOW_DAYS,
    max: MAX_WINDOW_DAYS,
    doc: '窗口天数（滚动，含今天）。默认 7 = 「最近七天」，不判自然周：周一还是周日算起点，各地各人说法不一，判错会让同一周出现两份周报。',
  },
  maxItemsPerSection: {
    kind: 'number',
    default: 5,
    min: MIN_ITEMS,
    max: MAX_ITEMS,
    doc: '每段最多几条素材。骨架给的是「写哪几件事」，不是全量清单。',
  },
  scanLimit: {
    kind: 'number',
    default: 500,
    min: MIN_SCAN,
    max: MAX_SCAN,
    advancedOnly: true,
    doc: '单次向上游扫描的最大条数。回满说明可能被截断，此时计数标为「下界」而不是准确值。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与上游缺席时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  windowDays: FIELD_SPECS.windowDays.default as number,
  maxItemsPerSection: FIELD_SPECS.maxItemsPerSection.default as number,
  scanLimit: FIELD_SPECS.scanLimit.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  windowDays: 'window-days',
  maxItemsPerSection: 'max-items-per-section',
  scanLimit: 'scan-limit',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '周报骨架',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-weekly',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取一个整数并夹到区间内；非有限数一律回退。 */
function intIn(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const truncated = Math.trunc(value)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
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
 * 补全配置。**永不抛错**：非法值一律回退默认值或夹到区间内。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    windowDays: intIn(raw.windowDays, DEFAULT_CONFIG.windowDays, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS),
    maxItemsPerSection: intIn(raw.maxItemsPerSection, DEFAULT_CONFIG.maxItemsPerSection, MIN_ITEMS, MAX_ITEMS),
    scanLimit: intIn(raw.scanLimit, DEFAULT_CONFIG.scanLimit, MIN_SCAN, MAX_SCAN),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
