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
 * **五因子权重刻意不在这里**（见 `types.ts` 的 `SPEC_WEIGHTS`）：
 * 它是手册 §2.3 / 裁决⑦ 已定版的产品参数，改它属于「调参」，
 * 而手册 §12.4 要求**先有评估集再改、改一次跑一次**。做成配置项会让人随手改，
 * 且改完之后「同一句话昨天想起三条、今天想起八条」将无法归因。
 *
 * 其余参数全部可调，且每个都写明「为什么是这个值」。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /**
   * 融合模式。默认 **`rrf`**（手册 §2.3 建议：默认 rrf，weighted 留 LEGACY）。
   *
   * - `rrf`：只看名次不看分数，消掉五因子尺度混合问题；
   * - `weighted`：裁决⑦ 的五因子加权和（`.18/.46/.11/.14/.11`）。
   *
   * 两条实现各自成函数、互不调用。评估集（O-136）跑出哪个好用就切哪个，
   * 切换不需要改代码。
   */
  readonly fuse: 'rrf' | 'weighted'
  /**
   * RRF 常数。默认 **60**（手册 §2.3 原值）。
   *
   * `k` 越大，名次之间的差距越平缓。改它等于改「第 1 名比第 10 名重要多少」，
   * 属于调参，需要评估集。
   */
  readonly rrfK: number
  /** BM25 词频饱和参数。默认 **1.2**（手册 §2.3 原值）。 */
  readonly bm25K1: number
  /** BM25 长度归一项。默认 **0.75**（手册 §2.3 原值）。 */
  readonly bm25B: number
  /**
   * BM25 分的「半分点」。默认 3.0。
   *
   * 五因子要求每项落在 0–1，而 BM25 分是无上界的。用 `x/(x+half)` 做单调压缩：
   * 分到 `half` 时因子恰为 0.5。**这是本插件补的标定值，手册未给**，
   * 必须由 O-136 评估集校准；改它会整体平移 `weighted` 模式的排序。
   */
  readonly bm25Half: number
  /**
   * 罕见词通道的 IDF 门槛。默认 **9**（手册 §2.3 原值，来自 jieba + 通用 IDF 口径）。
   *
   * 注意：手册那套 IDF 建在几十万词的通用词表上，而本插件没有分词器，
   * 用字符二元组近似「词」，IDF 上界受库容限制（N 条库单例词的 idf ≈ ln(2N)）。
   * 库容 1 万时上界约 9.9，库容 50 时只有 3.5——**小库上这条通道会自然为空**，
   * 这不是故障，`channels` 里会把它标成 `absent` 并写明原因。
   */
  readonly rareIdf: number
  /**
   * 罕见词通道生效的最小库容。默认 2000。
   *
   * 低于它时 idf 上界够不到 `rareIdf`，通道必然空转；与其每轮白算一遍，
   * 不如显式标 `absent` 并说明。2000 条的 idf 上界是 ln(4000)≈8.3，仍略低于 9，
   * 取这个数是为了让「接近生效」的状态也能被看见，而不是等它悄悄不干活。
   */
  readonly rareMinDocs: number
  /** 图谱种子条数。默认 3：取字面命中前 3 条当 1 跳扩散的起点。 */
  readonly graphSeeds: number
  /**
   * 图谱边权门槛。默认 **0.4**（手册 §9.7「扩散门槛 0.4」，与 O-015 共用同一常量）。
   *
   * 低于它的边不参与图谱因子，也不参与扩散——两处共用同一个数，
   * 免得「建边时算连上了、检索时又不算」。
   */
  readonly graphMinWeight: number
  /**
   * 是否把已沉底的记忆纳入候选。默认 **false**。
   *
   * 沉底 = 「还占不占主动位」的答案是否定的，但它**没被删**，按类检索仍能翻到。
   * 主动召回不该把它们端上来；「30 天未带出强行补 1 条」走 O-010 的
   * `dueForResurfacing()`，是另一条路径。
   */
  readonly includeArchived: boolean
  /**
   * 索引有效期（毫秒）。默认 30000。
   *
   * O-010 不提供写事件，故只能靠「条数变化 + 超时」两个信号判断过期。
   * 条数不变但内容被 `revise()` 改过的情形，由超时兜住——最多 30 秒的旧文本，
   * 而召回结果的正文会按 id 回读最新记录，故**用户看不到旧文本**，只是排序可能滞后一轮。
   */
  readonly indexTtlMs: number
  /** 分页大小。默认 500。全量扫描靠它翻页，**不是召回上限**。 */
  readonly pageSize: number
  /**
   * 扫描条数上限。默认 **0 = 全量**。
   *
   * 这是性能逃生口，不是召回预算：设成正数会让 `scanned` 小于库容，
   * 表现为「库大了以后老记忆想不起来」。除非机器实在跑不动，否则别动它。
   */
  readonly maxScanRows: number
  /**
   * 外部通道（向量 / recognition）的返回上限。默认 200。
   *
   * 这两个分支自带证据，被它们自己挡掉的条目不等于「被召回裁剪」——
   * 它们本来就没给出那条的语义依据。给 200 是为了不让一次向量检索拖垮一轮对话。
   */
  readonly externalLimit: number
  /** 向量分支开关。默认 `auto`（装了就用）。 */
  readonly vectorBranch: 'auto' | 'off'
  /** recognition 分支开关。默认 `auto`（装了就用）。 */
  readonly recognitionBranch: 'auto' | 'off'
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-recall'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归 O-092。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后召回不生效，服务以「不可用」状态注册。',
  },
  fuse: {
    kind: 'enum',
    default: 'rrf',
    options: Object.freeze(['rrf', 'weighted']),
    doc: '融合模式：rrf（名次融合，默认）／weighted（五因子加权和，裁决⑦ 原样）。',
  },
  rrfK: {
    kind: 'number',
    default: 60,
    min: 1,
    max: 1000,
    advancedOnly: true,
    doc: 'RRF 常数 k。手册原值 60。改它等于改「第 1 名比第 10 名重要多少」，属调参。',
  },
  bm25K1: {
    kind: 'number',
    default: 1.2,
    min: 0.1,
    max: 5,
    advancedOnly: true,
    doc: 'BM25 词频饱和参数。手册原值 1.2。',
  },
  bm25B: {
    kind: 'number',
    default: 0.75,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: 'BM25 长度归一项。手册原值 0.75。',
  },
  bm25Half: {
    kind: 'number',
    default: 3,
    min: 0.1,
    max: 100,
    advancedOnly: true,
    doc: 'BM25 分的半分点：分到该值时关键词因子为 0.5。本插件补的标定值，须由评估集校准。',
  },
  rareIdf: {
    kind: 'number',
    default: 9,
    min: 1,
    max: 30,
    advancedOnly: true,
    doc: '罕见词通道的 IDF 门槛。手册原值 9（jieba + 通用 IDF 口径）。',
  },
  rareMinDocs: {
    kind: 'number',
    default: 2000,
    min: 0,
    max: 1000000,
    advancedOnly: true,
    doc: '罕见词通道生效的最小库容。低于它时 idf 上界够不到门槛，通道必然空转，会被标成 absent。',
  },
  graphSeeds: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 20,
    doc: '图谱种子条数：取字面命中前 N 条当 1 跳扩散起点。0 表示关掉图谱因子。',
  },
  graphMinWeight: {
    kind: 'number',
    default: 0.4,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '图谱边权门槛。手册「扩散门槛 0.4」，与 O-015 共用同一个数。',
  },
  includeArchived: {
    kind: 'boolean',
    default: false,
    doc: '是否把已沉底的记忆纳入候选。默认不纳入（沉底的不占主动位，但没被删）。',
  },
  indexTtlMs: {
    kind: 'number',
    default: 30000,
    min: 0,
    max: 3600000,
    advancedOnly: true,
    doc: '索引有效期。内核不提供写事件，只能靠「条数变化 + 超时」判过期。',
  },
  pageSize: {
    kind: 'number',
    default: 500,
    min: 50,
    max: 5000,
    advancedOnly: true,
    doc: '全量扫描的分页大小。不是召回上限，调大只是少翻几页。',
  },
  maxScanRows: {
    kind: 'number',
    default: 0,
    min: 0,
    max: 1000000,
    advancedOnly: true,
    doc: '扫描条数上限，0 = 全量。这是性能逃生口：设正数会让老记忆想不起来，除非跑不动否则别动。',
  },
  externalLimit: {
    kind: 'number',
    default: 200,
    min: 1,
    max: 5000,
    advancedOnly: true,
    doc: '向量 / recognition 分支的返回上限。分支自带的证据范围，不是召回裁剪。',
  },
  vectorBranch: {
    kind: 'enum',
    default: 'auto',
    options: Object.freeze(['auto', 'off']),
    doc: '向量分支：auto（装了 O-122 就用）／off（强制关闭，语义因子退出归一化）。',
  },
  recognitionBranch: {
    kind: 'enum',
    default: 'auto',
    options: Object.freeze(['auto', 'off']),
    doc: 'recognition 分支：auto（装了 O-141 就用）／off（强制关闭）。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  fuse: FIELD_SPECS.fuse.default as Config['fuse'],
  rrfK: FIELD_SPECS.rrfK.default as number,
  bm25K1: FIELD_SPECS.bm25K1.default as number,
  bm25B: FIELD_SPECS.bm25B.default as number,
  bm25Half: FIELD_SPECS.bm25Half.default as number,
  rareIdf: FIELD_SPECS.rareIdf.default as number,
  rareMinDocs: FIELD_SPECS.rareMinDocs.default as number,
  graphSeeds: FIELD_SPECS.graphSeeds.default as number,
  graphMinWeight: FIELD_SPECS.graphMinWeight.default as number,
  includeArchived: FIELD_SPECS.includeArchived.default as boolean,
  indexTtlMs: FIELD_SPECS.indexTtlMs.default as number,
  pageSize: FIELD_SPECS.pageSize.default as number,
  maxScanRows: FIELD_SPECS.maxScanRows.default as number,
  externalLimit: FIELD_SPECS.externalLimit.default as number,
  vectorBranch: FIELD_SPECS.vectorBranch.default as Config['vectorBranch'],
  recognitionBranch: FIELD_SPECS.recognitionBranch.default as Config['recognitionBranch'],
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
  fuse: 'fuse',
  rrfK: 'rrf-k',
  bm25K1: 'bm25-k1',
  bm25B: 'bm25-b',
  bm25Half: 'bm25-half',
  rareIdf: 'rare-idf',
  rareMinDocs: 'rare-min-docs',
  graphSeeds: 'graph-seeds',
  graphMinWeight: 'graph-min-weight',
  includeArchived: 'include-archived',
  indexTtlMs: 'index-ttl-ms',
  pageSize: 'page-size',
  maxScanRows: 'max-scan-rows',
  externalLimit: 'external-limit',
  vectorBranch: 'vector-branch',
  recognitionBranch: 'recognition-branch',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆召回',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-recall',
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

/** 取枚举值，非法则回退。 */
function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bm25B = clampFloat(raw['bm25B'], DEFAULT_CONFIG.bm25B, 0, 1)
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    fuse: enumOf<Config['fuse']>(raw['fuse'], ['rrf', 'weighted'], DEFAULT_CONFIG.fuse),
    rrfK: clampInt(raw['rrfK'], DEFAULT_CONFIG.rrfK, 1, 1000),
    bm25K1: clampFloat(raw['bm25K1'], DEFAULT_CONFIG.bm25K1, 0.1, 5),
    bm25B,
    bm25Half: clampFloat(raw['bm25Half'], DEFAULT_CONFIG.bm25Half, 0.1, 100),
    rareIdf: clampFloat(raw['rareIdf'], DEFAULT_CONFIG.rareIdf, 1, 30),
    rareMinDocs: clampInt(raw['rareMinDocs'], DEFAULT_CONFIG.rareMinDocs, 0, 1000000),
    graphSeeds: clampInt(raw['graphSeeds'], DEFAULT_CONFIG.graphSeeds, 0, 20),
    graphMinWeight: clampFloat(raw['graphMinWeight'], DEFAULT_CONFIG.graphMinWeight, 0, 1),
    includeArchived: raw['includeArchived'] === undefined ? DEFAULT_CONFIG.includeArchived : raw['includeArchived'] === true,
    indexTtlMs: clampInt(raw['indexTtlMs'], DEFAULT_CONFIG.indexTtlMs, 0, 3600000),
    pageSize: clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 50, 5000),
    maxScanRows: clampInt(raw['maxScanRows'], DEFAULT_CONFIG.maxScanRows, 0, 1000000),
    externalLimit: clampInt(raw['externalLimit'], DEFAULT_CONFIG.externalLimit, 1, 5000),
    vectorBranch: enumOf<Config['vectorBranch']>(raw['vectorBranch'], ['auto', 'off'], DEFAULT_CONFIG.vectorBranch),
    recognitionBranch: enumOf<Config['recognitionBranch']>(
      raw['recognitionBranch'],
      ['auto', 'off'],
      DEFAULT_CONFIG.recognitionBranch,
    ),
  })
}
