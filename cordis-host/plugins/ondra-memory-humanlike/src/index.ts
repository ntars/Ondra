/**
 * O-018 `ondra-memory-humanlike`：三通道视图 + 三条想起路径（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储/检索/去重/衰减」列为复用档，
 * 本插件把**存储、记忆本体、强度公式、检索、扩散**全部交了出去：
 * 强度问 O-010、检索问 O-014（候选由调用方给）、扩散问 O-015、表问 O-006/O-007。
 * 真正自研的只有两样，生态里没有对应物：
 *
 * 1. **固定回忆的权重曲线** `(1−R) × (0.5 + 重要度/100) × (永久 ? 0.6 : 1)`
 *    ——「越模糊越容易被想起」是产品主张，不是通用算法。
 * 2. **勾起的概率闸** `p = 0.10 + 重合比×0.55 + R×0.35` 与它的后果
 *    （命中加固 / 未中记账）。
 *
 * 边界（写死在这里，防止下一轮有人顺手改）：
 * - **不重算强度**。R 全部来自 `core.strengthOf()`，本插件零 `Math.pow(0.5, …)`。
 * - **不建索引**。`cue()` 只接候选，不接查询；建索引就是第二套分词与 IDF。
 * - **不乘圈权重**。O-015 的 `diffuse()` 已经乘过；再乘一次水波纹只剩第一圈。
 * - **不复制通道天数**。4/12/180 只在 O-010 一处。
 * - **不装定时器**。三条路径都由调用方按场景显式触发（21:05 归宿主）。
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
import type { Config as HumanlikeConfig } from './settings.js'
import { HumanlikeRepository } from './service.js'
import { TraceStore } from './trace.js'
import { HUMANLIKE_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  GraphLike,
  HumanlikeService,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、通道表、错误类），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  CHANNEL_PROFILES,
  CHANNEL_PURPOSES,
  HUMANLIKE_SERVICE_KEY,
  MEMORY_CHANNELS,
  RECALL_PATHS,
  HumanlikeError,
} from './types.js'
export { TABLE_TRACE, TRACE_SPEC, TraceStore } from './trace.js'
export { channelOfRecord, stampOf, summarizeChannels, totalOf } from './channels.js'
export { bigrams, cueProbability, normalizeText, overlapRatio, sharedGramCount } from './cue.js'
export { buildDicePool, diceWeight, emptySkips, pickWeighted } from './dice.js'
export { arrangeRipple } from './ripple.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export { HumanlikeRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-humanlike'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-humanlike: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆拟人化服务；未装载本插件时为 undefined。 */
    'ondra-memory-humanlike'?: HumanlikeService
  }
}

/**
 * Cordis 入口：接上记忆内核、图谱与存储，建记账表，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内核缺席会让整插件停在 PENDING（静默不加载），连「三通道视图不可用」这句话都说不出来。
 * 改成「照常注册 + 各能力分别降级」，下游能区分「没装内核」与「装了但存储不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: HumanlikeConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-humanlike') : 'ondra.memory-humanlike') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      // 用户层用 kebab 键交给 O-005（§8.4 只认小写），回来再换成 camel 键。
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

  // 2. 记忆内核是**硬依赖**：三条路径全部要读记忆与强度。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('没有记忆内核（ondra-memory-core）：服务以「不可用」状态注册（三条想起路径都做不了）')
  }

  // 3. 图谱是**软依赖**：只有漫无目的联想需要它。
  const graph = ctx.get('ondra-memory-graph') as GraphLike | undefined
  if (graph === undefined) {
    log.info('没有图谱服务（ondra-memory-graph）：漫无目的联想不可用，另两条路径不受影响')
  }

  // 4. 存储端口是**软依赖**：只用来记「未命中次数」。缺席则退内存并如实上报。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (store === undefined) {
    log.info('没有存储端口：未命中记账只存内存（stats().tracePersisted 会如实为 false）')
  }

  const trace = new TraceStore(store, log)
  // 建表在**构造服务之前**：`trace.persisted` 决定服务初始化时是否记「只存内存」这条 issue。
  // 放进 effect 里会晚一步，报出来的状态与事实相反。
  trace.ensure()

  const service = new HumanlikeRepository(core, graph, settings, trace, log, () => Date.now())

  ctx.effect(() => ctx.provide(HUMANLIKE_SERVICE_KEY, service), 'ondra-memory-humanlike: 注册记忆拟人化服务')

  // 5. 报一次现状。可用性、三通道条数、两个软依赖在不在，都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('记忆拟人化已注册但不可用（%s）', stats.reason ?? '未知原因')
    return
  }
  const brief = stats.channels.map(view => `${view.profile.label} ${view.count}`).join(' / ')
  log.info(
    '记忆拟人化就绪：记忆 %d 条（%s），图谱 %s，记账 %s',
    stats.facts,
    brief,
    stats.graphAvailable ? '可用' : '缺席',
    stats.tracePersisted ? '落盘' : '仅内存',
  )
  if (settings.maxStrength <= settings.minStrength) {
    log.warn('maxStrength ≤ minStrength：固定回忆的强度区间为空，骰子会永远抽不到东西（已按 min 夹紧）')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载，
 * 只该让某个字段回退默认并被记下来。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: HumanlikeConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：越界值被夹紧、类型错回退默认，都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}
