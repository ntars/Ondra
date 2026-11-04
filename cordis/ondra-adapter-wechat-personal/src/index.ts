/**
 * O-062 `ondra-adapter-wechat-personal`：微信个人号通道（高危）。
 *
 * ## 装载期做五件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 读二次确认档案（决定「有没有资格存在」）；
 * 3. 注册一条宿主路由（**每个请求都要过回环判定**）；
 * 4. `provide` 服务；
 * 5. 把风险如实讲一遍（日志就是给用户看的那一屏）。
 *
 * ## 为什么路由照挂，即使双闸门关着
 *
 * 挂上但一律 200 + `ok:false` + 原因，桥接端能拿到「为什么没回」；
 * 不挂的话，桥接端只会看到「连接被拒」，然后去查端口、查防火墙——
 * 而那和真正的原因（没有二次确认）毫无关系。
 *
 * ## 关于「仅回环」
 *
 * 宿主的 listen 地址由它自己的配置决定（可以是某个具体网卡），
 * 所以这里**不假设端口只在本机**，而是在 handler 第一行判定
 * `req.socket.remoteAddress`。判不过就 403，且打一行 warn 记下对端地址——
 * 这一行是「有东西在扫你的端口」的唯一证据。
 */

import { TextDecoder } from 'node:util'
import type { Context } from '@ntars/cordis'
import { PersonalAdapter } from './adapter.js'
import type { LogLike } from './adapter.js'
import { confirmTemplate, readConfirmRecord } from './confirm.js'
import { isLoopback } from './gate.js'
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
import { HttpWebhookPush } from './transport.js'
import type {
  ChannelSpecLike,
  ClockLike,
  ConfigSchemaLike,
  HealthLike,
  HttpRequestLike,
  HttpResponseLike,
  IdentityLike,
  KitLike,
  PathLayoutLike,
  PersonalPush,
  PersonalService,
  RouterLike,
  WebServerLike,
} from './types.js'
import {
  CALLBACK_PORT_HINT,
  CHANNEL_ID,
  CHANNEL_LABEL,
  CONFIRM_FILE_SUFFIX,
  MAX_BODY_BYTES,
  PERSONAL_SERVICE_KEY,
  STATE_FILE_SUFFIX,
} from './types.js'

export type * from './types.js'
export {
  PERSONAL_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_MIN,
  COOLDOWN_MS,
  COOLDOWN_MIN,
  COOLDOWN_MAX,
  COOLDOWN_LIMIT,
  REPLY_BUDGET_MIN,
  REPLY_BUDGET_MAX,
  DEFAULT_REPLY_BUDGET_MS,
  DEFAULT_ROUTE_PATH,
  CALLBACK_PORT_HINT,
  LOOPBACK_ADDRESSES,
  CONFIRM_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  CONFIRM_NOTE_MIN,
  MAX_BODY_BYTES,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  PERSIST_MS,
  CONCURRENCY_CEIL,
  REQUEST_TIMEOUT_CEIL,
  completeConfig,
  configDriftOf,
  isUsablePath,
  isUsableWebhook,
} from './settings.js'
export type { ReplyMode } from './settings.js'
export { isLoopback, checkGate, markAnswered, pruneCooldown, parseCooldown } from './gate.js'
export {
  emptyRecord,
  readConfirmRecord,
  writeConfirmRecord,
  revokeConfirmRecord,
  confirmTemplate,
} from './confirm.js'
export { HttpWebhookPush } from './transport.js'
export type { WebhookDeps } from './transport.js'
export { PersonalAdapter, conversationOf, parseConversation, CONVERSATION_PREFIX, MAX_DRAIN } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-wechat-personal'

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
 * 错误转一句中文。
 * @param error 任意异常。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-wechat-personal: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

/**
 * 读请求体（有上限）。
 * @param req 请求。
 * @param limit 字节上限。
 */
