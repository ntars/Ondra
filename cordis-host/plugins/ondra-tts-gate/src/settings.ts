/**
 * 配置的**单一真源**（四道闸门 + 连读上限，全部数值来自手册 §9.4）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么 `minChars` 与 `maxChars` 要互相夹一次
 *
 * 两个数各自在合法区间里，合起来仍可能矛盾（`minChars=20` + `maxChars=10`）。
 * 那种配置的后果不是报错，而是**每一句都判 `too-short`**，
 * 日志却写着「不足 20 字」——而那句话明明有 12 个字，读日志的人会以为计数坏了。
 * 所以补全时把 `maxChars` 抬到不低于 `minChars`，并把这件事记进 drift。
 *
 * ## 为什么 `cooldownMs` 允许为 0
 *
 * 0 表示关掉频控。手册给了 3000ms，但「一次连发三条短句」在某些场景
 * （语音通话）是合理的。允许关掉，比让用户去改代码强。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`decide()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 句长下界（去空白后的字数）。 */
  readonly minChars: number
  /** 句长上界。 */
  readonly maxChars: number
  /** 情绪强度门槛。 */
  readonly intensityMin: number
  /** 频控间隔（毫秒）。 */
  readonly cooldownMs: number
  /** 连读上限：连读满这么多条后，下一条强制留文本。 */
  readonly maxConsecutive: number
  /** 有情绪词时是否跳过强度闸。 */
  readonly emotiveBypass: boolean
  /** 拒绝时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'tts-gate'

/** 句长下界的最小值（1 个字也叫一句话，但那时「念」没有意义）。 */
export const MIN_CHARS_FLOOR = 2

/** 句长下界的上限（与 `maxChars` 默认值对齐）。 */
export const MIN_CHARS_CEIL = 30

/** 句长上界的最小值。 */
export const MAX_CHARS_FLOOR = 6

/** 句长上界的上限（再长就该拆条，不该硬念）。 */
export const MAX_CHARS_CEIL = 120

/** 频控上限：10 秒已经长到「这一条永远赶不上」。 */
export const COOLDOWN_CEIL = 10000

/** 连读上限的上下界。 */
export const STREAK_FLOOR = 1
export const STREAK_CEIL = 10

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后一律不朗读（服务照常注册）。',
  },
  minChars: {
    kind: 'number',
    default: 6,
    min: MIN_CHARS_FLOOR,
    max: MIN_CHARS_CEIL,
    doc: `句长下界（${MIN_CHARS_FLOOR}–${MIN_CHARS_CEIL} 字，去空白后计）。太短的一句念出来像提示音。`,
  },
  maxChars: {
    kind: 'number',
    default: 30,
    min: MAX_CHARS_FLOOR,
    max: MAX_CHARS_CEIL,
    doc: `句长上界（${MAX_CHARS_FLOOR}–${MAX_CHARS_CEIL} 字）。超过就该拆条，不该硬念。`,
  },
  intensityMin: {
    kind: 'number',
    default: 0.15,
    min: 0,
    max: 1,
    doc: '情绪强度门槛（0–1）。低于它且没有情绪词就不出声：平铺直叙的话用文字就够。',
  },
  cooldownMs: {
    kind: 'number',
    default: 3000,
    min: 0,
    max: COOLDOWN_CEIL,
    doc: `频控间隔（0–${COOLDOWN_CEIL} 毫秒）。0 表示关掉频控。`,
  },
  maxConsecutive: {
    kind: 'number',
    default: 2,
    min: STREAK_FLOOR,
    max: STREAK_CEIL,
    advancedOnly: true,
    doc: `连读上限（${STREAK_FLOOR}–${STREAK_CEIL} 条）。连读满这么多条后，下一条强制留文本。`,
  },
  emotiveBypass: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '本轮有情绪词时跳过强度闸（手册：强度 ≥0.15 **或**本轮有情绪词）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '被拦下时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  minChars: FIELD_SPECS.minChars.default as number,
  maxChars: FIELD_SPECS.maxChars.default as number,
  intensityMin: FIELD_SPECS.intensityMin.default as number,
  cooldownMs: FIELD_SPECS.cooldownMs.default as number,
  maxConsecutive: FIELD_SPECS.maxConsecutive.default as number,
  emotiveBypass: FIELD_SPECS.emotiveBypass.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  minChars: 'min-chars',
  maxChars: 'max-chars',
  intensityMin: 'intensity-min',
  cooldownMs: 'cooldown-ms',
  maxConsecutive: 'max-consecutive',
  emotiveBypass: 'emotive-bypass',
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
  title: '语音闸门',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-tts-gate',
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

