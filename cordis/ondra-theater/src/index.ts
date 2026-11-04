/**
 * O-112 `ondra-theater`：多角色剧场（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答一句话：**「几个角色同场时，下一句该谁说？」**
 *
 * 只给调度：谁在场上、轮到谁、这一句什么意图、最多几句、哪些事不许做。
 * **零台词**——`TurnPlan` 里没有一个字段能放句子。
 *
 * ## 四条硬裁决
 *
 * 1. **同一角色不许连续两次发言。** 座位环 + 跳过刚说过的那一位，结构性地做不到连说。
 * 2. **角色数硬上限 4。** 超了当场拒绝，**不排队**（排队会让多出来的人在若干轮之后突然开口）。
 * 3. **每场必须有收束条件。** 轮数上限 + 冷场判据，任一命中即收。
 * 4. **离场必须先收束。** 契约里没有 `leave()`；换人只能 `close()` 之后重新 `open()`。
 *
 * ## 它刻意不做什么（逐条）
 *
 * - **不装配人格** → O-021 `ondra-persona-core`（本插件只读一个人设 id 当座位标签）。
 * - **不驱动对话** → O-033 `ondra-dialogue`（本插件不调用任何模型、不排队、不发消息）。
 * - **不出台词** → O-033 `ondra-dialogue` 生成 + O-037 `ondra-filter-chain` 过滤（本插件只给意图与句数上限）。
 * - **不做界面** → L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 * - **不落盘** → 场次是一次性的，重启即散场；存档会诱导「跨重启续演」。
 * - **不装定时器** → 冷场判据在被调到时按时刻现算。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（身份 / 时钟 / 人设内核 / 配置），故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as TheaterConfig } from './settings.js'
import { Theater } from './service.js'
import { MAX_ROLES, THEATER_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PersonaCoreLike,
  TheaterService,
} from './types.js'

export type * from './types.js'
export {
  THEATER_SERVICE_KEY,
  NAME_RE,
  ROLE_ID_RE,
  MAX_ROLES,
  MIN_ROLES,
  CLOSE_REASON_LIST,
  TURN_INTENT_LIST,
  MUST_NOT,
  TheaterError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  ROUNDS_FLOOR,
  ROUNDS_CEILING,
  SENTENCE_FLOOR,
  SENTENCE_CEILING,
  DISPERSE_FLOOR,
  DISPERSE_CEILING,
  completeConfig,
  policyOf,
} from './settings.js'
export {
  closeNoteOf,
  readRoles,
  openStage,
  nextSpeakerOf,
  stopReasonOf,
  nextTurnOf,
  advanceStage,
  closeStage,
  viewOf,
} from './stage.js'
export type { Stage, OpenInput } from './stage.js'
export { Theater } from './service.js'
export type { TheaterDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-theater'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：剧场最容易顺手接上两件事——
 * 「让模型按调度把台词写出来」和「到点了自动推进下一句」。
 * 前者会把 O-033 的活吞掉，后者会让插件变成常驻服务。两条都不接。
 */

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 判断是否是普通对象（配置行可能为空）。 */
function isObjectLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-theater: 注册配置段')
    return true
  } catch (error) {
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 多角色剧场服务；未装载本插件时为 undefined。 */
    'ondra-theater'?: TheaterService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: TheaterConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('theater') : 'ondra.theater')

  const raw: unknown = isObjectLike(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          // 回退是静默的危险动作：不报数等于埋雷（O-005 原话）。
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全。任何非法值都回退或夹到区间内，绝不抛。
  const settings = completeConfig(effective)

  // 3. 建服务。时钟与人设内核都用取值函数：上游晚装载能自愈，早卸载立刻退回降级。
  const service = new Theater({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    persona: () => ctx.get('ondra-persona-core') as PersonaCoreLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(THEATER_SERVICE_KEY, service), 'ondra-theater: 注册多角色剧场服务')

  // 4. 报一次现状。上限与两条收束条件必须能被自检读到，不许黑箱。
  log.info(
    '多角色剧场就绪：%s（最多 %d 人 / 最多 %d 轮 / 每句 %d 句 / 冷场 %ds 收场；只给调度不给台词）',
    service.available ? '可用' : '不可用',
    settings.maxRoles,
    settings.maxRounds,
    settings.maxSentences,
    settings.disperseSec,
  )
  if (settings.maxRoles < MAX_ROLES) {
    log.info('角色数上限已被配置压到 %d 人（硬天花板 %d）', settings.maxRoles, MAX_ROLES)
  }
  if (!settings.enable) {
    log.warn('多角色剧场已关闭（enable=false）：服务照常注册，open() / next() / advance() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。人数越界会被夹到 2–4，
 * 轮数 / 句数 / 冷场都在区间内收敛，因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: TheaterConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      return { value: completeConfig(value) }
    },
  },
}
