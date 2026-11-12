/**
 * O-132 `ondra-organ-host`：**器官 ABI 宿主**（手册 §8.1，P0）。
 *
 * ## 为什么它是 B6 的第一块地基
 *
 * O-136~O-144 有七个治理插件都长在这份 ABI 上。ABI 定错再改，等于把后面七个
 * 全部推翻——所以手册把「96 个插件写完再补等于推翻重来」写进了正文。
 * 本包因此**先立契约、再落实现**：`types.ts` 里五个核心形状
 * （`OrganManifest` / `CapabilityGrant` / `EnergyReceipt` / `FeedbackDelta` /
 * `PromptFragment`）一个字都不许下游自造。
 *
 * ## 三条不可让渡约束落在哪一行
 *
 * - **C1 器官不写状态**：`feedback()` 只入队；唯一写状态的是 `flush()`，
 *   而 `flush()` 只调「持有者自己登记的 `apply`」。器官手里连持有者的
 *   对象引用都拿不到（`state()` 给的是浅拷贝 + 冻结）。
 * - **C2 付费且可被拒**：`consume()` 是**唯一**能拿到读状态权限的入口；
 *   `denied=true` 时 `state()` 抛 `PerceptionDeniedError`——「放弃」不是靠自觉。
 * - **C3 错误不传播**：`tick()` / `toolResult()` / `prompt()` 三处的处理器调用
 *   全部逐个 try/catch，抛错转 `degraded` 并计数，宿主继续跑。
 *
 * ## 三个刻意的「不做」
 *
 * 1. **不装任何定时器。** `tick()` 由宿主调度。装了定时器，一个没人用的宿主
 *    也在偷偷烧 CPU，而「零常驻」正是 B6 的主题。
 * 2. **不提供 `setState()`。** 手册反模式①就是它。给了它，C1 立刻变成注释。
 * 3. **不做能力「临时授权」。** default-deny 一旦有例外通道，审计就无从谈起。
 *    要放开就改配置里的 `deniedCapabilities`，那是**一次显式的、有记录的操作**。
 *
 * ## 与手册摘要的一处差异（必须在简报里说）
 *
 * 手册 §8.1 C2 写「`denied=true` 时必须立刻放弃本次感知」。摘要没写
 * **谁来保证**。本包的选择是「让不放弃的那条路走不通」：不是只给一个布尔
 * 让器官自己记得检查，而是 `state()` 直接抛错。布尔提醒靠自觉，抛错靠机制。
 */

import type { Context } from '@ntars/cordis'
import { OrganHost } from './service.js'
import type { OrganHostDeps } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { ORGAN_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  EmotionSourceLike,
  EnergySourceLike,
  GapPoolLike,
  IdentityLike,
  LogLike,
  OrganHostService,
  ToolsRegistryLike,
} from './types.js'

export type * from './types.js'
// 契约里既有纯类型也有运行时值，分开导出才不违背「类型导入不得混入运行时值」。
export {
  ORGAN_SERVICE_KEY,
  KEY_RE,
  CAPABILITIES,
  CAPABILITY_SET,
  SCAR_ORDER,
  MIN_ORGAN_ORDER,
  MAX_ORDER,
  GAP_SOURCES,
  CapabilityDeniedError,
  OrganManifestError,
  ReceiptRequiredError,
  PerceptionDeniedError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  CHARGE_MODES,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  deniedCapabilitiesOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { failedCharge, normalizeCost, quoteEnergy } from './energy.js'
export type { EnergyQuoteInput, EnergyQuoteResult } from './energy.js'
export { applyBuckets, bucketize, enqueue, shapeDelta } from './arbitrate.js'
export type { EnqueueResult, PendingDelta } from './arbitrate.js'
export { assemble, charCount, isValidFragmentId } from './prompt.js'
export type { AssembleInput, AssembleOutput, AttributedDraft } from './prompt.js'
export { OrganHost } from './service.js'
export type { OrganHostDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-organ-host'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(schema: { register(decl: unknown, by?: string): () => void }, log: LogLike): boolean {
  try {
    schema.register(CONFIG_SECTION, name)
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** O-005 的结构对位子集。 */
interface ConfigSchemaLike {
  register(decl: unknown, by?: string): () => void
  resolve(id: string, layers: Record<string, unknown>): { readonly values: unknown; readonly fallbackCount: number } | undefined
}

declare module '@ntars/cordis' {
  interface Context {
    /** 器官宿主；未装载本插件时为 undefined。 */
    'ondra-organ-host'?: OrganHostService
  }
}

/**
 * Cordis 入口：解析配置、装五个只读端口、注册服务。**永不抛错**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('organ-host') : 'ondra.organ-host')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 配置：有 O-005 就走四层合并，没有就用插件实例配置。
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

  /**
   * 依赖全部**每次现取**（软依赖）。
   *
   * 在 `apply()` 里 `ctx.get` 一次存起来，会在「后装载」时永远拿到 undefined——
   * 而装载顺序由用户配置决定，不由本插件决定。每次现取的代价是一次 Map 查找。
   *
   * 四处的 `as X | undefined` 是刻意的：`ctx.get` 的返回类型在宿主侧是 `any`，
   * 写成 `as never` 会把「可能没有」这件事从类型里抹掉，而下游每一处都必须
   * 先判 `undefined`（见 `service.ts` 的 `deps.emotion()` 等调用点）。
   */
  const deps: OrganHostDeps = {
    settings: () => settings,
    log,
    emotion: () => ctx.get('ondra-emotion-core') as EmotionSourceLike | undefined,
    energySource: () => ctx.get('ondra-life-rhythm') as EnergySourceLike | undefined,
    gap: () => ctx.get('ondra-drive-gap') as GapPoolLike | undefined,
    tools: () => ctx.get('tools') as ToolsRegistryLike | undefined,
    now: () => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
  }

  const host = new OrganHost(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(ORGAN_SERVICE_KEY, host)
      return () => {
        // 先卸器官再撤服务：器官的撤销器可能还要调宿主。
        host.dispose()
        removeService()
      }
    },
    'ondra-organ-host: 注册器官宿主',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('器官宿主关着：所有器官注册申请都会被拒（reason=disabled）')
    return
  }

  log.info(
    '器官宿主就绪：计费模式 %s，回执有效期 %dms，置信度门槛 %s，片段上限 %d 片',
    settings.chargeMode,
    settings.receiptTtlMs,
    settings.minConfidence.toFixed(2),
    settings.maxFragments,
  )
  if (settings.chargeMode === 'shadow') {
    log.info('当前是 shadow 模式：只记账不真扣。跑一周看遥测，再逐个器官翻 additive（§8.2）')
  }
  if (!settings.enforceReceipt) {
    log.warn('`enforceReceipt=false`：C2 暂时只是纸面约束。迁移期可以这样跑，长期请打开')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
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
