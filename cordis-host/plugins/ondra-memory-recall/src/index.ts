/**
 * O-014 `ondra-memory-recall`：她此刻想起什么（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层检索」列为可复用档，本插件把**存储与打分基座**
 * 全部交了出去——建表、CRUD、寿命、强度、归档都在 O-010；边的权重在 O-015；
 * 向量在 O-122；recognition 在 O-141。真正自研的只有三样生态里没有的东西：
 *
 * 1. **五因子与归一化口径**（`.18/.46/.11/.14/.11`，且只除以参与的因子）。
 *    生态里的记忆库给的是「相似度 + 时间衰减」两项，没有「图谱」与「重要」这两项，
 *    也没有「缺席因子必须退出分母」这条——它们通常直接按 0 算，于是全库分数一起塌。
 * 2. **`dropped` 恒为 0 的召回**。所有现成实现都提供 `topK`；`topK` 在召回层就是
 *    物理删除，而手册 §12.1 把它列为 P0 第二条。
 * 3. **可解释**：`explain()` 能回答「她为什么没想起这条」，且给出的是同一个候选集
 *    （不是重新跑一遍再猜）。
 *
 * 与 O-015 的边界：本插件**只读边**，绝不建边、不衰减边、不改边权。
 * 与 O-013 的边界：本插件**只读强度**，绝不归档、不改 `archived`。
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
import type { Config as RecallConfig } from './settings.js'
import { RecallRepository } from './service.js'
import { RECALL_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  GraphLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  RecallService,
  RecognitionSourceLike,
  VectorSourceLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、权重表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  BM25_B,
  BM25_K1,
  CHANNEL_FAMILY,
  FUSE_MODES,
  RECALL_CHANNELS,
  RECALL_FACTORS,
  RECALL_SERVICE_KEY,
  RRF_K,
  SPEC_WEIGHTS,
  RecallError,
} from './types.js'
export { buildIndex, idfOf, queryGramsOf, searchBigram, searchRare, unknownGramsOf } from './lexical.js'
export type { LexicalDoc, LexicalIndex, Posting, RankedItem } from './lexical.js'
export { compareFused, rrfFuse, weightedRank } from './fuse.js'
export type { ChannelList, FusedEntry, WeightedEntry } from './fuse.js'
export { composeFactors, freshnessOf, importanceOf, keywordFactorOf, toFactorsView } from './score.js'
export type { FactorInput } from './score.js'
export { bigramsOf, charLengthOf, normalizeText, sharedGramsOf, termFreqOf } from './tokenize.js'
export { probeRecognition, probeVector } from './external.js'
export type { ProbeResult } from './external.js'
export { RecallRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-recall'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-recall: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆召回服务；未装载本插件时为 undefined。 */
    'ondra-memory-recall'?: RecallService
  }
}

/**
 * Cordis 入口：接上记忆内核、图谱与两条可选通道，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内核缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + `available=false`」，下游能区分「没装召回」与「装了但内核不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: RecallConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-recall') : 'ondra.memory-recall') as unknown) as LogLike

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

  // 2. 记忆内核是**唯一硬依赖**：没有它就没有「从哪儿读」。
  //    取不到不 return——服务照常注册，`available=false`，让下游自己判断。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('找不到记忆内核（ondra-memory-core），召回服务以「不可用」状态注册')
  }

  // 3. 图谱是**软依赖**：缺席时图谱因子退出归一化，其余四项照跑。
  const graph = ctx.get('ondra-memory-graph') as GraphLike | undefined
  if (graph === undefined) {
    log.info('没有图谱服务（ondra-memory-graph）：图谱因子退出归一化，分母从 1.00 降到 0.89')
  }

  // 4. 两条外部通道也是软依赖，且各带独立降级（一条挂了不影响另一条被选中）。
  const vector = ctx.get('ondra-memory-vector') as VectorSourceLike | undefined
  const recognition = ctx.get('ondra-memory-recognition') as RecognitionSourceLike | undefined

  const service = new RecallRepository(core, graph, vector, recognition, settings, log, () => Date.now())
  ctx.effect(() => ctx.provide(RECALL_SERVICE_KEY, service), 'ondra-memory-recall: 注册召回服务')

  // 5. 报一次现状。可用性、模式、通道都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('召回服务已注册但不可用（%s）：对话链应退回「无记忆」路径，不要等召回', stats.reason ?? '未知原因')
    return
  }
  const channels = [
    `字面=开`,
    `向量=${vector === undefined ? '缺席' : '在'}`,
    `图谱=${graph === undefined ? '缺席' : '在'}`,
    `recognition=${recognition === undefined ? '缺席' : '在'}`,
  ].join('，')
  log.info('召回就绪：融合=%s，k=%d，BM25 k1=%s b=%s，%s', settings.fuse, settings.rrfK, settings.bm25K1, settings.bm25B, channels)
  if (settings.fuse === 'rrf') {
    log.debug?.('rrf 模式下五因子只做平局裁决，不参与主导排序（手册 §2.3 硬规矩②）')
  }
  if (settings.maxScanRows > 0) {
    log.warn('maxScanRows=%d：扫描窗口外的记忆本轮不参与，这是性能逃生口，不是召回裁剪', settings.maxScanRows)
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
    ) => { readonly value: RecallConfig } | { readonly issues: readonly { readonly message: string }[] }
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
