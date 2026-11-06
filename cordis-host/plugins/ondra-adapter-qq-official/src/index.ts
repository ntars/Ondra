/**
 * O-058 `ondra-adapter-qq-official`：QQ 开放平台（官方机器人）通道适配器。
 *
 * ## 装载期只做五件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 算出凭据文件与状态文件的绝对路径；
 * 3. 把本通道的能力登记进 `ondra-router`（能力表归适配器，公共层不内置）；
 * 4. `provide` 服务；
 * 5. 把「还缺什么才能真的连上」讲清楚。
 *
 * **装载期不连网。** 默认 `enable=false`（手册 §9.11：九个适配器默认全关），
 * 打开之后还要有凭据、有传输实现才会真的连——三样缺一样都有明确原因码。
 *
 * ## 为什么这里没有 `new WebSocket(...)`
 *
 * 手册 §9.11 给了四条可核对的事实（WS 长连、`/app/getAppAccessToken`、
 * `QQBot <t>` 头、被动回复带 `msg_id`、单条 1200），**没有给 WS 帧格式**；
 * 本仓 `desktop/docs` 与 `desktop/packages` 检索这些关键字零命中，
 * 且禁止装依赖。自己拼一版握手会「看起来能跑」：连上了收不到事件，
 * 或字段名猜错——两种都表现为「她不回话」，与「根本没接」同形。
 * 所以传输做成 `QqTransport` 端口，`start()` 在端口为空时明确报 `no-transport`。
 */

import type { Context } from '@ntars/cordis'
import { QqAdapter, HEARTBEAT_MS } from './adapter.js'
import { credentialTemplate } from './credential.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  CREDENTIAL_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as QqConfig } from './settings.js'
import { CHANNEL_ID, CHANNEL_LABEL, QQ_SERVICE_KEY } from './types.js'
import type {
  ChannelSpecLike,
  ClockLike,
  ConfigSchemaLike,
  HealthLike,
  IdentityLike,
  KitLike,
  LogLike,
  PathLayoutLike,
  QqOfficialService,
  RouterLike,
} from './types.js'

export type * from './types.js'
export {
  QQ_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CONTENT_MAX_LEN,
  RISK_CODES,
  BACKOFF_SECONDS,
  QUIET_START,
  QUIET_END,
  TZ_OFFSET_MIN,
  START_FAILURES,
  START_FAILURE_ZH,
  GATE_REASONS,
  GATE_REASON_ZH,
  REPLY_REASONS,
  INGEST_REASONS,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CHUNK_MIN,
  RATE_FLOOR,
  PER_MINUTE_CEIL,
  PER_HOUR_CEIL,
  PER_DAY_CEIL,
  DEDUPE_CEIL,
  COOLDOWN_CEIL,
  JITTER_CEIL,
  STRIKES_CEIL,
  CIRCUIT_CEIL,
  STATE_FILE_SUFFIX,
  CREDENTIAL_FILE_SUFFIX,
  completeConfig,
  configDriftOf,
  parseClock,
} from './settings.js'
export { Gate, hashOf, minuteOfDay, inQuietHours, parseGateState, readGateState, writeGateState } from './gate.js'
export type { GateDeps, GateInput, GateState, RateWindow } from './gate.js'
export { loadCredentials, credentialTemplate, maskAppId } from './credential.js'
export { QqAdapter, conversationOf, HEARTBEAT_MS } from './adapter.js'
export type { AdapterDeps } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-qq-official'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 让定时器不阻止进程退出。
 * @param handle 定时器句柄。
 */
function unrefTimer(handle: ReturnType<typeof setInterval>): void {
  const maybe = handle as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-qq-official: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** QQ 官方机器人通道；未装载本插件时为 undefined。 */
    'ondra-adapter-qq-official'?: QqOfficialService
  }
}

