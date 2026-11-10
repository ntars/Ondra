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
 * 五帧形状、四值结束原因、前缀拼装分隔符（`\n\n`）都是**协议/规范**，
 * 做成配置项就等于让每台机器的对话协议不一样，而界面与通道只装到一个版本。
 * 这里只留「这台机器怎么跑」的参数。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`maxHistoryChars`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `turn()` 立刻以 `error` 收尾。 */
  readonly enable: boolean
  /**
   * 历史保留轮数上限。默认 10。
   *
   * 手册 §9.5：最近原文 ≤10 条且 ≤2000 字。「条」指消息条数，
   * 一轮 = user + assistant 两条，所以这里按**轮**计，内部换算成 2N 条。
   */
  readonly maxTurns: number
  /**
   * 历史字符上限。默认 2000（手册 §9.5 逐字）。
   *
   * 与 `maxTurns` 是**两个独立闸门**，任一超限都会触发裁剪：
   * 十条短消息只有 300 字，可以留；三条超长消息 4000 字，必须裁。
   * 只用条数会让长消息把预算撑爆，只用字数会让大量短消息把条数撑爆。
   */
  readonly maxHistoryChars: number
  /** 采样温度。默认 0.8（陪伴对话偏松，不需要 0.2 那种工程温度）。 */
  readonly temperature: number
  /** 输出上限（tokens）。默认 0 = 不设，交给上游按模型默认处理。 */
  readonly maxTokens: number
  /** 是否自动从 O-023 取人格四段作为稳定段。默认 `true`。 */
  readonly includePersona: boolean
  /** 是否自动从 O-024 取世界书常驻块作为稳定段。默认 `true`。 */
  readonly includeWorldbook: boolean
  /**
   * 易变段的最低置信度。默认 0.35。
   *
   * 依据：O-032 的兜底置信度 0.5、命中判据 0.9；O-029/O-030 的片段都在 0.7 以上。
   * 取 0.35 意味着「凡是正常产出的片段都进，只有明显是猜的才丢」。
   * 写成 0 等于不过滤（ABI 明确要求过滤低置信度），写 0.6 会误杀兜底片段。
   */
  readonly minTailConfidence: number
  /**
   * 同时保留的会话数上限。默认 8。
   *
   * 会话**只在内存**。通道适配器（一个群一个会话）会让这个 Map 无界增长，
   * 而内存泄漏在桌面应用里的表现是「开了一天之后开始卡」，没人会归因到对话链。
   * 淘汰规则是按最近活动时间淘汰**空闲**会话，正在跑的永远不淘汰。
   */
  readonly maxConversations: number
  /** 失败与拒绝时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'dialogue'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 turn() 立刻以 error 收尾（不静默不回应）。',
  },
  maxTurns: {
    kind: 'number',
    default: 10,
    min: 1,
    max: 200,
    doc: '历史保留轮数上限。一轮 = 一条 user + 一条 assistant。默认 10（手册 §9.5「最近原文 ≤10 条」按轮折算）。',
  },
  maxHistoryChars: {
    kind: 'number',
    default: 2000,
    min: 200,
    max: 200000,
    doc: '历史字符上限。与条数上限是两个独立闸门：条数挡不住超长消息，字数挡不住大量短消息。',
  },
  temperature: {
    kind: 'number',
    default: 0.8,
    min: 0,
    max: 2,
    doc: '采样温度。陪伴对话偏松，默认 0.8。',
  },
  maxTokens: {
    kind: 'number',
    default: 0,
    min: 0,
    max: 32000,
    advancedOnly: true,
    doc: '输出上限（tokens）。0 表示不设，交给上游按模型默认处理。',
  },
  includePersona: {
    kind: 'boolean',
    default: true,
    doc: '是否自动从 ondra-persona-assemble 取四段作为稳定段（只在 begin() 时取一次，之后冻结）。',
  },
  includeWorldbook: {
    kind: 'boolean',
    default: true,
    doc: '是否自动从 ondra-worldbook 取常驻块作为稳定段。只取常驻（每轮都在的那部分），不取按需条目。',
  },
  minTailConfidence: {
    kind: 'number',
    default: 0.35,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '易变段最低置信度。0.35 的依据：正常片段都在 0.5 以上，只有明显是猜的才丢。',
  },
  maxConversations: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 64,
    advancedOnly: true,
    doc: '同时保留的会话数上限（只在内存）。超出时按最近活动时间淘汰空闲会话。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '失败与拒绝时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxTurns: FIELD_SPECS.maxTurns.default as number,
  maxHistoryChars: FIELD_SPECS.maxHistoryChars.default as number,
  temperature: FIELD_SPECS.temperature.default as number,
  maxTokens: FIELD_SPECS.maxTokens.default as number,
  includePersona: FIELD_SPECS.includePersona.default as boolean,
  includeWorldbook: FIELD_SPECS.includeWorldbook.default as boolean,
  minTailConfidence: FIELD_SPECS.minTailConfidence.default as number,
  maxConversations: FIELD_SPECS.maxConversations.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxTurns: 'max-turns',
  maxHistoryChars: 'max-history-chars',
  temperature: 'temperature',
  maxTokens: 'max-tokens',
  includePersona: 'include-persona',
  includeWorldbook: 'include-worldbook',
  minTailConfidence: 'min-tail-confidence',
  maxConversations: 'max-conversations',
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
  title: '对话编排',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-dialogue',
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

/** 夹一个浮点数。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    maxTurns: clampInt(raw['maxTurns'], DEFAULT_CONFIG.maxTurns, 1, 200),
    maxHistoryChars: clampInt(raw['maxHistoryChars'], DEFAULT_CONFIG.maxHistoryChars, 200, 200000),
    temperature: clampNumber(raw['temperature'], DEFAULT_CONFIG.temperature, 0, 2),
    maxTokens: clampInt(raw['maxTokens'], DEFAULT_CONFIG.maxTokens, 0, 32000),
    includePersona:
      raw['includePersona'] === undefined ? DEFAULT_CONFIG.includePersona : raw['includePersona'] === true,
    includeWorldbook:
      raw['includeWorldbook'] === undefined
        ? DEFAULT_CONFIG.includeWorldbook
        : raw['includeWorldbook'] === true,
    minTailConfidence: clampNumber(raw['minTailConfidence'], DEFAULT_CONFIG.minTailConfidence, 0, 1),
    maxConversations: clampInt(raw['maxConversations'], DEFAULT_CONFIG.maxConversations, 1, 64),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
