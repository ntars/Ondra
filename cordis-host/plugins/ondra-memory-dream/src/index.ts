/**
 * O-019 `ondra-memory-dream`：做梦与睡眠巩固（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储/检索/去重/衰减」列为复用档，
 * 本插件把**存储、记忆本体、判重、模型调用、图谱建边、快照**全部交了出去：
 * 事实写 O-010、重复拒问 O-012、模型问 O-035、边问 O-015、备份问 O-009。
 * 真正自研的是三样，生态里都没有对应物：
 *
 * 1. **四道闸的组合**（逐字可查 / 改人格拒 / 重复拒 / 无人称工程结论拒）——
 *    这是「梦只补带出处的事实」这条产品承诺的全部实现。
 * 2. **五类卡片的纯规则挖掘**（pitfall / playbook / hotspot / unresolved / fact），
 *    零模型调用、可解释、失败可回溯。
 * 3. **荒诞联想的「同实体」近似**（共同二元组 + 时间差），以及它与闸式的互斥。
 *
 * 边界（写死在这里，防止下一轮有人顺手改）：
 * - **不做「重写摘要」**。需要「只改摘要」的接口，而 `revise()` 会改正文并把 S ×1.3。
 * - **不装定时器**。22:00 与「空闲多久」都由调用方给。
 * - **不复制 11 类表**。类别合法性归 O-010，本插件原样传下去。
 * - **不写 `memory_fact` 的任何一列**。所有写入经 `core.addFact()`。
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
import type { Config as DreamConfig } from './settings.js'
import { DreamRepository } from './service.js'
import { DreamStore } from './store.js'
import { DREAM_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  DedupeLike,
  DreamService,
  GatewayLike,
  GraphLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  SnapshotLike,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、模式表、卡片表、错误类），分开导出。
export type * from './types.js'
export {
  CARD_KINDS,
  DREAM_MODES,
  DREAM_SERVICE_KEY,
  EVIDENCE_SOURCES,
  REJECTION_CODES,
  DreamError,
} from './types.js'
export {
  DREAM_TABLE_SPECS,
  TABLE_DREAM_CARD,
  TABLE_DREAM_LOG,
  TABLE_DREAM_TALK,
  DreamStore,
  makeId,
  toDreamCard,
} from './store.js'
export { DREAM_SYSTEM_PROMPT, TALK_SYSTEM_PROMPT, buildMaterialMessage, buildTalkMessage } from './prompt.js'
export { gateImpersonal, gatePersona, gateQuote, gateShape } from './gates.js'
export { bigrams, charCount, containsVerbatim, cutTo, dateKey, normalizeForMatch, normalizeQuote, sharedGramCount } from './quote.js'
export { GateBranch, parseCandidates } from './branches/gate.js'
export { LightweightBranch, factCards, hotspotCards, pitfallCards, playbookCards, sortSignals, unresolvedCards } from './branches/lightweight.js'
export { SurrealBranch, cleanTalk, findSurrealPairs } from './branches/surreal.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export { DreamRepository, assertInput, cardWeight } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-dream'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-dream: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆做梦服务；未装载本插件时为 undefined。 */
    'ondra-memory-dream'?: DreamService
  }
}

/**
 * Cordis 入口：接上记忆内核、模型网关、图谱、判重、快照与存储，建三张表，注册服务。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内核缺席会让整插件停在 PENDING（静默不加载），连「做梦不可用」这句话都说不出来。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DreamConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-dream') : 'ondra.memory-dream') as unknown) as LogLike

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

  // 2. 记忆内核是**硬依赖**：三个分支都要读写记忆。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('没有记忆内核（ondra-memory-core）：服务以「不可用」状态注册')
  }

  // 3. 模型网关：闸式分支**必需**，荒诞分支可选，轻量分支不需要。
  const gateway = ctx.get('ondra-llm-gateway') as GatewayLike | undefined
  if (gateway === undefined && settings.mode === 'gate') {
    log.warn('没有模型网关（ondra-llm-gateway）：mode=gate 不可用。想零模型调用请把 mode 改成 lightweight')
  }

  // 4. 图谱：只有荒诞分支要。
  const graph = ctx.get('ondra-memory-graph') as GraphLike | undefined
  if (graph === undefined && settings.mode === 'surreal') {
    log.info('没有图谱服务（ondra-memory-graph）：荒诞分支建不了边，梦话照常')
  }

  // 5. 判重：重复拒用它，缺席则降级为「同批去重 + 墓碑」，**不自写包含度阈值**。
  const dedupe = ctx.get('ondra-memory-dedupe') as DedupeLike | undefined
  if (dedupe === undefined) {
    log.info('没有判重服务（ondra-memory-dedupe）：重复拒降级为「同批去重 + 墓碑」（不自己写第二把尺子）')
  }

  // 6. 快照：三道保险之一，只借 `create()`。
  const snapshot = ctx.get('ondra-snapshot') as SnapshotLike | undefined
  if (snapshot === undefined) {
    log.info('没有快照服务（ondra-snapshot）：做梦前不做备份（DreamReport.backup 会如实为 skipped）')
  }

  // 7. 存储：三张表要有地方放。
  const storePort = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (storePort === undefined) {
    log.warn('没有存储端口：做梦记账、梦话与卡片都不落盘（进程退出即失）')
  }
  const store = new DreamStore(storePort, log)
  // 建表在**构造服务之前**：`store.available` 决定初始化时是否记「不落盘」这条 issue。
  store.ensure()

  const service = new DreamRepository(core, gateway, graph, dedupe, snapshot, store, settings, log, () => Date.now())

  ctx.effect(() => ctx.provide(DREAM_SERVICE_KEY, service), 'ondra-memory-dream: 注册记忆做梦服务')

  // 8. 报一次现状。分支、可用性、三个软依赖在不在，都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('记忆做梦已注册但不可用（%s / mode=%s）', stats.reason ?? '未知原因', stats.mode)
    return
  }
  log.info(
    '记忆做梦就绪：mode=%s，记忆 %d 条，待注入梦话 %d 句，未归档卡片 %d 张，判重 %s，备份 %s，图谱 %s',
    stats.mode,
    stats.facts,
    stats.pendingTalk,
    stats.liveCards,
    stats.dedupeGate === 'service' ? '可用' : '降级',
    stats.snapshotAvailable ? '可用' : '缺席',
    stats.graphAvailable ? '可用' : '缺席',
  )
  if (stats.mode === 'surreal') {
    log.info('mode=surreal：荒诞边永不进检索（由 O-015 保证），梦话次日首次对话注入并标注「这是梦话」')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: DreamConfig } | { readonly issues: readonly { readonly message: string }[] }
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
