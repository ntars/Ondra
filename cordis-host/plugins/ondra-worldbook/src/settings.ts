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
 * - **`fitPolicy 'stop'`**：手册 §2.6 对世界书写的是「撞限**整条丢弃**」。
 *   「丢哪条」有两种读法：丢这一条继续试下一条（装箱制），或者这一层到此为止。
 *   默认选后者，因为世界书条目之间有先后依赖（先势力、后冲突），
 *   捡小的塞会拼出一份自相矛盾的世界，而它看起来完全正常。
 *   要装箱制改这一个字段即可——两种口径都是原文允许的，差别只在「谁先被牺牲」。
 *
 * - **`cjkCharsPerToken 1.6` / `asciiCharsPerToken 4`**：手册的预算是 **token**，
 *   而本仓手上没有分词器。1.6 是「中文约 0.6–0.7 token/字」的中间偏保守取值，
 *   ASCII 取业界常见的 4 字/token。**这是估算，不是事实**，所以：
 *   ① 两个比例都可配；② `setMeter()` 是唯一替换口，O-036 装真分词器时调它；
 *   ③ `stats().meter` 会把这个口径写成一句话，界面与日志都能查到「为什么装得比想象少」。
 *   绝不把「估算」写死在 `layers.ts` 里：写死之后，换模型就再也对不上账。
 *
 * - **`annotateDropped false`**：记忆注入要求写「另有 N 条未展开」（§2.6），
 *   世界书**没有**这条要求，而两者语义不同：记忆被丢是「她想不起来了」，
 *   世界书被丢是「这条设定这轮用不上」。把「另有 4 条设定未展开」写进提示词，
 *   等于让模型知道自己读到的是删节版，它会开始对着删节本推理。
 *   计数仍然逐条报在 `pack().dropped` 里，界面与自检查得到。
 *
 * - **`includeHeadings true`**：六层之间要有可见边界，否则模型会把 L5 的禁令
 *   读成 L4 的剧情描述。真要省这几十个 token 可以关掉。
 *
 * - **`maxEntryTokens 0`**：默认不设单条上限。上限会制造「悄悄少一条」的第二条路径，
 *   而手册只给了「撞限整条丢」这一条。要防「一条巨型条目吃掉整层」，
 *   `stats()` 与 `pack().dropped` 已经能把那条抓出来。
 *
 * - **`loadFile true`**：用户的世界书放在 `user/worldbook.json`（设置页「世界书导入」的落点）。
 *   文件不存在**不是错误**——没配世界书是正常状态，日志里不报 warn。
 *
 * **刻意没有的配置项**：
 * - **没有「每层预算」的配置字段。** 六层预算的真源是 `types.ts` 的 `LAYER_BUDGETS`；
 *   在这里再写一份，就会出现「界面 350、实际 500」而这种错没有任何报错。
 *   要临时换预算走 `pack({ budgets })`（一次性、可解释），不要改全局。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { WORLDBOOK_SERVICE_KEY } from './types.js'

/** 撞限之后怎么办。 */
export type FitPolicy =
  /** 这一层到此为止（手册「撞限整条丢弃」的字面读法）。 */
  | 'stop'
  /** 跳过这一条、继续试下一条（记忆注入的装箱制）。 */
  | 'skip'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 世界书文件名（相对 `user` 区）。 */
  readonly worldbookFile: string
  /** 启动时是否从文件加载。 */
  readonly loadFile: boolean
  /** 是否给每层加中文小标题。 */
  readonly includeHeadings: boolean
  /** 段标题是否写「另有 N 条未展开」。 */
  readonly annotateDropped: boolean
  /** 丢弃是否写日志。 */
  readonly reportDropped: boolean
  /** 撞限策略。 */
  readonly fitPolicy: FitPolicy
  /** 中文每 token 折几个字（估算）。 */
  readonly cjkCharsPerToken: number
  /** 非中文每 token 折几个字符（估算）。 */
  readonly asciiCharsPerToken: number
  /** 单条正文的 token 上限；0 表示不限。 */
  readonly maxEntryTokens: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'worldbook'

/** 折算比例的合法区间。1.0 = 一字一 token（最保守），4 = 四字一 token（最乐观）。 */
export const CHARS_PER_TOKEN_MIN = 1
/** 折算比例上限。 */
export const CHARS_PER_TOKEN_MAX = 6

/** 单条上限的上界（token）。 */
export const MAX_ENTRY_TOKENS_MAX = 4000

