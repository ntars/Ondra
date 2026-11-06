/**
 * O-111 `ondra-ambient` 的配置**单一真源**。
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
 * master-plan §9 参数速查里**没有**「键鼠反应」这一组（只有情绪、节奏、主动、语音、
 * 对话、界面六组）。故下面七个数值全是**本插件的工程取值**，依据是四条可观察的线：
 *
 * - 90 次/分：一个正常打字的人大约每分钟 200–300 个字符，扣除重复与停顿后落在
 *   1.5 次/秒附近。低于这个数说明手是闲着的，高于它说明人在往里灌东西。
 * - 45 秒停稳：一次「打完一段停下来想一想」通常在这个量级。短于它多半只是换气，
 *   长于它人可能已经去做别的事了。
 * - 180 秒可接话窗：停稳之后的三分钟是这个人最可能抬头的时候；再久，他已经在别处了。
 * - 10 分钟静默：与 O-105 的「离开」同量级，避免她一边说「你在」一边被护栏说「你走了」。
 *
 * ## 刻意没有的配置项（三条）
 *
 * 1. **没有「报不报次数 / 多久」。** 那是纪律不是偏好：`Reaction` 里没有任何数值字段，
 *    做成开关就等于允许「念出你刚敲了多少下」。
 * 2. **没有「忙碌时也说一句」。** 契约里 `quiet` 不给 `maySpeak`，连开关的位置都没留。
 *    忙碌时打扰是所有打扰里最典型的一种，不该是可选项。
 * 3. **没有「事件类型自定义」。** 事件是闭集，外壳只能往里填 `key` / `mouse` / `idle`。
 *    能新增就等于允许某个外壳把「应用名」也当事件发进来。
 */

import type { FieldSpecLike, SectionDeclLike, AmbientPolicy } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：不联网、不监听硬件、只有三类事件。 */
  readonly enable: boolean
  /** 判「密集」的每分钟事件数。 */
  readonly busyPerMin: number
  /** 密集输入停下后需要静默多久才算停稳（秒）。 */
  readonly settleSec: number
  /** 停稳之后可接话的窗口长度（秒）。 */
  readonly readyWindowSec: number
  /** 判「静默很久」的时长（秒）。只会得到 near。 */
  readonly idleSec: number
  /** 一段输入要连续密集多久才算「在做一件事」（秒）。 */
  readonly burstMinSec: number
  /** 同一个气泡的冷却时长（分钟）。 */
  readonly cooldownMin: number
  /** 一天最多冒几次泡。 */
  readonly dailyNudgeCap: number
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'ambient'

/** 密度的允许区间（次/分）。低于 20 会把正常打字判成空闲。 */
export const BUSY_FLOOR = 20
export const BUSY_CEILING = 600

/** 秒类字段的区间。 */
export const SECOND_FLOOR = 5
export const SECOND_CEILING = 3600

/** 冷却（分钟）的区间。 */
export const COOLDOWN_FLOOR = 1
export const COOLDOWN_CEILING = 240

/** 日上限的区间。上限就是 12——再多就不叫「冒个泡」了。 */
export const CAP_FLOOR = 1
export const CAP_CEILING = 12

/**
 * 两条事件之间的最小间隔（毫秒），**不给配**。
 *
 * 这是护栏不是偏好：外壳若把每一次 `keydown` 都送进来，本插件就拿到了一份按键节奏，
 * 而按键节奏能反推内容（击键动力学）。250 毫秒 = 每秒最多四条，够判密度，
 * 不够还原任何东西。写成配置就等于允许把这条线调回去。
 */
