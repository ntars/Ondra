/**
 * O-065 `ondra-adapter-dingtalk`：钉钉 Outgoing 通道。
 *
 * ## 装载期只做五件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 读凭据（`appSecret` 验签 + 换 token，`appKey`/`robotCode` 只给主动接口）；
 * 3. **真的注册一条宿主路由** `ctx.webServer.register({kind:'exact', path})`——
 *    钉钉是「平台打过来」的模型，没有这条路由就没有这个通道；
 * 4. 登记通道能力（可选，`router` 缺席就不登记）；
 * 5. `provide` 服务。
 *
 * ## 为什么这不是「独立 HTTP 服务」
 *
 * 手册 §12.4 允许的形态是 app 插件。路由注册在**宿主的 webServer 上**
 * （`desktop/docs/subsystems/web-server.zh.md`：`register(route)` 返回 disposer），
 * 插件自己不 listen、不占端口、卸载即撤。§9.11 记的 3454 是旧项目本机端口，
 * 实际部署是「宿主绑 443 或前置反代」。
 *
 * ## 为什么装载期不调任何网络
 *
 * 装载期探测一次 `accessToken` 看起来能提前发现配置错，代价是三件：
 * 网络抖动会让整包装载变慢、密钥会被用一次在「可能根本不会用」的路径上、
 * 而且它把「配置对不对」这个结论固化成了装载那一刻的答案。
 * 判断留给第一次真正发送，理由原文写进日志。
 */

import { TextDecoder } from 'node:util'
import type { Context } from '@ntars/cordis'
import { DingtalkAdapter, messageOf } from './adapter.js'
import type { LogLike } from './adapter.js'
import { activeReadyOf, credentialTemplate, maskSecret, readCredentials } from './credential.js'
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
import { HttpDingTalkPush } from './transport.js'
import { normalizeHeaders } from './wire.js'
import type {
  ChannelSpecLike,
  ClockLike,
  ConfigSchemaLike,
  DingtalkService,
  HealthLike,
  HttpRequestLike,
  HttpResponseLike,
  IdentityLike,
  KitLike,
  PathLayoutLike,
  RouterLike,
  WebServerLike,
} from './types.js'
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  CREDENTIAL_FILE_SUFFIX,
  JSON_CONTENT_TYPE,
  MAX_BODY_BYTES,
  STATE_FILE_SUFFIX,
  DINGTALK_SERVICE_KEY,
} from './types.js'

export type * from './types.js'
export {
  DINGTALK_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_MIN,
  ACK_BODY,
  JSON_CONTENT_TYPE,
  DEFAULT_ROUTE_PATH,
  DEFAULT_API_BASE,
  CREDENTIAL_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  MAX_BODY_BYTES,
  SIGN_SKEW_MS,
  SESSION_MARGIN_MS,
  SIGN_HEADER_TIMESTAMP,
  SIGN_HEADER_SIGN,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  REPLY_VIA_VALUES,
  DEDUPE_FLOOR,
  DEDUPE_CEIL,
  DEDUPE_DEFAULT,
  CONCURRENCY_CEIL,
  REQUEST_TIMEOUT_CEIL,
  SKEW_FLOOR,
  SKEW_CEIL,
  PERSIST_MS,
  completeConfig,
  configDriftOf,
  isUsablePath,
  isRecord,
  replyViaOf,
} from './settings.js'
export { signOf, verifySign, signReasonText } from './sign.js'
export {
  parseJson,
  inboundOf,
  dedupeKeyOf,
  msgTypeOf,
  robotCodeOf,
  normalizeHeaders,
  stripLeadingMentions,
} from './wire.js'
export { HttpDingTalkPush } from './transport.js'
export type { DingTalkPushDeps } from './transport.js'
export { readCredentials, credentialTemplate, maskSecret, activeReadyOf } from './credential.js'
export { DingtalkAdapter, conversationOf, parseConversation, parseSeen, SEEN_LIMIT, CONTACT_LIMIT } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-dingtalk'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-dingtalk: 注册配置段')
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

declare module '@ntars/cordis' {
  interface Context {
    /** 钉钉通道；未装载本插件时为 undefined。 */
    'ondra-adapter-dingtalk'?: DingtalkService
  }
}