/** 文件名长度上限。 */
export const FILE_NAME_MAX = 120

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后世界书不再参与拼装，服务以「不可用」状态注册。',
  },
  worldbookFile: {
    kind: 'string',
    default: 'worldbook.json',
    doc: '世界书文件名，落在数据目录的 user 区。设置页「世界书导入」写的就是这个文件。',
  },
  loadFile: {
    kind: 'boolean',
    default: true,
    doc: '启动时是否从文件加载世界书。文件不存在不是错误（没配世界书是正常状态）。',
  },
  includeHeadings: {
    kind: 'boolean',
    default: true,
    doc: '是否给每层加中文小标题。关掉能省几十个 token，但模型可能把禁令读成剧情。',
  },
  annotateDropped: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc:
      '段标题是否写「另有 N 条未展开」。默认关：世界书被丢是「这轮用不上」，' +
      '不是「她想不起来」，写进提示词会让模型对着删节本推理。计数仍逐条可查。',
  },
  reportDropped: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '丢弃是否写日志。默认 true——不静默丢；关掉只用于压自检噪音。',
  },
  fitPolicy: {
    kind: 'enum',
    options: Object.freeze(['stop', 'skip']),
    default: 'stop',
    advancedOnly: true,
    doc:
      '撞限策略。stop = 这一层到此为止（手册「撞限整条丢弃」的字面读法，默认）；' +
      'skip = 跳过这条继续试下一条（记忆注入的装箱制）。',
  },
  cjkCharsPerToken: {
    kind: 'number',
    default: 1.6,
    min: CHARS_PER_TOKEN_MIN,
    max: CHARS_PER_TOKEN_MAX,
    advancedOnly: true,
    doc: '中文每 token 折几个字（**估算**）。真分词由 O-036 通过 setMeter() 替换。',
  },
  asciiCharsPerToken: {
    kind: 'number',
    default: 4,
    min: CHARS_PER_TOKEN_MIN,
    max: CHARS_PER_TOKEN_MAX,
    advancedOnly: true,
    doc: '非中文每 token 折几个字符（**估算**）。',
  },
  maxEntryTokens: {
    kind: 'number',
    default: 0,
    min: 0,
    max: MAX_ENTRY_TOKENS_MAX,
    advancedOnly: true,
    doc: '单条正文的 token 上限，0 表示不限。超限整条拒收（不截断）。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  worldbookFile: FIELD_SPECS.worldbookFile.default as string,
  loadFile: FIELD_SPECS.loadFile.default as boolean,
  includeHeadings: FIELD_SPECS.includeHeadings.default as boolean,
  annotateDropped: FIELD_SPECS.annotateDropped.default as boolean,
  reportDropped: FIELD_SPECS.reportDropped.default as boolean,
  fitPolicy: FIELD_SPECS.fitPolicy.default as FitPolicy,
  cjkCharsPerToken: FIELD_SPECS.cjkCharsPerToken.default as number,
  asciiCharsPerToken: FIELD_SPECS.asciiCharsPerToken.default as number,
  maxEntryTokens: FIELD_SPECS.maxEntryTokens.default as number,
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
  worldbookFile: 'worldbook-file',
  loadFile: 'load-file',
  includeHeadings: 'include-headings',
  annotateDropped: 'annotate-dropped',
  reportDropped: 'report-dropped',
  fitPolicy: 'fit-policy',
  cjkCharsPerToken: 'cjk-chars-per-token',
  asciiCharsPerToken: 'ascii-chars-per-token',
  maxEntryTokens: 'max-entry-tokens',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '世界书',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: WORLDBOOK_SERVICE_KEY,
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
 * 夹一个整数到区间内。
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
 * 规整文件名：只允许**单段**相对名，不许路径分隔符与 `..`。
 *
 * 不做这个检查，`worldbookFile: '../../etc/passwd'` 就会把加载口变成任意文件读。
 * 世界书只有一个文件，没有"子目录"的需求，因此直接拒绝而不是清洗。
 * @param value 原始值。
 * @param fallback 非法时的兜底。
 */
export function normalizeFileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim()
  if (name.length === 0 || name.length > FILE_NAME_MAX) return fallback
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return fallback
  return name
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const policy = raw['fitPolicy']
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    worldbookFile: normalizeFileName(raw['worldbookFile'], DEFAULT_CONFIG.worldbookFile),
    loadFile: raw['loadFile'] === undefined ? DEFAULT_CONFIG.loadFile : raw['loadFile'] === true,
    includeHeadings:
      raw['includeHeadings'] === undefined ? DEFAULT_CONFIG.includeHeadings : raw['includeHeadings'] === true,
    annotateDropped:
      raw['annotateDropped'] === undefined ? DEFAULT_CONFIG.annotateDropped : raw['annotateDropped'] === true,
    reportDropped:
      raw['reportDropped'] === undefined ? DEFAULT_CONFIG.reportDropped : raw['reportDropped'] === true,
    fitPolicy: policy === 'stop' || policy === 'skip' ? policy : DEFAULT_CONFIG.fitPolicy,
    cjkCharsPerToken: clampNumber(
      raw['cjkCharsPerToken'],
      DEFAULT_CONFIG.cjkCharsPerToken,
      CHARS_PER_TOKEN_MIN,
      CHARS_PER_TOKEN_MAX,
    ),
    asciiCharsPerToken: clampNumber(
      raw['asciiCharsPerToken'],
      DEFAULT_CONFIG.asciiCharsPerToken,
      CHARS_PER_TOKEN_MIN,
      CHARS_PER_TOKEN_MAX,
    ),
    maxEntryTokens: clampInteger(
      raw['maxEntryTokens'],
      DEFAULT_CONFIG.maxEntryTokens,
      0,
      MAX_ENTRY_TOKENS_MAX,
    ),
  })
}

/**
 * 计量口径的人话说明（进 `stats().meter`，让「为什么装得少」可查）。
 * @param config 配置。
 */
export function meterDoc(config: Config): string {
  return '估算：中文 ' + config.cjkCharsPerToken + ' 字/token，其余 ' + config.asciiCharsPerToken + ' 字符/token'
}
