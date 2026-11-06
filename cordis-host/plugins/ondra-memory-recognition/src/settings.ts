/**
 * 配置：字段声明表 + 四层合并接入 + 补全与夹紧。
 *
 * 两条纪律（与 O-003~O-014、O-035 一脉相承）：
 *
 * 1. **默认值只在这里存一份。** `FIELD_SPECS` 是唯一真源，`DEFAULT_CONFIG` 由它派生，
 *    `cordis.patch.yml` 刻意不写 `config`——写了就是把默认值抄成第二份。
 * 2. **Config 键是 camelCase，段字段键是 kebab-case。** §8.4 只认小写与连字符，
 *    而 Cordis 插件实例配置历来是 camelCase。两边必须有一张**双向唯一**的映射表，
 *    缺了它注册期会抛 `bad-field-spec`，现象是「配置段静默不可用」。
 *
 * 所有参数都给了默认值，且默认值的选择理由写在每个 `doc` 里——
 * 没有理由的默认值等于「作者随手写的数」，下一个人不敢改也不知道该不该改。
 */

import type { ConfigSchemaLike, FieldSpecLike, SectionDeclLike } from './types.js'

/**
 * 估算口径（写进 `doc` 里，让界面上填数的人也看得到）。
 *
 * 手册的「500 条≈6k token」本身是约数；本插件按「中文 1 字 1 token、ASCII 4 字符 1 token」
 * 估算。把这句放进 `doc` 而不是只写在 README：改预算的人是在界面上改的
 * （§9.12：字段定义由插件声明，界面只按 schema 渲染），他不会去翻 README。
 */
const ESTIMATE_NOTE = '（token 为估算值：中文 1 字≈1 token，ASCII 4 字符≈1 token）'

/** 本插件的配置形状。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 最多进索引的条数。手册原值 500。 */
  readonly maxEntries: number
  /** 索引的 token 预算。手册原值 6k。 */
  readonly indexBudgetTokens: number
  /** 单行字符上限（含 slug）。 */
  readonly entryCharLimit: number
  /** 每条最多几个触发词。 */
  readonly triggersPerEntry: number
  /** `[[links]]` 最多走几圈。 */
  readonly maxRing: number
  /** 识别分门槛。 */
  readonly minScore: number
  /** 最多几个种子参与游走。 */
  readonly maxSeeds: number
  /** 索引有效期。 */
  readonly indexTtlMs: number
  /** 全量扫描的分页大小。 */
  readonly pageSize: number
  /** 是否把已沉底的记忆也纳入索引。 */
  readonly includeArchived: boolean
  /** 小模型那一路的开关。 */
  readonly pickEnabled: 'auto' | 'off'
  /** 小模型输出上限。 */
  readonly pickMaxTokens: number
  /** 小模型采样温度。 */
  readonly pickTemperature: number
  /** 小模型首块超时。 */
  readonly pickTimeoutMs: number
}

