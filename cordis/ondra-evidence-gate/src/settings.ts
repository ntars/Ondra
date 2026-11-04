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
 * 本插件**没有一个「必须由用户填」的字段**（§3.3-2）。门控站在写入路径上，
 * 它一旦要求先配三个阈值才能用，就等于把「她记得住」变成一道调参题。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`，`judge()` 一律放行。 */
  readonly enable: boolean
  /** 正文上限（字）。默认 **200**，手册 §2.2「条目 ≤200 字」。超长截断，不整条拒。 */
  readonly maxTextChars: number
  /** 摘要上限（字）。默认 **80**，手册 §2.2「summary ≤80 字」。 */
  readonly maxSummaryChars: number
  /**
   * 引文最短字数。默认 **2**，与 O-011 的 `minQuoteChars` 默认值一致。
   *
   * 1 个字的引文在任何句子里都能找到，等于没有证据；2 字是「怕狗」「28」这类
   * 短而具体的信息还能当证据的最小粒度。想更严就调到 4。
   */
  readonly minQuoteChars: number
  /**
   * 一条候选最多带几条引文。默认 **8**。
   *
   * 这是**防凑数闸**：模型可以一次给 50 条引文，只要有一条能逐字命中就蒙混过关。
   * 超过上限时按「USER > TOOL > ACT > SELF」优先保留——最先被牺牲的永远是她自己的散文。
   */
  readonly maxEvidence: number
  /**
   * 数字的允许来源。默认 **`tool-or-user`**（见下方「与手册字面的一处差异」）。
   *
   * - `tool-or-user`：TOOL 或 USER 的引文能覆盖就算有出处；
   * - `tool-only`：只有 TOOL 能覆盖（手册字面口径）；
   * - `off`：不检查（不推荐，等于放行编造的数字）。
   */
  readonly digitSource: 'tool-or-user' | 'tool-only' | 'off'
  /**
   * 数字没出处时的动作。默认 **`strip`**（剥掉含该数字的分句）。
   *
   * 手册语料（第十三部分 B 节）原话是「没有 `[TOOL]` 支撑的数字**被剥离**」，
   * 而手册 §2.2 正文写「数字必须有 `[TOOL]` 来源」。两处一个说剥、一个说必须有。
   * 默认按「剥」执行：剥完还能记住这件事的其余部分，整条拒则什么都不剩。
   * 想更严改成 `reject`。
   */
  readonly unbackedDigitAction: 'strip' | 'reject'
  /**
   * 引文必须落在**同类来源**的素材里。默认 `true`。
   *
   * 素材没有来源标注时这条自动跳过（没有可比的东西），不算违规。
   * 打开它的理由：把她的猜测标成「用户说过」比没有引文更危险——
   * 手册 §2.2 原话「归属错误比记不住更伤信任」。
   */
  readonly strictSource: boolean
  /**
   * 文本级归功检测。默认 `true`。
   *
   * 正文里出现「用户 / 你」+ 归功动词（说 / 要求 / 决定 / 答应…）却没有 USER 引文 → 拒。
   * O-011 只看 `subject` 字段，本插件再加一道看正文的——因为模型完全可以把
   * `subject` 写成 `self`，正文里却写着「用户答应下周一起吃饭」。
   */
  readonly strictAttribution: boolean
  /**
   * 只有 SELF 引文、说的却是别人的事时怎么办。默认 **`seed`**。
   *
   * 手册语料原话：「想法可以进'种子文件'，但不进记忆库」。`reject` 是保守档。
   */
  readonly selfOnlyAction: 'seed' | 'reject'
  /** 决策日志保留行数。默认 2000。0 表示不清理。 */
  readonly logLimit: number
  /** 每次最多清理多少行旧日志。默认 50（分批，避免一次事务太大）。 */
  readonly logPruneBatch: number
  /** 日志里正文最多存多少字。默认 120。**只留残文，不留全文**。 */
  readonly maxLogTextChars: number
}

/** 段键。与插件名去掉 `ondra-` 前缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'evidence-gate'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归 O-092。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后门控一律放行（等于关掉「无出处不入库」这条红线）。',
  },
  maxTextChars: {
    kind: 'number',
    default: 200,
    min: 20,
    max: 2000,
    doc: '正文上限（字）。手册要求条目 ≤200 字，超长截断而不是整条拒。',
  },
  maxSummaryChars: {
    kind: 'number',
    default: 80,
    min: 10,
    max: 500,
    doc: '摘要上限（字）。手册要求 summary ≤80 字。',
  },
  minQuoteChars: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 20,
    advancedOnly: true,
    doc: '引文最短字数。1 个字的引文在任何句子里都能找到，等于没有证据。',
  },
  maxEvidence: {
    kind: 'number',
    default: 8,
    min: 1,
    max: 64,
    advancedOnly: true,
    doc: '一条候选最多带几条引文。超出按 USER > TOOL > ACT > SELF 优先保留，防止「给 50 条蒙一条命中」。',
  },
  digitSource: {
    kind: 'enum',
    default: 'tool-or-user',
    options: Object.freeze(['tool-or-user', 'tool-only', 'off']),
    doc: '数字的允许来源。tool-or-user：TOOL 或 USER 的引文能覆盖即可；tool-only：只有 TOOL（手册字面）；off：不检查。',
  },
  unbackedDigitAction: {
    kind: 'enum',
    default: 'strip',
    options: Object.freeze(['strip', 'reject']),
    advancedOnly: true,
    doc: '数字没出处时：剥掉含该数字的分句（默认）／整条拒。',
  },
  strictSource: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '引文必须落在同类来源的素材里。素材没有来源标注时自动跳过。',
  },
  strictAttribution: {
    kind: 'boolean',
    default: true,
    doc: '文本级归功检测：正文出现「用户/你」+ 归功动词却没有 USER 引文 → 拒。',
  },
  selfOnlyAction: {
    kind: 'enum',
    default: 'seed',
    options: Object.freeze(['seed', 'reject']),
    advancedOnly: true,
    doc: '只有 SELF 引文却说的是别人的事：进种子文件（默认）／直接丢弃。',
  },
  logLimit: {
    kind: 'number',
    default: 2000,
    min: 0,
    max: 100000,
    advancedOnly: true,
    doc: '决策日志保留行数。0 表示不清理。日志的用途是回答「这句话怎么没记住」。',
  },
  logPruneBatch: {
    kind: 'number',
    default: 50,
    min: 1,
    max: 500,
    advancedOnly: true,
    doc: '每次最多清理多少行旧日志。分批删，避免一次事务太大。',
  },
  maxLogTextChars: {
    kind: 'number',
    default: 120,
    min: 20,
    max: 2000,
    advancedOnly: true,
    doc: '日志里正文最多存多少字。只留可辨认的残文，不留全文副本。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxTextChars: FIELD_SPECS.maxTextChars.default as number,
  maxSummaryChars: FIELD_SPECS.maxSummaryChars.default as number,
  minQuoteChars: FIELD_SPECS.minQuoteChars.default as number,
  maxEvidence: FIELD_SPECS.maxEvidence.default as number,
  digitSource: FIELD_SPECS.digitSource.default as Config['digitSource'],
  unbackedDigitAction: FIELD_SPECS.unbackedDigitAction.default as Config['unbackedDigitAction'],
  strictSource: FIELD_SPECS.strictSource.default as boolean,
  strictAttribution: FIELD_SPECS.strictAttribution.default as boolean,
  selfOnlyAction: FIELD_SPECS.selfOnlyAction.default as Config['selfOnlyAction'],
  logLimit: FIELD_SPECS.logLimit.default as number,
  logPruneBatch: FIELD_SPECS.logPruneBatch.default as number,
  maxLogTextChars: FIELD_SPECS.maxLogTextChars.default as number,
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
  maxTextChars: 'max-text-chars',
  maxSummaryChars: 'max-summary-chars',
  minQuoteChars: 'min-quote-chars',
  maxEvidence: 'max-evidence',
  digitSource: 'digit-source',
  unbackedDigitAction: 'unbacked-digit-action',
  strictSource: 'strict-source',
  strictAttribution: 'strict-attribution',
  selfOnlyAction: 'self-only-action',
  logLimit: 'log-limit',
  logPruneBatch: 'log-prune-batch',
  maxLogTextChars: 'max-log-text-chars',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '证据门控',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-evidence-gate',
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

  const digitSourceRaw = raw['digitSource']
  const digitSource: Config['digitSource'] =
    digitSourceRaw === 'tool-or-user' || digitSourceRaw === 'tool-only' || digitSourceRaw === 'off'
      ? digitSourceRaw
      : DEFAULT_CONFIG.digitSource

  const digitActionRaw = raw['unbackedDigitAction']
  const unbackedDigitAction: Config['unbackedDigitAction'] =
    digitActionRaw === 'strip' || digitActionRaw === 'reject' ? digitActionRaw : DEFAULT_CONFIG.unbackedDigitAction

  const selfOnlyRaw = raw['selfOnlyAction']
  const selfOnlyAction: Config['selfOnlyAction'] =
    selfOnlyRaw === 'seed' || selfOnlyRaw === 'reject' ? selfOnlyRaw : DEFAULT_CONFIG.selfOnlyAction

  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    maxTextChars: clampInt(raw['maxTextChars'], DEFAULT_CONFIG.maxTextChars, 20, 2000),
    maxSummaryChars: clampInt(raw['maxSummaryChars'], DEFAULT_CONFIG.maxSummaryChars, 10, 500),
    minQuoteChars: clampInt(raw['minQuoteChars'], DEFAULT_CONFIG.minQuoteChars, 1, 20),
    maxEvidence: clampInt(raw['maxEvidence'], DEFAULT_CONFIG.maxEvidence, 1, 64),
    digitSource,
    unbackedDigitAction,
    strictSource: raw['strictSource'] === undefined ? DEFAULT_CONFIG.strictSource : raw['strictSource'] === true,
    strictAttribution:
      raw['strictAttribution'] === undefined ? DEFAULT_CONFIG.strictAttribution : raw['strictAttribution'] === true,
    selfOnlyAction,
    logLimit: clampInt(raw['logLimit'], DEFAULT_CONFIG.logLimit, 0, 100000),
    logPruneBatch: clampInt(raw['logPruneBatch'], DEFAULT_CONFIG.logPruneBatch, 1, 500),
    maxLogTextChars: clampInt(raw['maxLogTextChars'], DEFAULT_CONFIG.maxLogTextChars, 20, 2000),
  })
}
