/**
 * 配置的**单一真源**（与 O-005 口径一致：默认值由声明方拥有、只存一份）。
 *
 * 刻意**不进配置**的两个数是 §3.5 的公式本身：`0.6`（斜率）与 `5000`（饱和点），
 * 以及 `+60%`（上限）。它们是产品承诺的量化版本（「越熟越难被取悦」），
 * 做成可调就等于承认「她多久开始变得难哄」可以随手改。
 * 要改就改 `types.ts` 一处。
 *
 * 放进来的只有**工程参数**：默认漂移幅度、单次幅度护栏、总开关、日志噪声。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后特质仍可读（全是基线）、阈值不漂移。 */
  readonly enable: boolean
  /**
   * 特质漂移上限占量程的默认比例。默认 0.15。
   *
   * 手册说「有界漂移」但没给界。取量程的 15% 的依据是**可察觉但仍是同一个人**：
   * 0–1 的特质动 0.15，读起来是「语气明显不一样了」；
   * 到 0.3 就是「换了个角色」，而人设包的内核正文一个字都没变——
   * 那种「设定没变、人却变了」的状态最难解释。单条特质可用 `maxDriftRatio` 覆盖。
   */
  readonly defaultTraitDriftRatio: number
  /**
   * 单次调整的幅度上限，占量程的比例。默认 0.1。
   *
   * 手册 §3.1 说「你骂他皮质醇会叫他收敛」——一次就收敛到底不是人，是开关。
   * 这条护栏让「一次经历最多推动一成」，配合漂移上限，等于「要很多次才会变」。
   */
  readonly maxDeltaRatio: number
  /** 调整 / 回滚时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'persona-evolve'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后特质一律读基线、阈值不漂移（服务照常注册，不会让下游拿到 undefined）。',
  },
  defaultTraitDriftRatio: {
    kind: 'number',
    default: 0.15,
    min: 0.01,
    max: 0.6,
    doc: '特质漂移上限占量程的默认比例。默认 0.15：能看出变化，但还是同一个人。',
  },
  maxDeltaRatio: {
    kind: 'number',
    default: 0.1,
    min: 0.01,
    max: 0.5,
    advancedOnly: true,
    doc: '单次调整幅度上限（占量程）。默认 0.1：一次经历最多推动一成。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '调整与回滚各打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  defaultTraitDriftRatio: FIELD_SPECS.defaultTraitDriftRatio.default as number,
  maxDeltaRatio: FIELD_SPECS.maxDeltaRatio.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 的配置键正则不认大写，而 Cordis 插件实例配置历来是 camelCase。
 * 映射必须**双向唯一**：两个字段抢同一个段键的表现是「改 A 生效在 B 上」，
 * 而且不报错。段声明 / 用户层归一化 / 结果回填三处**全部**由这张表派生。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  defaultTraitDriftRatio: 'default-trait-drift-ratio',
  maxDeltaRatio: 'max-delta-ratio',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '人格演化',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-persona-evolve',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**（交给 O-005 报 `unknown-field`）。
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

/** 夹一个浮点。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    defaultTraitDriftRatio: clampFloat(
      raw['defaultTraitDriftRatio'],
      DEFAULT_CONFIG.defaultTraitDriftRatio,
      0.01,
      0.6,
    ),
    maxDeltaRatio: clampFloat(raw['maxDeltaRatio'], DEFAULT_CONFIG.maxDeltaRatio, 0.01, 0.5),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
