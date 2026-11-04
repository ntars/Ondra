/**
 * O-011 `ondra-memory-extract`：记忆提炼（〔研〕自研）。
 *
 * 为什么是自研：模型调用**整块复用** O-035 网关（三来源、超时、重试、降级一条不重写），
 * 存储**整块复用** O-010 内核。真正自研的只有「提炼之后怎么保证没编」这一段：
 *
 * - **来源四分类 + 逐字引文校验**：把「记得」从生成任务变成检索任务，检索可验证；
 * - **五级解析兜底**：模型不总听「只输出 JSON」，兜住四种常见变形；
 * - **数字必须有 TOOL 来源**：口述数字（「他说他 28 岁」）不入库。
 *
 * 这三件事生态里没有现成实现：通用记忆库（mem0 一类）靠 embedding 相似度做去重，
 * 不做引文回查；而「她凭什么这么说」正是本产品与它们的分野。
 *
 * 边界：**不判重**（O-012）、**不算寿命**（O-010）、**不做证据门控的最终裁决**（O-140）。
 * 本插件是「提出干净候选」的那一层，不是「决定入库」的那一层。
 */

import type { Context } from '@ntars/cordis'
import { MemoryExtractor } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as ExtractConfig } from './settings.js'
import { EXTRACT_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  ExtractService,
  IdentityLike,
  LlmGatewayLike,
  LogLike,
  MemoryCoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、四个常量），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { EXTRACT_SERVICE_KEY, ExtractError, EVIDENCE_SOURCES, EXTRACT_CATEGORIES, EXTRACT_KINDS } from './types.js'
export { SYSTEM_PROMPT, buildUserMessage } from './prompt.js'
export { parseExtraction } from './parse.js'
export { verifyCandidate, digitRuns, normalizeForMatch } from './verify.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-extract'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect` 里：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-extract: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆提炼服务；未装载本插件时为 undefined。 */
    'ondra-memory-extract'?: ExtractService
  }
}

/**
 * Cordis 入口：接上配置、网关、内核，注册提炼服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-llm-gateway']` 后，
 * 网关缺席会让整个插件停在 PENDING（静默不加载）。改成「照常注册 + `available=false`」，
 * 下游能区分「没装提炼」与「装了但模型不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ExtractConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(
    identity ? identity.loggerName('memory-extract') : 'ondra.memory-extract',
  ) as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
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

  const settings = completeConfig(effective)

  // 2. 构造服务。两个上游都用**取值函数**：晚装载能自愈（O-035 的同一条裁决）。
  const extractor = new MemoryExtractor({
    settings,
    gateway: () => ctx.get('ondra-llm-gateway') as LlmGatewayLike | undefined,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    log,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(EXTRACT_SERVICE_KEY, extractor), 'ondra-memory-extract: 注册提炼服务')

  // 3. 报一次现状。可用性与原因码要能被自检读到，不许黑箱（§12.2）。
  if (extractor.available) {
    log.info(
      '记忆提炼就绪：单轮上限 %d 条，正文上限 %d 字，数字%s必须有工具来源',
      settings.maxFacts,
      settings.maxTextChars,
      settings.requireToolForDigits ? '' : '不',
    )
    if (settings.allowGroup) {
      log.warn('allowGroup=true：群聊也会提炼。手册把「不收群友闲聊」列为准入红线，确认是有意为之')
    }
    return
  }

  const reason = extractor.reason
  if (reason === 'disabled') {
    log.info('记忆提炼已关闭（enable=false）：服务已注册但不可用')
    return
  }
  log.warn('记忆提炼已注册但不可用（%s）：下游应跳过提炼而不是崩溃', reason ?? '未知原因')
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补**。`completeConfig` 永不抛错，所以这里不产出 issue——
 * 越界夹紧、类型错回退默认，都属于「能补的」。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: ExtractConfig } | { readonly issues: readonly { readonly message: string }[] }
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
