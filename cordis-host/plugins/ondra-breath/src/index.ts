/**
 * O-041 `ondra-breath`：「正在输入」与呼吸感动作（〔研〕自研）。
 *
 * ## 为什么是〔研〕
 *
 * 「正在输入」在生态里到处都是（每个 IM SDK 都有 typing indicator），
 * 但那些都是**通道侧的协议**（发一个 typing=true 的帧，由对方客户端渲染）。
 * 本插件要做的是**行为判定**：什么时候该发这个帧、什么时候必须撤回。
 * 手册给的那条口径（长停顿期间不显示）没有任何现成实现——因为
 * 现成的实现都假设「对方在打字」，而这里要表达的是「她在走神」。
 *
 * ## 为什么不复用 O-039
 *
 * O-039 已经把 `subscribe()` / `phaseOf()` 做出来了，那两个正是本插件唯一需要的东西，
 * 所以本插件**只接线、不重写**。真正自研的只有两件：
 *
 * 1. 阶段 → 显示与否的**一张表**（`presence.ts`，四行）；
 * 2. 单日额度 + 每动作每日去重（`quota.ts`）。
 *
 * ## 明确不做
 *
 * - **不发消息、不画界面**：只回 `show: boolean` 与一句动作文本。
 * - **不装定时器**：额度懒换日，跨零点不需要唤醒。
 * - **不给「长停顿也显示」留开关**：见 `presence.ts` 文件头。
 * - **不重试订阅**：O-039 晚装载时本次订阅不生效，写进 README 的限制。
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
import type { Config as BreathConfig } from './settings.js'
import { Breath } from './service.js'
import { BREATH_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  BreathService,
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  TypingServiceLike,
} from './types.js'

export type * from './types.js'
export {
  BREATH_SERVICE_KEY,
  NAME_RE,
  HARD_DAILY_CAP,
  HARD_MAX_ACTIONS,
  HANDBOOK_ACTION,
} from './types.js'
export { CONFIG_SECTION_ID, MAX_EXTRA_ACTIONS, completeConfig } from './settings.js'
export { isTypingPhase, normalizePhase, presenceOf, hidden } from './presence.js'
export { BreathLedger, localDayKey, quotaOf } from './quota.js'
export { Breath, normalizeActionText } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-breath'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-breath: 注册配置段')
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
    /** 呼吸感服务；未装载本插件时为 undefined。 */
    'ondra-breath'?: BreathService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：O-039 缺席时正确表现是「不显示正在输入」，
 * 而不是「整个插件停在 PENDING」。写进 `inject` 会把「没有指示器」
 * 升级成「连呼吸感额度也没有」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: BreathConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('breath') : 'ondra.breath')

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

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  //    服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§18.5）。
  const breath = new Breath({
    settings,
    log,
    typing: () => ctx.get('ondra-rhythm-typing') as TypingServiceLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(BREATH_SERVICE_KEY, breath), 'ondra-breath: 注册呼吸感服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '呼吸感就绪：正在输入 %s / 呼吸感动作 %s（单日 ≤%d 次，同动作每日一次 %s，池 %d 条）',
    settings.presenceEnabled ? '开' : '关',
    settings.breathEnabled ? '开' : '关',
    settings.dailyCap,
    settings.sameActionOncePerDay ? '是' : '否',
    breath.actions().length,
  )
  if (!settings.enable) {
    log.warn('呼吸感已关闭（enable=false）：服务照常注册，presence() 不显示、take() 返回 disabled')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-rhythm-typing') === undefined) {
    log.info('打字执行层未装载：presence() 一律不显示（不假装正在输入）')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时间服务未装载：自然日退回本机时区（跨时区部署时可能差几小时）')
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
    ) => { readonly value: BreathConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法元素丢弃、越界夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
