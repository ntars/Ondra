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
 * 六个关键默认值的理由：
 *
 * - **`exclusion 'group'`**：台账原文是「同层互斥」，但在 O-024 里「层」只是预算桶
 *   （手册没给层名）。直译成「同层只活一条」会让同一层里 N 条互补的卡互相杀死。
 *   默认按人设包自己的章节组互斥（`## 一、20 个核心场景` 为一组），
 *   既满足「一轮只用一张骨架」，又不依赖那个没定下来的层义。
 *   `layer` 保留为严格读法，改一个字段就能切回去——两条都合规，选稳的那边。
 *
 * - **`maxDepth 3`**：台账原文「递归 ≤3」。做成 `0` 就是关掉递归：
 *   **刻意不另设一个 `recursion: boolean`**——两个开关控制同一件事，
 *   必然出现「关了开关却还把深度填 3」这种谁也说不清生效哪一个的配置。
 *
 * - **`minTermChars 2`**：一个字的触发词会命中几乎所有句子（「好」「你」「我」）。
 *   两个汉字起步是「词」与「字」的经验分界；真需要单字触发时，
 *   在卡的 `触发` 栏里写引号形式（`「胖」`），解析器会照收并单独计数——
 *   但那样得到的误触发也会照实记在 `plan().terms` 里，不会悄悄发生。
 *   **作用范围**：只约束 `触发` 栏里没加引号的词，以及标题兜底词；
 *   引号内的词（`触发` 栏与标题都算）一律按 1 字收，不受此项影响。
 *
 * - **`negationGuard true`**：长期纪律里最贵的一条——「不」出现在「不错」里、
 *   「没」出现在「没做好」里，同一字符两种含义。`不胖` 不该触发「胖」那张卡。
 *   关掉它只用于对拍「带保护 / 不带保护」的命中差异。
 *
 * - **`defaultLayer 'l4'`**：只在使用 `exclusion: 'layer'` 时有意义。
 *   场景卡是"行为骨架"，不是世界设定，所以默认挂第四层（六层里最宽的那桶）。
 *   卡片自己声明 `layer` 时以卡为准。
 *
 * - **`reportExcluded true`**：被互斥淘汰的卡要能查。
 *   否则用户会觉得「我明明写了这张卡，怎么从来不用」——而它每轮都在被淘汰。
 *
 * **刻意没有的配置项**：
 * - **没有 `includeInner`。** 「内心」永不进提示词（见 `types.ts` 文件头第 2 条）。
 *   做成开关就等于允许把「嘴上比心里短」的人改成「想到什么说什么」。
 * - **没有「最多几张卡」。** 那是对命中结果按条数砍，与 P0 的「召回不按条数砍」
 *   同一类错误：一张卡被砍掉不会报错，只会表现为「她这轮不太像」。
 * - **没有预算字段。** 预算归 O-024 的六层；本插件只报 token 数。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { SCENES_SERVICE_KEY } from './types.js'
import type { ExclusionMode } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 场景文件相对包根的路径。 */
  readonly scenesFile: string
  /** 固定人设 id；空串表示跟随当前人设。 */
  readonly personaId: string
  /** 互斥粒度。 */
  readonly exclusion: ExclusionMode
  /** 递归上限（0 = 关掉递归）。 */
  readonly maxDepth: number
  /** 触发词最短字数。 */
  readonly minTermChars: number
  /** 否定邻域保护。 */
  readonly negationGuard: boolean
  /** 卡片未声明层时的兜底层。 */
  readonly defaultLayer: string
  /** 被互斥淘汰是否写日志。 */
  readonly reportExcluded: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'worldbook-scenes'

/**
 * 递归深度的**硬上限**。
 *
 * 台账写「递归 ≤3」，所以这里不是配置范围而是宪法：配大了夹回 3 并告警。
 * 放宽它需要改的是一条规范，而不是一个参数。
 */
export const MAX_DEPTH_LIMIT = 3

/** 触发词最短字数的下界（1 个字会让几乎每句都命中）。 */
export const MIN_TERM_CHARS_MIN = 1

/** 触发词最短字数的上界。 */
export const MIN_TERM_CHARS_MAX = 8

