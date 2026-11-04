/**
 * O-139 `ondra-failure-attrib`：**八类失败归因 + 处方表 + 伤口闭合判定**（手册 §8.6）。
 *
 * ## 一句话
 *
 * 每次工具调用结束，把「失败了」拆成八类中的一类，开一个伤口；
 * 同一个工具下次成功时闭合它；五分钟还不闭合就标 `chronic`，**停止空转**。
 *
 * ## 它接在哪
 *
 * `tools/result`——上游文档写明这是「冻结的、可无损 JSON 表示的最终结果」，
 * 并且「监听器抛错会被隔离」（`emit` 模式，不是 waterfall）。三件事都对得上本包：
 *
 * - **冻结**：归因读到的东西不会被后续改写，账本不会因为一次迟到的修改而对不上；
 * - **最终**：`tools/post-execute` 之前的结果还可能被替换，拿那里归因会归错；
 * - **隔离**：本包就算写坏了也不会把工具结果弄丢。
 *
 * 本包**不改写结果**（不做 `post-execute` 的 `add context`），理由写在 `service.ts`
 * 的文件头：工具输出的形状归工具自己声明，第三方塞东西会撞上输出契约。
 *
 * ## 为什么它不是器官
 *
 * 与 O-138 同一个理由的另一半：器官门面里**没有**「订阅上游事件」这条路
 * （只有 `onToolResult`，而它要有人喂）。本包恰好**就是那个喂食者**：
 * 它读上游 `tools/result`，转成 `ToolResultView` 推给小宿主的 `toolResult()`。
 * 把自己做成器官再喂自己，是个闭环，不是设计。
 *
 * 但 C3 的精神照守：整条处理链 try/catch，异常降级、绝不传播。
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
import type { Config as AttribConfig } from './settings.js'
import { FailureAttrib } from './service.js'
import type { AttribDeps } from './service.js'
import { ATTRIB_SERVICE_KEY, CAUSES } from './types.js'
import type { ConfigSchemaLike, FailureAttribService, IdentityLike, LogLike, OrganHostLike } from './types.js'

export type * from './types.js'
export {
  ATTRIB_SERVICE_KEY,
  CAUSES,
  CAUSE_SET,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { classify } from './classify.js'
export {
  PRESCRIPTIONS,
  UNKNOWN_RETRY_CAP,
  prescriptionOf,
  retryBudget,
  shouldRetry,
} from './prescribe.js'
export { WoundBook } from './wounds.js'
export { FailureAttrib } from './service.js'
export type { AttribDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-failure-attrib'

/**
 * 上游事件总线的最小形状。
 *
 * **刻意不 `declare module` 扩 `Events`**：上游已经声明过 `tools/result`，
 * 本包再声明一遍，签名差一个字就会让 `interface` 合并直接编译失败，
 * 而错误信息指向「重复声明」，看不出真正原因是「本包抄错了参数」。
 */
interface EventBusLike {
  on(event: string, listener: (...args: never[]) => unknown): () => void
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
    /** 失败归因；未装载本插件时为 undefined。 */
    'ondra-failure-attrib'?: FailureAttribService
  }
}

/**
 * Cordis 入口：解析配置、装归因服务、挂一个工具结果监听。**永不抛错**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: AttribConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('failure-attrib') : 'ondra.failure-attrib')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
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
  const settings = completeConfig(effective)

  const deps: AttribDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    // 现取：装载顺序由用户配置决定，快照会让「后装载的宿主」永远拿不到。
    host: () => ctx.get('ondra-organ-host') as OrganHostLike | undefined,
  }

  const service = new FailureAttrib(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(ATTRIB_SERVICE_KEY, service)
      return () => {
        // 先撤服务再清账本：卸载之后没人再查，留着只是占内存。
        service.dispose()
        removeService()
      }
    },
    'ondra-failure-attrib: 注册失败归因',
  )

  ctx.effect(
    () => {
      const bus = ctx as unknown as EventBusLike
      const off = bus.on('tools/result', (exec: unknown, result: unknown) => {
        try {
          service.handle(exec, result)
        } catch (error) {
          // 归因在工具返回的临界路径上：它坏了不能影响工具结果本身。
          log.warn('归因失败（已忽略，不影响工具结果）：%s', textOf(error))
        }
      })
      return () => off()
    },
    'ondra-failure-attrib: 监听工具结果',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('失败归因关着：服务仍注册（available=false），账本与报告仍可查（空）')
    return
  }

  log.info(
    '失败归因就绪：八类 %s；chronic 阈值 %dms；伤口上限 %d；可重试类上限 %d 次',
    CAUSES.join('/'),
    settings.chronicAfterMs,
    settings.maxOpenWounds,
    settings.maxRetries,
  )
  if (settings.feedHost) {
    if (ctx.get('ondra-organ-host') === undefined) {
      log.info('器官宿主（ondra-organ-host）不在：归因照常，但没有器官会收到工具结果')
    } else {
      log.info('已接上器官宿主：本包是 `onToolResult` 的唯一喂食者（feed-host 可关）')
    }
  }
  log.info('`arg_error` 永不自动重试：这条写在 retryBudget() 第一行，配置改不动')
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: AttribConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
