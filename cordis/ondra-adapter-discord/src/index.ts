/**
 * O-067 `ondra-adapter-discord`：Discord 通道（Gateway WS v10）。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 读凭据（token 只从 `user/channels/discord.json` 取，不进配置）；
 * 3. 登记通道能力（可选，`router` 缺席就不登记）；
 * 4. `provide` 服务 + 起一个 30 秒心跳定时器（**不是 WS 心跳**）。
 *
 * ## 为什么这里没有 `new WebSocket(...)`
 *
 * 手册 §9.11 那一行给了四件事：`Gateway WS v10 自实现 IDENTIFY+心跳`、
 * `Bot <token>`、单条 `1900`、`4004 停止重连其余 5s`、**无去重**。
 * 它**没有**给 op 码表、IDENTIFY 载荷字段、HELLO/心跳 ACK 规则、RESUME 序列号、
 * intents 位、zlib 分片约定。
 *
 * 本仓已 grep 确认：`MESSAGE_CREATE` / `HELLO` / `RESUME` / `op_code` / `intents` /
 * `gateway.discord` **全部 0 命中**；`IDENTIFY` 只在 master-plan §9.11 出现 1 次。
 * 宿主 `desktop/packages` 里 `ws` 只出现在 `api/gateway` 等包的私有依赖里，
 * **不是插件可调用的服务键**；本轮也禁装依赖。
 *
 * 自己拼一版的坏形态很具体：**连上了、READY 也来了、然后一条消息都收不到**
 * （intents 算错或帧名猜错）。这与「根本没接」在日志上完全同形，
 * 而用户看到的是「她装上了但不说话」——最难归因的一类。
 * 所以帧层做成 `DiscordSocket` 端口，`start()` 在端口为空时明确报出来。
 *
 * ## 心跳定时器为什么还在
 *
 * 它做两件 WS 心跳**做不到**的事：①向 `ondra-channel-health` 报一条
 * `heartbeat` 证据；②清理过期的本地排队。前者让面板能区分
 * 「WS 断了」（`disconnected` 后无心跳）与「WS 活着但她卡住」；
 * 后者补上 `pump()` 只在回合结束时才跑的盲区。
 *
 * 定时器挂在 `ctx.effect` 的 disposer 上（`unref` + `clearInterval`），
 * 卸载即停——不是常驻后台服务。
 */

import type { Context } from '@ntars/cordis'
import { DiscordAdapter } from './adapter.js'
import { errorOf } from './adapter.js'
import type { LogLike } from './adapter.js'
import { credentialTemplate, maskToken, readCredentials } from './credential.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { HttpDiscordPush } from './transport.js'
import type {
  ChannelSpecLike,
  ClockLike,
  ConfigSchemaLike,
  DiscordService,
  HealthLike,
  IdentityLike,
  KitLike,
  PathLayoutLike,
  RouterLike,
} from './types.js'
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  CREDENTIAL_FILE_SUFFIX,
  DISCORD_SERVICE_KEY,
} from './types.js'

export type * from './types.js'
export {
  DISCORD_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_MIN,
  AUTH_CLOSE_CODE,
  RECONNECT_MS,
  RECONNECT_FLOOR,
  RECONNECT_CEIL,
  DEFAULT_API_BASE,
  CREDENTIAL_FILE_SUFFIX,
  REQUEST_TIMEOUT_MS,
  REQUEST_FLOOR,
  REQUEST_CEIL,
  CONCURRENCY_CEIL,
  LINK_STATES,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  QUEUE_TTL_MS,
  QUEUE_TTL_FLOOR,
  QUEUE_TTL_CEIL,
  completeConfig,
  configDriftOf,
  isRecord,
} from './settings.js'
export { readCredentials, credentialTemplate, maskToken, redactToken, TOKEN_RE } from './credential.js'
export { LinkMachine, planOf } from './link.js'
export type { LinkSnapshot } from './link.js'
export {
  MESSAGE_EVENT,
  eventNameOf,
  payloadOf,
  kindOf,
  mentionedOf,
  createdAtOf,
  fromBotOf,
  authorIdOf,
  inboundOf,
  explainOf,
} from './wire.js'
export type { ParseOutcome } from './wire.js'
export { HttpDiscordPush } from './transport.js'
export type { HttpDiscordPushDeps } from './transport.js'
export { DiscordAdapter, conversationOf, parseConversation, errorOf } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-discord'

/** 心跳间隔（毫秒）。**不是 WS 心跳**，见文件头。 */
export const HEARTBEAT_MS = 30_000

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-discord: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', errorOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** Discord 通道；未装载本插件时为 undefined。 */
    'ondra-adapter-discord'?: DiscordService
  }
}

