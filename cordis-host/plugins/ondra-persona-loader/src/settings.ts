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
 * 数值来源分三类，逐条写明：
 *
 * **手册原值**：
 * - `factoryPersona 'oh-jingjing'`：手册 §1.1「出厂人格（定案）：初始人设为**鲸鲸**」，
 *   id 取自 `哦鲸鲸.skill.zip` 的 `meta.slug`。
 * - `samplePersona 'xia-ningqi'`：手册 §1.1「夏柠柒为示例人格包」，
 *   id 取自 `夏柠柒.skill.zip` 的 `meta.slug`。
 *
 * **本插件补的**（手册没给，写明理由）：
 * - `maxArchiveBytes 32MB`：单个人设包上限。实包 190KB / 188KB（已解包核对），
 *   32MB 是「有人把整套语料连图片一起打进去」的量级；到上限**拒收并报 `too-large`**，
 *   不截断——截断的包解出来是半个 ZIP，症状会比「拒绝」难查十倍。
 * - `maxEntryBytes 4MB`：单个文本文件上限。`SKILL.md` 最大 27KB，references 最大 35KB，
 *   4MB 是「有人把整本小说塞进 references」的量级。
 * - `maxTextCacheBytes 8MB`：文本缓存预算（见 `service.ts` 的 `readText`）。
 *   缓存是为了不违反 §8.2 反模式②（每次组装提示词都做 IO）：`SKILL.md` 只解一次。
 * - `maxPersonas 64`：一次扫描注册的人设上限。到上限报 `over-cap` 并**停下**，
 *   不淘汰已注册的（淘汰会让「导入的新人设把旧的挤掉」且界面上看不出来）。
 * - `keepIssues 50`：保留的问题条数。
 * - `userSubdir 'personas'`：用户根在数据根 `user/` 下的子目录名。
 *
 * **刻意没有的配置项**：
 * - **没有「是否允许写回人设包」的开关。** 手册与 master-plan §17-7 都定死了只读，
 *   做成布尔就一定会有人打开它，然后产品资产被用户机器上的某次界面操作改掉。
 * - **没有「人设正文」的配置项。** 正文只存在包里，配置层只放 id 与路径。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { FACTORY_PERSONA_ID, PERSONA_ID_PATTERN, SAMPLE_PERSONA_ID } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 随包根路径。空串 = 自动探测插件包同级的 `ondra-persona-skills`。 */
  readonly bundledDir: string
  /** 用户根在数据根 `user/` 下的子目录名。 */
  readonly userSubdir: string
  /** 出厂人设 id。默认 `oh-jingjing`（手册 §1.1）。 */
  readonly factoryPersona: string
  /** 示例人设 id。默认 `xia-ningqi`（手册 §1.1）。 */
  readonly samplePersona: string
  /** 初始激活的人设 id。默认 `oh-jingjing`。 */
  readonly activePersona: string
  /** 单个包上限（字节）。默认 32MB。 */
  readonly maxArchiveBytes: number
  /** 单个文件上限（字节）。默认 4MB。 */
  readonly maxEntryBytes: number
  /** 文本缓存预算（字节）。默认 8MB。 */
  readonly maxTextCacheBytes: number
  /** 一次扫描的人设上限。默认 64。 */
  readonly maxPersonas: number
  /** 保留的问题条数。默认 50。 */
  readonly keepIssues: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'persona-loader'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不再扫描人设包，服务以「不可用」状态注册。',
  },
  bundledDir: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '随包根路径。留空表示自动探测插件包同级的 `ondra-persona-skills`。',
  },
  userSubdir: {
    kind: 'string',
    default: 'personas',
    advancedOnly: true,
    doc: '用户根在数据根 `user/` 下的子目录名。用户把人设包放这里就能被扫到。',
  },
  factoryPersona: {
    kind: 'string',
    default: FACTORY_PERSONA_ID,
    advancedOnly: true,
    doc: '出厂人设 id（手册 §1.1 定案：鲸鲸）。只用于打「出厂」标记，不改任何正文。',
  },
  samplePersona: {
    kind: 'string',
    default: SAMPLE_PERSONA_ID,
    advancedOnly: true,
    doc: '示例人设 id（手册 §1.1：夏柠柒，示例人格·可随时替换）。只用于打「示例」标记。',
  },
  activePersona: {
    kind: 'string',
    default: FACTORY_PERSONA_ID,
    doc: '初始激活的人设 id。切换只改内存态，落盘归 O-005 用户层或界面。',
  },
  maxArchiveBytes: {
    kind: 'number',
    default: 33554432,
    min: 1048576,
    max: 536870912,
    advancedOnly: true,
    doc: '单个包上限（字节）。到上限拒收并报 too-large，不截断——截断的包解出来是半个 ZIP。',
  },
  maxEntryBytes: {
    kind: 'number',
    default: 4194304,
    min: 65536,
    max: 67108864,
    advancedOnly: true,
    doc: '单个文本文件上限（字节）。实包 SKILL.md 最大 27KB，4MB 是「有人塞整本小说」的量级。',
  },
  maxTextCacheBytes: {
    kind: 'number',
    default: 8388608,
    min: 262144,
    max: 268435456,
    advancedOnly: true,
    doc: '文本缓存预算（字节）。缓存是为了不在每次组装提示词时解包（§8.2 反模式②）。',
  },
  maxPersonas: {
    kind: 'number',
    default: 64,
    min: 1,
    max: 1024,
    advancedOnly: true,
    doc: '一次扫描注册的人设上限。到上限报 over-cap 并停下，不淘汰已注册的。',
  },
  keepIssues: {
    kind: 'number',
    default: 50,
    min: 0,
    max: 1000,
    advancedOnly: true,
    doc: '保留的问题条数。超出的丢弃并报 issue-truncated。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  bundledDir: FIELD_SPECS.bundledDir.default as string,
  userSubdir: FIELD_SPECS.userSubdir.default as string,
  factoryPersona: FIELD_SPECS.factoryPersona.default as string,
  samplePersona: FIELD_SPECS.samplePersona.default as string,
  activePersona: FIELD_SPECS.activePersona.default as string,
  maxArchiveBytes: FIELD_SPECS.maxArchiveBytes.default as number,
  maxEntryBytes: FIELD_SPECS.maxEntryBytes.default as number,
  maxTextCacheBytes: FIELD_SPECS.maxTextCacheBytes.default as number,
  maxPersonas: FIELD_SPECS.maxPersonas.default as number,
  keepIssues: FIELD_SPECS.keepIssues.default as number,
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
  bundledDir: 'bundled-dir',
  userSubdir: 'user-subdir',
  factoryPersona: 'factory-persona',
  samplePersona: 'sample-persona',
  activePersona: 'active-persona',
  maxArchiveBytes: 'max-archive-bytes',
  maxEntryBytes: 'max-entry-bytes',
  maxTextCacheBytes: 'max-text-cache-bytes',
  maxPersonas: 'max-personas',
  keepIssues: 'keep-issues',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '人设包',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-persona-loader',
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
 * 取一个「必须是合法人设 id」的字符串。
 *
 * 非法值回退默认**而不报错**：配置错不该让插件不加载，
 * 但也不该把一个非法 id 带进下游当键用（那会变成「查不到」而不是「配错了」）。
 * @param value 原始值。
 * @param fallback 默认值。
 */
function pickId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return PERSONA_ID_PATTERN.test(trimmed) ? trimmed : fallback
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const userSubdirRaw = typeof raw['userSubdir'] === 'string' ? raw['userSubdir'].trim() : ''
  // 子目录名不允许带路径分隔符与 `..`：它会被拼进数据根，越界就是写到根外面去。
  const userSubdir =
    userSubdirRaw !== '' && !userSubdirRaw.includes('/') && !userSubdirRaw.includes('\\') && userSubdirRaw !== '..'
      ? userSubdirRaw
      : DEFAULT_CONFIG.userSubdir
  const bundledRaw = typeof raw['bundledDir'] === 'string' ? raw['bundledDir'].trim() : ''
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    bundledDir: bundledRaw,
    userSubdir,
    factoryPersona: pickId(raw['factoryPersona'], FACTORY_PERSONA_ID),
    samplePersona: pickId(raw['samplePersona'], SAMPLE_PERSONA_ID),
    activePersona: pickId(raw['activePersona'], FACTORY_PERSONA_ID),
    maxArchiveBytes: clampInt(raw['maxArchiveBytes'], DEFAULT_CONFIG.maxArchiveBytes, 1048576, 536870912),
    maxEntryBytes: clampInt(raw['maxEntryBytes'], DEFAULT_CONFIG.maxEntryBytes, 65536, 67108864),
    maxTextCacheBytes: clampInt(raw['maxTextCacheBytes'], DEFAULT_CONFIG.maxTextCacheBytes, 262144, 268435456),
    maxPersonas: clampInt(raw['maxPersonas'], DEFAULT_CONFIG.maxPersonas, 1, 1024),
    keepIssues: clampInt(raw['keepIssues'], DEFAULT_CONFIG.keepIssues, 0, 1000),
  })
}