/** 包内相对路径长度上限。 */
export const SCENES_FILE_MAX = 160

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不再判定场景，服务以「不可用」状态注册。',
  },
  scenesFile: {
    kind: 'string',
    default: 'references/scenes.md',
    doc: '场景卡文件相对人设包根的路径。两个人设包都在这个位置（已实测）。',
  },
  personaId: {
    kind: 'string',
    default: '',
    doc: '固定用哪个人设的场景卡。留空表示跟随当前人设（换人设会自动重新解析）。',
  },
  exclusion: {
    kind: 'enum',
    options: Object.freeze(['group', 'layer', 'slot', 'off']),
    default: 'group',
    doc:
      '互斥粒度。group = 章节组内只活一张（默认）；layer = 同预算层只活一张（台账「同层互斥」的严格读法）；' +
      'slot = 只有声明了同一个 slot 的才互斥；off = 不互斥。',
  },
  maxDepth: {
    kind: 'number',
    default: 3,
    min: 0,
    max: MAX_DEPTH_LIMIT,
    doc: '递归上限，0 表示关掉递归。上限 3 是台账原文，配大了会被夹回并告警。',
  },
  minTermChars: {
    kind: 'number',
    default: 2,
    min: MIN_TERM_CHARS_MIN,
    max: MIN_TERM_CHARS_MAX,
    advancedOnly: true,
    doc: '触发词最短字数。1 个字会命中几乎所有句子，默认 2。',
  },
  negationGuard: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '否定邻域保护：「不胖」不触发「胖」。关掉只用于对拍命中差异。',
  },
  defaultLayer: {
    kind: 'enum',
    options: Object.freeze(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']),
    default: 'l4',
    advancedOnly: true,
    doc: '卡片没声明层时挂哪一层。只在 exclusion=layer 时有意义。',
  },
  reportExcluded: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '被互斥淘汰的卡是否写日志。默认 true——否则用户会以为「写了却从来不用」。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  scenesFile: FIELD_SPECS.scenesFile.default as string,
  personaId: FIELD_SPECS.personaId.default as string,
  exclusion: FIELD_SPECS.exclusion.default as ExclusionMode,
  maxDepth: FIELD_SPECS.maxDepth.default as number,
  minTermChars: FIELD_SPECS.minTermChars.default as number,
  negationGuard: FIELD_SPECS.negationGuard.default as boolean,
  defaultLayer: FIELD_SPECS.defaultLayer.default as string,
  reportExcluded: FIELD_SPECS.reportExcluded.default as boolean,
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
  scenesFile: 'scenes-file',
  personaId: 'persona-id',
  exclusion: 'exclusion',
  maxDepth: 'max-depth',
  minTermChars: 'min-term-chars',
  negationGuard: 'negation-guard',
  defaultLayer: 'default-layer',
  reportExcluded: 'report-excluded',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '世界书 · 场景卡',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: SCENES_SERVICE_KEY,
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**，交给 O-005 报 `unknown-field`。
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

/**
 * 规整包内相对路径：允许多段，禁止绝对路径、`..` 与反斜杠。
 *
 * 不做这个检查，`scenesFile: '../../../../etc/passwd'` 就会把读口变成越界读；
 * 而 O-020 的 `readText()` 只认包内路径，越界值会被它拒掉——
 * 但那时错误表现为「一张卡都没有」，查起来要绕一大圈。
 * @param value 原始值。
 * @param fallback 非法时的兜底。
 */
export function normalizeRelPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const path = value.trim().replace(/^\.\//, '')
  if (path.length === 0 || path.length > SCENES_FILE_MAX) return fallback
  if (path.startsWith('/') || path.includes('\\') || path.includes('..')) return fallback
  return path
}

/**
 * 夹一个数到区间内。
 * @param value 原始值。
 * @param fallback 非法时的兜底。
 * @param min 下界。
 * @param max 上界。
 */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 夹整数到区间内。
 * @param value 原始值。
 * @param fallback 非法时的兜底。
 * @param min 下界。
 * @param max 上界。
 */
export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const exclusion = raw['exclusion']
  const layer = raw['defaultLayer']
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    scenesFile: normalizeRelPath(raw['scenesFile'], DEFAULT_CONFIG.scenesFile),
    personaId: typeof raw['personaId'] === 'string' ? raw['personaId'].trim() : DEFAULT_CONFIG.personaId,
    exclusion:
      exclusion === 'group' || exclusion === 'layer' || exclusion === 'slot' || exclusion === 'off'
        ? exclusion
        : DEFAULT_CONFIG.exclusion,
    maxDepth: clampInteger(raw['maxDepth'], DEFAULT_CONFIG.maxDepth, 0, MAX_DEPTH_LIMIT),
    minTermChars: clampInteger(
      raw['minTermChars'],
      DEFAULT_CONFIG.minTermChars,
      MIN_TERM_CHARS_MIN,
      MIN_TERM_CHARS_MAX,
    ),
    negationGuard:
      raw['negationGuard'] === undefined ? DEFAULT_CONFIG.negationGuard : raw['negationGuard'] === true,
    defaultLayer:
      layer === 'l1' || layer === 'l2' || layer === 'l3' || layer === 'l4' || layer === 'l5' || layer === 'l6'
        ? layer
        : DEFAULT_CONFIG.defaultLayer,
    reportExcluded:
      raw['reportExcluded'] === undefined ? DEFAULT_CONFIG.reportExcluded : raw['reportExcluded'] === true,
  })
}
