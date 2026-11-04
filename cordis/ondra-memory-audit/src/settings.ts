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
 * - `pinCap 8`：手册 §2.6 八块装配 ②「【不能忘的】钉住（≤8）」。
 * - `resurfaceDays 30`：手册 §2.4「30 天未带出强行补 1 条」。
 *
 * **本插件补的**（手册没给，写明理由）：
 * - `fadingDays 7`：「快淡了」的窗口。手册给了三档**强度**（0.7 / 0.4），
 *   没给「还剩几天算快淡了」。取 7 天是「一周内会掉到地板」的量化，可调。
 *   刻意不用强度做这个阈值——强度阈值已经归 O-013 的话术，再用一次就是双阈值。
 * - `scanLimit 3000`：单次审计扫描的条数上限。端口没有聚合面，只能分页扫；
 *   撞上限时报告里 `complete=false`，**不静默半扫**。
 * - `pageSize 500`：分页大小。
 * - `pinNoteMaxChars 120`：钉子备注的长度上限（超长截断并记 issue）。
 * - `previewChars 40`：清单里正文预览的截断长度（**只用于展示，不回写**）。
 * - `autoScan false`：是否装定时器自动审计。审计本身是只读的，但 `archive()`
 *   是写操作，两者都不该交给一个「不知道第几个装载」的定时器。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 钉子上限。默认 **8**（手册 §2.6 注入块 ②）。 */
  readonly pinCap: number
  /** 「快淡了」的剩余天数窗口。默认 **7**（本插件补，见文件头）。 */
  readonly fadingDays: number
  /** 「最低曝光」的天数。默认 **30**（手册 §2.4）。 */
  readonly resurfaceDays: number
  /** 单次审计扫描的条数上限。默认 3000。 */
  readonly scanLimit: number
  /** 分页大小。默认 500。 */
  readonly pageSize: number
  /** 钉子备注长度上限。默认 120。 */
  readonly pinNoteMaxChars: number
  /** 清单里正文预览的截断长度。默认 40。 */
  readonly previewChars: number
  /** 是否装定时器自动审计。默认 **false**。 */
  readonly autoScan: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-audit'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后解释与删除都不生效，服务以「不可用」状态注册。',
  },
  pinCap: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 64,
    doc: '钉子上限（手册 §2.6「钉住（≤8）」）。到上限拒绝新建并报出来，不淘汰旧的——拔掉哪条钉子等于替用户决定哪件事可以忘。',
  },
  fadingDays: {
    kind: 'number',
    default: 7,
    min: 1,
    max: 365,
    advancedOnly: true,
    doc: '「快淡了」的剩余天数窗口。手册未给，取 7 天。刻意不用强度阈值——强度阈值已归 O-013 的话术，再用一次就是双阈值。',
  },
  resurfaceDays: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 3650,
    doc: '「最低曝光」天数（手册 §2.4「30 天未带出强行补 1 条」）。本插件只出候选清单，决定注入谁归 O-036。',
  },
  scanLimit: {
    kind: 'number',
    default: 3000,
    min: 100,
    max: 200000,
    advancedOnly: true,
    doc: '单次审计扫描的条数上限。撞上限时报告 complete=false，不静默半扫。',
  },
  pageSize: {
    kind: 'number',
    default: 500,
    min: 50,
    max: 5000,
    advancedOnly: true,
    doc: '分页大小。端口没有聚合面，扫描只能分页。',
  },
  pinNoteMaxChars: {
    kind: 'number',
    default: 120,
    min: 0,
    max: 1000,
    advancedOnly: true,
    doc: '钉子备注长度上限。超长截断并记 issue。',
  },
  previewChars: {
    kind: 'number',
    default: 40,
    min: 10,
    max: 200,
    advancedOnly: true,
    doc: '清单里正文预览的截断长度。**只用于展示，不回写**。',
  },
  autoScan: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '是否装定时器自动审计。默认 false：archive() 是写操作，时机该由回合边界或夜巡显式给。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  pinCap: FIELD_SPECS.pinCap.default as number,
  fadingDays: FIELD_SPECS.fadingDays.default as number,
  resurfaceDays: FIELD_SPECS.resurfaceDays.default as number,
  scanLimit: FIELD_SPECS.scanLimit.default as number,
  pageSize: FIELD_SPECS.pageSize.default as number,
  pinNoteMaxChars: FIELD_SPECS.pinNoteMaxChars.default as number,
  previewChars: FIELD_SPECS.previewChars.default as number,
  autoScan: FIELD_SPECS.autoScan.default as boolean,
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
  pinCap: 'pin-cap',
  fadingDays: 'fading-days',
  resurfaceDays: 'resurface-days',
  scanLimit: 'scan-limit',
  pageSize: 'page-size',
  pinNoteMaxChars: 'pin-note-max-chars',
  previewChars: 'preview-chars',
  autoScan: 'auto-scan',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '遗忘审计',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-audit',
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
  const pageSize = clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 50, 5000)
  // 扫描上限不得小于一页，否则「扫一次」连一页都读不完，报告永远 complete=false。
  const scanLimit = Math.max(pageSize, clampInt(raw['scanLimit'], DEFAULT_CONFIG.scanLimit, 100, 200000))
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    pinCap: clampInt(raw['pinCap'], DEFAULT_CONFIG.pinCap, 1, 64),
    fadingDays: clampInt(raw['fadingDays'], DEFAULT_CONFIG.fadingDays, 1, 365),
    resurfaceDays: clampInt(raw['resurfaceDays'], DEFAULT_CONFIG.resurfaceDays, 1, 3650),
    scanLimit,
    pageSize,
    pinNoteMaxChars: clampInt(raw['pinNoteMaxChars'], DEFAULT_CONFIG.pinNoteMaxChars, 0, 1000),
    previewChars: clampInt(raw['previewChars'], DEFAULT_CONFIG.previewChars, 10, 200),
    autoScan: raw['autoScan'] === undefined ? DEFAULT_CONFIG.autoScan : raw['autoScan'] === true,
  })
}
