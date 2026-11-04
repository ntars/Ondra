/**
 * O-101 `ondra-time-capsule` 的配置**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 刻意没有的配置项（四条，都写清理由）
 *
 * 1. **没有「最短封存天数」。** 它决定本插件与待办（O-021）的界线。
 *    做成可配置就意味着「把胶囊调成 1 天，当待办用」——两套机制立刻重叠，
 *    而重叠之后没有任何一处能说清「这条到底该谁提醒」。故 `MIN_HOLD_DAYS` 是常量。
 * 2. **没有「到期自动开封」。** 自动开封等于「到期那一刻正文进了记忆库」：
 *    邮箱一推送、摘要一生成，用户还没自己看，秘密就已经在上下文里了。
 *    开不开封是人的动作，见 README §2。
 * 3. **没有「标题必填」。** 标题只是清单里的抓手。强制填会让人把第一句话
 *    抄进标题，等于同一段话存两份（第二份还会进清单导出）。
 * 4. **没有「提醒我把胶囊打开」。** 推送归 O-042 ~~O-049 的主动域；
 *    本插件插一脚就会变成第二个提醒源，两处都响。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  DEFAULT_MAX_CAPSULES,
  DEFAULT_MAX_TEXT_CHARS,
  MAX_CAPSULES_CEILING,
  MAX_TEXT_CHARS_CEILING,
  MIN_TEXT_CHARS,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：只在不被调用时什么都不做。 */
  readonly enable: boolean
  /** 正文默认上限字数。超了拒收并说清上限，不静默截断。 */
  readonly maxTextChars: number
  /** 同时保留的胶囊数上限。 */
  readonly maxCapsules: number
  /** 降级与缺席时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'time-capsule'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册但 available=false，已有的胶囊不会被删。',
  },
  maxTextChars: {
    kind: 'number',
    default: DEFAULT_MAX_TEXT_CHARS,
    min: MIN_TEXT_CHARS,
    max: MAX_TEXT_CHARS_CEILING,
    advancedOnly: true,
    doc: '单颗胶囊正文的默认字数上限。超长拒收并说明上限，不静默截断。',
  },
  maxCapsules: {
    kind: 'number',
    default: DEFAULT_MAX_CAPSULES,
    min: 1,
    max: MAX_CAPSULES_CEILING,
    advancedOnly: true,
    doc: '同时保留的胶囊数上限。到上限时拒收新胶囊，不静默挤掉最旧的。',
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
  maxTextChars: FIELD_SPECS.maxTextChars.default as number,
  maxCapsules: FIELD_SPECS.maxCapsules.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxTextChars: 'max-text-chars',
  maxCapsules: 'max-capsules',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '时间胶囊',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-time-capsule',
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
    maxTextChars: clampInt(
      raw['maxTextChars'],
      DEFAULT_CONFIG.maxTextChars,
      MIN_TEXT_CHARS,
      MAX_TEXT_CHARS_CEILING,
    ),
    maxCapsules: clampInt(raw['maxCapsules'], DEFAULT_CONFIG.maxCapsules, 1, MAX_CAPSULES_CEILING),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
