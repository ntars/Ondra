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
 * 数值来源分两类，逐条写明，不混：
 *
 * **手册原值**（照抄，不改）：
 * - `extractMinChars 4` / `extractMaxChars 120`（§9.3「长度 4–120 字」）；
 * - `maxPromises 20`（§9.3「最多 20 条」）；
 * - `maxTodos 3`（§2.8「最多 3 条」）；
 * - `todoIdleDays 3`（§2.8「3 天没提起自动过期」）；
 * - `remindAheadHours 24` / `graceHours 24`（§3.4「提前 24h 提醒、宽限 24h」）；
 * - `expireGraceDays 3`（§9.3「过期 3 天清理」）；
 * - `keptDelta` / `brokenDelta`（§3.4 的四个数，见 `RELATIONSHIP_DELTAS`）。
 *
 * **本插件补的**（手册没给，写明理由）：
 * - `urgencyHorizonDays 7`：反向权重的「开始升温」窗口。手册只说「反向权重」，
 *   没给曲线；7 天是「一周内的承诺才开始催」这个直觉的量化，且可调。
 * - `urgencyFloor 0.2`：远期承诺的底。取 0.2 而不是 0，因为「还记着这件事」
 *   本身就该有一点分量——取 0 会让 7 天外的承诺在排序里彻底消失。
 * - `soonHours 2`：「一会儿」的落点。手册没给，取 2 小时（口语里「一会儿」
 *   很少指半天以上）。
 * - `promiseSalience 90`：承诺写入记忆时的显著度。手册写入打分表说「基底 30
 *   （长期类 70）」+「答应/约定 +20」，70+20=90 是**照表算出来的**，不是拍的。
 * - `maxScanRows 2000`：清理扫描的安全阀（端口没有聚合面，只能分页扫）。
 */

