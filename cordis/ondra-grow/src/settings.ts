/**
 * O-097 `ondra-grow` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
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
 * 1. **没有「权重」与「目标值」的配置项。**
 *    它们已经写在 `types.ts` 的 `FACTOR_WEIGHTS` / `FACTOR_TARGETS` 里，并且带依据注释。
 *    做成配置等于开放「调参旋钮」：一旦有人把 `days` 目标从 60 改成 5，
 *    「坚持才有养成感」这条产品口径就没了，而界面上看不出是配置改的。
 *    真要调，改那两个常量——它们只有一处。
 * 2. **没有「档位阈值」的配置项。** 同上，且更要紧：档位名会被应用外壳直接显示，
 *    阈值一动，「成荫」这个词跟用户看到的进度条就对不上了。
 * 3. **没有「要不要读记忆」的配置项。** 拿不到记忆服务就安静少算一项
 *    （见 `view()` 的 `missing`），这是降级不是开关。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /**
   * 总开关。**默认 true**：养成是只读派生，开着也没有副作用。
   * 关掉后服务仍注册，但 `available=false` 且 `view()` 返回 `disabled`。
   */
  readonly enable: boolean
  /**
   * 是否产出「刚达成、还没庆祝」的里程碑列表（`GrowView.fresh`）。
   *
   * 默认 true。关掉后 `fresh` 恒为空数组——`ack()` 仍可用，
   * 只是本插件不再主动提示「这里有个新里程碑」。
   * 应用外壳不打算播报（比如不想弹提示）时把它关掉，免得白算。
   */
  readonly celebrate: boolean
  /** 降级与缺席时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'grow'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。养成是只读派生，关掉后不再计算档位，服务以「不可用」状态注册。',
  },
  celebrate: {
    kind: 'boolean',
    default: true,
    doc: '是否产出「刚达成、还没庆祝」的里程碑。关掉后不再主动提示新里程碑。',
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
  celebrate: FIELD_SPECS.celebrate.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  celebrate: 'celebrate',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '养成',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-grow',
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
 * 只有三个布尔字段，所以没有夹紧逻辑；`!== true` 一律视为 false 这件事
 * 也刻意不做——「没写」与「写了 false」在布尔字段上是同一个结果，
 * 区分它们只会让配置更难读。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    celebrate: bool('celebrate', DEFAULT_CONFIG.celebrate),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
