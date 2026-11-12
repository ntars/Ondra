/**
 * O-027 `ondra-emotion-diffuse`：跨会话的情绪弥散（〔研〕自研）。
 *
 * ## 这一项为什么归自研档
 *
 * 手册 §1.8 把「情绪」整体列进自研档，理由是生态里做情绪的都是「读别人的话」。
 * 弥散更极端：它连「一句话有多正面」都不需要，它要的是**上一次会话结束时她剩多少心情**，
 * 以及**两个人有多熟**。前一个数只在 Ondra 自己的情绪内核里，后一个数只在关系域里，
 * 任何第三方库都拿不到。
 *
 * 真正自研的只有一样：**保留比例这条曲线**。而且它也不是我编的——
 * 手册 §9.1 参数速查表里逐字写着 `(mood−baseline)×0.4×(1−familiarity×0.5)`。
 * 本插件做的是把它拆成可单独验算的两段（`retain` / `target`），
 * 再把「什么时候该算」这件事做扎实（幂等 + 间隔闸）。
 *
 * ## 与邻居的边界
 *
 * - **不持有情绪**：心情的读写全归 O-026。本插件连 `setAxis` 都不在自己的
 *   结构对位接口里（`EmotionLike` 只有 `state` 与 `available`）——
 *   接口上先拿掉，比注释里写「请不要写」有效。
 * - **不表达**：一句人话都不产。`note` 只进日志与面板，不进提示词（§4.3 禁报数）。
 * - **不管张力**：张力有自己的 24 小时半衰与 O-030 的锁。公式里只有 mood。
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
import type { Config as DiffuseConfig } from './settings.js'
import { DiffuseRepository } from './service.js'
import { MarkStore } from './store.js'
import { DIFFUSE_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  DiffuseService,
  DiffuseUnavailableReason,
  EmotionLike,
  IdentityLike,
  LogLike,
  StoreLike,
} from './types.js'

export type * from './types.js'
export {
  DIFFUSE_COEFF,
  DIFFUSE_SERVICE_KEY,
  FAMILIARITY_DAMP,
  MOOD_BASELINE,
  MOOD_MAX,
  MOOD_MIN,
  DiffuseError,
} from './types.js'
export {
  FIRST_RUN_GAP,
  clamp01,
  gapMinutesOf,
  normalizeFamiliarity,
  noteOf,
  previewOf,
  retainOf,
  targetOf,
} from './diffuse.js'
export { TABLE_MARK, MarkStore } from './store.js'
export type { MarkRow } from './store.js'
export { DiffuseRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-diffuse'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-diffuse: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 情绪弥散服务；未装载本插件时为 undefined。 */
    'ondra-emotion-diffuse'?: DiffuseService
  }
}

/**
 * Cordis 入口：接上情绪内核与标记表，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-emotion-core']` 之后，
 * 情绪内核缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + 拒绝时带原因码」，调用方能区分「没装弥散」
 * 与「装了但情绪内核没起来」——后者的表现是「这次没带走情绪」，而不是她不说话。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DiffuseConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-diffuse') : 'ondra.emotion.diffuse') as unknown) as LogLike

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

  // 2. 标记表：幂等与间隔闸都要一个落点，否则重启后会把同一场再算一遍。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let marks: MarkStore | undefined
  let reason: DiffuseUnavailableReason | undefined
  if (store !== undefined) {
    const created = new MarkStore(store, log)
    if (created.ensure()) {
      marks = created
    } else {
      reason = 'no-store'
    }
  } else {
    reason = 'no-store'
    log.warn('没有可用存储端口：弥散标记只在内存里，重启后可能重算一次')
  }

  // 3. 情绪内核**每次现取**：装载顺序不确定，缓存一次就等于让顺序决定功能。
  const emotionOf = (): EmotionLike | undefined => ctx.get('ondra-emotion-core') as EmotionLike | undefined

  // 4. 造服务并注册。
  const service = new DiffuseRepository(settings, log, () => Date.now(), emotionOf, marks, reason)
  ctx.effect(() => ctx.provide(DIFFUSE_SERVICE_KEY, service), 'ondra-emotion-diffuse: 注册情绪弥散')

  // 5. 报一次现状。可用性、降级原因、间隔阈值都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn(
      '情绪弥散已注册但当前不可用（%s）：提领会返回带原因码的拒绝，不会抛错',
      stats.reason ?? '未知原因',
    )
    return
  }
  log.info(
    '情绪弥散就绪：保留比例 %s–%s，同会话判定间隔 %d 分钟，标记表 %s',
    service.retainOf(1).toFixed(2),
    service.retainOf(0).toFixed(2),
    settings.minGapMinutes,
    stats.storeProvider,
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
    ) => { readonly value: DiffuseConfig } | { readonly issues: readonly { readonly message: string }[] }
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
