/**
 * O-048 `ondra-life-rhythm`：她今天自己干了什么 + 她现在还剩多少力气。
 *
 * ## 为什么两件事挤在一个插件里
 *
 * 台账原文写「生活层并入本插件（失败域与作息重合，不单独开插件）」。它们的
 * 失败域确实重合：都靠「时间往前走」、都要一份落盘状态、都要在面板上说清
 * 「为什么现在是这个样子」。拆成两个包的下场是「她困了所以不活动」这句判定
 * 被写在两处，而两处迟早不一致。
 *
 * ## 只有一个定时器
 *
 * `clock.every(5 分钟)` 一个入口，里面先结算能量再判要不要活动。
 * **没有 `setInterval`**、没有子进程、没有常驻循环——卸载即停（`ctx.effect`）。
 * 台账写的「独立脚本进程」与 master-plan §12.4「禁止常驻后台服务」冲突，
 * 按 §12.4 执行，冲突记在 README。
 *
 * ## 心情是「读得到就用，读不到就当没有」
 *
 * 只按结构对位去读 `ondra-emotion-core` 的 `axes.pleasure`（0–1），
 * 全程 try/catch。读不到时按中性处理——**绝不把「读不到」当成「心情差」**，
 * 否则情绪插件一卸载，她就天天只刷视频。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as LifeConfig } from './settings.js'
import { Life } from './service.js'
import { NAME_RE, LIFE_SERVICE_KEY, STEP_MINUTES } from './types.js'
import type { ClockLike, ConfigSchemaLike, IdentityLike, LifeService, LogLike, PathLike } from './types.js'

export type * from './types.js'
export {
  LIFE_SERVICE_KEY,
  NAME_RE,
  STATE_FILE,
  WAKE_RATE,
  SLEEP_RATE,
  DEEP_BELOW,
  NATURAL_CAP,
  STEP_MINUTES,
  MAX_SEGMENTS,
  SLEEP_BUFFER_MINUTES,
  SLEEP_BUFFER_TEXT,
  ACTIVITY_KINDS,
  INTEREST_TAGS,
  KIND_ZH,
  TAG_ZH,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  HHMM_RE,
  EVERY_MIN,
  EVERY_MAX,
  DECAY_MIN,
  DECAY_MAX,
  NOTES_MIN,
  NOTES_MAX,
  completeConfig,
  configDriftOf,
} from './settings.js'
export { clampEnergy, emptyEnergy, asleepOf, rateOf, settleEnergy, takeBuffer } from './energy.js'
export type { EnergyDeps, EnergyState, SettleResult } from './energy.js'
export { hash32, slotOf, unitOf } from './seed.js'
export {
  SEED_INTERESTS,
  EXPLORE_POOL,
  KINDS_BY_TAG,
  DURATION_MIN,
  WEIGHT_CEIL,
  WEIGHT_FLOOR,
  WEIGHT_GROW,
  buildInterest,
  effectiveWeightOf,
  idOf,
  moodFactorOf,
  noteTextOf,
  pickActivity,
  retentionOf,
  viewOf,
} from './activities.js'
export type { PickOptions, PickResult, SeedInterest } from './activities.js'
export { MAX_INTERESTS, STATE_VERSION, emptyState, normalizeState, readState, writeState } from './store.js'
export type { LifeState } from './store.js'
export { Life } from './service.js'
export type { LifeDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-life-rhythm'

/** 启动后多久补跑一次（毫秒）。装载期宿主正忙，先让首屏过去。 */
export const STARTUP_DELAY_MS = 20_000

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 从情绪服务读心情（0–1）。
 *
 * 只按结构对位取 `state().axes.pleasure`，**不 import 对方源码**（§15.5）。
 * 任何一个环节形状不对就返回 `undefined`——「读不到」必须与「心情差」区分开。
 * @param ctx 宿主上下文。
 * @param at 时刻。
 */
