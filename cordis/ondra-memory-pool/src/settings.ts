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
 * - `coreCap 32`：手册 §2.5「核心池上限 32（CORE_MAX）」。
 * - `escalateAfter 3`：手册 §2.5「同一句重复写满 3 次 → 升级『需人工定池』」。
 *
 * **本插件补的**（手册没给，写明理由）：
 * - `hintCap 2000`：未归类线索表的行数上限。手册只说「夜巡单列」，没说列多少。
 *   取 2000 的理由：一天漏归类的碎片正常不超过几十条，2000 够撑一个月夜巡周期；
 *   到上限**拒绝新建并告警**，不淘汰旧的——淘汰会让「写满 3 次」永远凑不够。
 * - `previewChars 40`：线索预览的截断长度（**只用于展示，不回写**）。与 O-017 的
 *   清单预览同口径，界面不用为两个插件写两种截断。
 * - `allowLegacySkill false`：是否允许**自动**把新记忆分到 legacy 的 `skill` 池。
 *   默认 false：那一行是「代码保留」，自动分进去等于让一条记忆按一份
 *   连手册自己都说「README 写 60、代码写 90」的口径算寿命。
 * - `dueScanLimit 5000`：`dueForArchive()` 单次扫描的条数上限。端口没有聚合面，
 *   只能分页扫；撞上限时报告里的 `complete` 语义由调用方按 `dueScanLimit` 判断，
 *   **不静默半扫**。
 * - `pageSize 500`：分页大小。
 *
 * **刻意没有的配置项**：
 * - **没有「海马体是否注入」的开关。** 手册「永不注入」是硬性质，做成布尔
 *   就一定会有人打开它，然后未归类的原始片段开始挤占注入预算。
 * - **没有「各池宽限/半衰期/归档」的数值配置。** 那三列是**规范值**不是**偏好值**，
 *   做成可调等于把「用户立的规矩能留 730 天」变成一道产品参数题；
 *   真需要改就改 `pools.ts` 一处并留痕。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 核心池上限。默认 **32**（手册 §2.5 CORE_MAX）。 */
  readonly coreCap: number
  /** 「未归类」升级为「需人工定池」的重现次数。默认 **3**（手册 §2.5）。 */
  readonly escalateAfter: number
  /** 未归类线索表的行数上限。默认 2000（本插件补）。 */
  readonly hintCap: number
  /** 线索预览截断长度。默认 40（本插件补）。 */
  readonly previewChars: number
  /** 是否允许自动分到 legacy 的 `skill` 池。默认 **false**（本插件补）。 */
  readonly allowLegacySkill: boolean
  /** 归档候选单次扫描条数上限。默认 5000（本插件补）。 */
  readonly dueScanLimit: number
  /** 分页大小。默认 500（本插件补）。 */
  readonly pageSize: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-pool'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后池分类与时间轴都不生效，服务以「不可用」状态注册。',
  },
  coreCap: {
    kind: 'number',
    default: 32,
    min: 1,
    max: 512,
    doc: '核心池上限（手册 §2.5 CORE_MAX = 32）。满了直接拒绝、不淘汰——删一条核心等于替用户决定「你不该是自己」。',
  },
  escalateAfter: {
    kind: 'number',
    default: 3,
    min: 2,
    max: 20,
    advancedOnly: true,
    doc: '未归类线索重复写满几次就升级「需人工定池」（手册 §2.5 原话是 3 次）。',
  },
  hintCap: {
    kind: 'number',
    default: 2000,
    min: 10,
    max: 100000,
    advancedOnly: true,
    doc: '未归类线索表行数上限。到上限拒绝新建并告警，不淘汰——淘汰会让「写满 3 次」永远凑不够。',
  },
  previewChars: {
    kind: 'number',
    default: 40,
    min: 10,
    max: 200,
    advancedOnly: true,
    doc: '线索预览截断长度。只用于展示，不回写。',
  },
  allowLegacySkill: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '是否允许自动把新记忆分到 legacy 的 skill 池。默认 false：那一行口径本身存疑（README 60 / 代码 90）。',
  },
  dueScanLimit: {
    kind: 'number',
    default: 5000,
    min: 100,
    max: 200000,
    advancedOnly: true,
    doc: '归档候选单次扫描条数上限。端口没有聚合面，只能分页扫。',
  },
  pageSize: {
    kind: 'number',
    default: 500,
    min: 50,
    max: 5000,
    advancedOnly: true,
    doc: '分页大小。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  coreCap: FIELD_SPECS.coreCap.default as number,
  escalateAfter: FIELD_SPECS.escalateAfter.default as number,
  hintCap: FIELD_SPECS.hintCap.default as number,
  previewChars: FIELD_SPECS.previewChars.default as number,
  allowLegacySkill: FIELD_SPECS.allowLegacySkill.default as boolean,
  dueScanLimit: FIELD_SPECS.dueScanLimit.default as number,
  pageSize: FIELD_SPECS.pageSize.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），而 Cordis 插件实例
 * 配置历来是 camelCase。O-035 踩过这个坑：直接把 `FIELD_SPECS` 当段声明交出去，
 * 注册期会抛 `bad-field-spec`，现象是「配置段静默不可用、四层合并与来源追溯全失效」。
 * 映射必须**双向唯一**，否则两个字段会抢同一个段字段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  coreCap: 'core-cap',
  escalateAfter: 'escalate-after',
  hintCap: 'hint-cap',
  previewChars: 'preview-chars',
  allowLegacySkill: 'allow-legacy-skill',
  dueScanLimit: 'due-scan-limit',
  pageSize: 'page-size',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆八池',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-pool',
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
  const pageSize = clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 50, 5000)
  // 扫描上限不得小于一页，否则「扫一次」连一页都读不完，报告永远不完整。
  const dueScanLimit = Math.max(pageSize, clampInt(raw['dueScanLimit'], DEFAULT_CONFIG.dueScanLimit, 100, 200000))
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    coreCap: clampInt(raw['coreCap'], DEFAULT_CONFIG.coreCap, 1, 512),
    escalateAfter: clampInt(raw['escalateAfter'], DEFAULT_CONFIG.escalateAfter, 2, 20),
    hintCap: clampInt(raw['hintCap'], DEFAULT_CONFIG.hintCap, 10, 100000),
    previewChars: clampInt(raw['previewChars'], DEFAULT_CONFIG.previewChars, 10, 200),
    allowLegacySkill:
      raw['allowLegacySkill'] === undefined ? DEFAULT_CONFIG.allowLegacySkill : raw['allowLegacySkill'] === true,
    dueScanLimit,
    pageSize,
  })
}
