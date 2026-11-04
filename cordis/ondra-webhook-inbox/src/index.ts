/**
 * O-114 `ondra-webhook-inbox`：事件播报收件箱（〔复〕复用档，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答三个问题：**要不要说、什么时候说、说哪一类。**
 *
 * 外面发生的事（CI 挂了、订单来了、邮件到了）由宿主解析成一张简单的事件表，
 * 交给 `ingest()`。本插件去重（同一件事不播两遍）、入箱（队列有上限）、
 * 按静默时段压住（23:00–08:00 只入箱）、按三档优先级排队，然后等人来取。
 *
 * ## 为什么是「复用档」而不是自研
 *
 * 收件箱 / 去重 / 限流是成熟模式，生态里已经有大量实现（见 README 的技术来源表）。
 * 本项目要做的不是发明一套新的队列，而是**把这三件事接进 Ondra 的口径里**：
 * 指纹去重、静默时段、三档优先级、0600 原子存档、全软依赖降级。
 * 因此本插件没有引入任何依赖、没有复制任何代码，只有纯函数 + 一层接线。
 *
 * ## 它刻意不做什么（六条）
 *
 * - **不起服务器、不监听端口。** 接 webhook 是宿主的事（它才有验签与权限说明的义务）。
 *   本插件只提供 `ingest()`，入口是**宿主调它**，不是它去连谁。
 * - **不自己发消息。** 发不发、怎么发、发到哪个通道，归 O-042 的六道闸。
 * - **不存原文。** `InboxEvent` 里 `body` / `raw` / `payload` 的类型是 `never`；
 *   存档里只有摘要、指纹、源、类型、优先级与两个时刻。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 * - **不装定时器。** 一条事件一条记录，取与不取由调用方决定；自己挂 `setInterval`
 *   就成了常驻后台任务，而常驻任务会有自己的失败模式。
 * - **不提供静默时段能力。** 本插件只在自己这一层做一次软判断（读 O-003 的小时数），
 *   真正的静默归 O-042。两处都判是刻意的冗余。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（身份 / 时钟 / 路径 / 配置），故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
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
import type { Config as InboxConfig } from './settings.js'
import { Inbox } from './service.js'
import { WEBHOOK_INBOX_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  InboxService,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  WEBHOOK_INBOX_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  PRIORITIES,
  PRIORITY_ZH,
  WebhookInboxError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  QUEUE_FLOOR,
  QUEUE_CEILING,
  BATCH_FLOOR,
  BATCH_CEILING,
  RATE_FLOOR,
  RATE_CEILING,
  TTL_FLOOR,
  TTL_CEILING,
  AGE_FLOOR,
  AGE_CEILING,
  SUMMARY_FLOOR,
  SUMMARY_CEILING,
  QUIET_START_DEFAULT,
  QUIET_END_DEFAULT,
  completeConfig,
  policyOf,
} from './settings.js'
export {
  FINGERPRINT_LENGTH,
  collapse,
  normalizeToken,
  normalizeKeyValue,
  fingerprintOf,
  summarize,
  isToken,
  isKeyList,
} from './fingerprint.js'
export {
  normalizePriority,
  rankOf,
  compareItems,
  inQuietHours,
  selectDeliverable,
  expireItems,
  oldestIndex,
} from './priority.js'
export type { DeliveryQuery, DeliveryResult, ExpireResult } from './priority.js'
export type { Config as InboxConfig } from './settings.js'
export { ACK_STAMPS_CAP, emptyState, normalizeState, readState, writeState } from './store.js'
export type { FingerprintEntry, InboxState, LoadResult } from './store.js'
export { Inbox } from './service.js'
export type { InboxDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-webhook-inbox'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：事件收件箱最容易顺手接上「收到就播」，
 * 接上之后它就多了一条能自己开口的路径，而那条路径不经过 O-042 的六道闸。
 */

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-webhook-inbox: 注册配置段')
    return true
  } catch (error) {
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 事件播报收件箱服务；未装载本插件时为 undefined。 */
    'ondra-webhook-inbox'?: InboxService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: InboxConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('webhook-inbox') : 'ondra.webhook-inbox')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          // 回退是静默的危险动作：不报数等于埋雷（O-005 原话）。
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 建服务。时钟与路径都用取值函数：上游晚装载时能自愈，早卸载时立刻退回降级。
  const service = new Inbox({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(
    () => ctx.provide(WEBHOOK_INBOX_SERVICE_KEY, service),
    'ondra-webhook-inbox: 注册事件播报收件箱服务',
  )

  // 4. 报一次现状。上限与窗口必须能被自检读到，不许黑箱。
  log.info(
    '事件播报收件箱就绪：%s（队列上限 %d 条 / 一批 %d 条 / 每小时 %d 条 / 去重窗 %dh / 超龄 %dh；只收事件不发送）',
    service.available ? '可用' : '不可用',
    settings.queueCap,
    settings.maxBatch,
    settings.maxPerHour,
    settings.fingerprintTtlHours,
    settings.maxAgeHours,
  )
  if (!settings.enable) {
    log.warn('事件播报收件箱已关闭（enable=false）：服务照常注册，ingest() / ack() 抛 disabled')
  }
  if (!settings.quietHours) {
    log.warn('静默时段已关闭（quiet-hours=false）：半夜进来的事件也会进可投递批次')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。所有数值越界都会被夹到区间内，
 * `maxBatch` 超过 `queueCap` 会被压回去，因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: InboxConfig } | { readonly issues: readonly { readonly message: string }[] }
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
