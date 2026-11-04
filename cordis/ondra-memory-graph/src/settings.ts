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
 * 三个数值是**手册原值，不是本插件拍的**：
 * - `sameTopicInit 0.72`（区间 0.72–0.85 的下沿）／`sameTopicStep 0.05`；
 * - `cooccurInit 0.15`／`cooccurStep 0.10`；
 * - `diffuseMinWeight 0.4`、`hubCap 40`（建链与扩散共用）。
 *
 * 两个是**本插件补的**，都写明理由：
 * - `defaultInit / defaultStep`：手册只给了三个关系名，第四边的名字与初值都没给。
 *   与其编一个假名字配一个假初值，不如给一组中性默认，等裁决下来再改。
 * - `maxEdges`：边表没有天然上限，一张被写坏的库能把内存吃干。到上限**拒绝新建**
 *   而不是悄悄淘汰——「删掉一条边」比「写不进去」更难查。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** `same_topic` 初值。默认 **0.72**（手册区间 0.72–0.85 的下沿）。 */
  readonly sameTopicInit: number
  /** `same_topic` 每次加固增量。默认 **0.05**。 */
  readonly sameTopicStep: number
  /** `cooccur` 初值。默认 **0.15**。 */
  readonly cooccurInit: number
  /** `cooccur` 每次加固增量。默认 **0.10**。 */
  readonly cooccurStep: number
  /** `surreal` 权重。默认 **0.03**，永不加固、永不进检索。 */
  readonly surrealWeight: number
  /** 未知关系的初值。默认 0.5（中性，等裁决）。 */
  readonly defaultInit: number
  /** 未知关系的加固增量。默认 0.05。 */
  readonly defaultStep: number
  /** 扩散门槛。默认 **0.4**（与 O-014 的 `graphMinWeight` 共用）。 */
  readonly diffuseMinWeight: number
  /** 枢纽度上限。默认 **40**（建链与扩散共用）。 */
  readonly hubCap: number
  /** 扩散圈数上限。默认 **1**（台账职责是「1 跳扩散」；手册允许到 3 圈）。 */
  readonly maxRings: number
  /** 边衰减间隔（天）。默认 **90**。 */
  readonly decayDays: number
  /** 边衰减系数。默认 **0.5**。 */
  readonly decayFactor: number
  /** 软剪枝下界。默认 **0.05**。 */
  readonly pruneBelow: number
  /** 软剪枝落点。默认 **0.01**。 */
  readonly pruneTo: number
  /** 边表上限。默认 20000。到上限**拒绝新建**，不淘汰。 */
  readonly maxEdges: number
  /** 是否校验端点存在。默认 `true`：端点不在记忆库里时记 issue，但仍写（表间无外键）。 */
  readonly validateEndpoints: boolean
  /** 分页大小。默认 500（衰减 / 剪枝 / 统计要遍历全表）。 */
  readonly pageSize: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-graph'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后建边与查询都不生效，服务以「不可用」状态注册。',
  },
  sameTopicInit: {
    kind: 'number',
    default: 0.72,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '同主题边的初值。手册区间 0.72–0.85，本插件取下沿；极像的两条可显式给 0.85。',
  },
  sameTopicStep: {
    kind: 'number',
    default: 0.05,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '同主题边每次加固的增量。手册原值 0.05。',
  },
  cooccurInit: {
    kind: 'number',
    default: 0.15,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '共现边初值。手册原值 0.15。要加固 3 次（0.45）才越过扩散门槛 0.4。',
  },
  cooccurStep: {
    kind: 'number',
    default: 0.1,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '共现边每次加固的增量。手册原值 0.10。',
  },
  surrealWeight: {
    kind: 'number',
    default: 0.03,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '荒诞联想边权重。手册原值 0.03；永不加固、永不进检索、剪枝豁免。',
  },
  defaultInit: {
    kind: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '未知关系的初值。手册只给了三个关系名，第四个尚未裁决，故给中性默认而不是编一个名字。',
  },
  defaultStep: {
    kind: 'number',
    default: 0.05,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '未知关系的加固增量。',
  },
  diffuseMinWeight: {
    kind: 'number',
    default: 0.4,
    min: 0,
    max: 1,
    doc: '扩散门槛。手册原值 0.4，与 O-014 的图谱因子门槛共用同一个数。',
  },
  hubCap: {
    kind: 'number',
    default: 40,
    min: 2,
    max: 1000,
    doc: '枢纽度上限。建链与扩散共用同一个常量（手册原话）。',
  },
  maxRings: {
    kind: 'number',
    default: 1,
    min: 1,
    max: 3,
    advancedOnly: true,
    doc: '扩散圈数上限。台账职责是 1 跳；手册允许到 3 圈（圈权重 [1, 0.55, 0.3, 0.16]）。',
  },
  decayDays: {
    kind: 'number',
    default: 90,
    min: 1,
    max: 3650,
    advancedOnly: true,
    doc: '边衰减间隔（天）。手册「90 天未激活 ×0.5」。',
  },
  decayFactor: {
    kind: 'number',
    default: 0.5,
    min: 0.01,
    max: 0.99,
    advancedOnly: true,
    doc: '边衰减系数。手册原值 0.5。',
  },
  pruneBelow: {
    kind: 'number',
    default: 0.05,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '软剪枝下界。手册「权重 <0.05 压到 0.01」。',
  },
  pruneTo: {
    kind: 'number',
    default: 0.01,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '软剪枝落点。手册原值 0.01。不删行——软删才有得查。',
  },
  maxEdges: {
    kind: 'number',
    default: 20000,
    min: 100,
    max: 1000000,
    advancedOnly: true,
    doc: '边表上限。到上限拒绝新建（不淘汰）：删一条边比写不进去更难查。',
  },
  validateEndpoints: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '端点不在记忆库时记 issue 但仍写（表间无外键，硬拒会让「先建边后写记忆」的调用方全挂）。',
  },
  pageSize: {
    kind: 'number',
    default: 500,
    min: 50,
    max: 5000,
    advancedOnly: true,
    doc: '遍历全表时的分页大小（衰减 / 剪枝 / 统计）。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  sameTopicInit: FIELD_SPECS.sameTopicInit.default as number,
  sameTopicStep: FIELD_SPECS.sameTopicStep.default as number,
  cooccurInit: FIELD_SPECS.cooccurInit.default as number,
  cooccurStep: FIELD_SPECS.cooccurStep.default as number,
  surrealWeight: FIELD_SPECS.surrealWeight.default as number,
  defaultInit: FIELD_SPECS.defaultInit.default as number,
  defaultStep: FIELD_SPECS.defaultStep.default as number,
  diffuseMinWeight: FIELD_SPECS.diffuseMinWeight.default as number,
  hubCap: FIELD_SPECS.hubCap.default as number,
  maxRings: FIELD_SPECS.maxRings.default as number,
  decayDays: FIELD_SPECS.decayDays.default as number,
  decayFactor: FIELD_SPECS.decayFactor.default as number,
  pruneBelow: FIELD_SPECS.pruneBelow.default as number,
  pruneTo: FIELD_SPECS.pruneTo.default as number,
  maxEdges: FIELD_SPECS.maxEdges.default as number,
  validateEndpoints: FIELD_SPECS.validateEndpoints.default as boolean,
  pageSize: FIELD_SPECS.pageSize.default as number,
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
  sameTopicInit: 'same-topic-init',
  sameTopicStep: 'same-topic-step',
  cooccurInit: 'cooccur-init',
  cooccurStep: 'cooccur-step',
  surrealWeight: 'surreal-weight',
  defaultInit: 'default-init',
  defaultStep: 'default-step',
  diffuseMinWeight: 'diffuse-min-weight',
  hubCap: 'hub-cap',
  maxRings: 'max-rings',
  decayDays: 'decay-days',
  decayFactor: 'decay-factor',
  pruneBelow: 'prune-below',
  pruneTo: 'prune-to',
  maxEdges: 'max-edges',
  validateEndpoints: 'validate-endpoints',
  pageSize: 'page-size',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆图谱',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-graph',
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
  const pruneTo = clampFloat(raw['pruneTo'], DEFAULT_CONFIG.pruneTo, 0, 1)
  // 剪枝落点必须低于下界，否则「剪枝」会把权重剪上去。保序而不报错——配置错不该让插件不加载。
  const pruneBelow = Math.max(pruneTo, clampFloat(raw['pruneBelow'], DEFAULT_CONFIG.pruneBelow, 0, 1))
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    sameTopicInit: clampFloat(raw['sameTopicInit'], DEFAULT_CONFIG.sameTopicInit, 0, 1),
    sameTopicStep: clampFloat(raw['sameTopicStep'], DEFAULT_CONFIG.sameTopicStep, 0, 1),
    cooccurInit: clampFloat(raw['cooccurInit'], DEFAULT_CONFIG.cooccurInit, 0, 1),
    cooccurStep: clampFloat(raw['cooccurStep'], DEFAULT_CONFIG.cooccurStep, 0, 1),
    surrealWeight: clampFloat(raw['surrealWeight'], DEFAULT_CONFIG.surrealWeight, 0, 1),
    defaultInit: clampFloat(raw['defaultInit'], DEFAULT_CONFIG.defaultInit, 0, 1),
    defaultStep: clampFloat(raw['defaultStep'], DEFAULT_CONFIG.defaultStep, 0, 1),
    diffuseMinWeight: clampFloat(raw['diffuseMinWeight'], DEFAULT_CONFIG.diffuseMinWeight, 0, 1),
    hubCap: clampInt(raw['hubCap'], DEFAULT_CONFIG.hubCap, 2, 1000),
    maxRings: clampInt(raw['maxRings'], DEFAULT_CONFIG.maxRings, 1, 3),
    decayDays: clampInt(raw['decayDays'], DEFAULT_CONFIG.decayDays, 1, 3650),
    decayFactor: clampFloat(raw['decayFactor'], DEFAULT_CONFIG.decayFactor, 0.01, 0.99),
    pruneBelow,
    pruneTo,
    maxEdges: clampInt(raw['maxEdges'], DEFAULT_CONFIG.maxEdges, 100, 1000000),
    validateEndpoints:
      raw['validateEndpoints'] === undefined ? DEFAULT_CONFIG.validateEndpoints : raw['validateEndpoints'] === true,
    pageSize: clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 50, 5000),
  })
}
