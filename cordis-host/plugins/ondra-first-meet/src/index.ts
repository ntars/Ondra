/**
 * O-107 `ondra-first-meet`：初见剧本（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 把「第一次见面」切成五拍——到场 / 自我介绍 / 立边界 / 邀请 / 收束，
 * 每一拍只给**目的、必须做到的事、绝对不许做的事、句数上限**。
 * 一个字的话术都不给：话术归人格（O-020）与表达（O-047）。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不出台词。** 一旦这里出现「你好呀，我是……」，人格就有第二份声音来源，
 *   而那份声音不经过冻结前缀（O-033）与九步过滤（O-037）。
 * - **不主动发消息。** 谁来调用、什么时候说，归 O-042 与外壳；
 *   本插件只回答「下一拍该做什么」。自己开口就绕过了静默时段与日额度。
 * - **不存对方说的话。** 存档里只有节拍水位与时刻。初见那天人往往说真名、
 *   说处境——那些归记忆系统（O-010），有它自己的可见性与遗忘权（O-103）。
 * - **不替 O-045 出首条消息。** `firstMessage()` 在 `ondra-onboarding` 里；
 *   这里再吐一份就有了两个真源，而她到底说哪一句取决于谁先被调用。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（身份 / 时钟 / 路径 / 配置），故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as FirstMeetConfig } from './settings.js'
import { FirstMeet } from './service.js'
import { FIRST_MEET_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  FirstMeetService,
  IdentityLike,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  FIRST_MEET_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  BEAT_IDS,
  FirstMeetError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  SENTENCE_CAP_FLOOR,
  SENTENCE_CAP_CEILING,
  completeConfig,
} from './settings.js'
export { allBeats, beatAt, noteOf } from './beats.js'
export {
  emptyState,
  normalizeState,
  advanceState,
  interruptState,
  skipAllState,
  snapshotOf,
} from './progress.js'
export type { MeetState } from './progress.js'
export { FirstMeet } from './service.js'
export type { FirstMeetDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-first-meet'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：初见最容易顺手接上「人格装配 + 主动发送」，
 * 接上之后它就变成一条能自己开口的路径，而那条路径不经过任何节制闸。
 */

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-first-meet: 注册配置段')
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
    /** 初见剧本服务；未装载本插件时为 undefined。 */
    'ondra-first-meet'?: FirstMeetService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: FirstMeetConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('first-meet') : 'ondra.first_meet')

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
          // 回退是静默的危险动作：不报数等于埋雷（O-005 原话）。
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 建服务。时钟与路径都用取值函数：上游晚装载时能自愈，早卸载时立刻退回降级。
  const service = new FirstMeet({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(FIRST_MEET_SERVICE_KEY, service), 'ondra-first-meet: 注册初见剧本服务')

  // 4. 报一次现状。句数天花板与总拍数必须能被自检读到，不许黑箱。
  log.info(
    '初见剧本就绪：%s（%d 拍，单拍句数上限 %d；只给约束不给台词）',
    service.available ? '可用' : '不可用',
    service.beats().length,
    settings.maxSentencesCap,
  )
  if (!settings.enable) {
    log.warn('初见剧本已关闭（enable=false）：服务照常注册，advance() / reset() 一律抛 disabled')
  }
  if (!settings.autoStart) {
    log.warn('自动初见已关闭（auto-start=false）：plan() 返回空节拍，需要时再打开')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。三个字段都能安全补全
 * （数字越界夹到 1–3），因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: FirstMeetConfig } | { readonly issues: readonly { readonly message: string }[] }
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
