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
 * 数值来源分两类，逐条写明：
 *
 * **手册原值**（§2.3 三种想起路径）：
 * - `minStrength 0.06` / `maxStrength 0.9`：固定回忆的 `R ∈ [0.06, 0.9]`。
 * - `recentSkipDays 3`：「3 天内想过跳过」。
 * - `cueBaseProbability 0.10` / `cueOverlapWeight 0.55` / `cueStrengthWeight 0.35`：
 *   `p = 0.10 + 重合比×0.55 + R×0.35`。
 * - `minSharedGrams 1`：「2-gram 重合 ≥1 才考虑」。
 * - `rippleRings`：手册「1–3 圈」，**默认取 2**（1 圈看不出「漫无目的」，
 *   3 圈会把整张图拉进上下文；2 圈是中间值）。
 * - 权重公式 `(1−R) × (0.5 + 重要度/100)`、永久再 `×0.6`：写死在 `dice.ts`，
 *   **不做配置项**——它是公式不是旋钮，做成配置只会让人随手改坏「越模糊越容易想起」。
 *
 * **本插件补的**（手册没给，写明理由）：
 * - `longTermBaseHours 240`：「只从长期/永久挑」里的「长期」没有定义。
 *   本插件**不抄 11 类表**（那是 O-010 的真源），改用**基线阈值**判定：
 *   `stabilityBaseHours ≥ 240` 即长期档。240 恰好是 `person` 的基线，
 *   于是 `person` / `promise` / `self` 三类自然落入，其余（study 80 以下）不入。
 *   改这个阈值只影响「哪些记忆参与固定回忆」，不影响寿命计算。
 * - `permanentBaseHours 8000`：「永久」同样没有定义。取 `promise` 基线 8000 作下沿，
 *   `promise` / `self` 归永久档并乘 0.6。手册原意是「永久记忆别天天冒出来」，
 *   用基线阈值表达同一件事，且不需要一张池表（池表是 O-131 的活）。
 * - `scanLimit 500` / `pageSize 200`：单次扫描的安全阀与分页大小。
 *   端口没有聚合面，只能分页扫；撞上限时结果里 `note` 会写明「扫描被截断」。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 「长期档」的基线阈值（小时）。默认 **240**。 */
  readonly longTermBaseHours: number
  /** 「永久档」的基线阈值（小时）。默认 **8000**。 */
  readonly permanentBaseHours: number
  /** 固定回忆的强度下沿。默认 **0.06**。 */
  readonly minStrength: number
  /** 固定回忆的强度上沿。默认 **0.9**。 */
  readonly maxStrength: number
  /** 「最近想过」的跳过窗口（天）。默认 **3**。 */
  readonly recentSkipDays: number
  /** 勾起概率的基底。默认 **0.10**。 */
  readonly cueBaseProbability: number
  /** 勾起概率里「重合比」的权重。默认 **0.55**。 */
  readonly cueOverlapWeight: number
  /** 勾起概率里「强度」的权重。默认 **0.35**。 */
  readonly cueStrengthWeight: number
  /** 勾起的最少共享二元组数。默认 **1**。 */
  readonly minSharedGrams: number
  /** 水波纹圈数 1–3。默认 **2**。 */
  readonly rippleRings: number
  /** 单次扫描的条数上限。默认 500。 */
  readonly scanLimit: number
  /** 分页大小。默认 200。 */
  readonly pageSize: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-humanlike'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后三条想起路径都返回「不可用」，服务仍注册。',
  },
  longTermBaseHours: {
    kind: 'number',
    default: 240,
    min: 1,
    max: 100000,
    advancedOnly: true,
    doc: '「长期档」的基线阈值（小时）。手册说「只从长期/永久挑」但没定义长期；本插件用基线阈值判定，不抄 11 类表（那是 O-010 的真源）。240 = person 基线。',
    unit: '小时',
  },
  permanentBaseHours: {
    kind: 'number',
    default: 8000,
    min: 1,
    max: 200000,
    advancedOnly: true,
    doc: '「永久档」的基线阈值（小时）。8000 = promise 基线，self 20000 也在此档；永久档抽中权重再 ×0.6。',
    unit: '小时',
  },
  minStrength: {
    kind: 'number',
    default: 0.06,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '固定回忆的强度下沿（手册 §2.3 R ∈ [0.06, 0.9]）。低于它的已经淡到地板，不参与抽签。',
  },
  maxStrength: {
    kind: 'number',
    default: 0.9,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '固定回忆的强度上沿。高于它的太清楚，用不着「忽然想起」；也避免每次都是同一条最牢的记忆被抽中。',
  },
  recentSkipDays: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 365,
    advancedOnly: true,
    doc: '「最近想过」的跳过窗口（天）。判据是内核的 lastHitAt（reinforce(\'hit\') 写入），本插件不另记一份。',
    unit: '天',
  },
  cueBaseProbability: {
    kind: 'number',
    default: 0.1,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '勾起概率基底（手册 §2.3：p = 0.10 + 重合比×0.55 + R×0.35）。',
  },
  cueOverlapWeight: {
    kind: 'number',
    default: 0.55,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '勾起概率里「二元组覆盖率」的权重（手册 0.55）。',
  },
  cueStrengthWeight: {
    kind: 'number',
    default: 0.35,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '勾起概率里「强度 R」的权重（手册 0.35）。三项相加恰为 1.0，故概率天然落在 [0,1]。',
  },
  minSharedGrams: {
    kind: 'number',
    default: 1,
    min: 1,
    max: 8,
    advancedOnly: true,
    doc: '勾起的最少共享二元组数（手册「2-gram 重合 ≥1 才考虑」）。调高会让勾起更保守。',
  },
  rippleRings: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 3,
    doc: '水波纹圈数（手册 1–3 圈）。默认 2：1 圈看不出「漫无目的」，3 圈会把整张图拉进上下文。',
  },
  scanLimit: {
    kind: 'number',
    default: 500,
    min: 50,
    max: 50000,
    advancedOnly: true,
    doc: '单次扫描的条数上限。撞上限时结果 note 会写「扫描被截断」，不静默半扫。',
  },
  pageSize: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2000,
    advancedOnly: true,
    doc: '分页大小。端口没有聚合面，扫描只能分页。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  longTermBaseHours: FIELD_SPECS.longTermBaseHours.default as number,
  permanentBaseHours: FIELD_SPECS.permanentBaseHours.default as number,
  minStrength: FIELD_SPECS.minStrength.default as number,
  maxStrength: FIELD_SPECS.maxStrength.default as number,
  recentSkipDays: FIELD_SPECS.recentSkipDays.default as number,
  cueBaseProbability: FIELD_SPECS.cueBaseProbability.default as number,
  cueOverlapWeight: FIELD_SPECS.cueOverlapWeight.default as number,
  cueStrengthWeight: FIELD_SPECS.cueStrengthWeight.default as number,
  minSharedGrams: FIELD_SPECS.minSharedGrams.default as number,
  rippleRings: FIELD_SPECS.rippleRings.default as number,
  scanLimit: FIELD_SPECS.scanLimit.default as number,
  pageSize: FIELD_SPECS.pageSize.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），而 Cordis 插件实例
 * 配置历来是 camelCase。直接把 `FIELD_SPECS` 当段声明交出去会在注册期抛
 * `bad-field-spec`，现象是「配置段静默不可用」（O-035 踩过）。映射必须**双向唯一**。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  longTermBaseHours: 'long-term-base-hours',
  permanentBaseHours: 'permanent-base-hours',
  minStrength: 'min-strength',
  maxStrength: 'max-strength',
  recentSkipDays: 'recent-skip-days',
  cueBaseProbability: 'cue-base-probability',
  cueOverlapWeight: 'cue-overlap-weight',
  cueStrengthWeight: 'cue-strength-weight',
  minSharedGrams: 'min-shared-grams',
  rippleRings: 'ripple-rings',
  scanLimit: 'scan-limit',
  pageSize: 'page-size',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆拟人化',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-humanlike',
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

