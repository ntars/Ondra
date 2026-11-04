/**
 * O-138 `ondra-organ-gate`：**工具 schema 门控 + 确定性意图路由**（手册 §8.6，P0）。
 *
 * ## 一句话
 *
 * 每一轮开始前，按用户原话走一遍关键词规则，算出「这次真正可能要用的工具族」，
 * 把其余工具从这个 agent 的 schema 视图里摘掉。省下的是**每一轮**的输入 token。
 *
 * ## 为什么挂在 `agent/pre-step` 上
 *
 * 手册与上游文档把时机写得很死：「这一步被准入之后、系统提示词与被接受的消息
 * 提交之前」。工具 schema 就是在那一刻被装进请求的，所以限制必须在那之前落下。
 * 晚一步，这一轮已经装完了；早一步，还不知道用户说了什么。
 *
 * ## 三条必须写死的纪律
 *
 * 1. **这个 waterfall 必须放行。** 不调 `next()`，这一步就永远进不去——
 *    门控是优化，优化挂了不能让对话卡住。所以整个处理体先 try/catch，
 *    无论中间出什么事，最后一行永远是 `return next()`。
 * 2. **只摘视图，不动实现。** 唯一动作是 `agent.ctx.tools.restrict({ deny })`。
 *    不包 `tools.register`、不改工具定义、不动全局注册表。
 * 3. **不碰 `run_code`。** 它是 PTC 的保留传输名，`restrict()` 对它直接抛错；
 *    本包在算名单时就把它硬剔除，不指望调用方记得。
 *
 * ## 与手册摘要的一处差异（必须在简报里说）
 *
 * 手册只写「按需暴露工具 schema」，没写**怎么暴露**。本包选的是
 * **先算「该摘谁」再摘**，而不是「先算该给谁再只给这些」：
 * 后者用 `restrict({ allow })` 更彻底，但它会把**本插件不知道的新工具**
 * （例如后装载的器官工具）一起藏掉，而那种错误不会报错，只会让模型
 * 觉得「我没这个能力」。摘已知的、留未知的，错的那一半是安全的。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as GateConfig } from './settings.js'
import { textOfMessages } from './intent.js'
import { Gate } from './service.js'
import type { GateDeps } from './service.js'
import { DEFAULT_RULES } from './rules.js'
import { GATE_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, GateService, IdentityLike, LogLike } from './types.js'

export type * from './types.js'
export {
  GATE_SERVICE_KEY,
  KEY_RE,
  RESERVED_TRANSPORT,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  GATE_MODES,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  ALWAYS_KEEP,
  DEFAULT_RULES,
  allowedTools,
  auditRules,
  keywordHit,
  matchRules,
  toolMatches,
} from './rules.js'
export { estimateTokens, familiesOf, planGate } from './gate.js'
export type { PlanInput } from './gate.js'
export { excerptOf, textOfMessages } from './intent.js'
export type { IntentText } from './intent.js'
export { Gate } from './service.js'
export type { GateDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-organ-gate'

/**
 * 上游事件总线的最小形状。
 *
 * **刻意不 `declare module` 扩 `Events`。** 上游 `@ntars/ondra-agent` 已经
 * 声明过 `agent/pre-step` 与 `agent/disposed`；本包再声明一遍，一旦两边的
 * 函数签名有一个字不同，`interface` 合并就会直接编译失败——而且失败信息
 * 指向的是「重复声明」，看不出真正的原因是「本包抄错了一个参数」。
 * 结构对位 + 一次收窄的断言，坏处是少一层类型保护，好处是上游改签名时
 * 本包只会「不生效」而不会「编译不过」。
 */
