/**
 * O-105 `ondra-digital-health` 的配置**单一真源**。
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
 * ## 阈值从哪来（**必须写清，否则就是拍脑袋**）
 *
 * 手册与 master-plan 都**没有**给数字健康阈值——§9 参数速查里只有情绪、
 * 节奏、主动、语音、对话、界面六组。故下面八个字段的默认值全部是
 * **本插件的工程取值**，依据是三条公开的通行做法（详见 README §9 技术来源）：
 *
 * - 连续用眼 90 分钟歇一次：20-20-20 法则的放宽版（20 分钟太密，对写作类
 *   工作会变成骚扰；90 分钟是常见番茄工作法的两轮）；
 * - 连续 150 分钟强制收工：超过两个半小时的连续段，人的自我评估已经不可靠；
 * - 当日累计 480 分钟：八小时工作日的自然上界。
 *
 * 这三条**不是医学结论**，只是工程默认值。主人要给产品口径，只改这一处。
 *
 * ## 刻意没有的配置项（四条）
 *
 * 1. **没有「关闭某一类信号」的勾选。** 关掉深夜提醒之后，深夜就成了唯一
 *    没有护栏的时段——而它恰恰是最需要的那个。
 * 2. **没有「健康分阈值」。** 本插件不出分（见 `types.ts` 纪律 5）。
 * 3. **没有「打点间隔」。** 打点由调用方按真实活动触发；配一个间隔，
 *    就等于允许「每 60 秒假装活跃一次」把连续时长刷上去。
 * 4. **没有「强制锁屏」开关。** 锁屏不是护栏，是家长控制；本插件只劝，
 *    不做执行者。这一条也是 §17 第 6 条「不做假开关」的延伸。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。**默认 true**：纯判定 + 一个本地 JSON，不发网络。 */
  readonly enable: boolean
  /** 连续使用到这个分钟数，进入 `gentle` 档。 */
  readonly sessionWarnMinutes: number
  /** 连续使用到这个分钟数，进入 `stop` 档。必须大于 `sessionWarnMinutes`。 */
  readonly sessionStopMinutes: number
  /** 当日累计到这个分钟数，至少进入 `gentle` 档。 */
  readonly dailyWarnMinutes: number
  /** 中断多久算一次休息（分钟）。低于它的间隔不切段。 */
  readonly breakMinutes: number
  /** 同一档位两次提醒之间的最短间隔（分钟）。 */
  readonly nudgeCooldownMinutes: number
  /** 深夜窗起点 `HH:MM`（含）。 */
  readonly lateNightStart: string
  /** 深夜窗终点 `HH:MM`（不含）。与起点相同视为空窗，不解释成整天。 */
  readonly lateNightEnd: string
}

/** 段键。与插件名后缀一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'digital-health'

/** `HH:MM` 的合法形状。**不做时区解释**，只是形状校验。 */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务仍注册，pulse() / ack() 抛 disabled，读数照常可读。',
  },
  sessionWarnMinutes: {
    kind: 'number',
    default: 90,
    min: 15,
    max: 600,
    doc: '连续使用到多少分钟开始劝。默认 90（番茄工作法两轮）。',
  },
  sessionStopMinutes: {
    kind: 'number',
    default: 150,
    min: 30,
    max: 720,
    doc: '连续使用到多少分钟进入「该收工了」档。必须大于上一个字段。',
  },
  dailyWarnMinutes: {
    kind: 'number',
    default: 480,
    min: 60,
    max: 1440,
    doc: '当日累计到多少分钟开始劝。默认 480（八小时）。',
  },
  breakMinutes: {
    kind: 'number',
    default: 5,
    min: 1,
    max: 60,
    advancedOnly: true,
    doc: '中断多久算一次休息。低于它的间隔不切段——切个窗口不算休息。',
  },
  nudgeCooldownMinutes: {
    kind: 'number',
    default: 45,
    min: 5,
    max: 240,
    advancedOnly: true,
    doc: '同一档位两次提醒的最短间隔。防的是「每轮都劝一次」那种骚扰。',
  },
  lateNightStart: {
    kind: 'string',
    default: '00:30',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    doc: '深夜窗起点（含）。比主动静默时段 23:00–08:00 窄，因为这里管的是「还在用」。',
  },
  lateNightEnd: {
    kind: 'string',
    default: '05:00',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    doc: '深夜窗终点（不含）。与起点相同视为空窗，不会变成整天。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  sessionWarnMinutes: FIELD_SPECS.sessionWarnMinutes.default as number,
  sessionStopMinutes: FIELD_SPECS.sessionStopMinutes.default as number,
  dailyWarnMinutes: FIELD_SPECS.dailyWarnMinutes.default as number,
  breakMinutes: FIELD_SPECS.breakMinutes.default as number,
  nudgeCooldownMinutes: FIELD_SPECS.nudgeCooldownMinutes.default as number,
  lateNightStart: FIELD_SPECS.lateNightStart.default as string,
  lateNightEnd: FIELD_SPECS.lateNightEnd.default as string,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  sessionWarnMinutes: 'session-warn-minutes',
  sessionStopMinutes: 'session-stop-minutes',
  dailyWarnMinutes: 'daily-warn-minutes',
  breakMinutes: 'break-minutes',
  nudgeCooldownMinutes: 'nudge-cooldown-minutes',
  lateNightStart: 'late-night-start',
  lateNightEnd: 'late-night-end',
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
  title: '数字健康护栏',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-digital-health',
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

/**
 * 补全配置。**永不抛错**：非法值一律回退默认值。
 *
 * 唯一的跨字段修正：`sessionStopMinutes` 必须严格大于 `sessionWarnMinutes`。
 * 反过来的话「该收工了」会比「提一句」更早触发，那两档就永远只剩一档。
 * 修正方式是**把 stop 抬到 warn + 30**（不是把 warn 压下来）——压低阈值
 * 会让护栏提前叫，而人设的阈值不该因为另一个字段写错而变吵。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true
  const int = (key: keyof Config, fallback: number, min: number, max: number): number => {
    const given = raw[key]
    if (typeof given !== 'number' || !Number.isFinite(given)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(given)))
  }
  const hhmm = (key: keyof Config, fallback: string): string => {
    const given = raw[key]
    return typeof given === 'string' && HHMM_RE.test(given) ? given : fallback
  }

  const sessionWarnMinutes = int(
    'sessionWarnMinutes',
    DEFAULT_CONFIG.sessionWarnMinutes,
    15,
    600,
  )
  const rawStop = int('sessionStopMinutes', DEFAULT_CONFIG.sessionStopMinutes, 30, 720)
  const sessionStopMinutes = rawStop > sessionWarnMinutes ? rawStop : Math.min(720, sessionWarnMinutes + 30)

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    sessionWarnMinutes,
    sessionStopMinutes,
    dailyWarnMinutes: int('dailyWarnMinutes', DEFAULT_CONFIG.dailyWarnMinutes, 60, 1440),
    breakMinutes: int('breakMinutes', DEFAULT_CONFIG.breakMinutes, 1, 60),
    nudgeCooldownMinutes: int(
      'nudgeCooldownMinutes',
      DEFAULT_CONFIG.nudgeCooldownMinutes,
      5,
      240,
    ),
    lateNightStart: hhmm('lateNightStart', DEFAULT_CONFIG.lateNightStart),
    lateNightEnd: hhmm('lateNightEnd', DEFAULT_CONFIG.lateNightEnd),
  })
}
