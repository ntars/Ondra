/**
 * O-099 `ondra-memory-git` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
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
 * 1. **没有「历史深度」配置项。** 深度是 O-010 表结构决定的（只存 `revisions` 计数与
 *    最近一份 `oldText`），不是本插件能调的参数。做成旋钮等于给一个「拖到 10 就会
 *    有 10 版历史」的假承诺——拖完什么也不会变，这正是 §17-6 禁的假开关。
 * 2. **没有「自动打检查点」的开关。** 定时 `VACUUM INTO` 归 O-009 的 KEEP 策略；
 *    本插件再装一个定时器，就会出现两套轮转规则抢同一个目录。
 * 3. **没有「恢复前是否确认」的开关。** 二次确认是硬纪律，不是偏好。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：只读视图，开着没有副作用。 */
  readonly enable: boolean
  /**
   * 正文预览最多几个字。默认 25。
   *
   * 取 25 的理由：一行清单里放得下，且不足以还原一条完整记忆
   * （O-010 的正文上限是 200 字）。清单要能扫，不能变成第二个正文出口。
   */
  readonly previewChars: number
  /**
   * 差异计算最多比对多少个字符。默认 400。
   *
   * 正常正文 ≤200 字，双倍余量足够。设上限是因为差异算法是 O(n·m) 的：
   * 一旦有人手改库塞进一条万字记录，不做保护就会卡住一次界面渲染。
   */
  readonly diffChars: number
  /** 降级与缺席时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-git'

/** 预览下限：少于 8 字看不出一条记忆说的是什么。 */
const PREVIEW_MIN = 0

/** 预览上限：超过 120 字就不再是「预览」了。 */
const PREVIEW_MAX = 120

/** 差异比对下限。 */
const DIFF_MIN = 50

/** 差异比对上限。 */
const DIFF_MAX = 4000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。版本线是只读视图，关掉后服务仍注册但 available=false。',
  },
  previewChars: {
    kind: 'number',
    default: 25,
    min: PREVIEW_MIN,
    max: PREVIEW_MAX,
    advancedOnly: true,
    doc: '正文预览最多几个字。清单要能扫，但不能变成第二个正文出口。',
  },
  diffChars: {
    kind: 'number',
    default: 400,
    min: DIFF_MIN,
    max: DIFF_MAX,
    advancedOnly: true,
    doc: '差异计算最多比对多少个字符。设上限防止超长记录卡住一次渲染。',
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
  previewChars: FIELD_SPECS.previewChars.default as number,
  diffChars: FIELD_SPECS.diffChars.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  previewChars: 'preview-chars',
  diffChars: 'diff-chars',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆版本线',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-git',
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

/** 把数字夹进区间；非有限数退默认值。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    previewChars: clampInt(raw['previewChars'], DEFAULT_CONFIG.previewChars, PREVIEW_MIN, PREVIEW_MAX),
    diffChars: clampInt(raw['diffChars'], DEFAULT_CONFIG.diffChars, DIFF_MIN, DIFF_MAX),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
