/**
 * O-129 `ondra-drive-gap`：缺口池与张力（〔研〕自研，P0）。
 *
 * ## 一句话
 *
 * 她心里那几件没弄明白的事，记在这里；放得越久越压人，压到 80 就该被它叫醒。
 *
 * ## 为什么必须自研
 *
 * 手册 §1.8 把「缺口池」列进「必须自研」那一侧的依据是它的**形状**而不是难度：
 * 生态里做「主动消息」的插件一律是**定时器 + 话由模板**，
 * 而这里要的是「先有一个没解决的困惑，它自己慢慢变重，重到压不住才开口」。
 * 前者是调度问题，后者是内驱问题——`digital-life-core` 用 86 个文件才把后者做出来，
 * 说明它不是「加个 cron」能替代的东西。
 *
 * 真正自研的只有三样：**张力派生式**、**分类归并与相似加压**、**休眠期不焦虑的记账**。
 * 数值全是手册给的（0.6 / +10 / 80 / 30 / 60min / −10）。
 *
 * ## 与邻居的边界
 *
 * - **不外发**：唤醒谁发、怎么发、正文写什么，全归 O-042。本插件只出判定。
 * - **不存待办**：待办走 O-016 的 `working_todo`（§17「待办不进缺口池」）。
 * - **不改情绪**：能量只读 O-026；本插件结构里没有 `feel` / `setAxis`。
 * - **不 import 任何邻居的源码**（§18.5）：只用结构对位镜像。
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
import type { Config as DriveGapConfig } from './settings.js'
import { GapRepository } from './service.js'
import { GapStore } from './store.js'
import { BUMP_STEP, DRIVE_GAP_SERVICE_KEY, SIMILARITY_THRESHOLD, WAKE_TENSION } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DriveGapService,
  EmotionLike,
  IdentityLike,
  LogLike,
  StoreLike,
} from './types.js'

export type * from './types.js'
export {
  BUMP_STEP,
  DREAM_ENERGY_MIN,
  DREAM_IDLE_HOURS,
  DRIVE_GAP_SERVICE_KEY,
  FAILURE_KINDS,
  FAILURE_ZH,
  GAP_FRAGMENT_TEXT,
  GAP_SOURCES,
  MAX_TENSION,
  MIN_FRAGMENT_ORDER,
  SIMILARITY_THRESHOLD,
  TRUNCATE_CHARS,
  WAKE_COOLDOWN_MINUTES,
  WAKE_ENERGY_MIN,
  WAKE_IDLE_MINUTES,
  WAKE_TENSION,
} from './types.js'
export {
  buildFailureText,
  classifySourceQuery,
  clamp,
  clampTension,
  cooldownLeft,
  detectUnsure,
  elapsedHours,
  isDreamWindow,
  judgeDream,
  judgeWake,
  normalizeForCompare,
  similarity,
  tensionOf,
  toView,
  truncate,
} from './drive.js'
export { CONFIG_SECTION, CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS } from './settings.js'
export { EMPTY_WAKE_STATE, TABLE_GAP, TABLE_WAKE, GapStore } from './store.js'
export type { WakeState } from './store.js'
export { GapRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-drive-gap'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-drive-gap: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 缺口池服务；未装载本插件时为 undefined。 */
    'ondra-drive-gap'?: DriveGapService
  }
}

/**
 * Cordis 入口：接上存储与两个读数、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：写 `inject: ['ondra-emotion-core']` 会让情绪缺席时
 * 整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 而本插件的正确降级是「照常注册 + 能量读不到就不唤醒」——
 * 读不到能量时她不会半夜找你，但池子照常记账，等情绪服务回来立刻能用。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DriveGapConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('drive-gap') : 'ondra.drive.gap') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
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

  // 2. 池表：执念必须落盘，否则重启等于「她忽然什么都放下了」。
  //    这是产品语义问题，不是性能问题。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let gapStore: GapStore | undefined
  if (store === undefined) {
    log.warn('没有可用存储端口：缺口池只活在内存里，重启等于「她忽然什么都放下了」')
  } else {
    const created = new GapStore(store, log)
    if (created.ensure()) gapStore = created
  }

  // 3. 两个读数都用**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿不到。
  const service = new GapRepository(
    settings,
    log,
    () => Date.now(),
    () => ctx.get('ondra-emotion-core') as EmotionLike | undefined,
    () => ctx.get('ondra-clock') as ClockLike | undefined,
    gapStore,
  )
  ctx.effect(() => ctx.provide(DRIVE_GAP_SERVICE_KEY, service), 'ondra-drive-gap: 注册缺口池')

  // 4. 报一次现状（§12.2：可用性、降级原因都要能被自检读到，不许黑箱）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('缺口池已注册但不可用（%s）：不记账、不判唤醒、不出片段', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '缺口池就绪：开 %d 条 / 闭 %d 条，存储 %s；起点 %.0f + %.1f/h，唤醒线 %.0f，判重 %.1f 加压 +%d',
    stats.open,
    stats.closed,
    stats.storeProvider,
    settings.baseTension,
    settings.tensionPerHour,
    WAKE_TENSION,
    SIMILARITY_THRESHOLD,
    BUMP_STEP,
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
    ) => { readonly value: DriveGapConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      return { value: completeConfig(value) }
    },
  },
}
