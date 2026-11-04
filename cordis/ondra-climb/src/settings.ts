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
 * ## 为什么这些字段有默认值却没有手册出处
 *
 * 台账只写「带上限」，master-plan §9 没有爬楼这一节。所以这九个上限
 * 全部是**本包自定的工程值**，已在 README 的「待裁决」里登记。
 * 挑值的依据写在每个 `doc` 里，便于主人一眼否掉。
 *
 * ## `KEY_PAIRS` 为什么必须有
 *
 * `Config` 是 camelCase，而配置键正则 `^[a-z][a-z0-9_-]{1,63}$` 不认大写。
 * 段声明、用户层归一化、结果回填三处全部由它派生，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`plan()` 一律返回空计划。 */
  readonly enable: boolean
  /** 一轮最多照顾几个群。超出的群这一轮先放着（不丢）。 */
  readonly maxGroups: number
  /** 一轮最多几行。 */
  readonly maxItemsPerDigest: number
  /** 单条正文最多多少字（码位）。 */
  readonly maxCharsPerItem: number
  /** 整块清单最多多少字（码位）。 */
  readonly maxDigestChars: number
  /** 超过多少小时的积压不再补（**这些是真丢**）。 */
  readonly maxAgeHours: number
  /** 单个群最多缓存多少条待补读（超了挤掉最旧的）。 */
  readonly maxPendingPerGroup: number
  /** 是否也补读私聊里没来得及回的消息。默认关。 */
  readonly includePrivateBacklog: boolean
  /** 清单里是否带群号。默认带：主人说「那个群」时只有群号能定位。 */
  readonly showGroupId: boolean
  /** 是否把游标落盘。关掉后重启会重读一遍积压。 */
  readonly persistCursor: boolean
  /** 判重与拒收是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 `^[a-z][a-z0-9_-]{1,63}$`。 */
export const CONFIG_SECTION_ID = 'climb'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，plan() 返回 disabled 的空计划，不静默继续。',
  },
  maxGroups: {
    kind: 'number',
    default: 6,
    min: 1,
    max: 32,
    doc: '一轮最多照顾几个群。取 6 的理由：一次补读超过六个群，清单会长到没人读完；超出的群按「最旧一条」排序后顺延到下一轮。',
  },
  maxItemsPerDigest: {
    kind: 'number',
    default: 12,
    min: 1,
    max: 40,
    doc: '一轮最多几行。取 12 的理由：一行约 30 字，12 行约 400 字，是「她顺口提一句」的上限；再多就该主人自己去翻群。',
  },
  maxCharsPerItem: {
    kind: 'number',
    default: 60,
    min: 10,
    max: 200,
    doc: '单条正文最多多少字。取 60 的理由：群里一句话通常不到 40 字，60 字能带上一句解释；再长就变成「替别人转述」。',
  },
  maxDigestChars: {
    kind: 'number',
    default: 600,
    min: 80,
    max: 2000,
    doc: '整块清单的字数上限。取 600 的理由：与 O-036 的注入预算同一量级，且不会把本轮的对话历史挤出去。',
  },
  maxAgeHours: {
    kind: 'number',
    default: 72,
    min: 1,
    max: 720,
    doc: '超过多少小时的积压不再补。取 72 的理由：三天前的群聊补给她也没用，反而会让她说一句不合时宜的话。**这是唯一会真正丢消息的开关**。',
  },
  maxPendingPerGroup: {
    kind: 'number',
    default: 200,
    min: 10,
    max: 2000,
    doc: '单个群最多缓存多少条。取 200 的理由：200 条 × 60 字 ≈ 12KB，一个群的积压不至于把内存吃掉；超了挤掉最旧的并计数。',
  },
  includePrivateBacklog: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '是否也补读私聊里没来得及回的消息。默认关：私聊的消息本来就是「对话」，走正常回合，不需要补读清单。',
  },
  showGroupId: {
    kind: 'boolean',
    default: true,
    doc: '清单里是否带群号。默认带：主人说「那个群」时，只有群号能对上账。',
  },
  persistCursor: {
    kind: 'boolean',
    default: true,
    doc: '是否把游标落盘。关掉后重启会把已经说过的积压再说一遍（不报错，只是重复）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '判重与拒收是否逐条打日志。只影响噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxGroups: FIELD_SPECS.maxGroups.default as number,
  maxItemsPerDigest: FIELD_SPECS.maxItemsPerDigest.default as number,
  maxCharsPerItem: FIELD_SPECS.maxCharsPerItem.default as number,
  maxDigestChars: FIELD_SPECS.maxDigestChars.default as number,
  maxAgeHours: FIELD_SPECS.maxAgeHours.default as number,
  maxPendingPerGroup: FIELD_SPECS.maxPendingPerGroup.default as number,
  includePrivateBacklog: FIELD_SPECS.includePrivateBacklog.default as boolean,
  showGroupId: FIELD_SPECS.showGroupId.default as boolean,
  persistCursor: FIELD_SPECS.persistCursor.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须双向唯一，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxGroups: 'max-groups',
  maxItemsPerDigest: 'max-items-per-digest',
  maxCharsPerItem: 'max-chars-per-item',
  maxDigestChars: 'max-digest-chars',
  maxAgeHours: 'max-age-hours',
  maxPendingPerGroup: 'max-pending-per-group',
  includePrivateBacklog: 'include-private-backlog',
  showGroupId: 'show-group-id',
  persistCursor: 'persist-cursor',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '爬楼',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-climb',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * 未知键**原样保留**，交给 O-005 报 `unknown-field`。
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

/** 读一个夹紧的整数。非法值回退默认，再夹进区间。 */
function intIn(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, raw))
}

/** 读一个布尔。**只有 `true` 才算真**：字符串 `"false"` 不该被当成真。 */
function boolOf(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === true
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: boolOf(raw['enable'], DEFAULT_CONFIG.enable),
    maxGroups: intIn(raw['maxGroups'], DEFAULT_CONFIG.maxGroups, 1, 32),
    maxItemsPerDigest: intIn(raw['maxItemsPerDigest'], DEFAULT_CONFIG.maxItemsPerDigest, 1, 40),
    maxCharsPerItem: intIn(raw['maxCharsPerItem'], DEFAULT_CONFIG.maxCharsPerItem, 10, 200),
    maxDigestChars: intIn(raw['maxDigestChars'], DEFAULT_CONFIG.maxDigestChars, 80, 2000),
    maxAgeHours: intIn(raw['maxAgeHours'], DEFAULT_CONFIG.maxAgeHours, 1, 720),
    maxPendingPerGroup: intIn(raw['maxPendingPerGroup'], DEFAULT_CONFIG.maxPendingPerGroup, 10, 2000),
    includePrivateBacklog: boolOf(raw['includePrivateBacklog'], DEFAULT_CONFIG.includePrivateBacklog),
    showGroupId: boolOf(raw['showGroupId'], DEFAULT_CONFIG.showGroupId),
    persistCursor: boolOf(raw['persistCursor'], DEFAULT_CONFIG.persistCursor),
    verbose: boolOf(raw['verbose'], DEFAULT_CONFIG.verbose),
  })
}