function moodOf(ctx: Context, at: number): number | undefined {
  const emotion = ctx.get('ondra-emotion-core') as
    | { state?: (at?: number) => unknown }
    | undefined
  if (emotion === undefined || typeof emotion.state !== 'function') return undefined
  try {
    const snapshot = emotion.state(at)
    if (typeof snapshot !== 'object' || snapshot === null) return undefined
    const axes = (snapshot as { axes?: unknown }).axes
    if (typeof axes !== 'object' || axes === null) return undefined
    const pleasure = (axes as { pleasure?: unknown }).pleasure
    if (typeof pleasure !== 'number' || !Number.isFinite(pleasure)) return undefined
    return Math.min(1, Math.max(0, pleasure))
  } catch {
    return undefined
  }
}

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-life-rhythm: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 生活与作息服务；未装载本插件时为 undefined。 */
    'ondra-life-rhythm'?: LifeService
  }
}

/**
 * Cordis 入口：解析配置、建服务、排一个定时器。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: LifeConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('life') : 'ondra.life')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 时间与路径：两者都软。时钟缺席时能量不结算、活动不排；路径缺席时纯内存。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  const path = ctx.get('ondra-path-layout') as PathLike | undefined

  const life = new Life({
    settings,
    log,
    clock,
    path,
    mood: () => moodOf(ctx, clock === undefined ? Date.now() : clock.now()),
    now: () => (clock === undefined ? Date.now() : clock.now()),
  })

  ctx.effect(() => ctx.provide(LIFE_SERVICE_KEY, life), 'ondra-life-rhythm: 注册生活与作息服务')

  // 4. 唯一的定时入口。一次 tick 同时结算能量与判活动。
  if (clock !== undefined) {
    ctx.effect(
      () =>
        clock.every(STEP_MINUTES * 60_000, () => {
          try {
            const result = life.tick()
            if (result.note !== undefined && settings.verbose) {
              log.debug('生活：%s（%d 分钟，%s）', result.note.text, result.started?.minutes ?? 0, result.note.retention)
            }
          } catch (error) {
            // 定时器回调抛错会打断后续触发；这里兜住，最多这一次不记。
            log.warn('生活 tick 失败（下一次照常）：%s', messageOf(error))
          }
        }),
      'ondra-life-rhythm: 每 5 分钟结算一次',
    )
    ctx.effect(
      () =>
        clock.after(STARTUP_DELAY_MS, () => {
          try {
            life.tick()
          } catch (error) {
            log.warn('启动补跑失败：%s', messageOf(error))
          }
        }),
      'ondra-life-rhythm: 启动补跑',
    )
  }

  // 5. 报一次现状：能量、兴趣数、落盘、心情来源，都要能被自检读到（§12.2）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：作息时段与间隔可能因此不是你设的数', drift.join(' / '))
  }

  const view = life.settle()
  log.info(
    '生活与作息就绪：能量 %s（%s）· 兴趣 %d 个 · 间隔 %d 分钟 · 休息 %s–%s · 状态 %s',
    String(view.energy),
    view.frozen ? '急停冻结' : view.asleep ? '在睡' : '清醒',
    life.interests().length,
    settings.activityEveryMinutes,
    settings.restStart,
    settings.restEnd,
    life.stored ? '已落盘' : '仅内存（重启会丢）',
  )

  if (!settings.enable) {
    log.warn('生活与作息已关闭（enable=false）：服务照常注册，plan() 一律 disabled')
  }
  if (clock === undefined) {
    log.warn('时间服务未装载：能量不结算、活动不排（分段积分需要「几点」）')
  }
  if (path === undefined) {
    log.warn('路径服务未装载：状态只在内存，重启后她会忘记今天干了什么')
  }
  if (ctx.get('ondra-emotion-core') === undefined) {
    log.info('情绪服务未装载：心情按中性处理（不会因此判定为「心情差」）')
  }
  if (!settings.enableEnergy) {
    log.info('能量系统已关闭：只做生活层，energy() 返回存档读数且速率恒 0')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: LifeConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值回退默认、数值夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
