/**
 * 配置的**单一真源**（与 O-005 口径一致：默认值由声明方拥有、只存一份）。
 *
 * 刻意**不进配置**的一组数是 §5.1 逐字给出的：判重阈值 0.6、加压 +10、
 * 唤醒门槛 80 / 能量 30 / 闲置 30min / 冷却 60min、梦境能量 30 / 闲置 2h / 张力 −10。
 * 做成可调就等于承认「压到什么程度算压人」可以随手改——
 * 而这些数决定的是「她多久烦你一次」，是全仓最不该被调的那一组。
 * 要改就改 `types.ts` 一处。
 *
 * 放进来的只有**工程参数**：起点张力与增速（手册只说「有 base 和 rate」，
 * 没给数）、池子上限、片段排序键与存活时长、闭合行保留天数、日志噪声。
 */

import { MIN_FRAGMENT_ORDER } from './types.js'
import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后不记账、不判唤醒、不出片段。 */
  readonly enable: boolean
  /**
   * 新缺口的起点张力（0–100）。默认 40。
   *
   * 手册只写 `base`，没给数。取 40 的理由是配合下面的 2.5/h：
   * `(80 − 40) / 2.5 ≈ 16 小时`——一件没解决的事放一整天，她才会被它叫醒。
   * 再低就会变成「半天问一次」，那是定时任务不是惦记。
   */
  readonly baseTension: number
  /** 每小时涨多少点（0–100 尺度）。默认 2.5。 */
  readonly tensionPerHour: number
  /**
   * 池子里最多同时开多少条。默认 400。
   *
   * 满了**不淘汰**，只拒收新的（先保已有的执念：淘汰一条正在涨的执念，
   * 等于替她决定「这件事不重要」）。与 O-131 的 `core` 池「满了直接拒绝」同一条纪律。
   */
  readonly maxOpen: number
  /**
   * 执念片段的排序键。默认 790。
   *
   * 比 O-032 的情绪投影（+800）**前面一位**：投影是「她此刻什么状态」，
   * 执念是「她心里压着什么」——压着事会先影响她怎么接话，状态是接话时的语气。
   * 两者都在尾部易变段（§8.5），不进前缀，所以不破坏缓存。
   */
  readonly fragmentOrder: number
  /** 执念片段的存活时长（分钟）。默认 30。 */
  readonly fragmentTtlMinutes: number
  /**
   * 已闭合的行保留多少天。默认 30。
   *
   * 只影响 `prune()`（必须显式调用）。缺口的闭合史是「她解决过什么」的底稿，
   * 但没人会去查三个月前关掉的一条，留着只是把表养胖。
   */
  readonly closedRetainDays: number
  /** 开缺口 / 合并 / 唤醒时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'drive-gap'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不记账、不判唤醒、不出片段（服务照常注册，读到的是空池）。',
  },
  baseTension: {
    kind: 'number',
    default: 40,
    min: 0,
    max: 100,
    doc: '新缺口起点张力（0–100）。默认 40：配 2.5/h 约 16 小时到唤醒线，即「放一整天」。',
  },
  tensionPerHour: {
    kind: 'number',
    default: 2.5,
    min: 0.1,
    max: 20,
    doc: '每小时涨多少点。默认 2.5。改大只会让她更快被同一件事叫醒。',
  },
  maxOpen: {
    kind: 'number',
    default: 400,
    min: 20,
    max: 5000,
    advancedOnly: true,
    doc: '同时开着的上限。满了拒收新的，不淘汰已有的（不替她决定哪条不重要）。',
  },
  fragmentOrder: {
    kind: 'number',
    default: 790,
    min: MIN_FRAGMENT_ORDER,
    max: 9000,
    advancedOnly: true,
    doc: '执念片段的排序键，默认 790（紧接情绪投影 +800 之前）。不进前缀，不影响缓存。',
  },
  fragmentTtlMinutes: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 720,
    doc: '执念片段存活时长（分钟）。默认 30：一次对话里说不说这件事，半小时内有效。',
    unit: '分钟',
  },
  closedRetainDays: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 3650,
    advancedOnly: true,
    doc: '`prune()` 保留闭合行的天数。只会删 closed，绝不碰 open。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '开缺口、合并、唤醒判定通过时各打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  baseTension: FIELD_SPECS.baseTension.default as number,
  tensionPerHour: FIELD_SPECS.tensionPerHour.default as number,
  maxOpen: FIELD_SPECS.maxOpen.default as number,
  fragmentOrder: FIELD_SPECS.fragmentOrder.default as number,
  fragmentTtlMinutes: FIELD_SPECS.fragmentTtlMinutes.default as number,
  closedRetainDays: FIELD_SPECS.closedRetainDays.default as number,
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
  baseTension: 'base-tension',
  tensionPerHour: 'tension-per-hour',
  maxOpen: 'max-open',
  fragmentOrder: 'fragment-order',
  fragmentTtlMinutes: 'fragment-ttl-minutes',
  closedRetainDays: 'closed-retain-days',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '缺口池',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-drive-gap',
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
    baseTension: clampFloat(raw['baseTension'], DEFAULT_CONFIG.baseTension, 0, 100),
    tensionPerHour: clampFloat(raw['tensionPerHour'], DEFAULT_CONFIG.tensionPerHour, 0.1, 20),
    maxOpen: clampInt(raw['maxOpen'], DEFAULT_CONFIG.maxOpen, 20, 5000),
    fragmentOrder: clampInt(raw['fragmentOrder'], DEFAULT_CONFIG.fragmentOrder, MIN_FRAGMENT_ORDER, 9000),
    fragmentTtlMinutes: clampInt(raw['fragmentTtlMinutes'], DEFAULT_CONFIG.fragmentTtlMinutes, 1, 720),
    closedRetainDays: clampInt(raw['closedRetainDays'], DEFAULT_CONFIG.closedRetainDays, 1, 3650),
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}
