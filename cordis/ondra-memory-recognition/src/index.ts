/**
 * O-141 `ondra-memory-recognition`：recognition 检索分支（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「O-138~O-144 七个上下文/记忆治理插件」直接列为必须自研，
 * 而 recognition 这一条的机制来自 distill-kura 的**做法**（把索引读给模型听，而不是
 * 建向量库）。生态里没有能直接接上的现成插件：向量库解决的是「算相似度」，
 * 而这一条要的是「让模型从一份可读的清单里指认」——两者的失败方式完全不同，
 * 前者答不出「为什么是这条」，后者答得出。
 *
 * 本插件真正写厚的只有三样：
 *
 * 1. **索引块的形状**（一行一条、按 `seq` 升序、只追加、块内无易变内容）——
 *    这是 §8.5 前缀缓存能不能命中的全部原因，也是手册只给了「6k token」一句的地方；
 * 2. **两段式识别**：同步的确定性那一路（2ms，参与 O-014 融合）+ 异步的小模型那一路
 *    （0.4s，由注入层补一次）。手册把两段写在一个句子里，但 O-014 的契约是同步的，
 *    硬塞进一个方法只能二选一——拆开是唯一能同时满足两边形状的做法；
 * 3. **幻觉过滤**：模型会照 slug 的样子编，编出来的 id 交给 O-014 会静默少一条。
 *
 * 与 O-010 的边界：本插件对 `memory_fact` 是**纯读**（一次分页扫描 + 零次写）。
 * 与 O-014 的边界：本插件只被它调 `search()`，**不调它、不改它**。
 * 与 O-035 的边界：小模型走网关的 `complete()`，本插件不自带 HTTP、不读密钥。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  registerSection,
  valuesToConfigShape,
} from './settings.js'
import type { Config as RecognitionConfig } from './settings.js'
import { RecognitionRepository } from './service.js'
import { RECOGNITION_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LlmGatewayLike,
  LogLike,
  MemoryCoreLike,
  RecognitionService,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、圈权重、错误类），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  CATEGORY_CODES,
  CATEGORY_FALLBACK_CODE,
  MEMORY_ID_RE,
  NAME_RE,
  RECOGNITION_SERVICE_KEY,
  RING_WEIGHTS,
  RecognitionError,
} from './types.js'
export { buildIndex, optionsFingerprint, renderLine, revisionOf } from './index-block.js'
export type { BuildOptions, BuildResult } from './index-block.js'
export { assignSlugs, slugFor } from './slug.js'
export { indexEntries, matchEntries, mergeHits, resolveTarget, walkLinks } from './match.js'
export type { EntryIndex, MatchHit, MatchOptions } from './match.js'
export { PICK_MAX_PICKS, buildSystem, parsePicked, pickWithModel } from './pick.js'
export type { ParsedPick, PickInput } from './pick.js'
export {
  bigramsOf,
  charLengthOf,
  estTokensOf,
  extractTriggers,
  fnv1a,
  gramOverlap,
  linksOf,
  normalizeText,
  triggerRelation,
} from './text.js'
export { CONFIG_SECTION, CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, SECTION_KEYS } from './settings.js'
// `completeConfig` 已在上面 import 进来做校验器，这里用**本地绑定**再导出一次，
// 不写 `export … from`——同一个名字既 import 又 re-export 在某些 TS 版本里会报重复标识符。
export { completeConfig }
export { RecognitionRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-recognition'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆识别服务；未装载本插件时为 undefined。 */
    'ondra-memory-recognition'?: RecognitionService
  }
}

/**
 * Cordis 入口：接上记忆内核与模型网关，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，内核缺席会让
 * 整个插件停在 PENDING（静默不加载，最难查的失败形态）。改成「照常注册 +
 * `available=false`」，O-014 那边就会把这条通道标成 `absent` 而不是报错。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: RecognitionConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(
    identity !== undefined ? identity.loggerName('memory-recognition') : 'ondra.memory-recognition',
  ) as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log, name)) {
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
    log.warn('找不到记忆内核（ondra-memory-core），识别服务以「不可用」状态注册')
  }

  // 3. 模型网关是**软依赖**：缺席时小模型那一路关掉，同步的确定性识别照跑。
  //    这不是降级到「什么都不做」——确定性识别才是参与 O-014 融合的那一路。
  const gateway = ctx.get('ondra-llm-gateway') as LlmGatewayLike | undefined
  if (gateway === undefined) {
    log.info('没有模型网关（ondra-llm-gateway）：只提供同步确定性识别，不调小模型')
  }

  const service = new RecognitionRepository(core, gateway, settings, log, () => Date.now())
  ctx.effect(() => ctx.provide(RECOGNITION_SERVICE_KEY, service), 'ondra-memory-recognition: 注册识别服务')

  // 4. 报一次现状。可用性、预算、通道都要能被自检读到，不许黑箱（§12.2）。
  if (!service.available) {
    log.warn('识别服务已注册但不可用（%s）：O-014 的 recognition 通道应退出融合', service.reason ?? '未知原因')
    return
  }
  log.info(
    '识别就绪：索引按需构建（首次查询付一次全表扫描），上限 %d 条 / 预算 %d token，每行 ≤ %d 字符、%d 个触发词，游走 %d 圈',
    settings.maxEntries,
    settings.indexBudgetTokens,
    settings.entryCharLimit,
    settings.triggersPerEntry,
    settings.maxRing,
  )
  log.info(
    '小模型那一路：%s（网关%s）',
    settings.pickEnabled === 'auto' ? '开' : '关',
    gateway === undefined ? '缺席' : gateway.available === true ? '在位' : '在位但不可用',
  )
  if (settings.includeArchived) {
    log.warn('includeArchived=true：已沉底的记忆也会进索引并被认出——这会让「该沉下去的」重新冒头')
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
    ) => { readonly value: RecognitionConfig } | { readonly issues: readonly { readonly message: string }[] }
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
