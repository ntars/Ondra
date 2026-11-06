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
 * ## 为什么配置项只有两个
 *
 * 六态的**判据阈值**（0.7 / 0.55 / 0.45 / 0.35 / 0.5 / 0.3）与
 * **表达系数**（+10% / −15% / ±1）都**不进配置**。它们是手册 §3.2 逐字写下的
 * 产品口径，宣传片 05 章正在引用这六个标签。做成可调，等于承认
 * 「多开心算雀跃」可以随手改——而改完之后，宣传片里那个「雀跃」就不再是同一个东西了。
 *
 * 要改口径就改 `types.ts` 的 `STATE_SPECS` 与 `specs.ts` 的 `RHYTHM_SPECS`，
 * 一处改完即全仓生效，改动会出现在 diff 里，也会被下一个人看见。
 *
 * ## 为什么不需要 camelCase → kebab 映射表
 *
 * 前几轮（O-035 / O-029 / O-030）都写了 `KEY_PAIRS`，那是因为它们的 Config
 * 是 camelCase（`directiveTtlMinutes`），而 §8.4 的配置键正则不认大写。
 * 本插件两个字段叫 `enable` / `verbose`，**本身就是合法的 kebab**，
 * 一对一恒等。这里再写一张恒等映射表，只会让人以为存在两套名字。
 *
 * 这条边界要写清：**不是漏了映射，是确实没有第二套名字**。
 * 将来若新增一个 camelCase 字段（如 `proactivePauseEnabled`），
 * 必须同时补 `KEY_PAIRS` 并把 `normalizeUserLayer` / `valuesToConfigShape` 一起加上，
 * 否则注册配置段会在 O-005 的 `checkFieldSpec` 那里被拒（`bad-field-spec`），
 * 而现象只是「四层合并静默不可用」，日志里只有一行 warn。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册，但一律按「平静」出档（不改任何表达）。 */
  readonly enable: boolean
  /** 判定与取档时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'emotion-express'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但一律按「平静」出档，不改变任何表达参数。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '判定与取档时打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` 直接给出（键已是 kebab）。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '情绪六态表达',
  fields: FIELD_SPECS as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-emotion-express',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 *
 * 布尔字段的写法是 `raw['enable'] === undefined ? 默认 : raw['enable'] === true`，
 * 而不是 `Boolean(raw['enable'])`：后者会把字符串 `'false'` 判成 `true`，
 * 而配置文件里写 `"false"`（带引号）是被 YAML 解析成字符串的常见事故。
 * 这样写等于「只有明确的 true 才算开」，其余一律关——宁可保守。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    verbose: raw['verbose'] === undefined ? DEFAULT_CONFIG.verbose : raw['verbose'] === true,
  })
}

/**
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状。
 *
 * 因为键名恒等，这里只做一次浅过滤：**只认已知键**，
 * 未知键丢弃（它们已由 O-005 报过 `unknown-field`，到这里再留一份没有意义）。
 * @param values 解析结果的 `values`。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(FIELD_SPECS)) {
    if (values[key] !== undefined) out[key] = values[key]
  }
  return out
}
