/**
 * 配置的**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * 四个关键默认值的理由：
 *
 * - **`budgetChars 2600`**：手册 §2.6 的默认档（「省 token 派」）。选它而不是 24000，
 *   是因为 master-plan §12 的优先级是「正确 > 稳定 > 可维护 > 省资源」——
 *   2600 更稳（不容易把上下文挤爆），而且**超了会如实报 `overBudget`**，
 *   用户能看见并自己调到 24000。反过来默认 24000 会在小模型上直接失败，
 *   而失败现象是「模型开始胡说」，没人会怀疑到预算上。
 *
 * - **`includeHeadings true`**：四段之间需要有可见的边界。人设包的段落自带 `##` 标题，
 *   但关系段与浓度段是本插件生成的——不加标题，模型会把「【说话浓度：适中】」那句
 *   读成内核的一部分。真有人要省这几十个字符，可以关掉。
 *
 * - **`dropOrder` 固定为 `'tone-first'`（而不是可空数组）**：
 *   放弃顺序是**产品判断**，不是用户偏好。「先丢浓度、再丢关系微调、最后才动内核」
 *   这条顺序一旦可配，就会出现「某个用户的配置让她连自己是谁都不记得」，
 *   而这种配置没有任何界面能解释。要改就改 `ASSEMBLY_ORDER` 一处。
 *
 * - **`reportOverBudget true`**：超预算必须报。手册 §2.6 的原话是「不静默丢」，
 *   关掉它就等于允许静默丢。留着这个开关只是为了让「自检脚本」关掉日志噪音。
 *
 * **刻意没有的配置项**：
 * - **没有「每段字数上限」。** 那会变成第二套预算，与 `budgetChars` 打架时没人查得出来。
 * - **没有 `maxTokens` 之类的 token 换算。** 字符与 token 的换算比例随模型变化（中文约 1:0.6–1:1），
 *   在这里写一个比例就是写一个会过期的常数。要按 token 预算的话，换算在 O-036 做。
 * - **没有「priority 表」。** 放弃顺序是代码里的 `SLOT_PRIORITY`，不是配置——
 *   见 `sections.ts` 文件头。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { ASSEMBLE_SERVICE_KEY } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 每轮提示词的字符预算。默认 2600。 */
  readonly budgetChars: number
  /** 是否给每段加中文小标题。默认 `true`。 */
  readonly includeHeadings: boolean
  /** 是否在日志里报超预算。默认 `true`。 */
  readonly reportOverBudget: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'persona-assemble'

/** 预算上限（字符）。 */
export const BUDGET_MIN = 400

/**
 * 预算上限（字符）。
 *
 * 48000 = 24000 × 2。手册只给了 24000 的最高档，这里留一倍余量给「大模型 +
 * 全量人设 + 世界书」这种极端组合；再高就不是提示词预算问题，而是选错了模型。
 */
export const BUDGET_MAX = 48000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不再拼装，服务以「不可用」状态注册。',
  },
  budgetChars: {
    kind: 'number',
    default: 2600,
    min: BUDGET_MIN,
    max: BUDGET_MAX,
    doc:
      '每轮提示词的字符预算。默认 2600（手册 §2.6 省 token 派）；人格优先可调到 24000。' +
      '超了会如实报 overBudget，不静默截断。',
  },
  includeHeadings: {
    kind: 'boolean',
    default: true,
    doc: '是否给每段加中文小标题。关掉能省几十个字符，但模型可能把浓度段读成内核的一部分。',
  },
  reportOverBudget: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否在日志里报超预算。默认 true——手册 §2.6 要求「不静默丢」，关掉只用于压自检噪音。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  budgetChars: FIELD_SPECS.budgetChars.default as number,
  includeHeadings: FIELD_SPECS.includeHeadings.default as boolean,
  reportOverBudget: FIELD_SPECS.reportOverBudget.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），而 Cordis 插件实例
 * 配置历来是 camelCase。O-035 踩过这个坑：直接把 `FIELD_SPECS` 当段声明交出去，
 * 注册期会抛 `bad-field-spec`，现象是「配置段静默不可用、四层合并与来源追溯全失效」。
 * 映射必须**双向唯一**，否则两个字段会抢同一个段字段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  budgetChars: 'budget-chars',
  includeHeadings: 'include-headings',
  reportOverBudget: 'report-over-budget',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '人格拼装',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: ASSEMBLE_SERVICE_KEY,
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**，交给 O-005 报 `unknown-field`——在这里悄悄吞掉，
 * 用户就只会看到「我填了怎么没生效」。
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
 * 夹预算到一个合理整数。
 * @param value 原始值。
 * @param fallback 非法时的兜底。
 */
export function clampBudget(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.trunc(value)))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    budgetChars: clampBudget(raw['budgetChars'], DEFAULT_CONFIG.budgetChars),
    includeHeadings: raw['includeHeadings'] === undefined ? DEFAULT_CONFIG.includeHeadings : raw['includeHeadings'] === true,
    reportOverBudget:
      raw['reportOverBudget'] === undefined ? DEFAULT_CONFIG.reportOverBudget : raw['reportOverBudget'] === true,
  })
}
