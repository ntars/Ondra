/**
 * O-013 `ondra-memory-decay`：衰减调度与 SM-2 间隔复习（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储 / 检索 / 去重 / 衰减」列为可复用档，
 * 本插件把**存储与寿命计算全部交了出去**——强度公式、11 类基线、归档窗口都在 O-010，
 * 本插件连一次 `Math.pow(0.5, ...)` 都没有。真正自研的只有三样：
 *
 * 1. **SM-2 与艾宾浩斯表的融合**（手册 §2.4 + §1.7）。生态里的 SM-2 实现
 *    （dsh-engram 一类）是「1 天 → 6 天 → ×EF」，表达不了 5 分钟与 30 分钟这两档；
 *    而纯艾宾浩斯表是死节拍，表达不了「这条特别难记」。两者必须融（§12.1）。
 * 2. **清晰度三档话术**（手册 §2.6）。「，记不太清了」「，只剩个模糊的影子」——
 *    这是衰减唯一能被用户看见的产物，也是手册认定的「最拟人的遗忘表达」。
 * 3. **孤儿计划的清理**。记忆被 `forget()` 之后，复习计划会留下来继续报「该复习了」，
 *    界面点进去一条都没有。这个坑只有在真跑过一轮之后才会显现。
 *
 * 与 O-012 的边界：**本插件只管「旧的该暗到什么程度」，不管「新的该不该写」**。
 * 判重是 O-012 的活；本插件连 `addFact()` 都没有（镜像里刻意不含它）。
 *
 * 与 O-015 的边界（裁决⑪）：**只衰减条目，边归 O-015**。本插件从不读写图谱边。
 */

import type { Context } from '@ntars/cordis'
import { ReviewStore } from './review-store.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as DecayConfig } from './settings.js'
import { DecayRepository } from './service.js'
import { DECAY_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, DecayService, IdentityLike, LogLike, MemoryCoreLike, StoreLike } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、档位表、错误类），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { CLARITY_BANDS, DECAY_SERVICE_KEY, DecayError } from './types.js'
export {
  EF_MAX,
  EF_MIN,
  EF_START,
  LADDER_HOURS,
  PASS_GRADE,
  clampGrade,
  efAfter,
  initialEf,
  intervalHoursOf,
} from './sm2.js'
export { CLARITY_PHRASES, bandOf, clarityOf } from './decay.js'
export { ReviewStore, TABLE_REVIEW } from './review-store.js'
export type { ReviewRow } from './review-store.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-decay'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-decay: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆衰减服务；未装载本插件时为 undefined。 */
    'ondra-memory-decay'?: DecayService
  }
}

/**
 * Cordis 入口：接上记忆内核与存储端口、建复习表、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内核缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + `available=false`」，下游能区分「没装衰减」与「装了但内核不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DecayConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-decay') : 'ondra.memory-decay') as unknown) as LogLike

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

  // 2. 记忆内核：强度与归档的**唯一真源**。取不到不 return——服务照常注册。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('找不到记忆内核（ondra-memory-core），衰减服务以「不可用」状态注册')
  }

  // 3. 存储端口：复习计划必须落盘，否则「下次什么时候复习」每次都归零。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let reviewStore: ReviewStore | undefined
  if (store !== undefined) {
    const created = new ReviewStore(store, settings, log)
    ctx.effect(() => {
      created.ensure()
      return () => undefined
    }, 'ondra-memory-decay: 建复习计划表')
    reviewStore = created
  } else {
    log.warn('没有可用存储端口：复习计划无处可落，本插件的复习功能不可用（强度与清晰度仍可读）')
  }

  const service = new DecayRepository(core, reviewStore, store !== undefined, settings, log, () => Date.now())
  ctx.effect(() => ctx.provide(DECAY_SERVICE_KEY, service), 'ondra-memory-decay: 注册衰减服务')

  // 4. 可选周期扫描。默认关——扫描会触发沉底，那是一次写操作，
  //    时机应由夜巡/回合边界决定，而不是一个「不知道第几个装载」的定时器。
  if (settings.autoScan) {
    ctx.effect(() => {
      const handle = setInterval(() => {
        try {
          service.scan()
        } catch (error) {
          // 定时器里抛错会变成未捕获异常，直接冒到宿主进程。
          log.warn('周期扫描失败（下一轮再试）：%s', messageOf(error))
        }
      }, Math.max(5, settings.scanIntervalMinutes) * 60000)
      // 不阻止进程退出：`unref` 只在 Node 的 Timeout 上存在，
      // 浏览器/Worker 下 `setInterval` 返回数字，直接调会抛 TypeError。
      const maybe = handle as unknown as { unref?: unknown }
      if (typeof maybe.unref === 'function') {
        (maybe.unref as () => void).call(handle)
      }
      return () => clearInterval(handle)
    }, 'ondra-memory-decay: 周期扫描')
    log.info('周期扫描已开启：每 %d 分钟一次', settings.scanIntervalMinutes)
  }

  // 5. 报一次现状。可用性、后端、计划条数都要能被自检读到，不许黑箱（§12.2）。
  if (!service.available) {
    log.warn('衰减服务已注册但不可用（%s）：注入时不应等待清晰度话术', service.reason ?? '未知原因')
    return
  }
  const stats = service.stats()
  log.info(
    '衰减就绪：内核 %s，复习计划 %d 条（到期 %d 条），清晰度分档 %s / %s',
    stats.coreProvider,
    stats.reviews,
    stats.dueNow,
    settings.clearAbove,
    settings.fadedAbove,
  )
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
    ) => { readonly value: DecayConfig } | { readonly issues: readonly { readonly message: string }[] }
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