export const EVENT_FLOOR_MS = 250

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，但 observe() 抛 disabled，decide() 恒为 quiet。',
  },
  busyPerMin: {
    kind: 'number',
    default: 90,
    min: BUSY_FLOOR,
    max: BUSY_CEILING,
    doc: '判「密集」的每分钟事件数。越高越不容易被判成忙，也就是越不容易安静。',
  },
  settleSec: {
    kind: 'number',
    default: 45,
    min: SECOND_FLOOR,
    max: SECOND_CEILING,
    doc: '密集输入停下后需要静默多久才算「停稳」（秒）。这是 ready 唯一的来路。',
  },
  readyWindowSec: {
    kind: 'number',
    default: 180,
    min: SECOND_FLOOR,
    max: SECOND_CEILING,
    doc: '停稳之后可接话的窗口长度（秒）。窗口一过退回 near。',
  },
  idleSec: {
    kind: 'number',
    default: 600,
    min: SECOND_FLOOR,
    max: SECOND_CEILING,
    doc: '判「静默很久」的时长（秒）。只会得到 near——久不说话的人回来，第一句不该由「检测到空闲」决定。',
  },
  burstMinSec: {
    kind: 'number',
    default: 20,
    min: SECOND_FLOOR,
    max: SECOND_CEILING,
    doc: '一段输入要连续密集多久才算「真的在做一件事」（秒）。只影响诊断计数，不影响三态。',
  },
  cooldownMin: {
    kind: 'number',
    default: 20,
    min: COOLDOWN_FLOOR,
    max: COOLDOWN_CEILING,
    doc: '同一个可接话窗口里最多冒一次泡的冷却（分钟）。',
  },
  dailyNudgeCap: {
    kind: 'number',
    default: 3,
    min: CAP_FLOOR,
    max: CAP_CEILING,
    doc: '一天最多冒几次泡。再多就不叫「冒个泡」了。',
  },
})

/** 段声明。交给 O-005 做四层合并与来源追溯。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '键鼠反应',
  fields: FIELD_SPECS,
  owner: 'ondra-ambient',
})

/** 全部段键（自检按集合比对）。 */
export const SECTION_KEYS: readonly string[] = Object.freeze(
  Object.keys(FIELD_SPECS) as string[],
)

/** 默认配置。从 `FIELD_SPECS` 派生，**不手写第二份**。 */
function defaultsOf(): Config {
  return {
    enable: FIELD_SPECS.enable.default === true,
    busyPerMin: Number(FIELD_SPECS.busyPerMin.default),
    settleSec: Number(FIELD_SPECS.settleSec.default),
    readyWindowSec: Number(FIELD_SPECS.readyWindowSec.default),
    idleSec: Number(FIELD_SPECS.idleSec.default),
    burstMinSec: Number(FIELD_SPECS.burstMinSec.default),
    cooldownMin: Number(FIELD_SPECS.cooldownMin.default),
    dailyNudgeCap: Number(FIELD_SPECS.dailyNudgeCap.default),
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
 * 顺序类约束**向上抬而不是向下压**：`idleSec` 若短于「停稳 + 可接话窗」，
 * 静默会先吃掉整个 ready 窗口，三态就退化成两态，而 `ready` 这个插件存在的理由
 * 正是那一档。所以这里把 `idleSec` 抬到 `settleSec + readyWindowSec` 之上，
 * 宁可让「静默很久」来得晚一点，也不能让它把「刚好停下来」盖掉。
 * @param value 任意配置。
 * @returns 合法配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const base = defaultsOf()

  const settleSec = clampNumber(raw.settleSec, base.settleSec, SECOND_FLOOR, SECOND_CEILING)
  const readyWindowSec = clampNumber(
    raw.readyWindowSec,
    base.readyWindowSec,
    SECOND_FLOOR,
    SECOND_CEILING,
  )
  let idleSec = clampNumber(raw.idleSec, base.idleSec, SECOND_FLOOR, SECOND_CEILING)
  const windowEnd = settleSec + readyWindowSec + 1
  if (idleSec <= windowEnd) idleSec = Math.min(SECOND_CEILING, windowEnd)

  return {
    enable: raw.enable === undefined ? base.enable : raw.enable !== false,
    busyPerMin: clampNumber(raw.busyPerMin, base.busyPerMin, BUSY_FLOOR, BUSY_CEILING),
    settleSec,
    readyWindowSec,
    idleSec,
    burstMinSec: clampNumber(raw.burstMinSec, base.burstMinSec, SECOND_FLOOR, SECOND_CEILING),
    cooldownMin: clampNumber(raw.cooldownMin, base.cooldownMin, COOLDOWN_FLOOR, COOLDOWN_CEILING),
    dailyNudgeCap: clampNumber(
      raw.dailyNudgeCap,
      base.dailyNudgeCap,
      CAP_FLOOR,
      CAP_CEILING,
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
 * 换算只在这里做一次：纯函数拿到的一律是毫秒，不让每个判定各自乘 60。
 * @param config 合法配置。
 * @returns 判定口径。
 */
export function policyOf(config: Config): AmbientPolicy {
  return {
    busyPerMin: config.busyPerMin,
    settleMs: config.settleSec * 1000,
    readyWindowMs: config.readyWindowSec * 1000,
    idleMs: config.idleSec * 1000,
    burstMinMs: config.burstMinSec * 1000,
    minGapMs: EVENT_FLOOR_MS,
  }
}
