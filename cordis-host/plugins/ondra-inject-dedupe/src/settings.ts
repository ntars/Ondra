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
 * ## 哪些数不进配置
 *
 * 别名族（`mem:` / `pin:` 共用 `fact:`）、记账键的构造、两阶段提交、
 * 空增量不发——这些是**语义**，不是偏好。做成开关就等于允许「配错了会静默丢记忆」，
 * 而那种错没有任何报错。这里只留「这台机器怎么跑」的七个参数。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`maxSeenPerConversation`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，`begin()` 返回 `bypassed`。 */
  readonly enable: boolean
  /** 默认会话 id。`begin()` 不传会话时用它。 */
  readonly defaultConversation: string
  /**
   * 单会话记账容量。默认 2000。
   *
   * 满了按「最久没被记上」挤出（见 README 已知限制 2）：被挤出的可能下次再注入一次。
   * 太小的后果是「老记忆反复重现」，太大的后果只是几十 KB 内存。
   */
  readonly maxSeenPerConversation: number
  /** 同时记账的会话数上限。默认 8。超了挤掉最久没用的整本账。 */
  readonly maxConversations: number
  /**
   * 是否嗅「压缩发生了」。默认开。
   *
   * 只读 O-033 的 `stats().compactions` 计数器（**不改它**），
   * 且**只在单会话时自动释放**：多会话时全局计数器分不清是谁压的，
   * 那时不做自动释放并记 `ambiguousCompactions`——**猜错的代价是重复注入**，
   * 而那正是本插件要消灭的东西。
   */
  readonly autoDetectCompaction: boolean
  /** 未决批次上限。默认 16。调用方只 begin 不 commit 时不会漏内存。 */
  readonly maxPendingBatches: number
  /** 是否在降级与释放时打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'inject-dedupe'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，begin() 返回 bypassed，调用方走原路径（整块注入）。',
  },
  defaultConversation: {
    kind: 'string',
    default: 'default',
    doc: '默认会话 id。begin() 不传会话时用它。换会话时记得先 release("session-restart")。',
  },
  maxSeenPerConversation: {
    kind: 'number',
    default: 2000,
    min: 50,
    max: 20000,
    advancedOnly: true,
    doc: '单会话记账容量。满了按最久未记上挤出（被挤出的下次可能再注入一次）。',
  },
  maxConversations: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 64,
    advancedOnly: true,
    doc: '同时记账的会话数上限。超了挤掉最久没用的整本账（下次该会话整块重注一次）。',
  },
  autoDetectCompaction: {
    kind: 'boolean',
    default: true,
    doc: '是否读 O-033 的压缩计数器自动释放已见。只在单会话时生效，多会话时明确不猜。',
  },
  maxPendingBatches: {
    kind: 'number',
    default: 16,
    min: 2,
    max: 128,
    advancedOnly: true,
    doc: '未决批次上限。只 begin 不 commit 的调用方不会漏内存（最旧的未决批次被丢弃）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与释放时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  defaultConversation: FIELD_SPECS.defaultConversation.default as string,
  maxSeenPerConversation: FIELD_SPECS.maxSeenPerConversation.default as number,
  maxConversations: FIELD_SPECS.maxConversations.default as number,
  autoDetectCompaction: FIELD_SPECS.autoDetectCompaction.default as boolean,
  maxPendingBatches: FIELD_SPECS.maxPendingBatches.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  defaultConversation: 'default-conversation',
  maxSeenPerConversation: 'max-seen-per-conversation',
  maxConversations: 'max-conversations',
  autoDetectCompaction: 'auto-detect-compaction',
  maxPendingBatches: 'max-pending-batches',
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
  title: '注入去重',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-inject-dedupe',
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

/**
 * 取一个会话 id。
 *
 * 空串、纯空白一律退回默认值：会话 id 是账本的键，空串会让所有会话挤进同一本账，
 * 表现是「换了会话她还是觉得说过了」。这里不报错，只安静纠正。
 * @param value 原始值。
 * @param fallback 兜底值。
 */
export function conversationKey(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  // 上限 64：会话 id 进日志与快照，过长会把界面撑变形。
  return trimmed.slice(0, 64)
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    defaultConversation: conversationKey(raw['defaultConversation'], DEFAULT_CONFIG.defaultConversation),
    maxSeenPerConversation: clampInt(
      raw['maxSeenPerConversation'],
      DEFAULT_CONFIG.maxSeenPerConversation,
      50,
      20000,
    ),
    maxConversations: clampInt(raw['maxConversations'], DEFAULT_CONFIG.maxConversations, 1, 64),
    autoDetectCompaction:
      raw['autoDetectCompaction'] === undefined
        ? DEFAULT_CONFIG.autoDetectCompaction
        : raw['autoDetectCompaction'] === true,
    maxPendingBatches: clampInt(raw['maxPendingBatches'], DEFAULT_CONFIG.maxPendingBatches, 2, 128),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
