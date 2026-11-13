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
 * 本插件**没有一个「必须由用户填」的字段**：全部参数都有合理默认值（§3.3-2），
 * 装上去就能跑。这不是偷懒，是刻意的——记忆内核是 P0 底座，它一旦要求用户先配
 * 三个数才能用，就等于把「她记不记得你」变成一道配置题。
 *
 * 唯一的例外是 `importantSalience` 与 `longTermBaseHours`：手册给了分档口径
 * 却没给分界线，所以把它们做成**显式参数**而不是埋在代码里的魔法数。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /**
   * 「重要」的分界显著度（0–100）。默认 70。
   *
   * 手册只写「normal 30 天 / important 90 天未引用即 archived」，没给 important 的判定。
   * 取 70 的理由：写入打分表的基底是 30，+26（第一次）/+22（最难忘）/+16（难过）
   * 任意两条叠加即越过 70——也就是「有情绪或是有分量」的事才配 90 天窗口。
   */
  readonly importantSalience: number
  /** 长期类判定线（小时）。默认 240；基线 ≥ 此值的类别写入基底为 70。 */
  readonly longTermBaseHours: number
  /** 通道归一化锚点（天）。默认 12（三档中位，见 `stability.ts` 文件头第 3 条）。 */
  readonly channelAnchorDays: number
  /** 强度地板。默认 0.01；到底不等于 0（只忘不删）。 */
  readonly floorWeight: number
  /** 普通记忆归档窗口（天）。默认 30。 */
  readonly archiveNormalDays: number
  /** 重要记忆归档窗口（天）。默认 90。 */
  readonly archiveImportantDays: number
  /** 最低曝光：多少天没被带出就该「忽然想起」。默认 30。 */
  readonly resurfaceDays: number
  /** 默认通道。默认 `gist`（三档中位，最不容易偏）。 */
  readonly defaultChannel: 'fact' | 'gist' | 'affect'
  /** 单条正文上限（字）。默认 200（手册 §2.2「条目 ≤200 字」）。 */
  readonly maxTextChars: number
  /** 摘要上限（字）。默认 80（手册 §2.2「summary ≤80 字」）。 */
  readonly maxSummaryChars: number
  /**
   * 单次查询的硬上限（条）。默认 5000。
   *
   * **这是内存保护，不是召回预算**。召回「不按条数砍」是 O-014 的红线，
   * 任何把这个数字当成 topK 的用法都是越界——它只在调用方不传 `limit` 时兜底，
   * 且必须大到「正常库全量能出来」。
   */
  readonly maxSelectRows: number
  /** 写入时是否自动打分。默认 `true`；关掉则统一按 50 分（等权），仅供调试。 */
  readonly scoreOnWrite: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-core'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归应用侧。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  importantSalience: {
    kind: 'number',
    default: 70,
    min: 0,
    max: 100,
    doc: '「重要」的分界显著度。达到它就走 90 天归档窗口，否则 30 天。',
  },
  longTermBaseHours: {
    kind: 'number',
    default: 240,
    min: 1,
    max: 100000,
    advancedOnly: true,
    doc: '长期类判定线（小时）：类别基线不低于它的，写入基底记 70 分而不是 30 分。',
    unit: '小时',
  },
  channelAnchorDays: {
    kind: 'number',
    default: 12,
    min: 1,
    max: 3650,
    advancedOnly: true,
    doc: '通道归一化锚点（天）。三通道 4/12/180 天都除以它，得到无量纲通道系数。',
    unit: '天',
  },
  floorWeight: {
    kind: 'number',
    default: 0.01,
    min: 0.0001,
    max: 0.5,
    advancedOnly: true,
    doc: '强度地板。记忆再旧也不会掉到 0——「删了她就永远不知道自己曾经知道」。',
  },
  archiveNormalDays: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 3650,
    doc: '普通记忆多久没被引用就沉底（只忘不删，仍可被按类翻到）。',
  },
  archiveImportantDays: {
    kind: 'number',
    default: 90,
    min: 1,
    max: 3650,
    doc: '重要记忆多久没被引用才沉底。',
  },
  resurfaceDays: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 3650,
    doc: '多少天没被带出就该「忽然想起」一次（最低曝光）。只给候选，注入由 O-036 决定。',
  },
  defaultChannel: {
    kind: 'enum',
    default: 'gist',
    options: Object.freeze(['fact', 'gist', 'affect']),
    advancedOnly: true,
    doc: '调用方没说通道时用哪个。默认 gist（4/12/180 三档的中位）。',
  },
  maxTextChars: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 4000,
    doc: '单条正文上限（字）。超长会截断并记一条 issue，而不是整条拒绝——拒绝等于这条记忆彻底消失。',
    unit: '字',
  },
  maxSummaryChars: {
    kind: 'number',
    default: 80,
    min: 10,
    max: 1000,
    doc: '摘要上限（字）。',
    unit: '字',
  },
  maxSelectRows: {
    kind: 'number',
    default: 5000,
    min: 1,
    max: 100000,
    advancedOnly: true,
    doc: '单次查询硬上限。这是内存保护，不是召回预算；召回不按条数砍是 O-014 的红线。',
  },
  scoreOnWrite: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '写入时按打分表算显著度。关掉后统一 50 分，仅供对拍调试。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  importantSalience: FIELD_SPECS.importantSalience.default as number,
  longTermBaseHours: FIELD_SPECS.longTermBaseHours.default as number,
  channelAnchorDays: FIELD_SPECS.channelAnchorDays.default as number,
  floorWeight: FIELD_SPECS.floorWeight.default as number,
  archiveNormalDays: FIELD_SPECS.archiveNormalDays.default as number,
  archiveImportantDays: FIELD_SPECS.archiveImportantDays.default as number,
  resurfaceDays: FIELD_SPECS.resurfaceDays.default as number,
  defaultChannel: FIELD_SPECS.defaultChannel.default as Config['defaultChannel'],
  maxTextChars: FIELD_SPECS.maxTextChars.default as number,
  maxSummaryChars: FIELD_SPECS.maxSummaryChars.default as number,
  maxSelectRows: FIELD_SPECS.maxSelectRows.default as number,
  scoreOnWrite: FIELD_SPECS.scoreOnWrite.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * 为什么必须两套名字：§8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），
 * 而 Cordis 插件实例配置历来是 camelCase。O-035 已经踩过这个坑：
 * 直接把 `FIELD_SPECS` 当段声明交出去，会在注册期抛 `bad-field-spec`，
 * 现象是「配置段注册失败、四层合并静默不可用」，日志只有一句 warn。
 *
 * 映射必须**双向唯一**，否则两个 Config 字段会抢同一个段字段，
 * 表现是「改 A 生效在 B 上」——这类错查起来比报错难十倍。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  importantSalience: 'important-salience',
  longTermBaseHours: 'long-term-base-hours',
  channelAnchorDays: 'channel-anchor-days',
  floorWeight: 'floor-weight',
  archiveNormalDays: 'archive-normal-days',
  archiveImportantDays: 'archive-important-days',
  resurfaceDays: 'resurface-days',
  defaultChannel: 'default-channel',
  maxTextChars: 'max-text-chars',
  maxSummaryChars: 'max-summary-chars',
  maxSelectRows: 'max-select-rows',
  scoreOnWrite: 'score-on-write',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆内核',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-core',
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
  const channelRaw = raw['defaultChannel']
  const defaultChannel: Config['defaultChannel'] =
    channelRaw === 'fact' || channelRaw === 'gist' || channelRaw === 'affect'
      ? channelRaw
      : DEFAULT_CONFIG.defaultChannel

  return Object.freeze({
    importantSalience: clampFloat(raw['importantSalience'], DEFAULT_CONFIG.importantSalience, 0, 100),
    longTermBaseHours: clampFloat(raw['longTermBaseHours'], DEFAULT_CONFIG.longTermBaseHours, 1, 100000),
    channelAnchorDays: clampFloat(raw['channelAnchorDays'], DEFAULT_CONFIG.channelAnchorDays, 1, 3650),
    floorWeight: clampFloat(raw['floorWeight'], DEFAULT_CONFIG.floorWeight, 0.0001, 0.5),
    archiveNormalDays: clampInt(raw['archiveNormalDays'], DEFAULT_CONFIG.archiveNormalDays, 1, 3650),
    archiveImportantDays: clampInt(
      raw['archiveImportantDays'],
      DEFAULT_CONFIG.archiveImportantDays,
      1,
      3650,
    ),
    resurfaceDays: clampInt(raw['resurfaceDays'], DEFAULT_CONFIG.resurfaceDays, 1, 3650),
    defaultChannel,
    maxTextChars: clampInt(raw['maxTextChars'], DEFAULT_CONFIG.maxTextChars, 20, 4000),
    maxSummaryChars: clampInt(raw['maxSummaryChars'], DEFAULT_CONFIG.maxSummaryChars, 10, 1000),
    maxSelectRows: clampInt(raw['maxSelectRows'], DEFAULT_CONFIG.maxSelectRows, 1, 100000),
    scoreOnWrite: raw['scoreOnWrite'] === undefined ? DEFAULT_CONFIG.scoreOnWrite : raw['scoreOnWrite'] === true,
  })
}