/**
 * Cordis 入口：解析配置、算路径、登记能力、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: QqConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('adapter.qq-official') : 'ondra.adapter.qq-official')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并。坏正则在这里提示一次。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBadPattern = (text: string): void => {
    log.warn('内容闸正则有误已丢弃：%s', text)
  }
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
  const settings = completeConfig(effective, onBadPattern)

  // 2. 算凭据与状态文件路径。路径必须能落到数据根内部（O-002 会拦越界）。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const credentialFile =
    settings.credentialFile !== ''
      ? settings.credentialFile
      : layout === undefined
        ? ''
        : layout.fileIn('user', 'channels', CHANNEL_ID + CREDENTIAL_FILE_SUFFIX)
  const stateFile =
    settings.stateFile !== ''
      ? settings.stateFile
      : layout === undefined
        ? ''
        : layout.fileIn('user', 'channels', CHANNEL_ID + STATE_FILE_SUFFIX)

  const adapter = new QqAdapter({
    settings,
    log,
    now: (): number => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    credentialFile,
    stateFile,
    router: (): RouterLike | undefined => ctx.get('ondra-router') as RouterLike | undefined,
    kit: (): KitLike | undefined => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: (): HealthLike | undefined => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 3. 登记能力。能力表归适配器（master-plan §9.12），公共层不内置。
  ctx.effect(
    () => {
      const router = ctx.get('ondra-router') as RouterLike | undefined
      if (router === undefined) return () => {}
      const spec: ChannelSpecLike = {
        id: CHANNEL_ID,
        label: CHANNEL_LABEL,
        caps: {
          maxChars: settings.chunkMax,
          privateChat: true,
          groupChat: true,
          // 群消息只在被 @ 时由平台投递；再退一步要求点名，避免「关键词也回」。
          mentionRequired: true,
          // 只做文字：图/语音/贴纸/文件都还没验证过协议，不写「能发」。
          features: [],
        },
      }
      try {
        const result = router.registerChannel(spec)
        if (!result.ok) {
          log.warn('通道能力登记失败（%s）：不影响收发，但面板会查不到本通道能力', result.reason ?? '未知')
          return () => {}
        }
        return result.dispose ?? (() => {})
      } catch (error) {
        log.warn('通道能力登记抛错：%s', messageOf(error))
        return () => {}
      }
    },
    'ondra-adapter-qq-official: 登记通道能力',
  )

  // 4. 注册服务 + 心跳与落盘定时器。卸载时一起撤，不残留 socket/定时器。
  ctx.effect(
    () => {
      const dispose = ctx.provide(QQ_SERVICE_KEY, adapter)
      const heartbeatTimer = setInterval(() => {
        try {
          adapter.tick()
        } catch {
          // 心跳失败不影响通道。
        }
      }, HEARTBEAT_MS)
      unrefTimer(heartbeatTimer)
      const persistTimer = setInterval(() => {
        try {
          adapter.flush()
        } catch {
          // 落盘失败已由闸门内部计数。
        }
      }, settings.persistMs)
      unrefTimer(persistTimer)
      return () => {
        clearInterval(heartbeatTimer)
        clearInterval(persistTimer)
        adapter.stop()
        dispose()
      }
    },
    'ondra-adapter-qq-official: 注册 QQ 通道服务',
  )

  // 5. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('QQ（官方）通道默认关闭（enable=false）：打开后才会连，装上去就连是事故')
  } else if (credentialFile === '') {
    log.error('QQ 通道已打开，但算不出凭据路径：缺 ondra-path-layout，配置里也没写 credentialFile')
  } else {
    log.info('QQ 通道已打开：凭据 %s，单条上限 %d 字', credentialFile, settings.chunkMax)
  }

  if (settings.blockPatterns.length === 0) {
    log.info('内容闸正则为空（手册未给三类正则在原文，未编造）：当前只拦「空正文」与「超 %d 字」', settings.contentMaxLen)
  }

  if (settings.persist) {
    log.info('防封状态落盘到 %s（0600）：重启不清零，重启绕过防封的口子已堵上', stateFile === '' ? '（无路径，仅内存）' : stateFile)
  } else {
    log.warn('防封状态不落盘（persist=false）：重启即清零，等于给防封开后门')
  }

  log.info(
    '传输是端口不是实现：手册 §9.11 只给了 WS 长连 + /app/getAppAccessToken + QQBot 头 + 被动回复带 msg_id + 单条 1200，' +
      '没给 WS 帧格式。请用 useTransport() 注入实现后再 start()；凭据缺失时提示为「%s」',
    credentialTemplate(credentialFile === '' ? 'user/channels/qq-official.json' : credentialFile),
  )
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
    ) => { readonly value: QqConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏正则逐条丢弃、坏时间回退默认），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