/**
 * Cordis 入口：解析配置、读凭据、登记能力、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间按 master-plan §16.2-3 用 `channel.<id>`，前缀由 O-001 给（默认 `ondra.`）。
  const log = ctx.logger(identity ? identity.loggerName('channel.' + CHANNEL_ID) : 'ondra.channel.' + CHANNEL_ID)

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 配置：有 O-005 就走四层合并。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBad = (text: string, kind: string): void => {
    log.warn('配置条目已丢弃（%s）：%s', kind, text)
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
      log.warn('解析配置段失败，退回插件实例配置：%s', errorOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  // 2. 凭据。路径必须在数据根内部（O-002 会拦越界）。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const credentialFile =
    settings.credentialFile !== ''
      ? settings.credentialFile
      : layout === undefined
        ? ''
        : layout.fileIn('user', 'channels', CHANNEL_ID + CREDENTIAL_FILE_SUFFIX)
  const credential = readCredentials(credentialFile)

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 3. REST 实现：凭据齐才建（缺 token 时建了也只会每次 401，不如现在就说清楚）。
  const push =
    credential.ok && credential.value !== undefined
      ? new HttpDiscordPush({
          apiBase: settings.apiBase,
          token: credential.value.token,
          timeoutMs: settings.requestTimeoutMs,
        })
      : null

  const adapter = new DiscordAdapter({
    settings,
    log,
    now,
    credentialFile,
    push,
    readCredential: () => readCredentials(credentialFile),
    router: () => ctx.get('ondra-router') as RouterLike | undefined,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: () => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 4. 登记能力。能力表归适配器（master-plan §9.12），公共层不内置。
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
          // 群里能否收到非 @ 消息取决于 intents 与频道设置——那是平台侧与帧层实现方的事，
          // 本插件不假装能控制，故如实登记 false（与 O-066 同口径）。
          mentionRequired: false,
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
        log.warn('通道能力登记抛错：%s', errorOf(error))
        return () => {}
      }
    },
    'ondra-adapter-discord: 登记通道能力',
  )

  // 5. 注册服务 + 心跳定时器。**停服务与停定时器必须同时发生。**
  ctx.effect(
    () => {
      const dispose = ctx.provide(DISCORD_SERVICE_KEY, adapter)

      const heartbeatTimer = setInterval(() => {
        try {
          adapter.tick()
        } catch {
          // 心跳失败不影响连接（它只做探针上报与过期清理）。
        }
      }, HEARTBEAT_MS)
      unrefTimer(heartbeatTimer)

      // 开着才连；`start()` 自己会按 enable 早退，调它不产生副作用。
      adapter.start()

      return () => {
        // 先停连接（会把在飞的 open() 代际作废并关端口），再清定时器，最后撤服务。
        adapter.stop()
        clearInterval(heartbeatTimer)
        dispose()
      }
    },
    'ondra-adapter-discord: 注册 Discord 通道服务',
  )

  // 6. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('Discord 通道默认关闭（enable=false）：打开并注入帧层实现后才会连')
  } else if (!credential.ok) {
    log.error('通道已打开，但凭据不齐（缺 %s）', credential.missing ?? 'unknown')
    if (credentialFile !== '') log.info(credentialTemplate(credentialFile))
  } else {
    log.info(
      'Discord 通道已打开：单条上限 %d 字 / 并发 %d / 重连 %d 毫秒（token %s）',
      settings.chunkMax,
      settings.maxConcurrent,
      settings.reconnectMs,
      maskToken(credential.value === undefined ? '' : credential.value.token),
    )
  }

  log.info(
    '帧层是端口不是实现：手册 §9.11 只给了 Gateway WS v10 + Bot <token> + 1900 + 4004 停止重连 + 无去重，' +
      '没给 op 码 / IDENTIFY 载荷 / 心跳 ACK / RESUME 序列号。用 useSocket() 注入后才能真连上',
  )
  if (settings.stopOnCodes.length === 0) {
    log.info('stopOnCodes 为空：只把 4004 当「不重连」。平台另有一组 4010–4014 同类码，本仓无依据故不写死')
  }
  if (settings.allowSenderIds.length === 0) {
    log.warn('发信人白名单为空 → 任何能给这个 bot 发私信的人都能触发她。请确认这是你要的')
  }
  if (push === null) {
    log.warn('没有 REST 实现：服务照常注册，但发送与 probe() 都会以 no-credentials 结束')
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
    ) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏条目逐条丢弃），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
