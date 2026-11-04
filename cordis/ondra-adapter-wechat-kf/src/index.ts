/**
 * O-061 `ondra-adapter-wechat-kf`：微信客服通道。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 读凭据（决定能不能拉、能不能发）；
 * 3. 登记能力（O-055）并 `provide` 服务；
 * 4. 若配了 `callbackPath`，才额外挂一条宿主路由。
 *
 * ## 为什么默认**不挂**任何路由
 *
 * 这是本插件与 O-060（公众号）最大的形状差别。公众号是「微信打过来」，
 * 没有路由就没有通道；客服是「我过去拿」——每 5 秒 `sync_msg` 一次，
 * 用户不用开放端口、不用配公网域名、不用管 HTTPS 证书。
 *
 * 所以 `callbackPath` 出厂是空串。挂路由只为收事件（`enter_session` 之类），
 * 而事件不是「能回话」的前提。为了一个可选能力去要求公网，是拿主链路的
 * 可用性换一个边缘功能。
 *
 * ## 定时器全在 `ctx.effect` 里
 *
 * 拉取循环、心跳、落盘三个定时器都必须随卸载一起停（手册 §3.3-4 可逆注册）。
 * 漏一个的后果不是「多跑一会儿」，是「卸载后她还在拉消息、还在回人」。
 */

import { TextDecoder } from 'node:util'
import type { Context } from '@ntars/cordis'
import { KfAdapter } from './adapter.js'
import type { LogLike } from './adapter.js'
import { credentialTemplate, maskCorpId, maskKfId, readCredentials } from './credential.js'
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
import { HttpKfTransport } from './transport.js'
import { parseQuery } from './wire.js'
import type {
  ChannelSpecLike,
  ClockLike,
  ConfigSchemaLike,
  HealthLike,
  HttpRequestLike,
  HttpResponseLike,
  IdentityLike,
  KfService,
  KfTransport,
  KitLike,
  PathLayoutLike,
  RouterLike,
  WebServerLike,
} from './types.js'
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  CREDENTIAL_FILE_SUFFIX,
  KF_SERVICE_KEY,
  MAX_BODY_BYTES,
  STATE_FILE_SUFFIX,
} from './types.js'

export type * from './types.js'
export {
  KF_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_MIN,
  POLL_MS,
  POLL_MIN,
  POLL_MAX,
  MAX_ROUNDS,
  PAGE_LIMIT,
  PAGE_LIMIT_MAX,
  WINDOW_HOURS,
  SEEN_LIMIT,
  WINDOW_LIMIT,
  PERSONA_TIMEOUT_MS,
  PERSONA_TIMEOUT_MIN,
  PERSONA_TIMEOUT_MAX,
  DEFAULT_API_BASE,
  DEFAULT_ROUTE_PATH,
  CALLBACK_ROUTE_HINT,
  CREDENTIAL_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  MAX_BODY_BYTES,
  ORIGIN_CUSTOMER,
  ORIGIN_SYSTEM,
  ORIGIN_STAFF,
  MAX_SKEW_MS,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  PERSIST_MS,
  CONCURRENCY_CEIL,
  MAX_ROUNDS_CEIL,
  REQUEST_TIMEOUT_CEIL,
  completeConfig,
  configDriftOf,
  isUsablePath,
} from './settings.js'
export { sha1Hex, signatureOf, safeEqual, checkSignature, parseQuery } from './wire.js'
export {
  emptyState,
  parseState,
  dedupeKey,
  hasSeen,
  markSeen,
  markTouched,
  withinWindow,
  prune,
  SEEN_TTL_MS,
} from './cursor.js'
export type { CursorState, SeenEntry } from './cursor.js'
export { HttpKfTransport } from './transport.js'
export type { KfTransportDeps } from './transport.js'
export { readCredentials, credentialTemplate, maskCorpId, maskKfId } from './credential.js'
export { KfAdapter, conversationOf, parseConversation, CONVERSATION_PREFIX, MAX_DRAIN } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-wechat-kf'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-wechat-kf: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

/**
 * 错误转一句中文。
 * @param error 任意异常。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读请求体（有上限）。回调只用来收事件，不解析正文，但仍要读完再回。
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

declare module '@ntars/cordis' {
  interface Context {
    /** 微信客服通道；未装载本插件时为 undefined。 */
    'ondra-adapter-wechat-kf'?: KfService
  }
}

