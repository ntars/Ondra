/**
 * O-034 `ondra-dialogue-protocol`：五帧协议（〔研〕自研）。
 *
 * 手册 §9.5 / master-plan §9.5 把事件帧写成**五种**而不是两种：
 * `text-delta` / `text-replace` / `crisis` / `usage` / `done`。
 * 旧项目里这五个形状散落在「会话循环产出 / 界面消费 / 通道转发」三处，
 * 于是出现两类只能靠肉眼发现的失真——`text-replace` 被当增量追加（用户看到两遍开头）、
 * `crisis` 在通道侧被静默丢掉（危机提示永远到不了用户）。
 *
 * 本插件把帧的**形状、跨帧纪律、编解码**收敛到一处，别的插件只许消费。
 *
 * 与上游的关系：不注册 `ctx.llm` 事件、不碰 `ctx.sessions`。
 * 帧是本产品自己的对外协议（给界面与通道用），与上游 agent 事件流是两层东西；
 * 把两者接在一起会让「换个通道就要改对话链」。
 *
 * **不建 Session、不写 `app_session_log`**（master-plan §6 禁令 5）。
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
// 类型名与下面的 `export const Config` 撞名，所以在这里改名导入。
import type { Config as ProtocolConfig } from './settings.js'
import { DialogueProtocol } from './service.js'
import { DIALOGUE_PROTOCOL_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, DialogueProtocolService, IdentityLike } from './types.js'

export type * from './types.js'
export {
  DIALOGUE_PROTOCOL_SERVICE_KEY,
  NAME_RE,
  FRAME_TYPES,
  STOP_REASONS,
  CRISIS_LABELS,
} from './types.js'
export { stopReasonOf, validateFrame } from './frames.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-dialogue-protocol'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 放进 `ctx.effect` 里：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(
  ctx: Context,
  schema: ConfigSchemaLike,
  log: { warn(message: string, ...args: unknown[]): void },
): boolean {
  try {
    ctx.effect(
      () => schema.register(CONFIG_SECTION, name),
      'ondra-dialogue-protocol: 注册配置段',
    )
    return true
  } catch (error) {
    // 注册失败不致命：四层合并用不上，但插件实例配置照样能跑。
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 对话帧协议服务；未装载本插件时为 undefined。 */
    'ondra-dialogue-protocol'?: DialogueProtocolService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ProtocolConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(
    identity ? identity.loggerName('dialogue-protocol') : 'ondra.dialogue-protocol',
  )

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

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 构造服务。本插件没有任何服务依赖，所以不存在「上游缺席」这条降级路径。
  const protocol = new DialogueProtocol({ settings, log })

  ctx.effect(
    () => ctx.provide(DIALOGUE_PROTOCOL_SERVICE_KEY, protocol),
    'ondra-dialogue-protocol: 注册对话帧协议',
  )

  // 4. 报一次现状。帧类型与结束原因是闭集，让自检能直接读到（§12.2 可观测）。
  log.info(
    '对话帧协议就绪：%d 种帧（%s），%d 种结束原因，空增量%s',
    protocol.frames.length,
    protocol.frames.join('/'),
    protocol.stopReasons.length,
    settings.allowEmptyDelta ? '放行' : '拒绝',
  )
  if (!settings.enable) {
    log.warn('协议已关闭（enable=false）：服务照常注册，但 create() 返回一个立刻关闭的 writer，下游拿不到任何帧')
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
    ) => { readonly value: ProtocolConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 本插件三个字段都能被安全补全，因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
