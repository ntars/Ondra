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
 * ## 为什么只有三个字段
 *
 * 帧的形状与四值闭集都是**规范**，不是参数——把它们做成配置项，
 * 就等于让每台机器上的协议不一样，而通道与界面只会装到一个版本。
 * 这里只留三个真正属于「这台机器怎么跑」的开关。
 *
 * ## `KEY_PAIRS` 为什么必须有
 *
 * 本插件的 Config 是 camelCase（`allowEmptyDelta`），而手册 §8.4 的配置键
 * 正则 `^[a-z][a-z0-9_-]{1,63}$` **不认大写**。直接拿 `FIELD_SPECS` 当段字段表，
 * O-005 的 `checkFieldSpec` 会在注册期抛 `bad-field-spec`，现象是
 * 「四层合并静默不可用」，日志里只有一行 warn。所以段声明、用户层归一化、
 * 结果回填**三处全部由 `KEY_PAIRS` 派生**，不手写第二份。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但 `create()` 返回一个**立刻关闭**的 writer。 */
  readonly enable: boolean
  /**
   * 是否放行空文本增量。默认 `false`。
   *
   * 放行的唯一合理场景是通道保活（周期性发空帧）。默认关，是因为
   * 空帧在界面上表现为「她说了一句然后卡了一下」——一种没来由的停顿。
   */
  readonly allowEmptyDelta: boolean
  /** 写入被拒时是否打日志。只影响噪声：正常流里「终态后再写」每次都可能发生。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'dialogue-protocol'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 create() 返回一个立刻关闭的 writer（下游拿不到任何帧，不会静默继续）。',
  },
  allowEmptyDelta: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '是否放行空文本增量。默认关：空帧在界面上表现为「她说了一句然后卡了一下」。只有通道保活需要打开。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '写入被拒时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  allowEmptyDelta: FIELD_SPECS.allowEmptyDelta.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 *
 * 必须**双向唯一**，否则两个字段会抢同一个段键，表现是「改 A 生效在 B 上」。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  allowEmptyDelta: 'allow-empty-delta',
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
  title: '对话协议',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-dialogue-protocol',
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
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    allowEmptyDelta:
      raw['allowEmptyDelta'] === undefined
        ? DEFAULT_CONFIG.allowEmptyDelta
        : raw['allowEmptyDelta'] === true,
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