/**
 * Cordis 入口：解析配置、读凭据、注册路由与服务。**永不阻断宿主**。
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

  // 3. 发信实现：凭据齐才建（缺 appSecret 时建了也只会在验签那一步失败，不如现在就说清楚）。
  const push =
    credential.ok && credential.value !== undefined
      ? new HttpDingTalkPush({
          apiBase: settings.apiBase,
          appKey: credential.value.appKey,
          appSecret: credential.value.appSecret,
          robotCode: credential.value.robotCode,
          timeoutMs: settings.requestTimeoutMs,
          now,
        })
      : null

  const adapter = new DingtalkAdapter({
    settings,
    log,
    now,
    files,
    push,
    readCredential: () => readCredentials(files.credential),
    router: () => ctx.get('ondra-router') as RouterLike | undefined,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: () => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 4. 登记能力。钉钉单聊与群聊都有；群里只有被 @ 才会有回调（平台行为）。
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
          // 群里必须被 @ 才有回调——这是平台决定的，本插件如实登记，不做开关。
          mentionRequired: true,
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
    'ondra-adapter-dingtalk: 登记通道能力',
  )

  // 5. 注册服务 + 两个定时器（心跳 / 落盘）。全部随卸载撤销。
  ctx.effect(
    () => {
      const dispose = ctx.provide(DINGTALK_SERVICE_KEY, adapter)
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
    'ondra-adapter-dingtalk: 注册钉钉通道服务',
  )

  // 6. 真的注册路由。**没有 webServer 时如实说清楚**，不假装在听。
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    log.error('没有 webServer 服务：钉钉打过来的请求没人接，这个通道现在完全收不到消息')
  } else {
    ctx.effect(
      () => {
        try {
          const dispose = webServer.register({
            kind: 'exact',
            path: settings.routePath,
            handler: async (req, res) => {
              try {
                const method = (req.method ?? 'GET').toUpperCase()
                if (method !== 'POST') {
                  // 钉钉只发 POST；GET 打过来通常是有人在浏览器里点了一下。
                  res.setHeader('Allow', 'POST')
                  write(res, 405, 'text/plain; charset=utf-8', 'method-not-allowed')
                  return
                }

                const body = await readBody(req, MAX_BODY_BYTES)
                if (body === null) {
                  write(res, 413, 'text/plain; charset=utf-8', 'body-too-large')
                  return
                }

                // 验签要两个头，且必须原样（含空格）交给 sign.ts 判。
                const headers = normalizeHeaders(req.headers)
                const outcome = await adapter.ingest(body, headers)
                write(res, outcome.http, outcome.contentType, outcome.body)
              } catch (error) {
                log.warn('处理钉钉请求抛错：%s', messageOf(error))
                try {
                  // 500 会让钉钉重投——这正是「我们这边真的出事了」该有的表现。
                  write(res, 500, JSON_CONTENT_TYPE, '')
                } catch {
                  // 响应已经发出去了。
                }
              }
            },
          })
          adapter.markRegistered(true)
          return () => {
            adapter.markRegistered(false)
            dispose()
          }
        } catch (error) {
          log.error('路由注册失败（%s）：%s 可能已被别的插件占用', settings.routePath, messageOf(error))
          return () => {}
        }
      },
      'ondra-adapter-dingtalk: 注册回调路由',
    )
  }

  // 7. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  const activeReady = activeReadyOf(credential.value)
  if (!settings.enable) {
    log.info('钉钉通道默认关闭（enable=false）：打开前先填凭据，并把回调地址写进开发者后台')
  } else if (!credential.ok) {
    log.error('通道已打开，但凭据不齐（缺 %s）', credential.missing ?? 'unknown')
    if (files.credential !== '') log.info(credentialTemplate(files.credential))
  } else {
    log.info(
      '钉钉通道已打开：路由 %s，单条上限 %d 字，并发 %d，出口 %s（AppSecret %s）',
      settings.routePath,
      settings.chunkMax,
      settings.maxConcurrent,
      settings.replyVia,
      maskSecret(credential.value === undefined ? '' : credential.value.appSecret),
    )
  }

  if (credential.ok && !activeReady) {
    log.warn(
      '凭据里没有 appKey / robotCode：sessionWebhook 这条出口照常能发，但它过期之后就没法主动发话了（面板会把 activeReady 标成 false）',
    )
  }
  if (settings.allowSenderIds.length === 0) {
    log.warn('发信人白名单为空 → 组织内谁都能触发她。请确认这是你要的')
  }
  if (push === null) {
    log.warn('没有发信实现：验签能过、报文能收，但回答发不出去（原因见上一条凭据提示）')
  }

  log.info(
    '钉钉开发者后台「机器人 → 消息接收模式」选 HTTP 推送，地址填 https://<你的域名>%s，并打开「加签」（本插件按 HmacSHA256 校验）',
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
      // 全部字段都能安全补全（越界夹紧、坏路径回退、空名单回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
