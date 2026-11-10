/**
 * O-108 `ondra-absence` 的配置**单一真源**。
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
 * ## 阈值从哪来（**必须写清，否则就是拍脑袋**）
 *
 * 手册与 master-plan 都**没有**给空窗分档阈值——§9 参数速查里只有情绪、节奏、
 * 主动、语音、对话、界面六组。故下面四个阈值全是**本插件的工程取值**，
 * 依据是「对方还记不记得上次说了什么」这条可观察的线（参见 README §9）：
 *
 * - 6 小时：一次完整的睡眠。睡一觉回来不算「空窗」，提一句反而奇怪；
 * - 1 天：隔了一个作息周期，话头断了但人还记得；
 * - 3 天：记得人，忘了细节——从这里开始不能不承认隔了一段；
 * - 14 天：两周以上，对方可能已经忘了她是谁，得当重新认识。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「报不报具体天数」。** 那是纪律不是偏好：`greet()` 里没有任何数字字段，
 *    做成开关就等于允许「把 17 天念出来」。
 * 2. **没有「要不要问去哪了」。** 契约里 `askAboutGap` 的类型是字面量 `false`，
 *    连开关的位置都没留。
 * 3. **没有「每档句数」。** 句数写在 `gap.ts` 的档位表里，只受 `maxSentencesCap` 向下约束。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不联网、不写正文，只有一个时刻档。 */
  readonly enable: boolean
  /** 短于这个小时数不算空窗（一次睡眠）。 */
  readonly briefHours: number
  /** 超过这个天数进入 `noticed`。 */
  readonly noticedDays: number
  /** 超过这个天数进入 `long`。 */
  readonly longDays: number
  /** 超过这个天数进入 `distant`。 */
  readonly distantDays: number
  /** 单档句数天花板（1–3），**只收不放**。 */
  readonly maxSentencesCap: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'absence'

/** 句数上限的允许区间。档位表里最长的档是 2 句，故上限就是 3。 */
export const SENTENCE_CAP_FLOOR = 1
export const SENTENCE_CAP_CEILING = 3

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，touch() / mention() 抛 disabled，view() 照常可读。',
  },
  briefHours: {
    kind: 'number',
    default: 6,
    min: 1,
    max: 48,
    doc: '短于这个小时数不算空窗。默认 6（一次完整的睡眠）。',
  },
  noticedDays: {
    kind: 'number',
    default: 1,
    min: 1,
    max: 7,
    doc: '超过这个天数进入「记得人、话头断了」档。默认 1。',
  },
  longDays: {
    kind: 'number',
    default: 3,
    min: 2,
    max: 30,
    doc: '超过这个天数进入「记得人、忘了细节」档，必须承认隔了一段。默认 3。',
  },
  distantDays: {
    kind: 'number',
    default: 14,
    min: 4,
    max: 365,
    doc: '超过这个天数进入「可能已经忘了她是谁」档。默认 14。必须大于上一个字段。',
  },
  maxSentencesCap: {
    kind: 'number',
    default: 3,
    min: SENTENCE_CAP_FLOOR,
    max: SENTENCE_CAP_CEILING,
    advancedOnly: true,
    doc: '单档句数天花板（只收不放）。调小可以让每一档都更短，调大不会有任何效果。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  briefHours: FIELD_SPECS.briefHours.default as number,
  noticedDays: FIELD_SPECS.noticedDays.default as number,
  longDays: FIELD_SPECS.longDays.default as number,
  distantDays: FIELD_SPECS.distantDays.default as number,
  maxSentencesCap: FIELD_SPECS.maxSentencesCap.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  briefHours: 'brief-hours',
  noticedDays: 'noticed-days',
  longDays: 'long-days',
  distantDays: 'distant-days',
  maxSentencesCap: 'max-sentences-cap',
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
  title: '空窗期礼仪',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-absence',
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
 * 唯一的跨字段修正：四个阈值必须**严格递增**（按天数算）。
 * 顺序写反时，`distant` 会早于 `long` 触发，于是「记得人但忘了细节」这一档
 * 永远轮不到。修正方式是**把后面的抬上去**，而不是把前面压下来——
 * 压低阈值会让礼仪提前变生分，而那是整份分级里最伤人的方向。
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

  const briefHours = num('briefHours', DEFAULT_CONFIG.briefHours, 1, 48)
  const noticedDays = num('noticedDays', DEFAULT_CONFIG.noticedDays, 1, 7)
  const longRaw = num('longDays', DEFAULT_CONFIG.longDays, 2, 30)
  const longDays = longRaw > noticedDays ? longRaw : Math.min(30, noticedDays + 1)
  const distantRaw = num('distantDays', DEFAULT_CONFIG.distantDays, 4, 365)
  const distantDays = distantRaw > longDays ? distantRaw : Math.min(365, longDays + 1)
  const cap = num('maxSentencesCap', DEFAULT_CONFIG.maxSentencesCap, SENTENCE_CAP_FLOOR, SENTENCE_CAP_CEILING)

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    briefHours,
    noticedDays,
    longDays,
    distantDays,
    maxSentencesCap: cap,
  })
}
