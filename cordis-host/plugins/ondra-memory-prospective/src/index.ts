/**
 * O-016 `ondra-memory-prospective`：说好的事与要做的事（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储/检索/去重/衰减」列为复用档，
 * 本插件把**存储、建表、寿命公式、记忆本体**全部交了出去——表由 O-006/O-007 建、
 * 记忆由 O-010 写（`category=promise` 用它自己的 8000 小时基线算寿命）。
 * 真正自研的只有三样，生态里都没有：
 *
 * 1. **两张表的分界**：承诺进记忆、待办不进（手册 §2.8 + 语料 §17）。
 *    任何「记忆插件」都只有一张表，而这个分界是产品决策，不是技术选择。
 * 2. **反向权重**：承诺的紧迫度随剩余时间**上升**，与记忆强度的递减方向相反。
 * 3. **承诺抽取的四道闸**：长度 4–120、疑问句尾排除、只认明确时间词、最多 20 条。
 *
 * 边界（写死在这里，防止下一轮有人顺手改）：
 * - **不写情绪**。`settle()` 只返回 `{ delta, applied: false }`；关系域归 O-026。
 * - **待办一次都不碰记忆内核**。写了就会污染衰减统计与检索、进星云图。
 * - **不调模型**。手册 §2.8 原话「纯正则不调模型」，故不消费 `ondra-llm-gateway`。
 * - **不装定时器**（`autoExpire` 默认 false）。清理是写操作，时机由回合边界显式给。
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
import type { Config as ProspectiveConfig } from './settings.js'
import { ProspectiveRepository } from './service.js'
import { PROSPECTIVE_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  ProspectiveService,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、时间词表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  DONE_MARKERS,
  PROMISE_CATEGORY,
  PROMISE_MARKERS,
  PROSPECTIVE_SERVICE_KEY,
  TABLE_PROMISE,
  TABLE_TODO,
  TIME_WORDS,
  TODO_MARKERS,
  ProspectiveError,
} from './types.js'
export { endOfDayAfter, findTimeWord, overlapScore, resolveDue, saysDone, detectIn, stripTodoMarkers } from './extract.js'
export { compareUrgency, daysLeftOf, hoursLeftOf, urgencyOf } from './urgency.js'
export { toPromise, promiseToRow, toTodo, todoToRow, ProspectiveStore } from './store.js'
export { TABLE_PROMISE_SPEC, TABLE_TODO_SPEC } from './schema.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  RELATIONSHIP_DELTAS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export { ProspectiveRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-prospective'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-prospective: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 承诺与待办服务；未装载本插件时为 undefined。 */
    'ondra-memory-prospective'?: ProspectiveService
  }
}

/**
 * Cordis 入口：接上存储端口、记忆内核与时钟，建两张表，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内存兜底在位也救不了——整插件会停在 PENDING（静默不加载）。
 * 改成「照常注册 + 各能力分别降级」，下游能区分「没装内核」与「装了但存储不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ProspectiveConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-prospective') : 'ondra.memory-prospective') as unknown) as LogLike

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

  // 2. 存储端口：SQLite 优先，内存兜底。两个都没有才真的不可用。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (store === undefined) {
    log.warn('没有可用存储端口（ondra-store-sqlite / ondra-store-memory 都缺席）：承诺与待办以「不可用」状态注册')
  }

  // 3. 记忆内核是**承诺的必要条件**：没有它承诺写不进记忆，故不写（写了也没处存寿命）。
  //    待办不依赖它——待办本来就不进记忆链。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('没有记忆内核（ondra-memory-core）：承诺无法写入（remember 抛 no-core），待办照常可用')
  }

  // 4. 时钟是**软依赖**：只借它的 `startOfDay()` 做日历日算术。
  //    缺席时退回本地日历（已知限制 4：配置了非系统时区时会差几小时）。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  if (clock === undefined) {
    log.info('没有时钟服务（ondra-clock）：到期日改用本地日历推算，产品时区非系统时区时会偏')
  }

  const service = new ProspectiveRepository(store, core, settings, log, () => Date.now(), clock)

  // 5. 建表放进 effect：表是本插件的资源，卸载时要能被撤（端口不支持删表，
  //    但注册顺序与重载语义仍然要挂在 effect 上，否则重载会重复 ensure）。
  ctx.effect(() => {
    const ok = service.ready()
    if (!ok) log.warn('承诺表 / 待办表初始化失败：服务转「不可用」')
    return () => undefined
  }, 'ondra-memory-prospective: 建两张表')

  ctx.effect(() => ctx.provide(PROSPECTIVE_SERVICE_KEY, service), 'ondra-memory-prospective: 注册承诺与待办服务')

  // 6. 报一次现状。可用性、条数、可写性都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('承诺与待办已注册但不可用（%s）', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '承诺与待办就绪：承诺 %d 条（未结算 %d），待办 %d 条（未完成 %d），提醒提前 %d 小时、宽限 %d 小时，上限 %d / %d',
    stats.promises.total,
    stats.promises.open,
    stats.todos.total,
    stats.todos.open,
    settings.remindAheadHours,
    settings.graceHours,
    settings.maxPromises,
    settings.maxTodos,
  )
  if (!stats.promiseWritable) {
    log.warn('承诺不可写（缺记忆内核）：只记待办，不记承诺——免得写出一条不会提醒也不会结算的空承诺')
  }
  if (settings.autoExpire) {
    log.warn('autoExpire=true：清理是写操作，交给定时器会让「为什么这条承诺没了」查不出来（默认 false）')
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
    ) => { readonly value: ProspectiveConfig } | { readonly issues: readonly { readonly message: string }[] }
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
