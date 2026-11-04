/**
 * O-117 `ondra-cocreate`：共创流程（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 两个人一起做出点什么时的分工与轮次。四拍固定序——**立题 / 出稿 / 提意见 / 收束**，
 * 每一拍只给**该谁开口、要解决什么、必须做到什么、绝对不许做什么**。
 * 一个字的内容都不生成：内容归对话链（O-033）。
 *
 * ## 它刻意不做什么（六条）
 *
 * - **不生成内容。** 一旦这里出现示例段落，共创就有了第二份内容来源，
 *   而那份来源不经过冻结前缀（O-033）与九步过滤（O-037）。
 * - **不存作品正文。** 目标与交接备注**只校验、不留存**，只记字符数。
 *   正文归调用方与 O-010 记忆，那里有它自己的可见性与遗忘权（O-103）。
 * - **不替人定稿。** `final` 在类型上就是字面量 `false`——本插件没有「已定稿」这个状态。
 *   收束拍只做一件事：逼调用方原话问出「这版算定稿吗」。
 * - **不允许一个人既提又改。** 角色由状态机轮换，调用方无权指定「这轮谁来改」。
 * - **不主动发消息、不装定时器。** 谁来调用、什么时候说，归 O-042 与外壳；
 *   本插件只回答「这一拍该谁做什么」。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（身份 / 时钟 / 人设 / 配置），故不声明插件级 `inject`。
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
import type { Config as CocreateConfig } from './settings.js'
import { Cocreate } from './service.js'
import { COCREATE_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  CocreateService,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PersonaCoreLike,
} from './types.js'

export type * from './types.js'
export {
  COCREATE_SERVICE_KEY,
  NAME_RE,
  ROUND_KINDS,
  CocreateError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  EDITION_FLOOR,
  EDITION_CEILING,
  NOTE_CHARS_FLOOR,
  NOTE_CHARS_CEILING,
  GOAL_MAX_CHARS,
  completeConfig,
} from './settings.js'
export { allBriefs, briefAt, noteOf } from './briefs.js'
export type { BriefInput } from './briefs.js'
export {
  idleState,
  startState,
  handoffState,
  closeState,
  ownerOf,
  kindOf,
  snapshotOf,
} from './rounds.js'
export type { SessionState, StepFail, StepResult, CloseResult } from './rounds.js'
export { Cocreate } from './service.js'
export type { CocreateDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-cocreate'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：共创最容易顺手接上「对话链 + 主动发送」，
 * 接上之后它就变成一条能自己发言的路径，而那条路径不经过任何节制闸。
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-cocreate: 注册配置段')
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
    /** 共创流程服务；未装载本插件时为 undefined。 */
    'ondra-cocreate'?: CocreateService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: CocreateConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('cocreate') : 'ondra.cocreate')

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

  // 3. 建服务。时钟与人设都用取值函数：上游晚装载时能自愈，早卸载时立刻退回降级。
  const service = new Cocreate({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    persona: () => ctx.get('ondra-persona-core') as PersonaCoreLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(COCREATE_SERVICE_KEY, service), 'ondra-cocreate: 注册共创流程服务')

  // 4. 报一次现状。版数上限必须能被自检读到，不许黑箱。
  log.info(
    '共创流程就绪：%s（版数上限 %d，交接备注上限 %d 字；只给约束不生成内容）',
    service.available ? '可用' : '不可用',
    settings.maxEditions,
    settings.noteMaxChars,
  )
  if (!settings.enable) {
    log.warn('共创流程已关闭（enable=false）：服务照常注册，open() / handoff() / close() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。三个字段都能安全补全
 * （数字越界夹进区间），因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: CocreateConfig } | { readonly issues: readonly { readonly message: string }[] }
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
