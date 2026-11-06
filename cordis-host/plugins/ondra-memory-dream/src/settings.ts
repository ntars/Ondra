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
 * **手册原值**：
 * - `mode 'gate'`：§2.7 + 裁决⑤「闸式为默认，荒诞联想为独立分支（不可兼得）」。
 * - `maxItems 6`：§2.7「产出 `maxItems=6`/晚」。
 * - `minQuoteChars 4`：与 O-011 的引文最短字数同口径（低于 4 字的「引文」等于没引）。
 * - `maxTextChars 200`：§2.2「条目 ≤200 字」。
 * - `surrealMinGapDays 3` / `maxSurrealPerNight 3`：§9.7 第 4 步「同实体但时间差 >3 天」
 *   「每晚 ≤3 条」。
 * - `cardHalfLifeHours 168`：§1.7「未用卡片 168 小时半衰期、归档不删除」。
 * - `idleShallowMs 120000` / `idleDeepMs 300000`：§1.7「空闲 2 分钟浅睡 / 5 分钟深睡」。
 * - `talkMinChars 30` / `talkMaxChars 50`：§9.7 第 5 步「30–50 字呓语」。
 *
 * **本插件补的**（手册没给，写明理由）：
 * - `dreamSalience 40`：手册写 `importance=3`，那是 1–5 尺度；本仓的 `salience` 是 0–100。
 *   直译 3/5 → 60 会让**梦补的事实比用户亲口说的还显著**（写入打分表的基底是 30、
 *   「第一次/最」+26 → 56），于是梦话挤掉真话。取 40：略高于基底、低于「第一次」档。
 *   这是一个**换算**，不是新参数；调它只影响梦事实的寿命起点。
 * - `maxCandidates 24`：模型一次最多给多少条候选（解析保护，防跑飞）。
 * - `surrealMinSharedGrams 2`：「同实体」在手册里没有定义，本插件用「共享 ≥2 个二元组」
 *   近似同一实体/同一话题。**这是一个近似**，写进 README 已知限制。
 * - `cardArchiveWeight 0.05`：卡片归档的权重阈值。手册只说「归档不删除」，没给线。
 *   取 0.05 与图谱软剪枝同值，便于一句话解释「低于 5% 就不再冒头」。
 * - `scanLimit 500` / `pageSize 200`：扫描安全阀与分页大小。
 * - `factCardDays 7` / `factCardSalience 50` / `maxFactCards 3`：`fact` 卡片的取材口径
 *   （手册只给了卡片类型名，没给取材规则）。
 * - `temperature 0.3` / `maxTokens 900`：做梦调用的采样参数。温度压低是因为
 *   「补事实」不是创作；梦话那一段另用 `talkTemperature`。
 * - `talkTemperature 0.9`：梦话本来就该跳，温度太低会写成说明文。
 */

