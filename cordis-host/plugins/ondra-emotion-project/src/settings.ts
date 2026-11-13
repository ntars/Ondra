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
 * ## 为什么这一份必须有 `KEY_PAIRS`
 *
 * 本插件的 Config 是 camelCase（`projectionTtlMinutes`），而手册 §8.4 的配置键
 * 正则 `^[a-z][a-z0-9_-]{1,63}$` **不认大写**。直接把 `FIELD_SPECS` 当段字段表，
 * O-005 的 `checkFieldSpec` 会在注册期抛 `bad-field-spec`，
 * 现象是「四层合并静默不可用」，日志里只有一行 warn。
 *
 * 所以段声明、用户层归一化、结果回填**三处全部由 `KEY_PAIRS` 派生**，
 * 不手写第二份。这是 O-035 起就定下的模式，O-029 / O-030 照抄过两次，
 * 本插件是第三次——**照抄是对的，因为它防的正是「改一处漏两处」**。
 *
 * ## 哪些数不进配置
 *
 * 六态判据与表达系数（都在 O-031 里）不进配置，理由同 O-031 的 README。
 * 这里只有**工程参数**：开关、片段顺序与存活时长、两档置信度、日志噪声。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但一律拒绝产出投影（`refusal: 'disabled'`）。 */
  readonly enable: boolean
  /**
   * 投影片段的存活时长（分钟）。默认 10。
   *
   * 为什么是 10：情绪标签的半衰期是 45 分钟（§3.2），心情是 6 小时，
   * 而投影是**一句话的语气建议**——它比任何状态量都短命。
   * 取 10 分钟，意味着一轮对话结束、下一条消息来时它就该重新生成，
   * 而不是拿着半小时前「她有点蔫」的暗示去描述一个已经缓过来的人。
   */
  readonly projectionTtlMinutes: number
  /**
   * 投影片段的排序键。默认 **+800**（尾部）。
   *
   * 手册 §8.5：稳定段在会话开头，**易变段追加尾部**。情绪每轮都变，
   * 所以必须是正数。写成负数会插进稳定前缀，让前缀缓存命中率掉到 0，
   * 而成本账单要先于任何人发现这件事。
   *
   * 与邻居的对照：O-029 应激 `-900`、O-030 冲突 `-880`（硬约束在前），
   * 本插件 `+800`（软建议在后）。这不是重要性排序，是**两种性质的内容**。
   */
  readonly projectionOrder: number
  /** 命中判据时的置信度。默认 0.9（判据是手册逐字写的，可信）。 */
  readonly confidenceMatched: number
  /** 空档兜底时的置信度。默认 0.5（是兜底，不是判定）。 */
  readonly confidenceFallback: number
  /** 产出与护栏失败时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'emotion-project'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但一律拒绝产出投影（原因码 disabled）。',
  },
  projectionTtlMinutes: {
    kind: 'number',
    default: 10,
    min: 1,
    max: 1440,
    doc: '投影片段存活时长（分钟）。默认 10：它只是「这一轮该用什么语气」的建议，比任何状态量都短命。',
    unit: '分钟',
  },
  projectionOrder: {
    kind: 'number',
    default: 800,
    min: 0,
    max: 1000,
    doc: '投影片段排序键，默认 +800（尾部）。手册 §8.5 要求易变段追加尾部；写成负数会破坏前缀缓存。',
  },
  confidenceMatched: {
    kind: 'number',
    default: 0.9,
    min: 0,
    max: 1,
    doc: '命中显式判据时的置信度。判据是手册逐字写的，故取 0.9。',
  },
  confidenceFallback: {
    kind: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    doc: '空档兜底时的置信度。兜底不是判定，故取 0.5。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '产出与护栏失败时打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  projectionTtlMinutes: FIELD_SPECS.projectionTtlMinutes.default as number,
  projectionOrder: FIELD_SPECS.projectionOrder.default as number,
  confidenceMatched: FIELD_SPECS.confidenceMatched.default as number,
  confidenceFallback: FIELD_SPECS.confidenceFallback.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 *
 * 必须**双向唯一**，否则两个字段会抢同一个段键，表现是「改 A 生效在 B 上」。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  projectionTtlMinutes: 'projection-ttl-minutes',
  projectionOrder: 'projection-order',
  confidenceMatched: 'confidence-matched',
  confidenceFallback: 'confidence-fallback',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '情感投影',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-emotion-project',
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
 *
 * `projectionOrder` 另有两条硬夹：
 * - `>= 0`：负数会插进稳定前缀，破坏 §8.5 的前缀缓存；
 * - `<= 1000`：再大就没有意义了（尾部只有一段）。
 *
 * 置信度夹到 `[0, 1]`，且**不强制两档谁大谁小**：`confidenceFallback` 若被配成
 * 大于 `confidenceMatched`，那是一个奇怪的配置，但不是本插件该替用户决定的事。
 * 真要防，应该报一条 warn（`stats` 里没有这个字段，故只在启动日志里说）。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    projectionTtlMinutes: clampInt(raw['projectionTtlMinutes'], DEFAULT_CONFIG.projectionTtlMinutes, 1, 1440),
    // 下限 0：负数会跑到稳定前缀去，宁可夹到 0（最靠前的易变段）也不许为负。
    projectionOrder: clampInt(raw['projectionOrder'], DEFAULT_CONFIG.projectionOrder, 0, 1000),
    confidenceMatched: clampNumber(raw['confidenceMatched'], DEFAULT_CONFIG.confidenceMatched, 0, 1),
    confidenceFallback: clampNumber(raw['confidenceFallback'], DEFAULT_CONFIG.confidenceFallback, 0, 1),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
