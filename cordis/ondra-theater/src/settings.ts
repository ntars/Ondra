/**
 * O-112 `ondra-theater` 的配置**单一真源**。
 *
 * 与 O-005 的口径一致：默认值由声明方拥有、全仓只存一份。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 这些数从哪来（**必须写清，否则就是拍脑袋**）
 *
 * master-plan §9 参数速查里**没有**「多角色剧场」这一组——那里只有情绪、节奏、主动、
 * 语音、对话、界面六组。故下面四个数值全是**本插件的工程取值**，依据是三条可观察的线：
 *
 * - 6 轮：三人场 = 18 句。再长下去，同一个话题会被说三遍（每一轮都在复述上一轮的结论），
 *   而观众读到的不是热闹，是重复。
 * - 2 句/人：一次发言超过两句，就变成「一段独白 + 一句回应」，
 *   第二个角色只剩「嗯」的份——那已经退化成独白了，只是还没被第一条裁决拦下。
 * - 120 秒冷场：一段多人对话的正常停顿是秒级到十几秒；两分钟没人接，
 *   说明这一场已经被别的事情打断，继续挂着只会让下一句接在半分钟前的空气上。
 * - 4 人：见 `types.ts` 的 `MAX_ROLES`。**配置只能往下压**。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「允许同一人连说」。** 那是裁决不是偏好：打开它，第二个角色就再没有开口的理由，
 *    而劣化成独白是悄悄发生的（见 `types.ts` 第一条）。
 * 2. **没有「离场」开关。** 契约里根本没有 `leave()`；配一个开关就等于把那个方法放回来。
 * 3. **没有「角色台词长度」。** 本插件不出台词，句数上限是给下游的约束，不是长度配置。
 */

import { MAX_ROLES, MIN_ROLES } from './types.js'
import type { FieldSpecLike, SectionDeclLike, StagePolicy } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：纯内存状态机，不起任务、不联网。 */
  readonly enable: boolean
  /** 角色数上限。**天花板 4**，配置只能往下压。 */
  readonly maxRoles: number
  /** 轮数上限。 */
  readonly maxRounds: number
  /** 每句句数上限。 */
  readonly maxSentences: number
  /** 冷场判据（秒）：距上一句超过它就走「该散了」。 */
  readonly disperseSec: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'theater'

/** 轮数的允许区间。低于 1 就是「开场即收场」。 */
export const ROUNDS_FLOOR = 1
export const ROUNDS_CEILING = 12

/** 句数上限的允许区间。高于 4 句就已经是一段独白了。 */
export const SENTENCE_FLOOR = 1
export const SENTENCE_CEILING = 4

/** 冷场判据的允许区间（秒）。低于 30 秒会把正常的思考停顿当成散场。 */
export const DISPERSE_FLOOR = 30
export const DISPERSE_CEILING = 1800

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 open() / next() / advance() 一律抛 disabled。',
  },
  maxRoles: {
    kind: 'number',
    default: MAX_ROLES,
    min: MIN_ROLES,
    max: MAX_ROLES,
    doc: '角色数上限。硬天花板是 4，配置只能往下压——超过 4 人同场，每一轮都要等四下。',
  },
  maxRounds: {
    kind: 'number',
    default: 6,
    min: ROUNDS_FLOOR,
    max: ROUNDS_CEILING,
    doc: '轮数上限。轮数 × 座位数就是本场的总句数上限，这是第一条收束条件。',
  },
  maxSentences: {
    kind: 'number',
    default: 2,
    min: SENTENCE_FLOOR,
    max: SENTENCE_CEILING,
    doc: '每句句数上限。超过两句就变成「一段独白 + 一句回应」，第二个角色只剩「嗯」的份。',
  },
  disperseSec: {
    kind: 'number',
    default: 120,
    min: DISPERSE_FLOOR,
    max: DISPERSE_CEILING,
    doc: '冷场判据（秒）。距上一句超过它就走「该散了」，这是第二条收束条件。',
  },
})

/** 段声明。交给 O-005 做四层合并与来源追溯。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '多角色剧场',
  fields: FIELD_SPECS,
  owner: 'ondra-theater',
})

/** 全部段键（自检按集合比对）。 */
export const SECTION_KEYS: readonly string[] = Object.freeze(
  Object.keys(FIELD_SPECS) as string[],
)

/** 默认配置。从 `FIELD_SPECS` 派生，**不手写第二份**。 */
function defaultsOf(): Config {
  return {
    enable: FIELD_SPECS.enable.default === true,
    maxRoles: Number(FIELD_SPECS.maxRoles.default),
    maxRounds: Number(FIELD_SPECS.maxRounds.default),
    maxSentences: Number(FIELD_SPECS.maxSentences.default),
    disperseSec: Number(FIELD_SPECS.disperseSec.default),
  }
}

/** 默认配置（只读外观）。 */
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze(defaultsOf())

/** 把任意值夹到闭区间；非有限数回退默认。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  if (num < min) return min
  if (num > max) return max
  return Math.round(num)
}

/**
 * 补全配置。**永不抛错**：配置错不该让插件不加载。
 *
 * `maxRoles` 的上下界就是 `MIN_ROLES` / `MAX_ROLES`，因此「硬上限 4」在配置层面
 * 也不可能被绕过——写 8 会被夹回 4，而不是被拒绝。
 * @param value 任意配置。
 * @returns 合法配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const base = defaultsOf()

  return {
    enable: raw.enable === undefined ? base.enable : raw.enable !== false,
    maxRoles: clampNumber(raw.maxRoles, base.maxRoles, MIN_ROLES, MAX_ROLES),
    maxRounds: clampNumber(raw.maxRounds, base.maxRounds, ROUNDS_FLOOR, ROUNDS_CEILING),
    maxSentences: clampNumber(
      raw.maxSentences,
      base.maxSentences,
      SENTENCE_FLOOR,
      SENTENCE_CEILING,
    ),
    disperseSec: clampNumber(
      raw.disperseSec,
      base.disperseSec,
      DISPERSE_FLOOR,
      DISPERSE_CEILING,
    ),
  }
}

/** 只保留已知字段，丢掉陌生键（四层合并的 user 层用）。**入参可以是任意值。** */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === null || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(FIELD_SPECS)) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/** 把 O-005 的扁平值表还原成配置形状。 */
export function valuesToConfigShape(
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...values }
}

/**
 * 配置 → 判定口径（毫秒）。
 *
 * 换算只在这里做一次：纯函数拿到的一律是毫秒，不让每个判定各自乘 1000。
 * @param config 合法配置。
 * @returns 判定口径。
 */
export function policyOf(config: Config): StagePolicy {
  return {
    maxRoles: config.maxRoles,
    maxRounds: config.maxRounds,
    maxSentences: config.maxSentences,
    disperseMs: config.disperseSec * 1000,
  }
}