import type { DreamBranchSettings, DreamMode, FieldSpecLike, SectionDeclLike } from './types.js'
import { DREAM_MODES } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config extends DreamBranchSettings {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 分支。默认 `gate`。 */
  readonly mode: DreamMode
  /** 做梦调用的温度。 */
  readonly temperature: number
  /** 做梦调用的输出上限。 */
  readonly maxTokens: number
  /** 梦话调用的温度。 */
  readonly talkTemperature: number
  /** 荒诞联想从最近多少条出发。 */
  readonly surrealRecentSeeds: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-dream'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册但不可用。',
  },
  mode: {
    kind: 'enum',
    default: 'gate',
    options: DREAM_MODES,
    doc: '分支。gate=闸式（只补带逐字出处的事实，默认）；lightweight=纯规则五类卡片（零模型调用）；surreal=荒诞联想+梦话。闸式与荒诞不可兼得（裁决⑤），故是单一枚举而不是两个开关。',
  },
  maxItems: {
    kind: 'number',
    default: 6,
    min: 1,
    max: 64,
    doc: '每晚最多写几条事实（手册 §2.7 maxItems=6）。超出的候选记 max-items 拒收，不静默丢。',
  },
  maxCandidates: {
    kind: 'number',
    default: 24,
    min: 1,
    max: 200,
    advancedOnly: true,
    doc: '模型一次最多给多少条候选（解析保护）。',
  },
  dreamSalience: {
    kind: 'number',
    default: 40,
    min: 0,
    max: 100,
    advancedOnly: true,
    doc: '梦事实的显著度。手册的 importance=3 是 1–5 尺度，直译 60 会让梦补的事实比用户亲口说的还显著；取 40（略高于基底 30，低于「第一次」档 56）。',
  },
  minQuoteChars: {
    kind: 'number',
    default: 4,
    min: 2,
    max: 40,
    advancedOnly: true,
    doc: '引文最短字数。与 O-011 同口径：低于 4 字的「引文」等于没引。',
  },
  maxTextChars: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2000,
    doc: '事实正文上限（手册 §2.2 条目 ≤200 字）。超长直接拒，不截断——截断会毁掉引文与正文的对应关系。',
  },
  surrealMinGapDays: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 3650,
    advancedOnly: true,
    doc: '荒诞联想的最短时间差（天）。手册「同实体但时间差 >3 天」。',
  },
  maxSurrealPerNight: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 20,
    advancedOnly: true,
    doc: '每晚最多建几条荒诞边（手册 ≤3 条）。到上限就停，不淘汰旧的。',
  },
  surrealMinSharedGrams: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 12,
    advancedOnly: true,
    doc: '「同实体」的近似门槛（共享二元组数）。手册没定义实体，本插件用共同二元组近似——这是近似，不是等价。',
  },
  surrealRecentSeeds: {
    kind: 'number',
    default: 20,
    min: 1,
    max: 200,
    advancedOnly: true,
    doc: '荒诞联想从最近多少条记忆出发去找「远处的伴」。手册没给这个数：两两全比对是 O(n²)，500 条就是 12 万次比较，而「今晚梦到白天的事、跟很久以前的事连起来」本来就该从最近出发。',
  },
  cardHalfLifeHours: {
    kind: 'number',
    default: 168,
    min: 1,
    max: 8760,
    doc: '卡片的半衰期（小时）。手册「未用卡片 168 小时半衰期」。用过的卡片从「用」的那一刻重新起算。',
  },
  cardArchiveWeight: {
    kind: 'number',
    default: 0.05,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '卡片归档的权重阈值。归档是算出来的，不是写出来的（读接口不写库）。',
  },
  idleShallowMs: {
    kind: 'number',
    default: 120000,
    min: 1000,
    max: 3600000,
    advancedOnly: true,
    doc: '浅睡门槛（毫秒，默认 2 分钟）。空闲不到这个时长不做事。',
  },
  idleDeepMs: {
    kind: 'number',
    default: 300000,
    min: 1000,
    max: 7200000,
    advancedOnly: true,
    doc: '深睡门槛（毫秒，默认 5 分钟）。深睡时才做「事实卡片」这类更费的动作。',
  },
  talkMinChars: {
    kind: 'number',
    default: 30,
    min: 5,
    max: 200,
    advancedOnly: true,
    doc: '梦话最短字数（手册 30–50 字呓语）。',
  },
  talkMaxChars: {
    kind: 'number',
    default: 50,
    min: 5,
    max: 400,
    advancedOnly: true,
    doc: '梦话最长字数。',
  },
  scanLimit: {
    kind: 'number',
    default: 500,
    min: 20,
    max: 20000,
    advancedOnly: true,
    doc: '扫描条数上限（荒诞联想找配对、事实卡片取材）。撞上限时报告 note 会写明。',
  },
  pageSize: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2000,
    advancedOnly: true,
    doc: '分页大小。',
  },
  factCardDays: {
    kind: 'number',
    default: 7,
    min: 1,
    max: 365,
    advancedOnly: true,
    doc: '事实卡片取材的最近天数（手册只给了卡片类型，没给取材规则，本插件补）。',
  },
  factCardSalience: {
    kind: 'number',
    default: 50,
    min: 0,
    max: 100,
    advancedOnly: true,
    doc: '事实卡片的最低显著度。低于它不值得做成卡片。',
  },
  maxFactCards: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 20,
    advancedOnly: true,
    doc: '事实卡片最多几条（一次睡眠）。',
  },
  temperature: {
    kind: 'number',
    default: 0.3,
    min: 0,
    max: 2,
    advancedOnly: true,
    doc: '做梦调用的温度。压得低是因为「补事实」不是创作。',
  },
  maxTokens: {
    kind: 'number',
    default: 900,
    min: 100,
    max: 8000,
    advancedOnly: true,
    doc: '做梦调用的输出上限。',
  },
  toolPitfallStreak: {
    kind: 'number',
    default: 3,
    min: 2,
    max: 20,
    advancedOnly: true,
    doc: 'pitfall 卡片：同一工具连续失败几次算坑（手册 §B「同工具连败 ≥3」）。',
  },
  toolPlaybookRepeat: {
    kind: 'number',
    default: 2,
    min: 2,
    max: 20,
    advancedOnly: true,
    doc: 'playbook 卡片：同一条成功链路重复几次算套路（手册「跨工具成功链重复 ≥2」）。',
  },
  toolHotspotCalls: {
    kind: 'number',
    default: 8,
    min: 2,
    max: 200,
    advancedOnly: true,
    doc: 'hotspot 卡片：调用几次以上才看成功率（手册「≥8 次调用」）。',
  },
  toolHotspotRate: {
    kind: 'number',
    default: 0.7,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: 'hotspot 卡片：成功率低于多少算热点（手册「成功率 <70%」）。',
  },
  toolUnresolvedFails: {
    kind: 'number',
    default: 3,
    min: 2,
    max: 50,
    advancedOnly: true,
    doc: 'unresolved 卡片：上次成功之后累计失败几次算卡住（手册「上次成功后累计 ≥3 败」）。',
  },
  talkTemperature: {
    kind: 'number',
    default: 0.9,
    min: 0,
    max: 2,
    advancedOnly: true,
    doc: '梦话调用的温度。梦话本来就该跳，温度太低会写成说明文。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  mode: FIELD_SPECS.mode.default as DreamMode,
  maxItems: FIELD_SPECS.maxItems.default as number,
  maxCandidates: FIELD_SPECS.maxCandidates.default as number,
  dreamSalience: FIELD_SPECS.dreamSalience.default as number,
  minQuoteChars: FIELD_SPECS.minQuoteChars.default as number,
  maxTextChars: FIELD_SPECS.maxTextChars.default as number,
  surrealMinGapDays: FIELD_SPECS.surrealMinGapDays.default as number,
  maxSurrealPerNight: FIELD_SPECS.maxSurrealPerNight.default as number,
  surrealMinSharedGrams: FIELD_SPECS.surrealMinSharedGrams.default as number,
  cardHalfLifeHours: FIELD_SPECS.cardHalfLifeHours.default as number,
  cardArchiveWeight: FIELD_SPECS.cardArchiveWeight.default as number,
  idleShallowMs: FIELD_SPECS.idleShallowMs.default as number,
  idleDeepMs: FIELD_SPECS.idleDeepMs.default as number,
  talkMinChars: FIELD_SPECS.talkMinChars.default as number,
  talkMaxChars: FIELD_SPECS.talkMaxChars.default as number,
  scanLimit: FIELD_SPECS.scanLimit.default as number,
  pageSize: FIELD_SPECS.pageSize.default as number,
  factCardDays: FIELD_SPECS.factCardDays.default as number,
  factCardSalience: FIELD_SPECS.factCardSalience.default as number,
  maxFactCards: FIELD_SPECS.maxFactCards.default as number,
  temperature: FIELD_SPECS.temperature.default as number,
  maxTokens: FIELD_SPECS.maxTokens.default as number,
  talkTemperature: FIELD_SPECS.talkTemperature.default as number,
  surrealRecentSeeds: FIELD_SPECS.surrealRecentSeeds.default as number,
  toolPitfallStreak: FIELD_SPECS.toolPitfallStreak.default as number,
  toolPlaybookRepeat: FIELD_SPECS.toolPlaybookRepeat.default as number,
  toolHotspotCalls: FIELD_SPECS.toolHotspotCalls.default as number,
  toolHotspotRate: FIELD_SPECS.toolHotspotRate.default as number,
  toolUnresolvedFails: FIELD_SPECS.toolUnresolvedFails.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写）。直接把 `FIELD_SPECS`
 * 当段声明交出去会在注册期抛 `bad-field-spec`（O-035 踩过），现象是「配置段静默不可用」。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  mode: 'mode',
  maxItems: 'max-items',
  maxCandidates: 'max-candidates',
  dreamSalience: 'dream-salience',
  minQuoteChars: 'min-quote-chars',
  maxTextChars: 'max-text-chars',
  surrealMinGapDays: 'surreal-min-gap-days',
  maxSurrealPerNight: 'max-surreal-per-night',
  surrealMinSharedGrams: 'surreal-min-shared-grams',
  cardHalfLifeHours: 'card-half-life-hours',
  cardArchiveWeight: 'card-archive-weight',
  idleShallowMs: 'idle-shallow-ms',
  idleDeepMs: 'idle-deep-ms',
  talkMinChars: 'talk-min-chars',
  talkMaxChars: 'talk-max-chars',
  scanLimit: 'scan-limit',
  pageSize: 'page-size',
  factCardDays: 'fact-card-days',
  factCardSalience: 'fact-card-salience',
  maxFactCards: 'max-fact-cards',
  temperature: 'temperature',
  maxTokens: 'max-tokens',
  talkTemperature: 'talk-temperature',
  surrealRecentSeeds: 'surreal-recent-seeds',
  toolPitfallStreak: 'tool-pitfall-streak',
  toolPlaybookRepeat: 'tool-playbook-repeat',
  toolHotspotCalls: 'tool-hotspot-calls',
  toolHotspotRate: 'tool-hotspot-rate',
  toolUnresolvedFails: 'tool-unresolved-fails',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆做梦',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-dream',
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
 * 三处**保序**处理（不保序会静默失效）：
 * 1. `talkMaxChars ≥ talkMinChars`——否则梦话区间为空，永远生成不出梦话。
 * 2. `idleDeepMs ≥ idleShallowMs`——否则「深睡」比「浅睡」还容易进，深睡分支形同虚设。
 * 3. `scanLimit ≥ pageSize`——否则连一页都读不完，结果永远「截断」。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}

  const pageSize = clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 20, 2000)
  const scanLimit = Math.max(pageSize, clampInt(raw['scanLimit'], DEFAULT_CONFIG.scanLimit, 20, 20000))

  const talkMinChars = clampInt(raw['talkMinChars'], DEFAULT_CONFIG.talkMinChars, 5, 200)
  const talkMaxChars = Math.max(talkMinChars, clampInt(raw['talkMaxChars'], DEFAULT_CONFIG.talkMaxChars, 5, 400))

  const idleShallowMs = clampInt(raw['idleShallowMs'], DEFAULT_CONFIG.idleShallowMs, 1000, 3600000)
  const idleDeepMs = Math.max(idleShallowMs, clampInt(raw['idleDeepMs'], DEFAULT_CONFIG.idleDeepMs, 1000, 7200000))

  const modeRaw = raw['mode']
  const mode: DreamMode =
    typeof modeRaw === 'string' && (DREAM_MODES as readonly string[]).includes(modeRaw)
      ? (modeRaw as DreamMode)
      : DEFAULT_CONFIG.mode

  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    mode,
    maxItems: clampInt(raw['maxItems'], DEFAULT_CONFIG.maxItems, 1, 64),
    maxCandidates: clampInt(raw['maxCandidates'], DEFAULT_CONFIG.maxCandidates, 1, 200),
    dreamSalience: clampNumber(raw['dreamSalience'], DEFAULT_CONFIG.dreamSalience, 0, 100),
    minQuoteChars: clampInt(raw['minQuoteChars'], DEFAULT_CONFIG.minQuoteChars, 2, 40),
    maxTextChars: clampInt(raw['maxTextChars'], DEFAULT_CONFIG.maxTextChars, 20, 2000),
    surrealMinGapDays: clampInt(raw['surrealMinGapDays'], DEFAULT_CONFIG.surrealMinGapDays, 1, 3650),
    maxSurrealPerNight: clampInt(raw['maxSurrealPerNight'], DEFAULT_CONFIG.maxSurrealPerNight, 0, 20),
    surrealMinSharedGrams: clampInt(raw['surrealMinSharedGrams'], DEFAULT_CONFIG.surrealMinSharedGrams, 1, 12),
    cardHalfLifeHours: clampNumber(raw['cardHalfLifeHours'], DEFAULT_CONFIG.cardHalfLifeHours, 1, 8760),
    cardArchiveWeight: clampNumber(raw['cardArchiveWeight'], DEFAULT_CONFIG.cardArchiveWeight, 0, 1),
    idleShallowMs,
    idleDeepMs,
    talkMinChars,
    talkMaxChars,
    scanLimit,
    pageSize,
    factCardDays: clampInt(raw['factCardDays'], DEFAULT_CONFIG.factCardDays, 1, 365),
    factCardSalience: clampNumber(raw['factCardSalience'], DEFAULT_CONFIG.factCardSalience, 0, 100),
    maxFactCards: clampInt(raw['maxFactCards'], DEFAULT_CONFIG.maxFactCards, 0, 20),
    temperature: clampNumber(raw['temperature'], DEFAULT_CONFIG.temperature, 0, 2),
    maxTokens: clampInt(raw['maxTokens'], DEFAULT_CONFIG.maxTokens, 100, 8000),
    talkTemperature: clampNumber(raw['talkTemperature'], DEFAULT_CONFIG.talkTemperature, 0, 2),
    surrealRecentSeeds: clampInt(raw['surrealRecentSeeds'], DEFAULT_CONFIG.surrealRecentSeeds, 1, 200),
    toolPitfallStreak: clampInt(raw['toolPitfallStreak'], DEFAULT_CONFIG.toolPitfallStreak, 2, 20),
    toolPlaybookRepeat: clampInt(raw['toolPlaybookRepeat'], DEFAULT_CONFIG.toolPlaybookRepeat, 2, 20),
    toolHotspotCalls: clampInt(raw['toolHotspotCalls'], DEFAULT_CONFIG.toolHotspotCalls, 2, 200),
    toolHotspotRate: clampNumber(raw['toolHotspotRate'], DEFAULT_CONFIG.toolHotspotRate, 0, 1),
    toolUnresolvedFails: clampInt(raw['toolUnresolvedFails'], DEFAULT_CONFIG.toolUnresolvedFails, 2, 50),
  })
}
