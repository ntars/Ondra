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
 * **指标口径（k 列表、MRR 定义、分心判据）全部可调，但都写了「为什么是这个值」**。
 * 其中 `ks` 默认 `[1,3,5]`：手册正文只要求 `recall@1` / `recall@3`，
 * `@5` 来自手册 §2.3 的糯糯标准（`recall@5 > 0.80`）——多给一档，
 * 是为了让「@3 掉、@5 涨」这种「把对的往后挪了」的情况能被看见。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /**
   * 默认题集名（不含扩展名）。
   *
   * 文件落点：`user/eval/<setName>.set.json`。经 O-002 解析，不拼绝对路径。
   */
  readonly setName: string
  /**
   * 计算哪些 k。默认 `[1, 3, 5]`。
   *
   * 手册正文要 `@1` / `@3`，`@5` 对齐糯糯标准 `recall@5 > 0.80`。
   * 顺序会原样出现在报告里，方便对着旧报告逐列比。
   */
  readonly ks: readonly number[]
  /**
   * 手册要求的最小题数。默认 **20**（§2.3「20–40 条真实问法」）。
   *
   * 低于它的报告标 `insufficient`：**照跑照出数**，但结论不可用于调参。
   * 直接拒绝跑更糟——人会更倾向于「就手测两条算了」。
   */
  readonly minCases: number
  /**
   * 编造题的判据。默认 **`no-hit`**。
   *
   * - `no-hit`：命中列表为空才算「没硬凑」。`rrf` 模式下**强制**用这一种
   *   （名次分没有置信度含义，设阈值等于编一个量纲）。
   * - `score-floor`：最高分低于 `fabricatedScoreFloor` 也算「没硬凑」。
   *   只在 `weighted` 模式下有意义（分是 0–1 的加权和）。
   */
  readonly fabricatedJudge: 'no-hit' | 'score-floor'
  /**
   * `score-floor` 判据的分水岭。默认 0.05。
   *
   * 手册未给此值。取 0.05 是「几乎没有任何证据」的量级：
   * 五因子加权和里最小单项权重是 .11，任何一项有内容都会越过它。
   * **`rrf` 模式下本项完全不生效**（见 README「已知限制」）。
   */
  readonly fabricatedScoreFloor: number
  /**
   * 文本指纹的最短长度。默认 **4**。
   *
   * 2 字指纹（「猫粮」）在几十条库里几乎必然命中多条，全部判 `ambiguous`，
   * 题就废了；4 字是中文里「足够特异又不必抄整句」的下限。
   * 与 O-012 判重的最短 4 字同一口径（那边是「包含度还能区分的最小粒度」）。
   */
  readonly minFingerprintChars: number
  /** 是否把报告写盘。默认 `true`（手册：报告落盘）。 */
  readonly writeReport: boolean
  /**
   * 保留几份历史报告。默认 **20**。
   *
   * 只在自己命名规则内修剪（`<setName>-<13 位时间戳>.json|.md`），
   * 且在**新报告写成功之后**才修剪。目录里别人的文件一律不动。
   */
  readonly keepReports: number
  /**
   * 落盘时是否把问法原文截断。默认 `true`。
   *
   * 报告会离开内存（进 `user/eval/`，可能被用户发给别人看）。
   * 问法是用户亲口说的话，正文更是——正文根本不写，问法按 `queryMaxChars` 截。
   */
  readonly redactQueries: boolean
  /** 落盘时问法的最大字数。默认 40。 */
  readonly queryMaxChars: number
  /**
   * 每题在报告里记多少条命中 id。默认 **20**。
   *
   * 只记 id 不记正文。20 条足够看出「第 12 位才命中」这种问题，
   * 又不至于让报告变成一份记忆清单。
   */
  readonly recordHits: number
  /**
   * `seed()` 一次抽几条。默认 **30**（手册 20–40 的区间中位）。
   */
  readonly seedSize: number
}

/**
 * 段键。**全仓唯一真源就在这一行**（`types.ts` 里不再重复一份）。
 *
 * 与插件名一致，符合 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`。
 * 段声明 `CONFIG_SECTION.id` 由它派生，`index.ts` 的 `resolve()` 也用它——
 * 两处写死同一个字符串，是「段注册成功但永远解析不到」的经典成因。
 */
