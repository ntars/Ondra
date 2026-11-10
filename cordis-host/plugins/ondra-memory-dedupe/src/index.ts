/**
 * O-012 `ondra-memory-dedupe`：写入前的判重裁决（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储 / 检索 / 去重 / 衰减」列为可复用档，
 * 本插件把**存储与写入全部交了出去**——建表、事务、CRUD、寿命、墓碑都在 O-010，
 * 一个字都不重写。真正自研的只有三样生态里没有的东西：
 *
 * 1. **包含度口径下的五分类**（手册 §12.3 裁决⑥ 定的 0.4）。生态里的记忆库
 *    （mem0 一类）靠 embedding 余弦判重，而本产品的中文短句没有向量分支，
 *    余弦 0.85 与 Jaccard 0.75 又是别的场景的标定值——**口径不可互搬**。
 * 2. **「复述 / 补充 / 冲突」三分**。只有「重不重复」一个判断的记忆库，
 *    要么把「喜欢猫」和「喜欢猫和狗」当重复（丢掉狗），要么当两件事（库里两份）。
 * 3. **可解释的决策日志**。`merge` 与 `drop` 都不新增条目，没有日志就无法回答
 *    「我明明说过，怎么没记住」。
 *
 * 与 O-013 的边界：**本插件只管「该不该新写一条」，不管「旧的该暗到什么程度」**。
 * 衰减、归档、复习排期是 O-013 的活；本插件从不改 `archived` / `sealed` 之外的
 * 任何状态位，且在默认策略下连 `sealed` 都不碰。
 */

import type { Context } from '@ntars/cordis'
import { DedupeLog } from './log.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as DedupeConfig } from './settings.js'
import { DedupeRepository } from './service.js'
import { DEDUPE_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, DedupeService, IdentityLike, LogLike, MemoryCoreLike, StoreLike } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、动作表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { DEDUPE_ACTIONS, DEDUPE_SERVICE_KEY, DedupeError } from './types.js'
export { byRankDesc, isSlotReplacement, judge, slotDiff } from './judge.js'
export type { JudgeInput, SlotDiff } from './judge.js'
export {
  bigramsOf,
  containmentOf,
  digitTokens,
  effectiveChars,
  freshCountOf,
  negationCount,
  normalizeForCompare,
  noveltyOf,
  pickMergedText,
} from './similarity.js'
export { DedupeLog, TABLE_DEDUPE_LOG } from './log.js'
export type { DedupeLogEntry } from './log.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-dedupe'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-dedupe: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆判重服务；未装载本插件时为 undefined。 */
    'ondra-memory-dedupe'?: DedupeService
  }
}

/**
 * Cordis 入口：接上记忆内核与存储端口、建日志表、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内核缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + `available=false`」，下游能区分「没装判重」与「装了但内核不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DedupeConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-dedupe') : 'ondra.memory-dedupe') as unknown) as LogLike

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

  // 2. 记忆内核是**唯一硬依赖**：没有它就没有「往哪儿写」。
  //    取不到不 return——服务照常注册，`available=false`，让下游自己判断。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('找不到记忆内核（ondra-memory-core），判重服务以「不可用」状态注册')
  }

  // 3. 存储端口是**软依赖**：只用来落决策日志，缺席时判重照常。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let logStore: DedupeLog | undefined
  if (store !== undefined) {
    const created = new DedupeLog(store, settings, log, () => Date.now())
    ctx.effect(() => {
      created.ensure()
      return () => undefined
    }, 'ondra-memory-dedupe: 建判重日志表')
    logStore = created
  } else {
    log.warn('没有可用存储端口：判重照常，但不落决策日志（事后查不到「为什么合并了」）')
  }

  const service = new DedupeRepository(core, settings, log, () => Date.now(), logStore)
  ctx.effect(() => ctx.provide(DEDUPE_SERVICE_KEY, service), 'ondra-memory-dedupe: 注册判重服务')

  // 4. 报一次现状。可用性、后端、日志行数都要能被自检读到，不许黑箱（§12.2）。
  if (!service.available) {
    log.warn('判重服务已注册但不可用（%s）：写入路径应直接新建，不要等判重', service.reason ?? '未知原因')
    return
  }
  const stats = service.stats()
  log.info(
    '判重就绪：内核 %s，合并阈值 %s（包含度），候选上限 %d 条，决策日志 %s（%d 行）',
    stats.coreProvider,
    settings.mergeThreshold,
    settings.maxCandidates,
    stats.logging ? '开' : '关',
    stats.logRows,
  )
  if (settings.conflictPolicy === 'seal-old') {
    log.warn('conflictPolicy=seal-old：判成冲突时会封存旧条。这是「双时态」的等价动作，但会动状态位')
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
    ) => { readonly value: DedupeConfig } | { readonly issues: readonly { readonly message: string }[] }
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
