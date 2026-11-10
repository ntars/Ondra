/**
 * O-039 `ondra-rhythm-typing`：打字速度、首条延迟、长停顿、自我修正的**执行层**。
 *
 * ## 为什么和 O-038 分成两个插件
 *
 * O-038 是**纯函数**（分条与停顿的计算），本插件是**时间线**（等待、发送、取消、
 * 阶段上报）。分开的理由不是「代码多」，而是失败域不同：
 *
 * - 分条算错 → 她发 5 条、每条 60 字。功能还在，只是不好看。
 * - 计时坏掉 → 她一句话都不发，或者取消之后还在发。**对话断了**。
 *
 * 合成一个包，第二种故障会连累第一种的调试——日志里全是「发送超时」，
 * 没人看得出分条其实是对的。
 *
 * ## 明确不做
 *
 * - **不分条、不算延迟**：那是 O-038，本插件一个字都不复制（§18.4 同一能力只 provide 一次）。
 * - **不显示「正在输入」**：本插件只发阶段事件，UI 归 O-041 `ondra-breath`。
 * - **不做限流与重试**：各通道语义不同（QQ 被动回复带 `msg_id`、微信客服 48 小时窗口），
 *   归各适配器自己。
 * - **不改正文**：`steps[].text` 逐字来自 O-038 的计划。
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
import type { Config as TypingConfig } from './settings.js'
import { Typing } from './service.js'
import { NAME_RE, TYPING_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  RhythmServiceLike,
  TypingService,
} from './types.js'

export type * from './types.js'
export { TYPING_SERVICE_KEY, NAME_RE } from './types.js'
export { CONFIG_SECTION_ID } from './settings.js'
export { sleep } from './runner.js'
export { Typing } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-rhythm-typing'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-rhythm-typing: 注册配置段')
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
    /** 打字执行服务；未装载本插件时为 undefined。 */
    'ondra-rhythm-typing'?: TypingService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject` 里有 O-038 缺席，整个插件会停在 PENDING
 * （静默不加载）——而「没有节奏服务」的正确表现是「一次性整段发出」，
 * 不是「她一句话都不发」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: TypingConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('rhythm-typing') : 'ondra.rhythm-typing')

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

  // 3. 依赖用取值函数：O-038 晚装载能自愈，早卸载立刻反映。
  const typing = new Typing({
    settings,
    log,
    rhythm: () => ctx.get('ondra-rhythm') as RhythmServiceLike | undefined,
    now: () => Date.now(),
  })

  // 4. 卸载时必须先停掉在跑的轮次，再撤服务：
  //    否则定时器还在，回调会对着已经不存在的通道发消息。
  ctx.effect(
    () => {
      const removeService = ctx.provide(TYPING_SERVICE_KEY, typing)
      return () => {
        typing.dispose()
        removeService()
      }
    },
    'ondra-rhythm-typing: 注册打字执行服务',
  )

  // 5. 报一次现状。
  log.info(
    '打字执行就绪：默认会话 %s，长停顿判定 ≥%dms（报 paused），刚醒缓冲 %dms，阶段事件 %s',
    settings.conversationId,
    settings.longPauseThresholdMs,
    settings.wakeBufferMs,
    settings.emitPhaseEvents ? '开' : '关',
  )
  if (!settings.enable) {
    log.warn('打字执行已关闭（enable=false）：服务照常注册，但 run() 退回一次性整段发出')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-rhythm') === undefined) {
    log.warn('节奏服务未装载：所有回合都会一次性整段发出（不模拟打字）')
  }
  if (settings.wakeBufferMs > 0) {
    log.info('刚醒缓冲已设为 %dms，但只有调用方传 justWoke=true 时才生效（信号源归 O-049）', settings.wakeBufferMs)
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
    ) => { readonly value: TypingConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值丢弃、越界夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
