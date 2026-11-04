/**
 * O-098 `ondra-persona-workshop` 的配置**单一真源**。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 刻意没有的配置项（两条）
 *
 * 1. **没有「阈值」类配置**（SKILL.md 字数区间、触发词上限、档案字段下限）。
 *    它们写在 `src/types.ts` 并带依据注释。做成配置等于开放调参旋钮：
 *    把字数下限拉到 200 之后，所有薄包都会变「合格」，而体检就没意义了。
 * 2. **没有「是否允许写回人设包」的开关。**
 *    手册与 master-plan §17-7 都定死了只读。做成布尔就一定有人打开它，
 *    然后产品资产被用户机器上的某次操作改掉——而且是静默的。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。默认 true：只读体检，开着没有副作用。 */
  readonly enable: boolean
  /**
   * 对比表最多看几个包。默认 32。
   *
   * 上限 64（`MAX_AUDIT`）：每个包都要解一次元数据，200 个包会卡住一次 UI 渲染。
   */
  readonly maxPersonas: number
  /** 降级与跳过时打一行日志。默认 true，只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'persona-workshop'

/** 单次对比的包数下限。至少得看一个，否则这个功能没意义。 */
export const MAX_PERSONAS_MIN = 1

/** 单次对比的包数上限（与 `types.ts` 的 `MAX_AUDIT` 同一个数，防两处漂开）。 */
export const MAX_PERSONAS_MAX = 64

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。工坊是只读体检，关掉后不再接受体检与草案请求。',
  },
  maxPersonas: {
    kind: 'number',
    default: 32,
    min: MAX_PERSONAS_MIN,
    max: MAX_PERSONAS_MAX,
    doc: '对比表最多看几个包。上限 64，太多会卡住一次渲染。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '上游缺席、单项跳过时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxPersonas: FIELD_SPECS.maxPersonas.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/** Config 键（camelCase）→ 段字段键（kebab）的唯一映射。必须双向唯一。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxPersonas: 'max-personas',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '人格包工坊',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-persona-workshop',
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
    maxPersonas: clampInt(raw['maxPersonas'], DEFAULT_CONFIG.maxPersonas, MAX_PERSONAS_MIN, MAX_PERSONAS_MAX),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
