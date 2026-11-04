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
 * ## 哪些是手册参数，哪些是本项目自定
 *
 * | 字段 | 出处 |
 * |---|---|
 * | `cap=3` | 手册 §2.6 ④ 逐字「≤3」 |
 * | 三档骨架 `365`、`30/31` | 手册 §2.6 ④「≥1年 / 整365天 / 整30天」 |
 * | `scanLimit=5000` | 自定。手册只说「全库」，没说扫多少；见下 |
 * | `pageSize=200` | 自定。翻页步长，受存储层 `maxSelectRows` 夹紧 |
 * | `graphDedupe` 门槛 0.72 | 手册 §9.7 的 `same_topic` 初值下沿 |
 * | `leapFold` | 手册没给；见 README「待裁决」 |
 * | `includeArchived` | 手册 §2.4「只忘不删」+「忽然想起」的推论 |
 *
 * `scanLimit` 为什么是 5000：一条记忆读出来的成本约等于一次行映射，
 * 5000 条在普通机器上是一次十几毫秒的活；而一天只算一次（冻结点之后不再扫）。
 * 设成 500 就是 O-036 的老问题——库一大，「一年前的今天」永远落在窗口之外。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { CAP_MAX, PAGE_SIZE_MAX, SCAN_LIMIT_MAX } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`today()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 最多给几条（手册逐字 ≤3）。 */
  readonly cap: number
  /** 每次计算最多扫多少条记忆。 */
  readonly scanLimit: number
  /** 翻页步长。 */
  readonly pageSize: number
  /** 是否启用「周年」档（往年同月同日）。 */
  readonly shelfAnniversary: boolean
  /** 是否启用「整年」档（正好 365 天）。 */
  readonly shelfYearDay: boolean
  /** 是否启用「整月」档（差 30/31 天）。 */
  readonly shelfMonthDay: boolean
  /** 2 月 29 日的记忆是否折叠到 2 月 28 日。 */
  readonly leapFold: boolean
  /** 归档条目是否参与（封存条目任何情况下都不参与）。 */
  readonly includeArchived: boolean
  /** 是否用图谱把「同一件事」去重。 */
  readonly graphDedupe: boolean
  /** 是否把当天结果冻结（同一天内答案不变）。 */
  readonly freezePerDay: boolean
  /** 取走时是否记「被提起」账（`markSeen` + `reinforce('mention')`）。 */
  readonly reinforceOnTake: boolean
  /** 降级与跳过时打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'onthisday'

/** 条数下限。0 条等于关掉这一块，但那样不如直接关开关。 */
export const CAP_MIN = 1

/** 单页下限。 */
export const PAGE_SIZE_MIN = 20

/** 扫描下限：比一个月最多天数还小就没意义了。 */
export const SCAN_LIMIT_MIN = 200

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，today() 一律 disabled（面板能说清是关了，不是坏了）。',
  },
  cap: {
    kind: 'number',
    default: 3,
    min: CAP_MIN,
    max: CAP_MAX,
    doc: `最多给几条（手册 §2.6 ④ 逐字 ≤3）。给多了会挤掉后面几块的预算。`,
  },
  scanLimit: {
    kind: 'number',
    default: 5000,
    min: SCAN_LIMIT_MIN,
    max: SCAN_LIMIT_MAX,
    advancedOnly: true,
    doc: `每次计算最多扫多少条记忆（${SCAN_LIMIT_MIN}–${SCAN_LIMIT_MAX}）。自定值；扫不完会上报 truncated，不静默漏。`,
  },
  pageSize: {
    kind: 'number',
    default: 200,
    min: PAGE_SIZE_MIN,
    max: PAGE_SIZE_MAX,
    advancedOnly: true,
    doc: '翻页步长。真实页大小由存储层夹紧，本插件按「返回几条就前进几条」翻页，不假设页大小。',
  },
  shelfAnniversary: {
    kind: 'boolean',
    default: true,
    doc: '「周年」档：往年同月同日（含 2 月 29 日折叠）。这是「那年今日」的本体。',
  },
  shelfYearDay: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '「整年」档：正好 365 天但不同月同日。只兜闰日与跨年错位，关掉会让 2 月 29 日的记忆在平年整年不见。',
  },
  shelfMonthDay: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '「整月」档：差 30/31 天（一个月前）。关掉就只剩「往年」的回看。',
  },
  leapFold: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '2 月 29 日的记忆在平年的 2 月 28 日也算周年。关掉则那天每隔四年才有一次机会。',
  },
  includeArchived: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '归档条目是否参与。手册 §2.4「只忘不删」——归档只是不主动注入，「那年今日」正是忽然想起的场景。封存条目任何情况下都不参与。',
  },
  graphDedupe: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '用图谱（O-015）把「同一件事写了三遍」合并成一条。图谱缺席时自动退回字面去重。',
  },
  freezePerDay: {
    kind: 'boolean',
    default: true,
    doc: '当天结果冻结：同一天内答案不变。关掉会让注入前缀在同一天里抖动，命中率下降。',
  },
  reinforceOnTake: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '被带出时记「被提起」账（markSeen + reinforce mention）。关掉则她提过这件事，记忆强度也不会变。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级与跳过时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  cap: FIELD_SPECS.cap.default as number,
  scanLimit: FIELD_SPECS.scanLimit.default as number,
  pageSize: FIELD_SPECS.pageSize.default as number,
  shelfAnniversary: FIELD_SPECS.shelfAnniversary.default as boolean,
  shelfYearDay: FIELD_SPECS.shelfYearDay.default as boolean,
  shelfMonthDay: FIELD_SPECS.shelfMonthDay.default as boolean,
  leapFold: FIELD_SPECS.leapFold.default as boolean,
  includeArchived: FIELD_SPECS.includeArchived.default as boolean,
  graphDedupe: FIELD_SPECS.graphDedupe.default as boolean,
  freezePerDay: FIELD_SPECS.freezePerDay.default as boolean,
  reinforceOnTake: FIELD_SPECS.reinforceOnTake.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  cap: 'cap',
  scanLimit: 'scan-limit',
  pageSize: 'page-size',
  shelfAnniversary: 'shelf-anniversary',
  shelfYearDay: 'shelf-year-day',
  shelfMonthDay: 'shelf-month-day',
  leapFold: 'leap-fold',
  includeArchived: 'include-archived',
  graphDedupe: 'graph-dedupe',
  freezePerDay: 'freeze-per-day',
  reinforceOnTake: 'reinforce-on-take',
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
  title: '那年今日',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-onthisday',
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

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    cap: clampInt(raw['cap'], DEFAULT_CONFIG.cap, CAP_MIN, CAP_MAX),
    scanLimit: clampInt(raw['scanLimit'], DEFAULT_CONFIG.scanLimit, SCAN_LIMIT_MIN, SCAN_LIMIT_MAX),
    pageSize: clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, PAGE_SIZE_MIN, PAGE_SIZE_MAX),
    shelfAnniversary: bool('shelfAnniversary', DEFAULT_CONFIG.shelfAnniversary),
    shelfYearDay: bool('shelfYearDay', DEFAULT_CONFIG.shelfYearDay),
    shelfMonthDay: bool('shelfMonthDay', DEFAULT_CONFIG.shelfMonthDay),
    leapFold: bool('leapFold', DEFAULT_CONFIG.leapFold),
    includeArchived: bool('includeArchived', DEFAULT_CONFIG.includeArchived),
    graphDedupe: bool('graphDedupe', DEFAULT_CONFIG.graphDedupe),
    freezePerDay: bool('freezePerDay', DEFAULT_CONFIG.freezePerDay),
    reinforceOnTake: bool('reinforceOnTake', DEFAULT_CONFIG.reinforceOnTake),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置里有没有被悄悄夹过。
 *
 * `completeConfig()` 拿到的已经是夹紧后的值，它自己不知道「刚才那个数是 12」。
 * @param value 原始配置。
 * @returns 被回退或夹紧的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []
  const bounds: ReadonlyArray<readonly [keyof Config, number, number]> = [
    ['cap', CAP_MIN, CAP_MAX],
    ['scanLimit', SCAN_LIMIT_MIN, SCAN_LIMIT_MAX],
    ['pageSize', PAGE_SIZE_MIN, PAGE_SIZE_MAX],
  ]
  for (const [key, min, max] of bounds) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }
  return drift
}