/** 夹一个浮点（强度门槛精度到 0.01）。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
/**
 * 取一个字段，**两种键名都认**。
 *
 * ## 为什么必须两种都认
 *
 * 这个函数收到的对象有两条来路，键名口径不同：
 *
 * | 来路 | 键名 | 谁给的 |
 * | --- | --- | --- |
 * | 宿主把用户层注入成 `ctx.plugin(plugin, config)` | **kebab**（`min-chars`） | `settings.json` 里就是这么写的 |
 * | 同一份配置经过 `Config['~standard'].validate` 后 | camel（`minChars`） | Cordis 用插件的校验器跑一遍 |
 *
 * 只认 camel 的后果是本轮踩到的那个：用户在设置里把 `min-chars` 改成 25，
 * 界面读得回、落得盘、`config` 命令也显示 25，而判定链一律按默认 6 跑。
 * **唯一的疑似生效字段是 `enable`——它两种写法同名，纯属巧合。**
 *
 * 两处都不报错，因为「取不到就用默认值」本来就是设计好的降级路径。
 * 这种「一个字段巧合生效、其余全不生效」比全部不生效更难查：
 * 它看起来像「改错了一个字段」，实际是**一个都没进去**。
 * @param raw 配置对象。
 * @param camel Config 形状的键。
 * @param kebab 段字段的键。
 */
function pick(raw: Record<string, unknown>, camel: keyof Config, kebab: string): unknown {
  const direct = raw[camel]
  if (direct !== undefined) return direct
  return raw[kebab]
}

/**
 * 补全配置。任何非法值都回退默认，**永不抛错**。
 * @param value 原始配置（camel 或 kebab 键均可）。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, kebab: string, fallback: boolean): boolean => {
    const picked = pick(raw, key, kebab)
    return picked === undefined ? fallback : picked === true
  }

  const minChars = clampInt(
    pick(raw, 'minChars', 'min-chars'),
    DEFAULT_CONFIG.minChars,
    MIN_CHARS_FLOOR,
    MIN_CHARS_CEIL,
  )
  const maxCharsRaw = clampInt(
    pick(raw, 'maxChars', 'max-chars'),
    DEFAULT_CONFIG.maxChars,
    MAX_CHARS_FLOOR,
    MAX_CHARS_CEIL,
  )
  // 上界不得低于下界：否则每一句都判 too-short，日志却说「不足 N 字」。
  const maxChars = Math.max(minChars, maxCharsRaw)

  return Object.freeze({
    enable: bool('enable', 'enable', DEFAULT_CONFIG.enable),
    minChars,
    maxChars,
    intensityMin: clampFloat(pick(raw, 'intensityMin', 'intensity-min'), DEFAULT_CONFIG.intensityMin, 0, 1),
    cooldownMs: clampInt(pick(raw, 'cooldownMs', 'cooldown-ms'), DEFAULT_CONFIG.cooldownMs, 0, COOLDOWN_CEIL),
    maxConsecutive: clampInt(
      pick(raw, 'maxConsecutive', 'max-consecutive'),
      DEFAULT_CONFIG.maxConsecutive,
      STREAK_FLOOR,
      STREAK_CEIL,
    ),
    emotiveBypass: bool('emotiveBypass', 'emotive-bypass', DEFAULT_CONFIG.emotiveBypass),
    verbose: bool('verbose', 'verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 * @returns 被改过的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly [keyof Config, number, number][] = [
    ['minChars', MIN_CHARS_FLOOR, MIN_CHARS_CEIL],
    ['maxChars', MAX_CHARS_FLOOR, MAX_CHARS_CEIL],
    ['intensityMin', 0, 1],
    ['cooldownMs', 0, COOLDOWN_CEIL],
    ['maxConsecutive', STREAK_FLOOR, STREAK_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) drift.push(key)
  }

  // 两个数各自合法、合起来矛盾：也要报出来（这是最难自己发现的一种配置错）。
  const minGiven = raw['minChars']
  const maxGiven = raw['maxChars']
  if (typeof minGiven === 'number' && typeof maxGiven === 'number' && maxGiven < minGiven) {
    drift.push('maxChars')
  }
  return drift
}