export const CONFIG_SECTION_ID = 'recall-eval'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归 O-092。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后评估不生效，服务以「不可用」状态注册。',
  },
  setName: {
    kind: 'string',
    default: 'recall-eval-set',
    doc: '默认题集名（不含扩展名）。文件落在 user/eval/<名字>.set.json。',
  },
  ks: {
    kind: 'json',
    default: Object.freeze([1, 3, 5]),
    doc: '计算哪些 k。手册要 @1 与 @3，@5 对齐糯糯标准 recall@5 > 0.80。',
  },
  minCases: {
    kind: 'number',
    default: 20,
    min: 1,
    max: 500,
    doc: '手册要求的最小题数（20）。低于它的报告标「不足」，照出数但不能用来调参。',
  },
  fabricatedJudge: {
    kind: 'enum',
    default: 'no-hit',
    options: Object.freeze(['no-hit', 'score-floor']),
    doc: '编造题判据：no-hit（无命中，默认）／score-floor（最高分低于分水岭）。rrf 模式下强制 no-hit。',
  },
  fabricatedScoreFloor: {
    kind: 'number',
    default: 0.05,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: 'score-floor 判据的分水岭。手册未给，取 0.05（几乎无证据的量级）。rrf 模式下不生效。',
  },
  minFingerprintChars: {
    kind: 'number',
    default: 4,
    min: 2,
    max: 40,
    advancedOnly: true,
    doc: '文本指纹最短长度。太短会命中多条被判「不可判」，与 O-012 判重最短 4 字同口径。',
  },
  writeReport: {
    kind: 'boolean',
    default: true,
    doc: '是否把报告写盘（json + md）。没有 path-layout 时自动降级为只算不写。',
  },
  keepReports: {
    kind: 'number',
    default: 20,
    min: 1,
    max: 500,
    advancedOnly: true,
    doc: '保留几份历史报告。只修剪自己命名规则内的文件，别人的文件不动。',
  },
  redactQueries: {
    kind: 'boolean',
    default: true,
    doc: '落盘时截断问法原文。报告会离开内存，问法是用户亲口说的话。',
  },
  queryMaxChars: {
    kind: 'number',
    default: 40,
    min: 4,
    max: 500,
    advancedOnly: true,
    doc: '落盘时问法最多保留多少字。',
  },
  recordHits: {
    kind: 'number',
    default: 20,
    min: 0,
    max: 500,
    advancedOnly: true,
    doc: '每题在报告里记多少条命中 id（只记 id，不记正文）。',
  },
  seedSize: {
    kind: 'number',
    default: 30,
    min: 1,
    max: 200,
    doc: 'seed() 一次抽几条记忆生成待填模板。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  setName: FIELD_SPECS.setName.default as string,
  ks: FIELD_SPECS.ks.default as readonly number[],
  minCases: FIELD_SPECS.minCases.default as number,
  fabricatedJudge: FIELD_SPECS.fabricatedJudge.default as Config['fabricatedJudge'],
  fabricatedScoreFloor: FIELD_SPECS.fabricatedScoreFloor.default as number,
  minFingerprintChars: FIELD_SPECS.minFingerprintChars.default as number,
  writeReport: FIELD_SPECS.writeReport.default as boolean,
  keepReports: FIELD_SPECS.keepReports.default as number,
  redactQueries: FIELD_SPECS.redactQueries.default as boolean,
  queryMaxChars: FIELD_SPECS.queryMaxChars.default as number,
  recordHits: FIELD_SPECS.recordHits.default as number,
  seedSize: FIELD_SPECS.seedSize.default as number,
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
  setName: 'set-name',
  ks: 'ks',
  minCases: 'min-cases',
  fabricatedJudge: 'fabricated-judge',
  fabricatedScoreFloor: 'fabricated-score-floor',
  minFingerprintChars: 'min-fingerprint-chars',
  writeReport: 'write-report',
  keepReports: 'keep-reports',
  redactQueries: 'redact-queries',
  queryMaxChars: 'query-max-chars',
  recordHits: 'record-hits',
  seedSize: 'seed-size',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '检索评估',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-recall-eval',
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

/** 夹一个浮点。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 取布尔值；非布尔回退默认。 */
function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 取枚举值，非法则回退。 */
function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * 把 `ks` 归一化成「正整数、去重、升序、上限 100」。
 *
 * 用户可能填 `[1,1,3]` 或 `[-1, 3]` 或 `"1,3"`。一律整理成可用值：
 * 指标表里出现重复键会互相覆盖，出现负数会 slice 出空结果，
 * 两者都不报错，只会让报告少一列。
 * @param value 原始值。
 */
export function normalizeKs(value: unknown): readonly number[] {
  let list: unknown = value
  if (typeof value === 'string') list = value.split(',')
  if (!Array.isArray(list)) return DEFAULT_CONFIG.ks
  const seen = new Set<number>()
  for (const item of list) {
    const num = typeof item === 'number' ? item : Number(item)
    if (!Number.isFinite(num)) continue
    const k = Math.trunc(num)
    if (k < 1 || k > 100) continue
    seen.add(k)
  }
  if (seen.size === 0) return DEFAULT_CONFIG.ks
  return Object.freeze([...seen].sort((a, b) => a - b))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: boolOf(raw['enable'], DEFAULT_CONFIG.enable),
    setName: typeof raw['setName'] === 'string' && raw['setName'].trim() !== '' ? raw['setName'].trim() : DEFAULT_CONFIG.setName,
    ks: normalizeKs(raw['ks']),
    minCases: clampInt(raw['minCases'], DEFAULT_CONFIG.minCases, 1, 500),
    fabricatedJudge: enumOf<Config['fabricatedJudge']>(
      raw['fabricatedJudge'],
      ['no-hit', 'score-floor'],
      DEFAULT_CONFIG.fabricatedJudge,
    ),
    fabricatedScoreFloor: clampFloat(raw['fabricatedScoreFloor'], DEFAULT_CONFIG.fabricatedScoreFloor, 0, 1),
    minFingerprintChars: clampInt(raw['minFingerprintChars'], DEFAULT_CONFIG.minFingerprintChars, 2, 40),
    writeReport: boolOf(raw['writeReport'], DEFAULT_CONFIG.writeReport),
    keepReports: clampInt(raw['keepReports'], DEFAULT_CONFIG.keepReports, 1, 500),
    redactQueries: boolOf(raw['redactQueries'], DEFAULT_CONFIG.redactQueries),
    queryMaxChars: clampInt(raw['queryMaxChars'], DEFAULT_CONFIG.queryMaxChars, 4, 500),
    recordHits: clampInt(raw['recordHits'], DEFAULT_CONFIG.recordHits, 0, 500),
    seedSize: clampInt(raw['seedSize'], DEFAULT_CONFIG.seedSize, 1, 200),
  })
}

/**
 * 判断一个题集名能不能安全当文件名用。
 *
 * 题集名直接参与拼路径，`../` 或 `/` 会让 `ensure()` 抛 `PathEscapeError`，
 * 而那是在写盘时才发现——此时已经把一轮搜索跑完了。前置判掉。
 * @param name 题集名。
 */
export function isValidSetName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.includes('..')
}
