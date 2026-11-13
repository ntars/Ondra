/**
 * 配置的**单一真源**。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 四档「她多主动」怎么落成字段
 *
 * 手册 §3.3-2 要求「简单模式四档（关闭 / 缓慢 / 标准 / 快速），
 * 高级模式才露具体数值」。这里**不给「关闭」单独一个档位值**：
 * `enable=false` 就是关闭，`profile` 只留三档。两个「关」并存的下场是
 * 用户关了一个、另一个还在工作，而面板只说「已关闭」。
 *
 * 高级模式的「具体数值」是 `quotaOverride`：`0` = 跟随档位，非 0 = 直接用它。
 * 优先级写死在 `rules.quotaFor()` 一处，别在别处再判一次。
 *
 * ## `KEY_PAIRS` 必须存在
 *
 * Config 是 camelCase（`giveUpRate`），手册 §8.4 的配置键正则不认大写。
 * 段声明 / 用户层归一化 / 结果回填三处全由 `KEY_PAIRS` 派生，不手写第二份。
 */

import {
  DEFAULT_GIVE_UP_RATE,
  DEFAULT_MIN_INTERVAL_MINUTES,
  HARD_DAILY_QUOTA,
  RETREAT_AFTER_PROACTIVE,
  RETREAT_PER_DAY,
  RETREAT_SILENT_DAYS,
} from './types.js'
import type { FieldSpecLike, QuotaProfile, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`plan()` 一律 `drop/disabled`。 */
  readonly enable: boolean
  /** 额度档位（简单模式）。第四档「关闭」由 `enable` 表达。 */
  readonly profile: QuotaProfile
  /** 高级模式的具体额度。`0` = 跟随档位；上限锁 20。 */
  readonly quotaOverride: number
  /** 两次主动之间的最小间隔（分钟）。 */
  readonly minIntervalMinutes: number
  /** 性格化沉默的放弃率（0–1）。 */
  readonly giveUpRate: number
  /** 用户开口后主动说几次就改说退场句。 */
  readonly retreatAfterProactive: number
  /** 连续几天没说话就改说退场句。 */
  readonly retreatSilentDays: number
  /** 退场句每天最多几条。 */
  readonly retreatPerDay: number
  /** 拒绝与降级时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'proactive-quota'

/** 档位取值（与 `QuotaProfile` 同源，供段声明用）。 */
export const PROFILE_VALUES: readonly string[] = Object.freeze(['slow', 'standard', 'fast'])

/** 间隔下限的语义：0 = 不限制（调试用），正常部署不该这么配。 */
export const MIN_INTERVAL_FLOOR = 0

/** 间隔上限：一天。再大就等于「一天最多一条」，那件事由额度表达更清楚。 */
export const MIN_INTERVAL_CEIL = 1440

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    /*
     * 这个开关**本身不会让她闭嘴**，文案必须说实话。
     *
     * 节律的服务面只有 `patch()` / `commit()` / `surrender()` 三个方法，
     * 三个都不看 `enable`：关掉它之后额度照算、照记账，实测
     * `/api/proactive/check` 仍返回 `allow:true`、额度仍是 3。
     * 唯一能让主动彻底停下的是门控的总开关（`proactive-gate.enable`）。
     *
     * 原来写的是「plan() 一律 drop/disabled」——本插件根本没有 plan()，
     * 那句是从话由插件的说明抄过来的，抄错了一个服务。
     */
    doc: '总开关。关掉后服务照常注册，但额度与节律仍照算；想让她完全不主动说话，请关「主动闸门」的 enable。',
  },
  profile: {
    kind: 'enum',
    default: 'standard',
    values: PROFILE_VALUES,
    doc: '额度档位：slow 1 条/日 · standard 3 条/日（§9.3 原值）· fast 6 条/日。想让主动彻底停下用门控的 enable。',
  },
  quotaOverride: {
    kind: 'number',
    default: 0,
    min: 0,
    max: HARD_DAILY_QUOTA,
    advancedOnly: true,
    doc: '高级模式：直接指定每日主动条数。0 = 跟随档位。',
  },
  minIntervalMinutes: {
    kind: 'number',
    default: DEFAULT_MIN_INTERVAL_MINUTES,
    min: MIN_INTERVAL_FLOOR,
    max: MIN_INTERVAL_CEIL,
    doc: '两次主动之间的最小间隔（分钟）。手册未给，自定 90 并登记待裁决。',
    unit: '分钟',
  },
  giveUpRate: {
    kind: 'number',
    default: DEFAULT_GIVE_UP_RATE,
    min: 0,
    max: 1,
    doc: '性格化沉默的放弃率（§9.3 原值 0.30）。§5.2 写 0.35，两处不一致，登记待裁决。',
  },
  retreatAfterProactive: {
    kind: 'number',
    default: RETREAT_AFTER_PROACTIVE,
    min: 1,
    max: 10,
    doc: '用户开口后主动说几次就改说退场句（§9.3 原值 2）。',
  },
  retreatSilentDays: {
    kind: 'number',
    default: RETREAT_SILENT_DAYS,
    min: 1,
    max: 30,
    doc: '连续几天没说话就改说退场句（§9.3 原值 2）。',
  },
  retreatPerDay: {
    kind: 'number',
    default: RETREAT_PER_DAY,
    min: 0,
    max: 5,
    advancedOnly: true,
    doc: '退场句每天最多几条（§9.3 只说「一句」，上限自定）。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '拒绝与降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  profile: FIELD_SPECS.profile.default as QuotaProfile,
  quotaOverride: FIELD_SPECS.quotaOverride.default as number,
  minIntervalMinutes: FIELD_SPECS.minIntervalMinutes.default as number,
  giveUpRate: FIELD_SPECS.giveUpRate.default as number,
  retreatAfterProactive: FIELD_SPECS.retreatAfterProactive.default as number,
  retreatSilentDays: FIELD_SPECS.retreatSilentDays.default as number,
  retreatPerDay: FIELD_SPECS.retreatPerDay.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  profile: 'profile',
  quotaOverride: 'quota-override',
  minIntervalMinutes: 'min-interval-minutes',
  giveUpRate: 'give-up-rate',
  retreatAfterProactive: 'retreat-after-proactive',
  retreatSilentDays: 'retreat-silent-days',
  retreatPerDay: 'retreat-per-day',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '主动节律',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-proactive-quota',
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

/** 夹一个实数（放弃率是 0–1 的小数，取整会把它变成 0 或 1）。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 归一化档位。非法值回退默认，**绝不因为一个拼错的档名让插件不加载**。
 * @param value 原始值。
 * @param fallback 默认值。
 */
function profileOf(value: unknown, fallback: QuotaProfile): QuotaProfile {
  if (value === 'slow' || value === 'standard' || value === 'fast') return value
  return fallback
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
    profile: profileOf(raw['profile'], DEFAULT_CONFIG.profile),
    // 上限锁 20：与 O-042 的 HARD_DAILY_QUOTA 同值，两边各自锁，不互相引用。
    quotaOverride: clampInt(raw['quotaOverride'], DEFAULT_CONFIG.quotaOverride, 0, HARD_DAILY_QUOTA),
    minIntervalMinutes: clampInt(
      raw['minIntervalMinutes'],
      DEFAULT_CONFIG.minIntervalMinutes,
      MIN_INTERVAL_FLOOR,
      MIN_INTERVAL_CEIL,
    ),
    giveUpRate: clampFloat(raw['giveUpRate'], DEFAULT_CONFIG.giveUpRate, 0, 1),
    retreatAfterProactive: clampInt(raw['retreatAfterProactive'], DEFAULT_CONFIG.retreatAfterProactive, 1, 10),
    retreatSilentDays: clampInt(raw['retreatSilentDays'], DEFAULT_CONFIG.retreatSilentDays, 1, 30),
    retreatPerDay: clampInt(raw['retreatPerDay'], DEFAULT_CONFIG.retreatPerDay, 0, 5),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}
