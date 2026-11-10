/**
 * O-017 `ondra-memory-audit`：遗忘可解释与四态删除（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储/检索/去重/衰减」列为复用档，
 * 本插件把**存储、记忆本体、强度公式、三档话术、孤儿边清理**全部交了出去：
 * 强度问 O-010、话术问 O-013、边问 O-015、表问 O-006/O-007。
 * 真正自研的只有两样，生态里都没有：
 *
 * 1. **「为什么记不清了」的解释**——把 O-010 的输入与结果翻译成人话，
 *    并明确**不解释因子数值**（那需要第二份公式）。
 * 2. **钉住与四态删除的组合**：`forget` 顺带清钉子与孤儿边、`archive` 前给钉住项
 *    续命、`sink` 刻意没有方法。
 *
 * 边界（写死在这里，防止下一轮有人顺手改）：
 * - **不写 `memory_fact` 的任何一列**。`pin` 只写 `memory_pin`；
 *   删除动作全部经 O-010 的公开方法。
 * - **不复制话术阈值**。0.7 / 0.4 只在 O-013 一处；本插件缺席时给 `undefined`。
 * - **不装定时器**（`autoScan` 默认 false）。`archive()` 是写操作。
 * - **`sink` 没有方法**。手册 §2.4「自然沉底：什么都不做」，字面意义上的不做；
 *   给它写一个空方法就是 §17-6 禁止的假开关。
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
import type { Config as AuditConfig } from './settings.js'
import { AuditRepository } from './service.js'
import { AUDIT_SERVICE_KEY } from './types.js'
import type {
  AuditService,
  ConfigSchemaLike,
  DecayLike,
  GraphLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、四态说明书），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  AUDIT_SERVICE_KEY,
  DELETION_MODES,
  TABLE_PIN,
  AuditError,
} from './types.js'
export { categoryLabel, previewOf, reasonsOf } from './explain.js'
export { pinToRow, toPin, PinStore } from './store.js'
export { TABLE_PIN_SPEC } from './schema.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export { AuditRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-audit'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-audit: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 遗忘审计服务；未装载本插件时为 undefined。 */
    'ondra-memory-audit'?: AuditService
  }
}

/**
 * Cordis 入口：接上记忆内核、存储端口、衰减与图谱，建钉子表，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内存兜底在位也救不了——整插件会停在 PENDING（静默不加载）。
 * 改成「照常注册 + 各能力分别降级」，下游能区分「没装内核」与「装了但存储不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: AuditConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-audit') : 'ondra.memory-audit') as unknown) as LogLike

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

  // 2. 记忆内核是**硬依赖**：解释与删除全部依赖它。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('没有记忆内核（ondra-memory-core）：审计服务以「不可用」状态注册（解释与删除都做不了）')
  }

  // 3. 存储端口：SQLite 优先，内存兜底。钉子必须有地方放。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (store === undefined) {
    log.warn('没有可用存储端口（ondra-store-sqlite / ondra-store-memory 都缺席）：钉子无处可放，审计服务转「不可用」')
  }

  // 4. 衰减服务是**软依赖**：只借 `clarityOf()` 一句话术函数。
  //    缺席时解释照给，只是没有「，记不太清了」那半句——**不自算阈值**。
  const decay = ctx.get('ondra-memory-decay') as DecayLike | undefined
  if (decay === undefined) {
    log.info('没有衰减服务（ondra-memory-decay）：解释里不含三档话术（阈值只有一个真源，不在这里复制一份）')
  }

  // 5. 图谱服务是**软依赖**：只借 `forgetOf()` 清孤儿边。
  const graph = ctx.get('ondra-memory-graph') as GraphLike | undefined
  if (graph === undefined) {
    log.info('没有图谱服务（ondra-memory-graph）：忘记记忆时不清孤儿边（ForgetOutcome.edgesCleared 会如实为 false）')
  }

  const service = new AuditRepository(store, core, decay, graph, settings, log, () => Date.now())

  // 6. 建表放进 effect：表是本插件的资源，卸载时要能被撤（端口不支持删表，
  //    但注册顺序与重载语义仍然要挂在 effect 上，否则重载会重复 ensure）。
  ctx.effect(() => {
    const ok = service.ready()
    if (!ok) log.warn('钉子表初始化失败：审计服务转「不可用」')
    return () => undefined
  }, 'ondra-memory-audit: 建钉子表')

  ctx.effect(() => ctx.provide(AUDIT_SERVICE_KEY, service), 'ondra-memory-audit: 注册遗忘审计服务')

  // 7. 报一次现状。可用性、钉子数、两个软依赖在不在，都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('遗忘审计已注册但不可用（%s）', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '遗忘审计就绪：记忆 %d 条，钉子 %d / %d，三档话术 %s，孤儿边清理 %s',
    stats.facts,
    stats.pins,
    stats.pinCap,
    stats.clarityAvailable ? '可用' : '缺席',
    stats.graphAvailable ? '可用' : '缺席',
  )
  if (settings.autoScan) {
    log.warn('autoScan=true：archive() 是写操作，交给定时器会让「为什么这条沉底了」查不出来（默认 false）')
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
    ) => { readonly value: AuditConfig } | { readonly issues: readonly { readonly message: string }[] }
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