import type { FieldSpecLike, SectionDeclLike, RelationshipDelta } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 抽取的最短字数。默认 **4**（手册 §9.3）。 */
  readonly extractMinChars: number
  /** 抽取的最长字数。默认 **120**（手册 §9.3）。 */
  readonly extractMaxChars: number
  /** 承诺条数上限。默认 **20**（手册 §9.3）。满了**拒绝新建**，不淘汰。 */
  readonly maxPromises: number
  /** 待办条数上限。默认 **3**（手册 §2.8）。满了**拒绝新建**，不淘汰。 */
  readonly maxTodos: number
  /** 待办闲置几天过期。默认 **3**（手册 §2.8）。 */
  readonly todoIdleDays: number
  /** 过宽限期几天后转 `expired`。默认 **3**（手册 §9.3「过期 3 天清理」）。 */
  readonly expireGraceDays: number
  /** 提前多少小时提醒。默认 **24**（手册 §3.4）。 */
  readonly remindAheadHours: number
  /** 宽限多少小时。默认 **24**（手册 §3.4）。 */
  readonly graceHours: number
  /** 反向权重的升温窗口（天）。默认 **7**（本插件补，见文件头）。 */
  readonly urgencyHorizonDays: number
  /** 反向权重的底。默认 **0.2**（本插件补，见文件头）。 */
  readonly urgencyFloor: number
  /** 「一会儿」折算成多少小时。默认 **2**（本插件补，见文件头）。 */
  readonly soonHours: number
  /** 承诺写入记忆时的显著度。默认 **90**（= 长期类 70 + 答应/约定 20）。 */
  readonly promiseSalience: number
  /** 承诺写入记忆时的唤醒度。默认 0.5（中性，与 O-010 的缺省一致）。 */
  readonly promiseArousal: number
  /** 清理扫描的分页安全阀。默认 2000。 */
  readonly maxScanRows: number
  /** 是否装定时器自动清理。默认 **false**（写操作不交给定时器）。 */
  readonly autoExpire: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-prospective'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不抽取、不落库，服务以「不可用」状态注册。',
  },
  extractMinChars: {
    kind: 'number',
    default: 4,
    min: 2,
    max: 40,
    doc: '抽取的最短字数。手册 §9.3 原值 4：3 个字以内分不清「承诺」与「随口一说」。',
  },
  extractMaxChars: {
    kind: 'number',
    default: 120,
    min: 20,
    max: 600,
    doc: '抽取的最长字数。手册 §9.3 原值 120：再长的句子通常是叙述，不是承诺。',
  },
  maxPromises: {
    kind: 'number',
    default: 20,
    min: 1,
    max: 200,
    doc: '承诺条数上限（手册 §9.3 原值 20）。到上限拒绝新建并报出来，不淘汰旧的——删一条承诺等于替用户决定哪件事不重要。',
  },
  maxTodos: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 20,
    doc: '待办条数上限（手册 §2.8 原值 3）。到上限拒绝新建并提示先清理，与核心池上限 32 同一条纪律。',
  },
  todoIdleDays: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 30,
    doc: '待办几天没被提起就过期（手册 §2.8 原值 3 天）。',
  },
  expireGraceDays: {
    kind: 'number',
    default: 3,
    min: 0,
    max: 90,
    doc: '过了宽限期几天后把仍未结算的承诺转成 expired（手册 §9.3「过期 3 天清理」）。',
  },
  remindAheadHours: {
    kind: 'number',
    default: 24,
    min: 0,
    max: 240,
    doc: '提前多少小时提醒（手册 §3.4 原值 24）。',
  },
  graceHours: {
    kind: 'number',
    default: 24,
    min: 0,
    max: 240,
    doc: '宽限多少小时（手册 §3.4 原值 24）。宽限内仍算「来得及」，不判违约。',
  },
  urgencyHorizonDays: {
    kind: 'number',
    default: 7,
    min: 1,
    max: 90,
    advancedOnly: true,
    doc: '反向权重从「底」升到「1」的窗口。手册未给曲线，本插件取 7 天并登记为待裁决。',
  },
  urgencyFloor: {
    kind: 'number',
    default: 0.2,
    min: 0,
    max: 0.9,
    advancedOnly: true,
    doc: '远期承诺的紧迫度底。取 0.2 而非 0：还记着这件事本身就该有点分量。',
  },
  soonHours: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 24,
    advancedOnly: true,
    doc: '「一会儿」折算成多少小时。手册未给，取 2 小时。',
  },
  promiseSalience: {
    kind: 'number',
    default: 90,
    min: 0,
    max: 100,
    advancedOnly: true,
    doc: '承诺的显著度。手册写入打分表：长期类基底 70 + 答应/约定 20 = 90。',
  },
  promiseArousal: {
    kind: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '承诺的唤醒度。取 0.5 中性，与 O-010 的缺省一致。',
  },
  maxScanRows: {
    kind: 'number',
    default: 2000,
    min: 50,
    max: 100000,
    advancedOnly: true,
    doc: '清理扫描的分页安全阀。端口没有聚合面，只能分页扫；到顶就停并告警，不静默半扫。',
  },
  autoExpire: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '是否装定时器自动清理。默认 false：清理是写操作，时机该由 O-033 回合边界或 O-019 夜巡显式给。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  extractMinChars: FIELD_SPECS.extractMinChars.default as number,
  extractMaxChars: FIELD_SPECS.extractMaxChars.default as number,
  maxPromises: FIELD_SPECS.maxPromises.default as number,
  maxTodos: FIELD_SPECS.maxTodos.default as number,
  todoIdleDays: FIELD_SPECS.todoIdleDays.default as number,
  expireGraceDays: FIELD_SPECS.expireGraceDays.default as number,
  remindAheadHours: FIELD_SPECS.remindAheadHours.default as number,
  graceHours: FIELD_SPECS.graceHours.default as number,
  urgencyHorizonDays: FIELD_SPECS.urgencyHorizonDays.default as number,
  urgencyFloor: FIELD_SPECS.urgencyFloor.default as number,
  soonHours: FIELD_SPECS.soonHours.default as number,
  promiseSalience: FIELD_SPECS.promiseSalience.default as number,
  promiseArousal: FIELD_SPECS.promiseArousal.default as number,
  maxScanRows: FIELD_SPECS.maxScanRows.default as number,
  autoExpire: FIELD_SPECS.autoExpire.default as boolean,
})

