/**
 * O-142 `ondra-inject-dedupe`：注入去重记账（〔研〕自研）。
 *
 * 手册 §2.6 的原文是这一句：「首轮一次性大块注入 + 已见 id 记账 +
 * 压缩信号触发"释放已见" + 之后只推增量。实测事故：每次唤醒重复注入一遍，
 * 一次多背 13000+ 字，修正后单次上下文省一半。」
 *
 * ```
 *   账本（谁进过上下文）
 *     ├─ begin()   ── 摊成 seen 交给 O-036 装箱 → 拿回增量正文与待记账键
 *     ├─ commit()  ── 那一轮真发出去了，才记账
 *     └─ release() ── 压缩 / 换会话 / 记忆改写，把已见吐回去
 * ```
 *
 * ## 为什么是〔研〕而不是〔复〕
 *
 * 生态里的「去重」几乎都是**内容层**去重（同一句话不重复入库，mem0 / Letta 都这样）。
 * 本插件要做的是**上下文层**记账：同一条记忆在不同轮次、不同块里出现，只该说一次；
 * 而一旦上下文被压缩，它又必须重新说。这两条取决于「那段正文还在不在上下文里」，
 * 是宿主侧的知识，任何记忆库都不掌握。故自己写，且只有一本账。
 *
 * ## 明确不做
 *
 * - **不改 O-036。** `seen` 是它的入参、`plan().ids` 是它的出口，本插件只在这两头接线（§15.7）。
 * - **不做装箱、不做预算。** 预算归 O-036；本插件一个字符都不删。
 * - **不碰前缀、不碰消息序列。** 增量文本交给 O-033 拼到易变段尾部（§8.5）。
 * - **不落盘。** 账本随进程生死（见 `types.ts` 第 4 条）。
 * - **不注册工具。** 注册工具要 `inject: ['tools']`，上游缺席时整插件会停在 PENDING。
 *   要「翻旧账」的是 `chain_recall`（O-132 / O-138 的门面）。
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
import type { Config as DedupeConfig } from './settings.js'
import { Dedupe } from './service.js'
import { DEDUPE_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ConfigSchemaLike,
  DedupeService,
  DialogueLike,
  IdentityLike,
  InjectionLike,
  LogLike,
  Sources,
} from './types.js'

export type * from './types.js'
export { DEDUPE_SERVICE_KEY, NAME_RE } from './types.js'
export { CONFIG_SECTION_ID, conversationKey } from './settings.js'
export { Dedupe, idleBatch } from './service.js'
export { Ledger, LedgerBook, idsOfKey, keyOfId, parseId } from './ledger.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-inject-dedupe'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-inject-dedupe: 注册配置段')
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
    /** 注入去重服务；未装载本插件时为 undefined。 */
    'ondra-inject-dedupe'?: DedupeService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject` 里有任何一个上游缺席，整个插件会停在
 * PENDING（静默不加载，最难查的失败形态）。这里全部改成取值函数，
 * 缺谁就退成「本轮不拦」并留痕。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DedupeConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('inject-dedupe') : 'ondra.inject-dedupe')

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
  //    服务键是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§15.5），
  //    取回来立刻按结构对位断言。拼错键不会被编译器发现，但会走已实现的降级路径。
  const sources: Sources = {
    inject: () => ctx.get('ondra-prompt-inject') as InjectionLike | undefined,
    dialogue: () => ctx.get('ondra-dialogue') as DialogueLike | undefined,
  }

  const dedupe = new Dedupe({ settings, log, sources, now: () => Date.now() })

  ctx.effect(() => ctx.provide(DEDUPE_SERVICE_KEY, dedupe), 'ondra-inject-dedupe: 注册注入去重')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '注入去重就绪：单会话容量 %d 条、会话上限 %d、未决批次上限 %d、自动嗅压缩 %s',
    settings.maxSeenPerConversation,
    settings.maxConversations,
    settings.maxPendingBatches,
    settings.autoDetectCompaction ? '开' : '关',
  )
  if (!settings.enable) {
    log.warn('注入去重已关闭（enable=false）：服务照常注册，但 begin() 一律返回 bypassed')
  }
  if (sources.inject() === undefined) {
    log.warn('注入装箱未装载（ondra-prompt-inject）：本轮起 begin() 返回 bypassed，调用方应整块注入')
  }
  if (sources.dialogue() === undefined) {
    log.info('对话编排未装载（ondra-dialogue）：嗅不到压缩信号，压缩后需显式 release("compaction")')
  }
  if (!NAME_RE.test(name)) {
    // 这条永远不该触发；留着是因为服务键不合规的代价是「模型侧直接拒绝」，
    // 而那类事故没有任何运行期报错。
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
    ) => { readonly value: DedupeConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值退回默认），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
