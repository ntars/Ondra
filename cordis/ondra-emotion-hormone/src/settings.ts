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
 * ## 为什么默认是关闭的
 *
 * 台账第 16 组把 `ondra-emotion-hormone` 的「默认分支」写成「否（关闭）」。
 * 这不是保守，是**口径纪律**：激素是「核心三维之外的可选增强」（手册 §14.3），
 * 它一旦默认开启，六态、应激倍率、投影三处都会多出一层解释，
 * 而用户从没要求过。默认关掉，想用的人一句话打开，是最干净的边界。
 *
 * ## 为什么要有 camelCase ↔ kebab 映射表
 *
 * §8.4 的配置键正则 `^[a-z][a-z0-9_-]{1,63}$` **不认大写**。
 * 本插件的 `autoSeed` / `includeSerotonin` 是 camelCase（与 Cordis 插件实例配置、
 * `cordis.yml` 的写法一致），直接当 `SectionDecl.fields` 交给 O-005，
 * 会在它的 `checkFieldSpec` 里被拒（`bad-field-spec`），
 * 而现象只是「配置段注册失败、四层合并与追溯静默不可用」，日志里只有一行 warn。
 *
 * 故建一张**双向唯一**映射表，段声明 / 用户层归一化 / 结果回填三处全部由它派生，
 * 不手写第二份（O-035 起的既有模式，见长期纪律 15）。
 * 用户写 camel 或 kebab 都认。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。默认关闭。关掉后服务仍注册，读数一律给出厂基线、叠加一律平稳。 */
  readonly enable: boolean
  /**
   * 是否在装载时自动补造缺失的主维度（默认只补 oxytocin）。
   *
   * 关掉它也不会让 `read()` 少一维：缺失维度按基线代入并标 `missing`，
   * 只是面板上那一维显示「还没建」。默认开着是因为
   * 「装了激素插件却永远少一维」比「多造一个停在 50 的维度」更让人困惑。
   */
  readonly autoSeed: boolean
  /** 是否把血清素作为参考维度一起读出（不影响叠加权重）。 */
  readonly includeSerotonin: boolean
  /** 读数与叠加时是否打日志。只影响日志噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'emotion-hormone'

/**
 * camelCase（Config 字段）↔ kebab（配置键）**双向唯一**映射。
 *
 * 新增字段时必须同时加在这里，否则 `completeConfig` 收不到值、`register` 会拒整段。
 * 自检会核「三个集合相等」：`Config` 字段集合 = `FIELD_SPECS` 键集合 = 本表键集合。
 */
export const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  autoSeed: 'auto-seed',
  includeSerotonin: 'include-serotonin',
  verbose: 'verbose',
})

/** 反向表（kebab → camel）。由 `KEY_PAIRS` 派生，不手写。 */
export const KEY_PAIRS_REVERSE: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 字段声明表 —— **本插件全部默认值的唯一存放处**（键用 kebab）。 */
export const FIELD_SPECS: Readonly<Record<string, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '总开关。默认关闭；关掉后服务照常注册，读数给出厂基线、叠加一律平稳。',
  },
  'auto-seed': {
    kind: 'boolean',
    default: true,
    doc: '装载时自动用 O-026 的动态激素通道补造缺失的主维度（默认只补 oxytocin）。',
  },
  'include-serotonin': {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否把血清素作为参考维度读出。只影响展示，不影响叠加权重。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '读数与叠加时打一行日志。只影响日志噪声。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS['enable'].default as boolean,
  autoSeed: FIELD_SPECS['auto-seed'].default as boolean,
  includeSerotonin: FIELD_SPECS['include-serotonin'].default as boolean,
  verbose: FIELD_SPECS['verbose'].default as boolean,
})

/** 交给 O-005 的段声明。字段表用 kebab 键（`FIELD_SPECS` 已经是）。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '情绪激素维度',
  fields: FIELD_SPECS,
  owner: 'ondra-emotion-hormone',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 取一个布尔配置。
 *
 * 写法刻意是「只有明确的 true 才算开」：`Boolean('false')` 是 `true`，
 * 而 YAML 里写 `"false"`（带引号）被解析成字符串是常见事故。
 * @param raw 原始值。
 * @param fallback 默认值。
 */
function boolOf(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  return raw === true
}

/**
 * 把用户层的键归一化成 camelCase。
 *
 * 用户可能写 camel（`autoSeed`）也可能写 kebab（`auto-seed`），两种都认；
 * 未知键原样保留（交给 O-005 报 `unknown-field`，这里不吞掉）。
 * @param value 原始用户层。
 */
export function normalizeUserLayer(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const camel = KEY_PAIRS_REVERSE[key]
    out[camel ?? key] = item
  }
  return out
}

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置（camel 或 kebab 键都可）。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? normalizeUserLayer(value) : {}
  return Object.freeze({
    enable: boolOf(raw['enable'], DEFAULT_CONFIG.enable),
    autoSeed: boolOf(raw['autoSeed'], DEFAULT_CONFIG.autoSeed),
    includeSerotonin: boolOf(raw['includeSerotonin'], DEFAULT_CONFIG.includeSerotonin),
    verbose: boolOf(raw['verbose'], DEFAULT_CONFIG.verbose),
  })
}

/**
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状。
 *
 * **只认已知键**：未知键已被 O-005 报过，这里再留一份没有意义。
 * @param values 解析结果的 `values`。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [camel, kebab] of Object.entries(KEY_PAIRS)) {
    if (values[kebab] !== undefined) out[camel] = values[kebab]
    // 用户层可能已经写成 camel，一并接住（O-005 不会改键名）。
    else if (values[camel] !== undefined) out[camel] = values[camel]
  }
  return out
}