interface EventBusLike {
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

/**
 * `agent/pre-step` 的载荷子集。
 * @param payload 原始载荷。
 */
interface StepPayloadLike {
  readonly agent?: unknown
  readonly turn?: unknown
  readonly step?: unknown
  readonly messages?: unknown
}

/** 取出的、已判空的一步信息。 */
interface StepInfo {
  readonly agent: object
  readonly turn: number
  readonly step: number
  readonly messages: readonly unknown[]
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 从载荷里取出本包要用的四个字段。**缺一个就返回 undefined**，不猜默认值：
 * 拿不到轮次号就没法判断「这是不是同一轮的中途步骤」，猜错会让门控在第一句
 * 之后就全放开。
 * @param payload 原始载荷。
 */
function stepInfoOf(payload: unknown): StepInfo | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const data = payload as StepPayloadLike
  if (typeof data.agent !== 'object' || data.agent === null) return undefined
  if (typeof data.turn !== 'number' || !Number.isFinite(data.turn)) return undefined
  if (typeof data.step !== 'number' || !Number.isFinite(data.step)) return undefined
  const messages = Array.isArray(data.messages) ? data.messages : []
  return { agent: data.agent, turn: data.turn, step: data.step, messages }
}

/**
 * 向 O-005 注册配置段。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    schema.register(CONFIG_SECTION, name)
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 工具门控；未装载本插件时为 undefined。 */
    'ondra-organ-gate'?: GateService
  }
}

/**
 * Cordis 入口：解析配置、装门控服务、挂两个生命周期监听。**永不抛错**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GateConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('organ-gate') : 'ondra.organ-gate')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBad = (text: string, kind: string): void => {
    log.warn('配置条目已丢弃（%s）：%s', kind, text)
  }
  if (schema !== undefined && registerSection(schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  const deps: GateDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    // 现取而不是快照：装载顺序由用户配置决定，不由本插件决定。
    toolsReady: () => ctx.get('tools') !== undefined,
  }

  const gate = new Gate(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(GATE_SERVICE_KEY, gate)
      return () => {
        // 先撤服务再清限制：卸载之后，agent 身上挂着的 `restrict` 撤销器就没人持有了。
        // 不在这里撤，插件卸载了工具却仍然是「被摘过」的样子，而且没有任何报错。
        gate.dispose()
        removeService()
      }
    },
    'ondra-organ-gate: 注册工具门控',
  )

  /**
   * 一步开始前门控。
   *
   * 这里的 `try/catch` 不是为了吞错，而是因为**这个 waterfall 不放行会让对话停住**：
   * 门控是优化，优化挂了不能让主流程卡死。错误一律降级为「本轮不门控」。
   */
  ctx.effect(
    () => {
      const bus = ctx as unknown as EventBusLike
      const offStep = bus.on('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
        try {
          const info = stepInfoOf(payload)
          if (info !== undefined) {
            const intent = textOfMessages(info.messages, settings.intentChars)
            gate.before(info.agent, info.turn, info.step, intent.text)
          }
        } catch (error) {
          log.warn('门控出错，本轮按「不门控」放行：%s', textOf(error))
        }
        return next()
      })
      const offGone = bus.on('agent/disposed', (payload: unknown) => {
        try {
          const agent = (payload as { readonly agent?: unknown }).agent
          gate.forget(agent)
        } catch (error) {
          log.warn('清理已销毁 agent 的门控状态失败：%s', textOf(error))
        }
      })
      return () => {
        offStep()
        offGone()
      }
    },
    'ondra-organ-gate: 监听 agent 生命周期',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (settings.mode === 'off') {
    log.info('工具门控关着：服务仍注册（available=false），报告接口仍可查')
    return
  }
  if (ctx.get('tools') === undefined) {
    log.warn('工具注册表（tools）不在：门控服务已注册但不可用（reason=no-tools）')
    return
  }

  log.info(
    '工具门控就绪：模式 %s，规则 %d 条，门槛 %d 个工具，至少留 %d 个，比例上限 %d%%',
    settings.mode,
    DEFAULT_RULES.length,
    settings.minToolsToGate,
    settings.minKeepTools,
    Math.round(settings.maxDenyRatio * 100),
  )
  if (settings.mode === 'observe') {
    log.info('当前是 observe：只算不拦。先看 report() 里命中与摘除合不合常理，再翻 enforce')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: GateConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏条目回退并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
