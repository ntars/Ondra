/**
 * O-066 `ondra-adapter-telegram`：Telegram 长轮询通道。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 读凭据（token 只从 `user/channels/telegram.json` 取，不进配置）；
 * 3. `provide` 服务，并在同一个 `ctx.effect` 里**启动轮询循环**——
 *    循环挂在 disposer 上，卸载即停；
 * 4. 登记通道能力（可选，`router` 缺席就不登记）。
 *
 * ## 为什么没有 `webServer`
 *
 * 拉取式不需要任何入站端口。这不是「简化」，而是这类通道的形态：
 * 没有回调就没人能打进来，也就没有「端口暴露」这件事。
 * 与 O-061（微信客服 `sync_msg`）同一类，与 O-060/O-063/O-064（回调式）相反。
 *
 * ## 为什么装载期不调 `getMe`
 *
 * 装载期探一次 token 看起来能提前发现填错，代价是三件：装载变慢、网络抖动会让
 * 「她好像没装上」、以及把「token 对不对」的结论固化在装载那一刻。
 * 面板要这个结论时调 `probe()`；它是**显式**的只读动作，不会被误当成预检。
 *
 * ## 为什么循环放在 `ctx.effect` 里而不是模块顶层
 *
 * 模块顶层启动等于「只要 import 了就占着一个长轮询」，插件被禁用、被卸载时
 * 那个循环还在跑，还会真的发消息出去——这是最难解释的一类 bug。
 * `ctx.effect` 的 disposer 是唯一正确的停止点。
 */

import type { Context } from '@ntars/cordis'
import { TelegramAdapter, errorOf } from './adapter.js'
import type { LogLike } from './adapter.js'
import { credentialTemplate, maskToken, readCredentials } from './credential.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  requestTimeoutOf,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { HttpTelegramPush } from './transport.js'
import type {
  ChannelSpecLike,
  ClockLike,
  ConfigSchemaLike,
  HealthLike,
  IdentityLike,
  KitLike,
  PathLayoutLike,
  RouterLike,
  TelegramService,
} from './types.js'
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  CREDENTIAL_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  TELEGRAM_SERVICE_KEY,
  UPDATE_LIMIT,
} from './types.js'

export type * from './types.js'
export {
  TELEGRAM_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_MIN,
  POLL_TIMEOUT_SEC,
  POLL_TIMEOUT_FLOOR,
  POLL_TIMEOUT_CEIL,
  BACKOFF_MS,
  BACKOFF_FLOOR,
  BACKOFF_CEIL,
  DEFAULT_API_BASE,
  CREDENTIAL_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  UPDATE_LIMIT,
  REQUEST_PADDING_MS,
  SPIN_GUARD_MS,
  SEEN_LIMIT,
  SEEN_TTL_MS,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONCURRENCY_CEIL,
  PADDING_FLOOR,
  PADDING_CEIL,
  PERSIST_MS,
  completeConfig,
  configDriftOf,
  requestTimeoutOf,
  isRecord,
} from './settings.js'
export { readCredentials, credentialTemplate, maskToken, redactToken, TOKEN_RE } from './credential.js'
export { parseState, toJson, advanceTo, seenRecently, markSeen, prune, emptyState } from './cursor.js'
export type { CursorState } from './cursor.js'
export { inboundOf, kindOf, mentionedOf, dedupeKeyOf, fromBotOf } from './wire.js'
export { HttpTelegramPush } from './transport.js'
export type { HttpTelegramPushDeps } from './transport.js'
export { TelegramAdapter, conversationOf, parseConversation, errorOf } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-telegram'

/** 心跳间隔（毫秒）。 */
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-telegram: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', errorOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** Telegram 通道；未装载本插件时为 undefined。 */
    'ondra-adapter-telegram'?: TelegramService
  }
}

