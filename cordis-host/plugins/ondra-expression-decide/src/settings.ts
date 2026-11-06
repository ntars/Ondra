/**
 * 配置的**单一真源**（分数门槛 + 回落策略）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么门槛是分数，不是概率
 *
 * 线索权重是整数（强词 3 / 中词 2 / 标点 2 / 句形 1），总分会随着
 * 一句话里命中几条而累加。门槛写成 `≥ minScore` 有一个好处：
 * **面板能拿真实分数去解释**（「这条 2 分，刚好够线」），
 * 而写成 0–1 的概率就得再编一套归一化，那套归一化没人看得懂。
 *
 * 默认 2 = 一条中词，或两条弱线索。**一条句形线索不算数**：
 * 「4 个字没标点」这种形状，正常说话里到处都是。
 *
 * ## 为什么默认表情是「平静」
 *
 * 六态里副作用最小的一档。`fallbackState` 可改，但**不建议改成蔫**——
 * 蔫会连着语速、音量、主动额度一起变，一个"没判出来"的表情
 * 不该带这么多后果（O-031 的判据表里也是同样的理由）。
 */

import { EXPRESS_STATES } from './types.js'
import type { ExpressionState, FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`decide()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 分数门槛：低于它就不算"正文里有线索"。 */
  readonly minScore: number
  /** 正文无线索时，是否回落到 O-031 的当前六态。 */
  readonly useStateFallback: boolean
  /** 既无线索也拿不到六态时，用哪个表情。 */
  readonly fallbackState: ExpressionState
  /** 判定结果是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'expression-decide'

/** 门槛下界：1 分意味着"任何一条线索都算数"。 */
export const MIN_SCORE_FLOOR = 1

/** 门槛上界：强词 3 分，10 分已经高到「一句话必须命中四条强线索」。 */
export const MIN_SCORE_CEIL = 10

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后一律不出标记（服务照常注册）。',
  },
  minScore: {
    kind: 'number',
    default: 2,
    min: MIN_SCORE_FLOOR,
    max: MIN_SCORE_CEIL,
    doc: `分数门槛（${MIN_SCORE_FLOOR}–${MIN_SCORE_CEIL}）。强词 3 分 / 中词 2 分 / 标点 2 分 / 句形 1 分。默认 2 = 一条中词或两条弱线索。`,
  },
  useStateFallback: {
    kind: 'boolean',
    default: true,
    doc: '正文没线索时，跟当前六态走（脸上不动）。关掉则直接用默认表情。',
  },
  fallbackState: {
    kind: 'enum',
    default: 'calm',
    values: EXPRESS_STATES,
    advancedOnly: true,
    doc: '既没线索也拿不到六态时的表情。不建议改成蔫：它会连带语速、音量、主动额度一起变。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '判定结果打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  minScore: FIELD_SPECS.minScore.default as number,
  useStateFallback: FIELD_SPECS.useStateFallback.default as boolean,
  fallbackState: FIELD_SPECS.fallbackState.default as ExpressionState,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  minScore: 'min-score',
  useStateFallback: 'use-state-fallback',
  fallbackState: 'fallback-state',
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
  title: '表情判定',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-expression-decide',
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
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const given = raw['fallbackState']
  const fallbackState =
    typeof given === 'string' && (EXPRESS_STATES as readonly string[]).includes(given)
      ? (given as ExpressionState)
      : DEFAULT_CONFIG.fallbackState

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    minScore: clampInt(raw['minScore'], DEFAULT_CONFIG.minScore, MIN_SCORE_FLOOR, MIN_SCORE_CEIL),
    useStateFallback: bool('useStateFallback', DEFAULT_CONFIG.useStateFallback),
    fallbackState,
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
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

  const given = raw['minScore']
  if (given !== undefined) {
    if (typeof given !== 'number' || !Number.isFinite(given) || given < MIN_SCORE_FLOOR || given > MIN_SCORE_CEIL) {
      drift.push('minScore')
    }
  }

  const state = raw['fallbackState']
  if (state !== undefined && !(typeof state === 'string' && (EXPRESS_STATES as readonly string[]).includes(state))) {
    drift.push('fallbackState')
  }
  return drift
}