/**
 * 结算的关系增量（手册 §3.4 原值，**不是本插件拍的**）。
 *
 * 违约罚 `{trust−0.05, warmth−0.03, tension+0.04}`；
 * 履约奖 `{trust+0.02, warmth+0.02}`（张力不变，故给 0）。
 *
 * 本插件只把这份增量交出去，**不写情绪**（关系域归 O-026）。
 */
export const RELATIONSHIP_DELTAS: Readonly<Record<'kept' | 'broken', RelationshipDelta>> = Object.freeze({
  kept: Object.freeze({ trust: 0.02, warmth: 0.02, tension: 0 }),
  broken: Object.freeze({ trust: -0.05, warmth: -0.03, tension: 0.04 }),
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
  extractMinChars: 'extract-min-chars',
  extractMaxChars: 'extract-max-chars',
  maxPromises: 'max-promises',
  maxTodos: 'max-todos',
  todoIdleDays: 'todo-idle-days',
  expireGraceDays: 'expire-grace-days',
  remindAheadHours: 'remind-ahead-hours',
  graceHours: 'grace-hours',
  urgencyHorizonDays: 'urgency-horizon-days',
  urgencyFloor: 'urgency-floor',
  soonHours: 'soon-hours',
  promiseSalience: 'promise-salience',
  promiseArousal: 'promise-arousal',
  maxScanRows: 'max-scan-rows',
  autoExpire: 'auto-expire',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '承诺与待办',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-prospective',
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

/** 夹一个浮点。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const extractMinChars = clampInt(raw['extractMinChars'], DEFAULT_CONFIG.extractMinChars, 2, 40)
  // 长度上下界必须保序，否则「min > max」会让所有句子都被拒，且日志里看不出原因。
  const extractMaxChars = Math.max(
    extractMinChars + 1,
    clampInt(raw['extractMaxChars'], DEFAULT_CONFIG.extractMaxChars, 20, 600),
  )
  const urgencyFloor = clampFloat(raw['urgencyFloor'], DEFAULT_CONFIG.urgencyFloor, 0, 0.9)
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    extractMinChars,
    extractMaxChars,
    maxPromises: clampInt(raw['maxPromises'], DEFAULT_CONFIG.maxPromises, 1, 200),
    maxTodos: clampInt(raw['maxTodos'], DEFAULT_CONFIG.maxTodos, 1, 20),
    todoIdleDays: clampInt(raw['todoIdleDays'], DEFAULT_CONFIG.todoIdleDays, 1, 30),
    expireGraceDays: clampInt(raw['expireGraceDays'], DEFAULT_CONFIG.expireGraceDays, 0, 90),
    remindAheadHours: clampInt(raw['remindAheadHours'], DEFAULT_CONFIG.remindAheadHours, 0, 240),
    graceHours: clampInt(raw['graceHours'], DEFAULT_CONFIG.graceHours, 0, 240),
    urgencyHorizonDays: clampInt(raw['urgencyHorizonDays'], DEFAULT_CONFIG.urgencyHorizonDays, 1, 90),
    urgencyFloor,
    soonHours: clampInt(raw['soonHours'], DEFAULT_CONFIG.soonHours, 1, 24),
    promiseSalience: clampInt(raw['promiseSalience'], DEFAULT_CONFIG.promiseSalience, 0, 100),
    promiseArousal: clampFloat(raw['promiseArousal'], DEFAULT_CONFIG.promiseArousal, 0, 1),
    maxScanRows: clampInt(raw['maxScanRows'], DEFAULT_CONFIG.maxScanRows, 50, 100000),
    autoExpire: raw['autoExpire'] === undefined ? DEFAULT_CONFIG.autoExpire : raw['autoExpire'] === true,
  })
}
