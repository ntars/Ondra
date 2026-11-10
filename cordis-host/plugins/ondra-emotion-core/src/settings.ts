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
 * 刻意**不放进配置**的一组值：
 *
 * - `0.12`（单条消息情绪变化上限）、`0.6`（标签上限）、`45min`（标签半衰期）、
 *   `6h`（心情半衰期）、`0.08`（道歉降幅）——这五个是**产品口径**，手册 §3.2 定死的。
 *   做成可调就等于承认「她能有多容易高兴」可以随手改，而它一旦被改，
 *   宣传片 05 章的六态映射就没有依据了。
 * - 三种激素的基线与半衰期（§3.9 实读 `genome.json`）同理，放在 `types.ts` 的
 *   `CORE_HORMONE_SPEC` 里当常量。
 *
 * 放进来的只有**工程参数**：结算跨度上限、阈值、总开关。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后不结算、不落盘，服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /**
   * 「张力偏高」的阈值。默认 0.5。
   *
   * 依据是手册 §3.2 的六态映射：`炸毛（tension > 0.5）`。
   * 注意它**不是冲突锁**——锁的建立与解除归 O-030，本插件只回答「现在张力过没过线」。
   */
  readonly tensionHighThreshold: number
  /**
   * 单次结算最多往前积分多少分钟。默认 10080（7 天）。
   *
   * 为什么要有上限：存档放一个月再打开，若按真实时间差积分，
   * 会得到一个「所有激素都精确回落到基线」的结果——那看起来不是「过了一个月」，
   * 而是「这个人重置了」。截断到 7 天，等于说「再久也只能恢复到这个程度，
   * 剩下的靠重新相处」。与手册 §3.10「上限 2000 段（≈7 天）」同一口径。
   */
  readonly maxSettleMinutes: number
  /**
   * 存档后是否顺带把「上一次存档时刻」写进日志。默认 true。
   *
   * 只影响日志噪声，不影响任何数值。
   */
  readonly verboseSave: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'emotion-core'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归应用侧。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不结算、不落盘；下游取到的是基线状态，而不是报错。',
  },
  tensionHighThreshold: {
    kind: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    doc: '「张力偏高」的判据（手册 §3.2 六态：炸毛 = tension > 0.5）。它只回答过没过线，不是冲突锁。',
  },
  maxSettleMinutes: {
    kind: 'number',
    default: 10080,
    min: 5,
    max: 525600,
    advancedOnly: true,
    doc: '单次结算最多往前积分多少分钟。默认 7 天：再久也按 7 天恢复，避免「放一个月回来人就重置了」。',
  },
  verboseSave: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '存档时是否打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  tensionHighThreshold: FIELD_SPECS.tensionHighThreshold.default as number,
  maxSettleMinutes: FIELD_SPECS.maxSettleMinutes.default as number,
  verboseSave: FIELD_SPECS.verboseSave.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），而 Cordis 插件实例
 * 配置历来是 camelCase。映射必须**双向唯一**，否则两个字段会抢同一个段键，
 * 表现是「改 A 生效在 B 上」——比报错难查十倍。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  tensionHighThreshold: 'tension-high-threshold',
  maxSettleMinutes: 'max-settle-minutes',
  verboseSave: 'verbose-save',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '情绪内核',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-emotion-core',
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

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
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
    tensionHighThreshold: clampFloat(
      raw['tensionHighThreshold'],
      DEFAULT_CONFIG.tensionHighThreshold,
      0,
      1,
    ),
    maxSettleMinutes: clampInt(raw['maxSettleMinutes'], DEFAULT_CONFIG.maxSettleMinutes, 5, 525600),
    verboseSave: raw['verboseSave'] === undefined ? DEFAULT_CONFIG.verboseSave : raw['verboseSave'] === true,
  })
}
