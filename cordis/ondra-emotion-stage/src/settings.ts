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
 * - **七阶阈值**（3 天 / 0.18 / 0.15 ……）。它们是手册 §9.1 逐字给出的产品口径，
 *   做成可调就等于承认「多久算心动」可以随手改，而宣传与文档都在引用这组数。
 *   要改就改 `types.ts` 的 `STAGE_SPECS` 一处——那是唯一真源。
 * - **`MAX_STEP = 0.06`**（步长闸）。同上，§3.4 与 §9.1 两处都写死了这个数。
 * - **三维半衰期**（240h / 720h / 8760h）。§3.4 定死。
 *
 * 放进来的只有**工程参数**：总开关、空闲结算门槛、衰减截断、日志噪声。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后不结算、不升阶，服务仍注册但所有写操作原样返回。 */
  readonly enable: boolean
  /**
   * 空闲结算门槛（分钟）。默认 15。
   *
   * 手册 §3.4 原话：「`settle_on_session_end true`、idle 15min 结算」。
   * 不足这个间隔时 `settle()` 什么都不做——结算一次要写一次库，
   * 每轮都结算等于每轮一次磁盘写。
   */
  readonly idleSettleMinutes: number
  /**
   * 单次结算最多往前积分多少小时。默认 8760（一年）。
   *
   * 为什么要有上限：存档放一年再打开，若按真实时间差积分，
   * 好感会精确落回基线 0.1——那看起来不是「一年没联系」，而是「重置了」。
   * 与 O-026 的 `maxSettleMinutes` 同一条纪律。
   */
  readonly maxSettleHours: number
  /** 升阶与结算时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'emotion-stage'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不再升阶、不再衰减，关系停在最后一次结算的样子。',
  },
  idleSettleMinutes: {
    kind: 'number',
    default: 15,
    min: 1,
    max: 10080,
    doc: '空闲多久才结算一次（手册 §3.4：idle 15min 结算）。不足则跳过，避免每轮一次磁盘写。',
  },
  maxSettleHours: {
    kind: 'number',
    default: 8760,
    min: 1,
    max: 876000,
    advancedOnly: true,
    doc: '单次结算最多往前积分多少小时。默认一年：再久也按一年衰减，避免「放一年回来关系被重置」。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '升阶与结算时打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  idleSettleMinutes: FIELD_SPECS.idleSettleMinutes.default as number,
  maxSettleHours: FIELD_SPECS.maxSettleHours.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
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
  idleSettleMinutes: 'idle-settle-minutes',
  maxSettleHours: 'max-settle-hours',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '关系阶段',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-emotion-stage',
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

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    idleSettleMinutes: clampInt(raw['idleSettleMinutes'], DEFAULT_CONFIG.idleSettleMinutes, 1, 10080),
    maxSettleHours: clampInt(raw['maxSettleHours'], DEFAULT_CONFIG.maxSettleHours, 1, 876000),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
