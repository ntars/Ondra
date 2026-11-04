/**
 * O-116 `ondra-study` 的配置**单一真源**。
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
 * 手册与 master-plan 都**没有**给学习节奏阈值，故下面四项全是本插件的工程取值：
 *
 * - **15 分钟**：两次打点隔超过它，就认为人已经不在这一段里了。取 15 而不是 5，
 *   是因为读一段材料、接一个电话、走开倒杯水都可能七八分钟；取 60 又会把
 *   「合上电脑去吃饭」算成专注。**这个值的唯一职责是拦住假时长**，不是精确刻画
 *   她在不在——精确刻画需要键鼠活动，那是 O-111 的事，且它默认关闭。
 * - **45 分钟**：一段专注的长度。参照的是「一节课」的量级，不是番茄钟的 25 分钟：
 *   25 分钟对写代码、写长文的人太短，提示会变成骚扰。
 * - **5 分钟**：休息段长度。这里**只记录、不执行**：到点只是允许她回到 `idle`，
 *   不锁屏、不弹窗、不打断。
 * - **20 分钟**：拒绝之后的冷却。**冷却不是惩罚**，是为了让「拒绝」真的有效果——
 *   拒绝完下一次检查又弹一遍，等于没让她拒绝。
 *
 * ## 刻意没有的配置项（四条）
 *
 * 1. **没有「要不要强制休息」。** 契约里 `mandatory` 的类型是字面量 `false`，
 *    连开关的位置都没留。
 * 2. **没有「每日目标时长」。** 一旦有目标，就会有完成度百分比，
 *    然后就会有人为了那个百分比让插件替她记时长。
 * 3. **没有「连续打卡天数」。** 那是考勤，不是学伴，而且它第一天就会开始撒谎。
 * 4. **没有「提示语自定义」。** 本插件只说一句人话标签；台词归人格与 O-047。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不联网、不写正文，只有一个 JSON 与几个时刻。 */
  readonly enable: boolean
  /** 两次打点间隔超过这个分钟数就判为被打断（不计入时长）。 */
  readonly gapLimitMinutes: number
  /** 连续专注达到这个分钟数后，允许提一句休息。 */
  readonly restAfterMinutes: number
  /** 休息段长度（分钟）。到点只回到 `idle`，**不执行任何强制**。 */
  readonly restMinutes: number
  /** 拒绝休息提示后的冷却（分钟）。 */
  readonly restCooldownMinutes: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'study'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，写操作抛 disabled，snapshot() 照常可读。',
  },
  gapLimitMinutes: {
    kind: 'number',
    default: 15,
    min: 2,
    max: 240,
    doc: '两次打点间隔超过它，这一段判为被打断，一秒都不计入。默认 15。调大等于允许更长的空档算专注。',
  },
  restAfterMinutes: {
    kind: 'number',
    default: 45,
    min: 5,
    max: 480,
    doc: '连续专注达到这个分钟数后允许提一句休息。默认 45。',
  },
  restMinutes: {
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    doc: '休息段长度。到点只回到 idle，不锁屏、不弹窗。默认 5。',
  },
  restCooldownMinutes: {
    kind: 'number',
    default: 20,
    min: 1,
    max: 480,
    advancedOnly: true,
    doc: '拒绝休息提示后的冷却。默认 20。调成 0 等于拒绝无效，不建议。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  gapLimitMinutes: FIELD_SPECS.gapLimitMinutes.default as number,
  restAfterMinutes: FIELD_SPECS.restAfterMinutes.default as number,
  restMinutes: FIELD_SPECS.restMinutes.default as number,
  restCooldownMinutes: FIELD_SPECS.restCooldownMinutes.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  gapLimitMinutes: 'gap-limit-minutes',
  restAfterMinutes: 'rest-after-minutes',
  restMinutes: 'rest-minutes',
  restCooldownMinutes: 'rest-cooldown-minutes',
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
  title: '学伴',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-study',
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
 * 这里**不做跨字段修正**（不像空窗期那样要保证四道阈值递增）：本插件的四个阈值
 * 互相独立——间隔门槛只管「还算不算在同一段里」，休息门槛只管「要不要提一句」，
 * 两者谁大谁小都各有合理场景，硬把它们排成序反而是替主人做主。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const num = (key: keyof Config, min: number, max: number): number => {
    const given = raw[key]
    const fallback = FIELD_SPECS[key].default as number
    if (typeof given !== 'number' || !Number.isFinite(given)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(given)))
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    gapLimitMinutes: num('gapLimitMinutes', 2, 240),
    restAfterMinutes: num('restAfterMinutes', 5, 480),
    restMinutes: num('restMinutes', 1, 120),
    restCooldownMinutes: num('restCooldownMinutes', 1, 480),
  })
}
