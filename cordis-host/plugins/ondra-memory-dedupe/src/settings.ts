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
 * 本插件**没有一个「必须由用户填」的字段**（§3.3-2）。判重是写入路径上的闸门，
 * 它一旦要求先配三个阈值才能用，就等于把「她记得住」变成一道调参题。
 *
 * 两个阈值是**显式参数而不是魔法数**：
 * - `mergeThreshold` 来自手册 §12.3 裁决⑥ 的「包含度 0.4」；
 * - `duplicateThreshold` 手册没给，是本插件补的「近乎全等」分界，
 *   取 0.95 是因为包含度到 0.95 时两条中文短句通常只差一两个字。
 *   它是**包含度**口径，与「余弦 0.85」「Jaccard 0.75」没有换算关系。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /**
   * 合并阈值（包含度）。默认 **0.4**，手册 §12.3 裁决⑥ 原值。
   *
   * 低于它就不是「同一件事」，直接 `add`——这一步不调模型（省 4 倍成本）。
   */
  readonly mergeThreshold: number
  /**
   * 「近乎全等」阈值（包含度）。默认 0.95。
   *
   * 达到它说明两条只差一两个字，此时由「新颖度」决定是复述（`drop`）还是补充（`merge`）。
   */
  readonly duplicateThreshold: number
  /**
   * 复述判定线（新颖度）。默认 0.25。
   *
   * 待写入正文里「旧条没有的二元组」占比 ≤ 它 → 视为复述 → 只记一次被提起，不改正文。
   * 超过它说明确有新信息 → `merge`（并入主条，旧正文进 `oldText` 可回溯）。
   */
  readonly appendNovelty: number
  /**
   * 复述判定的**绝对量**线。默认 2。
   *
   * 新颖度是占比，占比会随句子变长而变小：长句里加「三岁了」三个字，
   * 占比可能只有 0.2，但那三个字是真信息。故再加一条「新增二元组个数」。
   * **两个条件同时满足才算复述**（占比低 **且** 绝对新增少）。
   */
  readonly appendNoveltyGrams: number
  /**
   * 槽位替换的覆盖线。默认 0.45。
   *
   * 「公共前后缀」占较长那条的比例不低于它，才认为两句是**同一句式**。
   * 取 0.45 是两个真实用例夹出来的：
   * - `我28岁` 与 `我30岁` 的覆盖是 **0.5**（「我」+「岁」），线画到 0.5 以上就整类漏检；
   * - `她说她怕狗` 与 `用户怕狗` 的覆盖是 **0.4**，线画到 0.4 以下就会把「换个说法」误判成冲突。
   */
  readonly slotCoverage: number
  /**
   * 槽位差异段合计字数上限。默认 8。
   *
   * 超过它说明两句是两件事，不是「换了个值」。放宽会把「今天吃了面条」
   * 与「今天去了面馆吃面」也判成冲突。
   */
  readonly maxSlotChars: number
  /**
   * 参与判重的最短正文（字）。默认 **4**。
   *
   * 4 字 = 3 个二元组，是包含度还能区分「相同 / 不同」的最小粒度。
   * 低于 4 字（「好的」「嗯」「她怕狗」）包含度恒为 1.0，判重只会误合并，
   * 一律直接新建。这个数不能取 6：中文里 5 个字的短句（「用户喜欢猫」）
   * 是最常见的记忆形态之一，抬到 6 等于让它们永远不判重。
   */
  readonly minCompareChars: number
  /**
   * 最多带回几条候选。默认 **5**，手册 §2.2「候选 ≤5 条才交模型」。
   *
   * 这是**成本闸门**：本插件自己从不调模型，只保证交出去的候选不超过这个数。
   */
  readonly maxCandidates: number
  /** 候选池大小（最近多少条活跃记忆参与比对）。默认 200。 */
  readonly candidatePool: number
  /** 存量扫描条数上限。默认 300。**O(n²) 比对**，调大会明显变慢。 */
  readonly maxScanRows: number
  /** 冲突处置策略。默认 `report-only`（不写不改，只报告）。 */
  readonly conflictPolicy: 'report-only' | 'seal-old'
  /** 决策日志保留行数。默认 2000。 */
  readonly logLimit: number
  /** 每次最多清理多少行旧日志。默认 50（分批，避免一次删太多）。 */
  readonly logPruneBatch: number
  /** 日志里新正文最多存多少字。默认 200（与记忆正文上限同档）。 */
  readonly maxLogTextChars: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-dedupe'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归 O-092。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后判重不生效，所有写入都会新建一条（等于关掉去重）。',
  },
  mergeThreshold: {
    kind: 'number',
    default: 0.4,
    min: 0.05,
    max: 1,
    doc: '合并阈值（包含度）。低于它视为「不是同一件事」，直接新建。手册裁决⑥ 原值 0.4。',
  },
  duplicateThreshold: {
    kind: 'number',
    default: 0.95,
    min: 0.5,
    max: 1,
    advancedOnly: true,
    doc: '近乎全等阈值（包含度）。达到它之后由「新颖度」决定是复述还是补充。',
  },
  appendNovelty: {
    kind: 'number',
    default: 0.25,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '新颖度判定线（占比）。旧条没有的二元组占比不超过它，才算「大概率是复述」。',
  },
  appendNoveltyGrams: {
    kind: 'number',
    default: 2,
    min: 0,
    max: 20,
    advancedOnly: true,
    doc: '新颖度判定线（绝对量）。新增二元组个数不超过它，才算复述。与占比条件同时满足才生效。',
  },
  minCompareChars: {
    kind: 'number',
    default: 4,
    min: 2,
    max: 200,
    advancedOnly: true,
    doc: '参与判重的最短正文（字）。低于 4 字包含度恒为 1.0，直接新建。',
  },
  slotCoverage: {
    kind: 'number',
    default: 0.45,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '槽位替换的覆盖线：公共前后缀占较长那条的比例不低于它，才认为两句是同一句式。',
  },
  maxSlotChars: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 60,
    advancedOnly: true,
    doc: '槽位差异段合计字数上限。超过它说明是两件事，不是「换了个值」。',
  },
  maxCandidates: {
    kind: 'number',
    default: 5,
    min: 1,
    max: 50,
    doc: '最多带回几条候选。手册要求「候选 ≤5 条才交模型」，这是成本闸门。',
  },
  candidatePool: {
    kind: 'number',
    default: 200,
    min: 10,
    max: 5000,
    advancedOnly: true,
    doc: '候选池：最近多少条活跃记忆参与比对。调大更准但更慢。',
  },
  maxScanRows: {
    kind: 'number',
    default: 300,
    min: 20,
    max: 3000,
    advancedOnly: true,
    doc: '存量扫描条数上限。两两比对是 O(n²)，300 条约 4.5 万次，再大就会卡。',
  },
  conflictPolicy: {
    kind: 'enum',
    default: 'report-only',
    options: Object.freeze(['report-only', 'seal-old']),
    advancedOnly: true,
    doc: '冲突处置：只报告（不动数据）／封存旧条再写新条（双时态的等价动作）。',
  },
  logLimit: {
    kind: 'number',
    default: 2000,
    min: 0,
    max: 100000,
    advancedOnly: true,
    doc: '决策日志保留行数。0 表示不清理。日志的用途是回答「我的记忆怎么少了一条」。',
  },
  logPruneBatch: {
    kind: 'number',
    default: 50,
    min: 1,
    max: 500,
    advancedOnly: true,
    doc: '每次最多清理多少行旧日志。分批删，避免一次事务太大。',
  },
  maxLogTextChars: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2000,
    advancedOnly: true,
    doc: '日志里新正文最多存多少字。只留可辨认的残文，不留全文副本。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  mergeThreshold: FIELD_SPECS.mergeThreshold.default as number,
  duplicateThreshold: FIELD_SPECS.duplicateThreshold.default as number,
  appendNovelty: FIELD_SPECS.appendNovelty.default as number,
  appendNoveltyGrams: FIELD_SPECS.appendNoveltyGrams.default as number,
  minCompareChars: FIELD_SPECS.minCompareChars.default as number,
  slotCoverage: FIELD_SPECS.slotCoverage.default as number,
  maxSlotChars: FIELD_SPECS.maxSlotChars.default as number,
  maxCandidates: FIELD_SPECS.maxCandidates.default as number,
  candidatePool: FIELD_SPECS.candidatePool.default as number,
  maxScanRows: FIELD_SPECS.maxScanRows.default as number,
  conflictPolicy: FIELD_SPECS.conflictPolicy.default as Config['conflictPolicy'],
  logLimit: FIELD_SPECS.logLimit.default as number,
  logPruneBatch: FIELD_SPECS.logPruneBatch.default as number,
  maxLogTextChars: FIELD_SPECS.maxLogTextChars.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），而 Cordis 插件实例
 * 配置历来是 camelCase。O-035 踩过这个坑：直接把 `FIELD_SPECS` 当段声明交出去，
 * 注册期会抛 `bad-field-spec`，现象是「配置段静默不可用」。映射必须**双向唯一**。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  mergeThreshold: 'merge-threshold',
  duplicateThreshold: 'duplicate-threshold',
  appendNovelty: 'append-novelty',
  appendNoveltyGrams: 'append-novelty-grams',
  minCompareChars: 'min-compare-chars',
  slotCoverage: 'slot-coverage',
  maxSlotChars: 'max-slot-chars',
  maxCandidates: 'max-candidates',
  candidatePool: 'candidate-pool',
  maxScanRows: 'max-scan-rows',
  conflictPolicy: 'conflict-policy',
  logLimit: 'log-limit',
  logPruneBatch: 'log-prune-batch',
  maxLogTextChars: 'max-log-text-chars',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆判重',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-dedupe',
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
  const policy = raw['conflictPolicy']
  const conflictPolicy: Config['conflictPolicy'] =
    policy === 'report-only' || policy === 'seal-old' ? policy : DEFAULT_CONFIG.conflictPolicy

  const mergeThreshold = clampFloat(raw['mergeThreshold'], DEFAULT_CONFIG.mergeThreshold, 0.05, 1)
  // 两个阈值有先后关系：全等线低于合并线时判重会自相矛盾（先判「不够像」再判「几乎一样」）。
  // 这里做一次保序，而不是报错——配置错不该让插件不加载。
  const duplicateThreshold = Math.max(
    mergeThreshold,
    clampFloat(raw['duplicateThreshold'], DEFAULT_CONFIG.duplicateThreshold, 0.5, 1),
  )

  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    mergeThreshold,
    duplicateThreshold,
    appendNovelty: clampFloat(raw['appendNovelty'], DEFAULT_CONFIG.appendNovelty, 0, 1),
    appendNoveltyGrams: clampInt(raw['appendNoveltyGrams'], DEFAULT_CONFIG.appendNoveltyGrams, 0, 20),
    minCompareChars: clampInt(raw['minCompareChars'], DEFAULT_CONFIG.minCompareChars, 2, 200),
    slotCoverage: clampFloat(raw['slotCoverage'], DEFAULT_CONFIG.slotCoverage, 0, 1),
    maxSlotChars: clampInt(raw['maxSlotChars'], DEFAULT_CONFIG.maxSlotChars, 1, 60),
    maxCandidates: clampInt(raw['maxCandidates'], DEFAULT_CONFIG.maxCandidates, 1, 50),
    candidatePool: clampInt(raw['candidatePool'], DEFAULT_CONFIG.candidatePool, 10, 5000),
    maxScanRows: clampInt(raw['maxScanRows'], DEFAULT_CONFIG.maxScanRows, 20, 3000),
    conflictPolicy,
    logLimit: clampInt(raw['logLimit'], DEFAULT_CONFIG.logLimit, 0, 100000),
    logPruneBatch: clampInt(raw['logPruneBatch'], DEFAULT_CONFIG.logPruneBatch, 1, 500),
    maxLogTextChars: clampInt(raw['maxLogTextChars'], DEFAULT_CONFIG.maxLogTextChars, 20, 2000),
  })
}