function readBody(req: HttpRequestLike, limit: number): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Uint8Array[] = []
    let total = 0
    let settled = false

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    req.on('data', chunk => {
      if (settled) return
      total += chunk.byteLength
      if (total > limit) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      finish(new TextDecoder('utf-8').decode(merged))
    })
    req.on('error', () => finish(null))
  })
}

/**
 * 写响应。
 * @param res 响应。
 * @param status 状态码。
 * @param contentType 类型。
 * @param body 正文。
 */
function write(res: HttpResponseLike, status: number, contentType: string, body: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.end(body)
}

/**
 * 一段 JSON（用于错误响应；不引第三方库）。
 * @param payload 内容。
 */
function jsonOf(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload)
  } catch {
    return '{"ok":false,"reason":"bad-body"}'
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 微信个人号通道；未装载本插件时为 undefined。 */
    'ondra-adapter-wechat-personal'?: PersonalService
  }
}

/**
 * Cordis 入口：解析配置、读确认档案、注册路由与服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('adapter.wechat-personal') : 'ondra.adapter.wechat-personal')

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
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  // 2. 路径与确认档案。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const fileIn = (suffix: string): string =>
    layout === undefined ? '' : layout.fileIn('user', 'channels', CHANNEL_ID + suffix)
  const confirmFile = settings.confirmFile !== '' ? settings.confirmFile : fileIn(CONFIRM_FILE_SUFFIX)
  const stateFile = settings.stateFile !== '' ? settings.stateFile : fileIn(STATE_FILE_SUFFIX)
  const loaded = readConfirmRecord(confirmFile)

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 3. 出站实现：配了地址才建。
  let push: PersonalPush | null = null
  if (settings.outboundWebhook !== '') {
    push = new HttpWebhookPush({ url: settings.outboundWebhook, timeoutMs: settings.requestTimeoutMs })
  }

  const adapter = new PersonalAdapter({
    settings,
    log,
    now,
    confirmFile,
    stateFile,
    push: () => push ?? undefined,
    router: () => ctx.get('ondra-router') as RouterLike | undefined,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: () => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 4. 登记能力。群聊能力跟着 allow-groups 走：说了不回群，就别把「支持群」挂出去。
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
          groupChat: settings.allowGroups,
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
        log.warn('通道能力登记抛错：%s', messageOf(error))
        return () => {}
      }
    },
    'ondra-adapter-wechat-personal: 登记通道能力',
  )

  // 5. 服务 + 两个定时器（心跳 / 落盘）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(PERSONAL_SERVICE_KEY, adapter)

      const heartbeatTimer = setInterval(() => {
        try {
          adapter.tick()
        } catch {
          // 心跳失败不影响收发。
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

      return () => {
        clearInterval(heartbeatTimer)
        clearInterval(persistTimer)
        adapter.flush()
        dispose()
      }
    },
    'ondra-adapter-wechat-personal: 注册个人号通道服务',
  )

  // 6. 注册路由。**每个请求都先过回环判定**，包括 GET 探活。
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    log.error('没有 webServer 服务：桥接端推不进来，这个通道现在完全收不到消息')
  } else {
    ctx.effect(
      () => {
        try {
          const dispose = webServer.register({
            kind: 'exact',
            path: settings.routePath,
            handler: async (req, res) => {
              try {
                const remote = req.socket?.remoteAddress
                if (!isLoopback(remote)) {
                  // 非本机一律拒。这一行 warn 是「有东西在扫端口」的唯一证据。
                  log.warn('拒绝非本机请求（%s）：这个通道只接受 127.0.0.1 / ::1', remote ?? '未知地址')
                  const outcome = adapter.loopbackReject()
                  write(res, outcome.http, outcome.contentType, outcome.body)
                  return
                }

                const method = (req.method ?? 'GET').toUpperCase()
                if (method === 'GET') {
                  // 探活：桥接端先 GET 一下就知道「通道在不在、为什么不在」。
                  const status = adapter.status()
                  write(
                    res,
                    200,
                    'application/json; charset=utf-8',
                    jsonOf({
                      ok: adapter.available,
                      channel: CHANNEL_ID,
                      reason: adapter.reason ?? null,
                      gate: status.gate,
                    }),
                  )
                  return
                }
                if (method !== 'POST') {
                  res.setHeader('Allow', 'GET, POST')
                  write(res, 405, 'text/plain; charset=utf-8', 'method-not-allowed')
                  return
                }

                const body = await readBody(req, MAX_BODY_BYTES)
                if (body === null) {
                  write(res, 413, 'application/json; charset=utf-8', jsonOf({ ok: false, reason: 'body-too-large' }))
                  return
                }

                let payload: unknown
                try {
                  payload = JSON.parse(body) as unknown
                } catch {
                  // 200 + ok:false：本通道**无去重**，回 4xx 会让桥接端重试，
                  // 而重试的代价是同一句话被答两遍。
                  write(res, 200, 'application/json; charset=utf-8', jsonOf({ ok: false, reason: 'bad-body' }))
                  return
                }

                const outcome = await adapter.ingest(payload)
                write(res, outcome.http, outcome.contentType, outcome.body)
              } catch (error) {
                log.warn('处理个人号请求抛错：%s', messageOf(error))
                try {
                  write(res, 500, 'text/plain; charset=utf-8', 'internal-error')
                } catch {
                  // 响应已经发出去了。
                }
              }
            },
          })
          adapter.markMounted(true)
          return () => {
            adapter.markMounted(false)
            dispose()
          }
        } catch (error) {
          log.error('路由注册失败（%s）：%s 可能已被别的插件占用', settings.routePath, messageOf(error))
          return () => {}
        }
      },
      'ondra-adapter-wechat-personal: 注册入站路由',
    )
  }

  // 7. 风险区块：单独、完整、不折行到别处（§16.2-6「风险隔离」）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  log.warn(
    '⚠ 高危通道：微信个人号自动化违反平台用户协议，可能导致**账号被限制或封禁**。' +
      '手册 §6.2 的原话是「刚注册的小号基本秒风控，只能用养过一段时间的号」。' +
      '本插件只做接线，不改变这个事实；是否开启由操作者自己承担。',
  )

  if (!settings.confirmed) {
    log.info('双闸门未闭合：confirmed=false。即使 enable=true，也一律不回（原因会写进响应体）')
  } else if (!loaded.exists) {
    log.warn('confirmed=true 但没有确认档案：仍然不回。想清楚之后调 confirm(说明) 或手写档案：')
    log.info(confirmTemplate(confirmFile))
  } else if (!loaded.record.confirmed) {
    log.warn('确认档案写着「未确认」（可能被撤销过）：仍然不回')
  } else {
    log.info(
      '双闸门已闭合：路由 %s，单条 %d 字，冷却 %d ms，出口 %s（档案说明：%s）',
      settings.routePath,
      settings.chunkMax,
      settings.cooldownMs,
      settings.replyMode,
      loaded.record.note,
    )
  }

  if (settings.allowContacts.length === 0) {
    log.warn('联系人白名单为空 → 默认**全拒**（手册 §6.2：白名单外不发信息）。要回话必须先把这个填上')
  }
  if (settings.outboundWebhook === '') {
    log.warn('没有配 outbound-webhook：超预算的回复（以及 reply-mode=webhook 的全部回复）发不出去')
  }
  log.info(
    '入站只接受本机请求。手册 §9.11 记的端口是 %d，但**端口归宿主**：宿主绑在哪个端口，桥接端就打哪个',
    CALLBACK_PORT_HINT,
  )
  log.info(
    '桥接端请 POST %s，报文形如 {"contact":"张三","text":"在吗"}；wxauto 跑在 Windows 上，本插件不代管它',
    settings.routePath,
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
    ) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏路径回退、非法 webhook 置空），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
