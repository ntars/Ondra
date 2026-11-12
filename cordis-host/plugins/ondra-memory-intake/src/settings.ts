/**
 * `ondra-memory-intake` 的配置：声明 + 补全。
 *
 * 字段只在这一处写默认值（`FIELD_SPECS` 的 `default`），`cordis.patch.yml`
 * 与 `Config` 都不重复写——三处各写一份默认值，改一处就会漂。
 */

import type { IntakeConfig } from './types.js'
import { CONFIG_SECTION_ID, DEFAULT_CONFIG } from './types.js'

export { CONFIG_SECTION_ID }

/** 一个字段在设置页上的样子。 */
interface FieldSpec {
  readonly kind: 'boolean' | 'number'
  readonly label: string
  readonly doc: string
  readonly default: boolean | number
  readonly min?: number
  readonly max?: number
}

/**
 * O-005 的字段声明形状（结构对位，不 import 它的源码）。
 *
 * 只镜像本插件真正用到的键：`label` 是设置页标题、O-005 不认，
 * 所以这里不收——收了会让「两份字段表长得一样」变成一种维持负担。
 */
interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/**
 * O-005 配置真源的结构对位（只用到注册与解析）。
 *
 * `resolve` 返回 `undefined` 表示「段没登记」，调用方必须退回本地校验，
 * 不能当成「取到了一份空配置」——那会把用户设置静默清空。
 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layers?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 段内字段（单一真源）。 */
export const FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  enable: {
    kind: 'boolean',
    label: '收对话进记忆',
    doc: '关掉后服务照常注册，但一轮都不收（右栏会一直显示「暂无记忆」）。',
    default: DEFAULT_CONFIG.enable,
  },
  extract: {
    kind: 'boolean',
    label: '自动抽事实',
    doc: '关掉只写原文：她记得「有过这段对话」，但说不出「你叫什么」。',
    default: DEFAULT_CONFIG.extract,
  },
  maxConcurrent: {
    kind: 'number',
    label: '同时提炼数',
    doc: '每轮提炼要调一次模型。调高会更跟手，也更费。',
    default: DEFAULT_CONFIG.maxConcurrent,
    min: 1,
    max: 4,
  },
  maxFacts: {
    kind: 'number',
    label: '每轮最多几条',
    doc:
      '0（出厂值）= 交给提炼服务自己定，它按证据强度收，当前默认 8 条；'
      + '1–30 = 本侧硬上限，超过的候选记 over-limit 拒绝，不静默丢。',
    default: DEFAULT_CONFIG.maxFacts,
    min: 0,
    max: 30,
  },
  verbose: {
    kind: 'boolean',
    label: '记日志',
    doc: '收下与失败都打一行，排查「为什么她记不住」时用得到。',
    default: DEFAULT_CONFIG.verbose,
  },
}

/**
 * 段内字段键（camel）→ 配置文件键（kebab）。
 *
 * `maxConcurrent` → `max-concurrent` 这类映射**不能靠字符串替换**推断：
 * 本仓有过「`bm25K1` → `bm25-k1` 恰好对、换个名字就错」的先例。
 * 所以映射写成表，`SECTION_KEYS` 与 `CONFIG_SECTION` 都从这一张表派生。
 */
export const KEY_PAIRS: Readonly<Record<keyof IntakeConfig, string>> = Object.freeze({
  enable: 'enable',
  extract: 'extract',
  maxConcurrent: 'max-concurrent',
  maxFacts: 'max-facts',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof IntakeConfig>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof IntakeConfig])),
)

/**
 * 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。
 *
 * ## 为什么本插件必须有这一份
 *
 * 宿主扫描设置段时只认**导出了 `CONFIG_SECTION`** 的包；只有 `FIELD_SPECS`
 * 的包会被标成 `registered=false`，设置页在它上面直接写一行
 * 「未注册配置段，不参与四层合并」（`ModuleLayer.tsx`）。
 * 本仓 64 个有 `settings.ts` 的包里，此前**只有本插件是那样**——
 * 也就是说别处都对，唯独记忆的入口没有接进四层合并。
 * 补上之后「插件声明的段」与「设置页看见的段」才是同一件事。
 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆入库',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof IntakeConfig)[]).map((camel) => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-intake',
})

/** 判断一个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**：交给 O-005 报 `unknown-field`，在这里悄悄吞掉，
 * 用户就只会看到「我填了怎么没生效」。
 * @param raw 原始配置对象。
 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_PAIRS[key as keyof IntakeConfig] ?? key] = value
  }
  return out
}

/**
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状（camel 键）。
 *
 * **少这一步就是把整份配置打回默认值**：`completeConfig` 只读 camel 键，
 * 喂它 kebab 键不会有任何报错，只会安静地全部落空。
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

/**
 * `Config` 必须是标准 schema 形状（`~standard.validate`），不是「字段表」。
 *
 * 三处各写一份默认值是漂移之源：`FIELD_SPECS` 只负责「设置页长什么样」，
 * 真正的默认值住在 `DEFAULT_CONFIG`，校验入口把任意输入补成完整形态。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) =>
      | { readonly value: IntakeConfig }
      | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：越界值夹紧、类型错回退默认——都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}

/**
 * 把任意来源的配置补成完整形态。任何非法值回退默认，**绝不抛**。
 * @param raw 配置行内容。
 * @returns 补全后的配置。
 */
export function completeConfig(raw: unknown): Required<IntakeConfig> {
  const source = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (key: keyof IntakeConfig, fallback: boolean): boolean =>
    typeof source[key] === 'boolean' ? source[key] as boolean : fallback
  const num = (key: keyof IntakeConfig, fallback: number, min: number, max: number): number => {
    const value = source[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(value)))
  }
  return {
    enable: bool('enable', DEFAULT_CONFIG.enable),
    extract: bool('extract', DEFAULT_CONFIG.extract),
    maxConcurrent: num('maxConcurrent', DEFAULT_CONFIG.maxConcurrent, 1, 4),
    maxFacts: num('maxFacts', DEFAULT_CONFIG.maxFacts, 0, 30),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  }
}