/** 夹一个数（浮点）。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.trunc(clampNumber(value, fallback, min, max))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 *
 * 三处**保序**处理（不保序会静默失效，且现象极难查）：
 * 1. `maxStrength` 不得低于 `minStrength`——否则区间为空，骰子**永远抽不到东西**，
 *    现象是「她今晚什么都没想起」而不是报错（O-013 的 `clearAbove`/`fadedAbove` 同型）。
 * 2. `scanLimit` 不得小于一页——否则连一页都读不完，结果永远是「截断」。
 * 3. `permanentBaseHours` 不得低于 `longTermBaseHours`——否则「永久档」比「长期档」还宽。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const pageSize = clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 20, 2000)
  const scanLimit = Math.max(pageSize, clampInt(raw['scanLimit'], DEFAULT_CONFIG.scanLimit, 50, 50000))

  const minStrength = clampNumber(raw['minStrength'], DEFAULT_CONFIG.minStrength, 0, 1)
  const maxStrength = Math.max(minStrength, clampNumber(raw['maxStrength'], DEFAULT_CONFIG.maxStrength, 0, 1))

  const longTermBaseHours = clampNumber(raw['longTermBaseHours'], DEFAULT_CONFIG.longTermBaseHours, 1, 100000)
  const permanentBaseHours = Math.max(
    longTermBaseHours,
    clampNumber(raw['permanentBaseHours'], DEFAULT_CONFIG.permanentBaseHours, 1, 200000),
  )

  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    longTermBaseHours,
    permanentBaseHours,
    minStrength,
    maxStrength,
    recentSkipDays: clampInt(raw['recentSkipDays'], DEFAULT_CONFIG.recentSkipDays, 1, 365),
    cueBaseProbability: clampNumber(raw['cueBaseProbability'], DEFAULT_CONFIG.cueBaseProbability, 0, 1),
    cueOverlapWeight: clampNumber(raw['cueOverlapWeight'], DEFAULT_CONFIG.cueOverlapWeight, 0, 1),
    cueStrengthWeight: clampNumber(raw['cueStrengthWeight'], DEFAULT_CONFIG.cueStrengthWeight, 0, 1),
    minSharedGrams: clampInt(raw['minSharedGrams'], DEFAULT_CONFIG.minSharedGrams, 1, 8),
    rippleRings: clampInt(raw['rippleRings'], DEFAULT_CONFIG.rippleRings, 1, 3),
    scanLimit,
    pageSize,
  })
}