/**
 * Cordis 入口：解析配置、读凭据、登记能力、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('adapter.wechat-kf') : 'ondra.adapter.wechat-kf')

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

  // 2. 路径与凭据。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const fileIn = (suffix: string): string =>
    layout === undefined ? '' : layout.fileIn('user', 'channels', CHANNEL_ID + suffix)
  const files = {
    credential: settings.credentialFile !== '' ? settings.credentialFile : fileIn(CREDENTIAL_FILE_SUFFIX),
    state: settings.stateFile !== '' ? settings.stateFile : fileIn(STATE_FILE_SUFFIX),
  }
  const credential = readCredentials(files.credential)

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 3. 传输：凭据齐才建（缺 corpId 时建了也只会每次拉都失败，不如现在就说清楚）。
  let transport: KfTransport | null = null
  if (credential.ok && credential.value !== undefined) {
    transport = new HttpKfTransport({
      apiBase: settings.apiBase,
      corpId: credential.value.corpId,
      secret: credential.value.secret,
      openKfId: credential.value.openKfId,
      timeoutMs: settings.requestTimeoutMs,
      now,
    })
  }

  const adapter = new KfAdapter({
    settings,
    log,
    now,
    stateFile: files.state,
    credential,
    transport: () => transport ?? undefined,
    router: () => ctx.get('ondra-router') as RouterLike | undefined,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: () => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 4. 登记能力。客服是一对一，没有群。
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
          groupChat: false,
          mentionRequired: false,
          // 只做文字：图/语音的协议本版没验证过，不挂假能力。
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
    'ondra-adapter-wechat-kf: 登记通道能力',
  )

  // 5. 注册服务 + 三个定时器（拉取 / 心跳 / 落盘）。全部随卸载撤销。
  ctx.effect(
    () => {
      const dispose = ctx.provide(KF_SERVICE_KEY, adapter)

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

      adapter.start()

      return () => {
        adapter.stop()
        clearInterval(heartbeatTimer)
        clearInterval(persistTimer)
        dispose()
      }
    },
    'ondra-adapter-wechat-kf: 注册客服通道服务',
  )

  // 6. 可选回调。**默认不挂**：拉取式不需要公网。
  if (settings.callbackPath !== '') {
    const webServer = ctx.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) {
      log.error('配了回调路径 %s，但没有 webServer：回调挂不上，事件收不到（拉取仍然照跑）', settings.callbackPath)
    } else {
      ctx.effect(
        () => {
          try {
            const dispose = webServer.register({
              kind: 'exact',
              path: settings.callbackPath,
              handler: async (req, res) => {
                try {
                  const method = (req.method ?? 'GET').toUpperCase()
                  if (method !== 'GET' && method !== 'POST') {
                    res.setHeader('Allow', 'GET, POST')
                    write(res, 405, 'text/plain; charset=utf-8', 'method-not-allowed')
                    return
                  }

                  const outcome = adapter.verify(parseQuery(req.url))
                  if (!outcome.ok) {
                    write(res, outcome.http, outcome.contentType, outcome.body)
                    return
                  }

                  if (method === 'GET') {
                    // 平台「提交」时的验证：原样回 echostr（纯文本，不带外壳）。
                    write(res, outcome.http, outcome.contentType, outcome.body)
                    return
                  }

                  const body = await readBody(req, MAX_BODY_BYTES)
                  if (body === null) {
                    write(res, 413, 'text/plain; charset=utf-8', 'body-too-large')
                    return
                  }
                  // 事件不在这里处理：能回话靠的是拉取，事件只是「有人进来了」的信号。
                  // 如实说清楚，而不是假装收下了又什么都不做。
                  if (settings.verbose) log.info('收到一条回调事件（%d 字节）：本版不解析事件正文', body.length)
                  write(res, 200, 'text/plain; charset=utf-8', '')
                } catch (error) {
                  log.warn('处理客服回调抛错：%s', messageOf(error))
                  try {
                    write(res, 500, 'text/plain; charset=utf-8', 'internal-error')
                  } catch {
                    // 响应已经发出去了。
                  }
                }
              },
            })
            adapter.markCallbackMounted(true)
            return () => {
              adapter.markCallbackMounted(false)
              dispose()
            }
          } catch (error) {
            log.error('回调注册失败（%s）：%s 可能已被别的插件占用', settings.callbackPath, messageOf(error))
            return () => {}
          }
        },
        'ondra-adapter-wechat-kf: 注册可选回调路由',
      )
    }
  }

  // 7. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('客服通道默认关闭（enable=false）：打开前先填凭据；拉取式不需要公网，直接开就能用')
  } else if (!credential.ok) {
    log.error('通道已打开，但凭据不齐（缺 %s）', credential.missing ?? 'unknown')
    if (files.credential !== '') log.info(credentialTemplate(files.credential))
  } else {
    log.info(
      '客服通道已打开：每 %d ms 拉一次，单条上限 %d 字，窗口 %d 小时（%s / %s）',
      settings.pollMs,
      settings.chunkMax,
      settings.windowHours,
      maskCorpId(credential.value?.corpId ?? ''),
      maskKfId(credential.value?.openKfId ?? ''),
    )
  }

  if (settings.allowExternalUserIds.length === 0) {
    log.warn('外部联系人白名单为空 → 任何加到客服的人都能触发她。客服号是对外入口，请确认这是你要的')
  }
  if (settings.callbackPath === '') {
    log.info('回调未挂（callbackPath 为空）：这是拉取式的正常状态，不需要公网域名')
  }
  if (transport === null && settings.enable) {
    log.warn('没有传输实现：凭据齐了才会有，现在一条都拉不到')
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
      // 全部字段都能安全补全（越界夹紧、坏路径回退、空来源表回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