/**
 * Cordis 入口：解析配置、读凭据、注册服务并启动轮询。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间按 §16.2-3 用 `channel.<id>`，前缀由 O-001 给（默认 `ondra.`）。
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

  // 2. 路径与凭据。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const fileIn = (suffix: string): string =>
    layout === undefined ? '' : layout.fileIn('user', 'channels', CHANNEL_ID + suffix)
  const credentialFile = settings.credentialFile !== '' ? settings.credentialFile : fileIn(CREDENTIAL_FILE_SUFFIX)
  const stateFile = settings.stateFile !== '' ? settings.stateFile : fileIn(STATE_FILE_SUFFIX)
  const credential = readCredentials(credentialFile)

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 3. 网络实现：凭据齐才建（缺 token 时建了也只会每轮 401，不如现在就说清楚）。
  //    `timeoutMsOf` 每轮现取：轮询超时改了要立刻生效，不能被构造时冻结。
  const push =
    credential.ok && credential.value !== undefined
      ? new HttpTelegramPush({
          apiBase: settings.apiBase,
          token: credential.value.token,
          // 构造值只作兜底；真正用的是 `timeoutMsOf()`。
          timeoutMs: requestTimeoutOf(settings),
          timeoutMsOf: () => requestTimeoutOf(settings),
        })
      : null

  const adapter = new TelegramAdapter({
    settings,
    log,
    now,
    stateFile,
    credentialFile,
    push,
    readCredential: () => readCredentials(credentialFile),
    router: () => ctx.get('ondra-router') as RouterLike | undefined,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: () => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 4. 登记能力。Telegram 私聊与群都有；群里能否收到全量消息取决于 BotFather 的
  //    privacy mode——那是平台侧开关，本插件不假装能控制，所以 `mentionRequired: false`。
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
          mentionRequired: false,
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
    'ondra-adapter-telegram: 登记通道能力',
  )

  // 5. 注册服务 + 启动轮询。**两者在同一个 effect 里**：停服务与停循环必须同时发生。
  ctx.effect(
    () => {
      const dispose = ctx.provide(TELEGRAM_SERVICE_KEY, adapter)

      const heartbeatTimer = setInterval(() => {
        try {
          adapter.tick()
        } catch {
          // 心跳失败不影响拉取。
        }
      }, HEARTBEAT_MS)
      unrefTimer(heartbeatTimer)

      const persistTimer = setInterval(() => {
        try {
          adapter.flush()
        } catch {
          // 落盘失败已由适配器内部计数。
        }
      }, settings.persistMs)
      unrefTimer(persistTimer)

      // 开关关着时 `start()` 自己会早退，调它不产生副作用。
      adapter.start()

      return () => {
        // 先停循环（会中止在飞的长轮询），再清定时器，最后撤服务。
        adapter.stop()
        clearInterval(heartbeatTimer)
        clearInterval(persistTimer)
        dispose()
      }
    },
    'ondra-adapter-telegram: 注册 Telegram 通道服务',
  )

  // 6. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('Telegram 通道默认关闭（enable=false）：打开前先填凭据，否则轮询一启动就会 401')
  } else if (!credential.ok) {
    log.error('通道已打开，但凭据不齐（缺 %s）', credential.missing ?? 'unknown')
    if (credentialFile !== '') log.info(credentialTemplate(credentialFile))
  } else {
    log.info(
      'Telegram 通道已打开：长轮询 %d 秒 / 每轮最多 %d 条 / 单条上限 %d 字 / 并发 %d（token %s）',
      settings.pollTimeoutSec,
      UPDATE_LIMIT,
      settings.chunkMax,
      settings.maxConcurrent,
      maskToken(credential.value === undefined ? '' : credential.value.token),
    )
    log.info(
      'HTTP 超时 = %d 毫秒（轮询 %d 秒 + 余量 %d 毫秒）。**不要**把它调到小于轮询超时——那会每轮都超时，看起来像通道挂了',
      requestTimeoutOf(settings),
      settings.pollTimeoutSec,
      settings.requestPaddingMs,
    )
  }

  if (settings.allowSenderIds.length === 0) {
    log.warn('发信人白名单为空 → 任何能给这个 bot 发消息的人都能触发她。请确认这是你要的')
  }
  log.info(
    '群聊里能否收到非 @ 消息取决于 BotFather 的 privacy mode（/setprivacy）：本插件不假装能控制它，只如实登记 mentionRequired=false',
  )
  if (push === null) {
    log.warn('没有网络实现：服务照常注册，但拉取与发送都会以 no-credentials 结束（原因见上一条凭据提示）')
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
      // 全部字段都能安全补全（越界夹紧、空名单回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
