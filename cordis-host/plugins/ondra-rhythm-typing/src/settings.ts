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
 * 等待时长、分条数、首字延迟**全部来自 O-038**，本插件一个都不复制。
 * 一旦这里也存一份「6000ms」，两边就会漂移——症状是「面板说 6 秒、实际等 9 秒」，
 * 而查的人会先怀疑时钟。
 *
 * 本插件只有三个真正属于自己的参数：
 *
 * - `longPauseThresholdMs`：多长的等待算「停顿」（决定报 `paused` 还是 `typing`）。
 * - `wakeBufferMs`：刚醒缓冲（手册第 1363 行的缺口，默认 0 = 关）。
 * - `conversationId`：没有传会话 id 时的默认键。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `run()` 退回一次性整段发出。 */
  readonly enable: boolean
  /** 默认会话 id（调用方没传时用）。 */
  readonly conversationId: string
  /**
   * 多长的等待算「停顿」。默认 2500ms。
   *
   * 低于它的等待报 `typing`（正在打字），高于它报 `paused`（走神了）。
   * 这个界线只影响**对外报的阶段**，不影响实际等待时长。
   */
  readonly longPauseThresholdMs: number
  /**
   * 刚醒缓冲（毫秒）。默认 0（关）。
   *
   * 手册第 1363 行：「§9.2 节奏只有分条、停顿、打字，**没有刚醒缓冲**（开头慢半拍）」
   * → 建议并入 `rhythm-typing` 或 `life-rhythm`。本插件提供参数，
   * 但**默认 0**：判断「刚醒」需要作息数据，那是 O-049 `ondra-life-rhythm` 的事。
   */
  readonly wakeBufferMs: number
  /** 是否对外发阶段事件。默认 `true`（O-041 靠它显示正在输入）。 */
  readonly emitPhaseEvents: boolean
  /** 失败与降级时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'rhythm-typing'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 run() 退回一次性整段发出。',
  },
  conversationId: {
    kind: 'string',
    default: 'default',
    advancedOnly: true,
    doc: '默认会话 id。调用方没传 conversationId 时用它。',
  },
  longPauseThresholdMs: {
    kind: 'number',
    default: 2500,
    min: 0,
    max: 30000,
    advancedOnly: true,
    doc: '多长的等待算「停顿」（报 paused 而不是 typing）。只影响对外阶段，不影响实际等待。',
  },
  wakeBufferMs: {
    kind: 'number',
    default: 0,
    min: 0,
    max: 10000,
    advancedOnly: true,
    doc: '刚醒缓冲（手册第 1363 行的缺口）。默认 0：判断「刚醒」要作息数据，归 O-049。',
  },
  emitPhaseEvents: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否对外发阶段事件（O-041 的「正在输入」靠它）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '失败与降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  conversationId: FIELD_SPECS.conversationId.default as string,
  longPauseThresholdMs: FIELD_SPECS.longPauseThresholdMs.default as number,
  wakeBufferMs: FIELD_SPECS.wakeBufferMs.default as number,
  emitPhaseEvents: FIELD_SPECS.emitPhaseEvents.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  conversationId: 'conversation-id',
  longPauseThresholdMs: 'long-pause-threshold-ms',
  wakeBufferMs: 'wake-buffer-ms',
  emitPhaseEvents: 'emit-phase-events',
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
  title: '打字与停顿执行',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-rhythm-typing',
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
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const rawId = raw['conversationId']
  const conversationId =
    typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : DEFAULT_CONFIG.conversationId

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    conversationId,
    longPauseThresholdMs: clampInt(
      raw['longPauseThresholdMs'],
      DEFAULT_CONFIG.longPauseThresholdMs,
      0,
      30000,
    ),
    wakeBufferMs: clampInt(raw['wakeBufferMs'], DEFAULT_CONFIG.wakeBufferMs, 0, 10000),
    emitPhaseEvents: bool('emitPhaseEvents', DEFAULT_CONFIG.emitPhaseEvents),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