/** 段键。与插件短名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-recognition'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归 O-092。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后本服务以「不可用」状态注册，O-014 的 recognition 通道自动退出融合。',
  },
  maxEntries: {
    kind: 'number',
    default: 500,
    min: 20,
    max: 5000,
    doc: `最多进索引的条数。手册原值 500 条≈6k token。${ESTIMATE_NOTE}`,
  },
  indexBudgetTokens: {
    kind: 'number',
    default: 6000,
    min: 500,
    max: 64000,
    advancedOnly: true,
    doc: `索引的 token 预算。手册原值 6k。与 maxEntries 是双闸：条数与 token 先到先算。${ESTIMATE_NOTE}`,
  },
  entryCharLimit: {
    kind: 'number',
    default: 32,
    min: 12,
    max: 120,
    advancedOnly: true,
    doc: '单行字符上限（含 slug）。本插件补的标定值：500 条 × 12 token 的预算下，一行约 12–20 个字符最划算。',
  },
  triggersPerEntry: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 8,
    advancedOnly: true,
    doc: '每条最多几个识别触发词。3 个是「够认出」与「不吃预算」的折中；加到 8 个会让每行翻倍。',
  },
  maxRing: {
    kind: 'number',
    default: 2,
    min: 0,
    max: 3,
    doc: '沿 [[links]] 最多走几圈。0 = 不游走。手册只说「走邻域」，圈数是本插件补的（derived），默认 2：第三圈权重已降到 0.16，带来的多是噪声。',
  },
  minScore: {
    kind: 'number',
    default: 0.3,
    min: 0.05,
    max: 0.95,
    advancedOnly: true,
    doc: '识别分门槛，低于它不进结果。这不是召回裁剪：被挡的条目本来就没被识别出来。',
  },
  maxSeeds: {
    kind: 'number',
    default: 5,
    min: 1,
    max: 20,
    advancedOnly: true,
    doc: '最多几个第一轮命中当游走种子。种子太多会让「一个热门词扩散到全库」。',
  },
  indexTtlMs: {
    kind: 'number',
    default: 300000,
    min: 0,
    max: 3600000,
    advancedOnly: true,
    doc: '索引有效期。内核不提供写事件，只能靠「条数变化 + 超时」判过期；5 分钟是「够新鲜」与「不反复全量扫」的折中。',
  },
  pageSize: {
    kind: 'number',
    default: 500,
    min: 50,
    max: 5000,
    advancedOnly: true,
    doc: '全量扫描的分页大小。不是索引上限，调大只是少翻几页。',
  },
  includeArchived: {
    kind: 'boolean',
    default: false,
    doc: '是否把已沉底的记忆也纳入索引。默认不纳入：沉底的不该被主动认出来（但它们仍可被按类检索翻到）。',
  },
  pickEnabled: {
    kind: 'enum',
    default: 'auto',
    options: Object.freeze(['auto', 'off']),
    doc: '小模型那一路：auto（有 O-035 网关就用）／off（强制关掉，只留同步的确定性识别）。',
  },
  pickMaxTokens: {
    kind: 'number',
    default: 200,
    min: 32,
    max: 2000,
    advancedOnly: true,
    doc: '小模型输出上限。答案就是最多 8 行 slug，200 已经宽裕；调大只是给模型更多编造空间。',
  },
  pickTemperature: {
    kind: 'number',
    default: 0,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '小模型采样温度。默认 0：这是「挑哪几行」的分类任务，不是写作，随机性只会让同一句话两次识别结果不同。',
  },
  pickTimeoutMs: {
    kind: 'number',
    default: 8000,
    min: 1000,
    max: 60000,
    advancedOnly: true,
    doc: '小模型首块超时。手册说未命中整索引 + 小模型约 0.4s，8s 是给慢模型留的余量；超时即降级为「只走同步那一路」。',
  },
} as const)

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  maxEntries: FIELD_SPECS.maxEntries.default as number,
  indexBudgetTokens: FIELD_SPECS.indexBudgetTokens.default as number,
  entryCharLimit: FIELD_SPECS.entryCharLimit.default as number,
  triggersPerEntry: FIELD_SPECS.triggersPerEntry.default as number,
  maxRing: FIELD_SPECS.maxRing.default as number,
  minScore: FIELD_SPECS.minScore.default as number,
  maxSeeds: FIELD_SPECS.maxSeeds.default as number,
  indexTtlMs: FIELD_SPECS.indexTtlMs.default as number,
  pageSize: FIELD_SPECS.pageSize.default as number,
  includeArchived: FIELD_SPECS.includeArchived.default as boolean,
  pickEnabled: FIELD_SPECS.pickEnabled.default as Config['pickEnabled'],
  pickMaxTokens: FIELD_SPECS.pickMaxTokens.default as number,
  pickTemperature: FIELD_SPECS.pickTemperature.default as number,
  pickTimeoutMs: FIELD_SPECS.pickTimeoutMs.default as number,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * 双向唯一由 `settings.test` 之外的自检脚本保证（`SECTION_KEYS` 是反向表，
 * 值必须与键一样多且互不相同）。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxEntries: 'max-entries',
  indexBudgetTokens: 'index-budget-tokens',
  entryCharLimit: 'entry-char-limit',
  triggersPerEntry: 'triggers-per-entry',
  maxRing: 'max-ring',
  minScore: 'min-score',
  maxSeeds: 'max-seeds',
  indexTtlMs: 'index-ttl-ms',
  pageSize: 'page-size',
  includeArchived: 'include-archived',
  pickEnabled: 'pick-enabled',
  pickMaxTokens: 'pick-max-tokens',
  pickTemperature: 'pick-temperature',
  pickTimeoutMs: 'pick-timeout-ms',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '记忆识别',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-recognition',
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

/** 取枚举值，非法则回退。 */
function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    maxEntries: clampInt(raw['maxEntries'], DEFAULT_CONFIG.maxEntries, 20, 5000),
    indexBudgetTokens: clampInt(raw['indexBudgetTokens'], DEFAULT_CONFIG.indexBudgetTokens, 500, 64000),
    entryCharLimit: clampInt(raw['entryCharLimit'], DEFAULT_CONFIG.entryCharLimit, 12, 120),
    triggersPerEntry: clampInt(raw['triggersPerEntry'], DEFAULT_CONFIG.triggersPerEntry, 1, 8),
    maxRing: clampInt(raw['maxRing'], DEFAULT_CONFIG.maxRing, 0, 3),
    minScore: clampFloat(raw['minScore'], DEFAULT_CONFIG.minScore, 0.05, 0.95),
    maxSeeds: clampInt(raw['maxSeeds'], DEFAULT_CONFIG.maxSeeds, 1, 20),
    indexTtlMs: clampInt(raw['indexTtlMs'], DEFAULT_CONFIG.indexTtlMs, 0, 3600000),
    pageSize: clampInt(raw['pageSize'], DEFAULT_CONFIG.pageSize, 50, 5000),
    includeArchived:
      raw['includeArchived'] === undefined ? DEFAULT_CONFIG.includeArchived : raw['includeArchived'] === true,
    pickEnabled: enumOf<Config['pickEnabled']>(raw['pickEnabled'], ['auto', 'off'], DEFAULT_CONFIG.pickEnabled),
    pickMaxTokens: clampInt(raw['pickMaxTokens'], DEFAULT_CONFIG.pickMaxTokens, 32, 2000),
    pickTemperature: clampFloat(raw['pickTemperature'], DEFAULT_CONFIG.pickTemperature, 0, 1),
    pickTimeoutMs: clampInt(raw['pickTimeoutMs'], DEFAULT_CONFIG.pickTimeoutMs, 1000, 60000),
  })
}

/**
 * 向 O-005 注册配置段。注册放进 `ctx.effect` 里：段是本插件的资源，
 * 卸载时必须一起撤，否则重载后第二次注册会撞「段键已被占用」。
 *
 * 单独放在 settings 里而不是 index 里，是为了让「注册失败只告警、不阻断」
 * 这条行为跟声明表挨着——它们说的是同一件事，分开就容易只改一半。
 * @param ctx 宿主上下文（只用 `effect`）。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
export function registerSection(
  ctx: { effect(callback: () => () => void, label?: string): void },
  schema: ConfigSchemaLike,
  log: { warn(message: string, ...args: unknown[]): void },
  owner: string,
): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, owner), `${owner}: 注册配置段`)
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s',
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}
