/**
 * O-035 `ondra-llm-gateway`：模型网关（〔薄〕薄封装）。
 *
 * **全仓阻塞项**：`O-011` 提炼 / `O-014` 检索扩展 / `O-019` 做梦全部等这条模型调用路径。
 *
 * 为什么是「薄封装」而不是自研：上游 `ctx.llm`（`@ntars/ondra-llm`）已经提供了
 * provider 适配器注册表、流式协议、重试策略、模型解析四件事，`llm-deepseek` 与
 * `llm-pi-ai` 两个适配器把 SSE 解码与重放状态都做完了。在这里再实现一遍协议编解码
 * 等于把「协议层」自研一次，是手册 §1.8 明确点名的违规。
 *
 * 本插件只补上游**刻意不管**的四件事（因为它面向会话，不面向「产品要选哪条链路」）：
 * 三来源清单与优先级选路、首块/块间隔超时、首块前的重试与跨来源降级、用量记账。
 *
 * 与上游 `llm-retry` 的边界：那个插件挂在 **agent loop** 的 `RequestErrorAction` 上，
 * 管的是「会话里的模型请求失败了怎么办」；本插件管的是**直接调网关的一次性请求**
 * （提炼、做梦、评估）。两者不叠加——网关不在 loop 内被调用。若某个调用方确实在 loop 内，
 * 把 `maxAttempts` 配成 1，避免「重试套重试」把一次故障放大成 N×M 次请求。
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
// 类型名与下面的 `export const Config` 撞名，所以在这里改名导入：
// `Config` 这个名字必须留给 Cordis 的配置校验器，否则宿主取不到。
import type { Config as GatewayConfig } from './settings.js'
import { LlmGateway } from './service.js'
import { describeStates } from './sources.js'
import { LLM_GATEWAY_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  CredentialLike,
  IdentityLike,
  LlmGatewayService,
  LlmRuntimeLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、两个正则），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { LLM_GATEWAY_SERVICE_KEY, GatewayError, NAME_RE, CREDENTIAL_REF_RE, SOURCE_KINDS } from './types.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-llm-gateway'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect` 里：段是**本插件的资源**，卸载时必须一起撤，
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-llm-gateway: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，但插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 模型网关服务；未装载本插件时为 undefined。 */
    'ondra-llm-gateway'?: LlmGatewayService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：那样上游 `llm` 缺席会让整个插件停在 PENDING
 * （静默不加载，是最难查的失败形态）。这里改成「照常注册 + `available=false`」，
 * 下游能明确区分「没装网关」与「装了但上游没就绪」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GatewayConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('llm-gateway') : 'ondra.llm-gateway')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（并在出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      // 用户层用 kebab 键交给 O-005（§8.4 只认小写），回来再换成 camel 键继续走。
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
  const completed = completeConfig(effective)
  const settings = completed.config
  for (const issue of completed.issues) {
    log.warn('来源清单问题：%s', issue.message)
  }

  // 3. 构造服务。依赖全部用取值函数：上游晚装载时 `probe()` 能自愈。
  const gateway = new LlmGateway({
    settings,
    // 上游服务键（`llm` / `credentials`）走 Cordis 的字符串重载：
    // 它们的类型声明在上游包的 .d.ts 里，本插件不许 import（§15.5），
    // 所以这里取回来立刻按结构对位断言。拼错键不会被编译器发现，
    // 但会退回「上游未就绪」这条已实现的降级路径，不会崩。
    runtime: () => ctx.get('llm') as LlmRuntimeLike | undefined,
    credentials: () => ctx.get('credentials') as CredentialLike | undefined,
    log,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(LLM_GATEWAY_SERVICE_KEY, gateway), 'ondra-llm-gateway: 注册模型网关')

  // 4. 报一次现状。可用性、来源数、超时值都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '模型网关就绪：上游%s，来源 %d 条（%s），首块超时 %dms，块间隔 %dms，最多 %d 次尝试',
    gateway.available ? '已就绪' : '未就绪',
    settings.sources.length,
    describeStates(gateway.sources),
    settings.timeoutMs,
    settings.idleTimeoutMs,
    settings.maxAttempts,
  )
  if (settings.sources.length === 0) {
    log.info('来源清单为空：网关已注册但不参与选路。请在设置里填写 sources，provider 必须是已安装适配器的路由键')
  }
  if (!gateway.available) {
    log.warn('上游模型服务 ctx.llm 未就绪：网关服务已注册但 available=false，下游应跳过模型调用而不是崩溃')
  }
  if (!settings.allowFallback) {
    log.info('allowFallback=false：只试第一条可用来源，失败即返回，不做跨来源降级')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。这条与运行期一致——
 * 配置错不该让插件不加载，只该让某个字段回退默认并被记下来。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: GatewayConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const completed = completeConfig(value)
      const issues: { message: string }[] = completed.issues.map(issue => ({ message: issue.message }))
      if (issues.length > 0) return { issues }
      return { value: completed.config }
    },
  },
}
