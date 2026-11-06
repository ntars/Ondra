/**
 * O-033 `ondra-dialogue`：对话编排（〔研〕自研）。
 *
 * 手册 §8.5 的实测是硬的：缓存命中 99.3–99.6%，成本 ¥879.97 → ¥19.96。
 * 而把命中率打到 0 只需要一行——**每轮重拼 system prompt**。
 * 本插件的全部结构都为这件事服务：
 *
 * ```
 *   begin()  ── 拼一次稳定段（人格 + 世界书常驻），冻结，记指纹
 *     │
 *   turn()   ── [冻结前缀] + [已提交历史] + [本轮易变段] + [本轮输入]
 *     │                         ↑ 只追加，前面一个字节都不动
 *   compact() ── 只在两轮之间裁历史（成对裁，至少留一轮）
 * ```
 *
 * ## 为什么是〔研〕而不是〔薄〕
 *
 * 「会话内冻结前缀」这件事生态里没有现成实现：所有通用 agent 框架都是
 * 「每轮重建上下文」，这是它们的抽象决定的（消息列表就是唯一真源）。
 * 手册要的是「消息列表 + 一份不可变前缀」两件事，这一层只能自己写。
 *
 * ## 明确不做
 *
 * - **不建 Session、不写 `app_session_log`**（master-plan §6 禁令 5 / 决策 13）。
 * - **不改写正文**：九步过滤归 O-037；本插件连 `text-replace` 帧都不发。
 * - **不做注入装箱**：装什么、装不下写「另有 N 条」归 O-036。
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
import type { Config as DialogueConfig } from './settings.js'
import { Dialogue } from './service.js'
import type { ProtocolLike } from './writer.js'
import { DIALOGUE_SERVICE_KEY } from './types.js'
import type {
  AssembleLike,
  ConfigSchemaLike,
  DialogueService,
  GatewayLike,
  IdentityLike,
  WorldbookLike,
} from './types.js'

export type * from './types.js'
export { DIALOGUE_SERVICE_KEY, NAME_RE } from './types.js'
export { djb2 } from './prefix.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-dialogue'

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
function registerSection(
  ctx: Context,
  schema: ConfigSchemaLike,
  log: { warn(message: string, ...args: unknown[]): void },
): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-dialogue: 注册配置段')
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
    /** 对话编排服务；未装载本插件时为 undefined。 */
    'ondra-dialogue'?: DialogueService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject` 里有任何一个上游缺席，整个插件会停在
 * PENDING（静默不加载，最难查的失败形态）。这里全部改成**取值函数**，
 * 缺谁就在 `turn()` 里返回一帧 `done{error}` 并说清缺谁。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DialogueConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('dialogue') : 'ondra.dialogue')

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

  // 3. 构造服务。依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  const dialogue = new Dialogue({
    settings,
    log,
    // 上游服务键（`llm` / `credentials`）与各域服务键都走 Cordis 的字符串重载：
    // 它们的类型声明在别的包里，本插件不许 import（§15.5），
    // 所以取回来立刻按结构对位断言。拼错键不会被编译器发现，
    // 但会退回已实现的降级路径（一帧 done{error} + 一条 warn），不会崩。
    gateway: () => ctx.get('ondra-llm-gateway') as GatewayLike | undefined,
    protocol: () => ctx.get('ondra-dialogue-protocol') as ProtocolLike | undefined,
    assemble: () => ctx.get('ondra-persona-assemble') as AssembleLike | undefined,
    worldbook: () => ctx.get('ondra-worldbook') as WorldbookLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(DIALOGUE_SERVICE_KEY, dialogue), 'ondra-dialogue: 注册对话编排')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '对话编排就绪：历史上限 %d 轮 / %d 字，易变段置信度门槛 %.2f，会话上限 %d',
    settings.maxTurns,
    settings.maxHistoryChars,
    settings.minTailConfidence,
    settings.maxConversations,
  )
  if (!settings.enable) {
    log.warn('对话编排已关闭（enable=false）：服务照常注册，但 turn() 会立刻以 error 收尾，不会静默不回应')
  }
  if (ctx.get('ondra-llm-gateway') === undefined) {
    log.warn('模型网关未装载：对话编排已注册但无法产出任何正文，turn() 会返回 done{error}')
  }
  if (ctx.get('ondra-dialogue-protocol') === undefined) {
    log.warn('帧协议未装载：将退回内部兜底 writer（同形状、不校验，会丢掉「输出被截断」的区分）')
  }
  if (settings.includePersona && ctx.get('ondra-persona-assemble') === undefined) {
    log.info('人格装配未装载：稳定段里不会有人格（可在 begin() 里显式传 stable）')
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
    ) => { readonly value: DialogueConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（枚举外的值退回默认），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
