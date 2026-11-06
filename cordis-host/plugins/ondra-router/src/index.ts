/**
 * O-055 `ondra-router`：通道公共层（判定 + 排队 + 能力查询 + 唤醒身份纪律）。
 *
 * ## 装载期只做三件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. `provide` 服务；
 * 3. 把「此刻能判什么、缺什么」逐条打出来。
 *
 * **装载期不注册任何通道能力**：手册 §9.11 的那张表是旧项目实测值，
 * 各适配器的 `Config` 才是自己通道的真源（master-plan §9.12）。
 * 内置一份会与适配器打架，且新通道永远漏。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 消费 `ondra-config-schema`（软）/ `ondra-clock`（软）/ `ondra-identity`（软）三个。
 * 全软。声明 `inject` 会让缺一个就整包停 PENDING——而「为什么通道不回消息」
 * 恰恰要从日志里读出来，插件没装载连日志都没有。
 *
 * ## 刻意不注册工具、不发消息
 *
 * 注册 `wake_me` 这类工具，模型就能自己决定「现在该叫主人」，
 * 那等于让被叫的人自己按门铃。发消息更不行：一发，本插件就变成第 10 个适配器，
 * 而且是唯一一个不知道自己跑在哪条协议上的适配器。
 */

import type { Context } from '@ntars/cordis'
import { Router } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as RouterConfig } from './settings.js'
import { NAME_RE, REASON_ZH, ROUTER_SERVICE_KEY, WAKE_SECTION_NAME } from './types.js'
import type { ClockLike, ConfigSchemaLike, IdentityLike, LogLike, RouterService } from './types.js'

export type * from './types.js'
export {
  ROUTER_SERVICE_KEY,
  NAME_RE,
  CONVERSATION_KINDS,
  TRIGGERS,
  ROUTE_ACTIONS,
  ROUTE_REASONS,
  REASON_ZH,
  CHANNEL_FEATURES,
  WAKE_BODY,
  WAKE_SECTION_NAME,
  isConversationKind,
  isTrigger,
  isChannelFeature,
  canSend,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  MAX_QUEUE_FLOOR,
  MAX_QUEUE_CEIL,
  MAX_CONVERSATIONS_FLOOR,
  MAX_CONVERSATIONS_CEIL,
  DEDUPE_MS_FLOOR,
  DEDUPE_MS_CEIL,
  completeConfig,
  configDriftOf,
} from './settings.js'
export { decideRoute, kindOf, triggerOf, isEmpty } from './decide.js'
export type { Verdict } from './decide.js'
export { ConversationQueue, QUEUE_TEXT_MAX, seedOf } from './queue.js'
export type { QueueSeed } from './queue.js'
export { ChannelRegistry, normalizeCaps } from './channels.js'
export { Router } from './service.js'
export type { RouterDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-router'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-router: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 通道路由服务；未装载本插件时为 undefined。 */
    'ondra-router'?: RouterService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: RouterConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('router') : 'ondra.router')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并。
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

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  const router = new Router({
    settings,
    log,
    now: (): number => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
  })

  // 3. 注册服务。卸载时把四个容器一起清掉（不留半条队列在内存里）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(ROUTER_SERVICE_KEY, router)
      return () => {
        router.dispose()
        dispose()
      }
    },
    'ondra-router: 注册通道路由服务',
  )

  // 4. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('通道路由已关闭（enable=false）：admit() 一律给 disabled，服务照常注册')
  } else {
    log.info(
      '通道路由就绪：单会话积压上限 %d · 会话数上限 %d · 去重窗口 %dms · 群关键词回复 %s · 私聊唤醒概率 %s',
      settings.maxQueue,
      settings.maxConversations,
      settings.dedupeMs,
      settings.replyOnKeyword ? '开' : '关',
      settings.wakeProbability >= 1 ? '全量（每次都叫）' : settings.wakeProbability.toFixed(2),
    )
  }

  if (router.channelIds().length === 0) {
    log.info('通道能力表还空着：各适配器装载时用 registerChannel() 登记，未登记不影响判定')
  }

  // 唤醒身份纪律是 P0，装载时确认一次它确实在。
  const delivery = router.wakeDelivery()
  log.info(
    '唤醒投递：正文 %s · 说明段 %s（%d 字）——组装方需自行注册该段，本插件不动会话前缀',
    JSON.stringify(delivery.body),
    WAKE_SECTION_NAME,
    delivery.section.chars,
  )

  if (ctx.get('ondra-clock') === undefined) {
    log.info('此刻没有 ondra-clock：时刻退回系统时钟（装好之后自动恢复，无需重启插件）')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  log.debug?.('路由原因码共 %d 个，例：%s', Object.keys(REASON_ZH).length, REASON_ZH['private-message'])
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
    ) => { readonly value: RouterConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（越界夹紧、非法枚举回退），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
