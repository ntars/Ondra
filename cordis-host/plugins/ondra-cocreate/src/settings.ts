/**
 * O-117 `ondra-cocreate` 的配置**单一真源**。
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
 * ## 为什么只有三个字段（这是本轮最克制的决定）
 *
 * 共创最容易做成一张设置表：「每轮多少字」「要不要先给大纲」「意见要不要逐条」
 * 「谁先开始」「标题怎么起」……每加一个勾选，就多一种「两个人一起写周报」的配置组合。
 * 而共创的核心矛盾只有一个：**什么时候停**。所以三个字段全部围绕停与交接。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「角色指派」。** 角色由状态机轮换，调用方无权指定「这轮谁来改」。
 *    做成可配，就等于允许同一个人既提又改，共创立刻退化成独白。
 * 2. **没有「关闭收束询问」。** 「这版算定稿吗」是收束拍的唯一动作，
 *    关掉它，收束拍就只剩一句「那就这样」，而那句就是自动定稿。
 * 3. **没有「目标字数 / 作品字数」。** 字数上限会让人把三件事塞进一句长句；
 *    版数是硬的，字数不是。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：本插件不联网、不写正文，只有内存里几个计数。 */
  readonly enable: boolean
  /** 版数硬上限（1–6）。**到点只能收束**，不许再出一版。 */
  readonly maxEditions: number
  /** 交接备注的字数上限（1–500）。只校验，不留存。 */
  readonly noteMaxChars: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'cocreate'

/** 版数上限的允许区间。上限 6 是工程取值：再多就不是共创而是逐字校对了。 */
export const EDITION_FLOOR = 1
export const EDITION_CEILING = 6

/** 交接备注字数的允许区间。 */
export const NOTE_CHARS_FLOOR = 1
export const NOTE_CHARS_CEILING = 500

/**
 * 目标字数上限（**不是配置**）。
 *
 * 立题要一句话。做成配置，第一个动作就是把上限调到 2000，
 * 于是「立题」变成一份需求文档，而需求文档没有验收标准也一样能写很长。
 */
export const GOAL_MAX_CHARS = 200

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，open()/handoff()/close() 抛 disabled，next()/snapshot() 照常可读。',
  },
  maxEditions: {
    kind: 'number',
    default: 3,
    min: EDITION_FLOOR,
    max: EDITION_CEILING,
    doc: '版数硬上限。到点只能收束：默认 3 版（初稿 + 两次修改）。按版数算而不按发言次数算——发言谁都能刷。',
  },
  noteMaxChars: {
    kind: 'number',
    default: 120,
    min: NOTE_CHARS_FLOOR,
    max: NOTE_CHARS_CEILING,
    advancedOnly: true,
    doc: '交接备注的字数上限。备注只校验、不留存；上限存在的意义是逼一句话说清，而不是写一段总结。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxEditions: FIELD_SPECS.maxEditions.default as number,
  noteMaxChars: FIELD_SPECS.noteMaxChars.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxEditions: 'max-editions',
  noteMaxChars: 'note-max-chars',
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
  title: '共创流程',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [
        KEY_PAIRS[camel],
        FIELD_SPECS[camel],
      ]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-cocreate',
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

/** 夹到区间内的整数。 */
function intIn(value: unknown, fallback: number, floor: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(ceiling, Math.max(floor, Math.trunc(value)))
}

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 *
 * 配置错不该让插件不加载——共创关了，用户会以为「两个人一起做点什么」这件事
 * 在这个产品里根本不存在，而实际上只是某个数字写成了小数。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    maxEditions: intIn(
      raw['maxEditions'],
      DEFAULT_CONFIG.maxEditions,
      EDITION_FLOOR,
      EDITION_CEILING,
    ),
    noteMaxChars: intIn(
      raw['noteMaxChars'],
      DEFAULT_CONFIG.noteMaxChars,
      NOTE_CHARS_FLOOR,
      NOTE_CHARS_CEILING,
    ),
  })
}
