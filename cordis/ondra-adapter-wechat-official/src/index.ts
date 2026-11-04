/**
 * O-060 `ondra-adapter-wechat-official`：微信公众号通道。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 读凭据（决定能不能验签、能不能发客服消息）；
 * 3. **真的注册一条宿主路由** `ctx.webServer.register({kind:'exact', path})`——
 *    公众号是「微信打过来」的模型，没有这条路由就没有这个通道；
 * 4. `provide` 服务。
 *
 * ## 为什么这不是「独立 HTTP 服务」
 *
 * 手册 §12.4 允许的形态是 app 插件。这里的路由注册在**宿主的 webServer 上**
 * （`desktop/docs/subsystems/web-server.zh.md`：`register(route)` 返回 disposer），
 * 插件自己不 listen、不占端口、卸载即撤。这跟「起一个自己的服务器」是两件事：
 * 后者要用户开放端口、要自己管 TLS、卸载还留进程。
 *
 * ## 公众号后台只能填 80 / 443
 *
 * 这是平台限制（手册 §9.11 的 3456 是旧项目的本机端口）。所以实际部署是
 * 「宿主 webServer 绑 443（或在前面挂反代）→ 公众号后台填 `https://<域名><routePath>`」。
 * 本插件不替用户改端口：端口归宿主。
 */

import { TextDecoder } from 'node:util'
import type { Context } from '@ntars/cordis'
import { WechatAdapter, messageOf } from './adapter.js'
import type { LogLike } from './adapter.js'
import { credentialTemplate, maskAppId, readCredentials } from './credential.js'
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
import { HttpWechatPush } from './transport.js'
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
  QueryLike,
  RouterLike,
  WechatOfficialService,
  WebServerLike,
} from './types.js'
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  CREDENTIAL_FILE_SUFFIX,
  MAX_BODY_BYTES,
  STATE_FILE_SUFFIX,
  WECHAT_SERVICE_KEY,
} from './types.js'

export type * from './types.js'
export {
  WECHAT_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_MIN,
  HARD_LIMIT_MS,
  DEFAULT_REPLY_BUDGET_MS,
  REPLY_BUDGET_MIN,
  REPLY_BUDGET_MAX,
  MESSAGE_WINDOW_HOURS,
  CALLBACK_PORTS_ZH,
  DEFAULT_ROUTE_PATH,
  DEFAULT_API_BASE,
  CREDENTIAL_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  MAX_BODY_BYTES,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  DEFAULT_DEGRADE_TEXT,
  DEDUPE_FLOOR,
  DEDUPE_CEIL,
  CONCURRENCY_CEIL,
  REQUEST_TIMEOUT_CEIL,
  WINDOW_MIN,
  WINDOW_MAX,
  completeConfig,
  configDriftOf,
  isUsablePath,
} from './settings.js'
export {
  sha1Hex,
  signatureOf,
  safeEqual,
  checkSignature,
  extractTag,
  hasDtd,
  parseInbound,
  cdata,
  buildTextReply,
  verifyRequest,
  MAX_SKEW_MS,
} from './wire.js'
export {
  emptyWindowState,
  parseWindowState,
  withinWindow,
  dedupeKey,
  markSeen,
  prune,
  withinBudget,
  SEEN_LIMIT,
  WINDOW_LIMIT,
} from './window.js'
export type { BudgetResult, WindowState } from './window.js'
export { HttpWechatPush } from './transport.js'
export type { FetchLike, FetchResponseLike, PushDeps } from './transport.js'
export { readCredentials, credentialTemplate, maskAppId } from './credential.js'
export { WechatAdapter, conversationOf, parseConversation, messageOf } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-wechat-official'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-wechat-official: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

/**
 * 解析 query 串。
 * @param url 请求 URL（可能只有路径）。
 */
function queryOf(url: string | undefined): QueryLike {
  const out: Record<string, string> = {}
  if (url === undefined || url === '') return out
  try {
    // 相对路径也能被 URL 解析：基址只用来凑一个合法 URL，不会被访问。
    const parsed = new URL(url, 'http://localhost')
    for (const [key, value] of parsed.searchParams.entries()) out[key] = value
  } catch {
    // URL 坏掉就当没有 query：验签会以 missing-params 拒掉，不会静默通过。
  }
  return out
}

/**
 * 读请求体（有上限）。
 *
 * 上限是防「打错端口」的：公众号报文是几百字节量级，几十 KB 已经异常。
 * 没有上限的话，一个 100MB 的 POST 会先把内存吃掉再谈验签。
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
    /** 微信公众号通道；未装载本插件时为 undefined。 */
    'ondra-adapter-wechat-official'?: WechatOfficialService
  }
}

/**
 * Cordis 入口：解析配置、读凭据、注册路由与服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('adapter.wechat-official') : 'ondra.adapter.wechat-official')

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

  // 3. 推送实现：凭据齐才建（缺 appId 时建了也只会在发的时候失败，不如现在就说清楚）。
  const push =
    credential.ok && credential.value !== undefined
      ? new HttpWechatPush({
          apiBase: settings.apiBase,
          appId: credential.value.appId,
          appSecret: credential.value.appSecret,
          timeoutMs: settings.requestTimeoutMs,
          now,
        })
      : null

  const adapter = new WechatAdapter({
    settings,
    log,
    now,
    files,
    push,
    router: () => ctx.get('ondra-router') as RouterLike | undefined,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: () => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 4. 登记能力。公众号只有一对一，没有群。
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
          // 一对一：每条都是对着她说的话，不需要「点名」。
          mentionRequired: false,
          // 只做文字：图/语音都还没验证过协议。
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
    'ondra-adapter-wechat-official: 登记通道能力',
  )

  // 5. 注册服务。
  ctx.effect(
    () => {
      const dispose = ctx.provide(WECHAT_SERVICE_KEY, adapter)
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
    'ondra-adapter-wechat-official: 注册微信通道服务',
  )

  // 6. 真的注册路由。**没有 webServer 时如实说清楚**，不假装在听。
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    log.error('没有 webServer 服务：公众号打过来的请求没人接，这个通道现在完全收不到消息')
  } else {
    ctx.effect(
      () => {
        try {
          const dispose = webServer.register({
            kind: 'exact',
            path: settings.routePath,
            handler: async (req, res) => {
              try {
                const query = queryOf(req.url)
                const method = (req.method ?? 'GET').toUpperCase()

                if (method === 'GET') {
                  // 微信后台「提交」时的验证：原样回 echostr（纯文本，不带 XML 壳）。
                  const outcome = adapter.verify(query)
                  write(res, outcome.http, outcome.contentType, outcome.body)
                  return
                }
                if (method !== 'POST') {
                  res.setHeader('Allow', 'GET, POST')
                  write(res, 405, 'text/plain; charset=utf-8', 'method-not-allowed')
                  return
                }

                const body = await readBody(req, MAX_BODY_BYTES)
                if (body === null) {
                  // 超限或读取失败：回 413 让它别再重试这份报文。
                  write(res, 413, 'text/plain; charset=utf-8', 'body-too-large')
                  return
                }
                const outcome = await adapter.ingest(body, query)
                write(res, outcome.http, outcome.contentType, outcome.body)
              } catch (error) {
                // 路由处理里的任何异常都不能让宿主进程留下一个挂着的响应。
                log.warn('处理微信请求抛错：%s', messageOf(error))
                try {
                  write(res, 500, 'text/plain; charset=utf-8', 'internal-error')
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
      'ondra-adapter-wechat-official: 注册回调路由',
    )
  }

  // 7. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('公众号通道默认关闭（enable=false）：打开前先填凭据，并把回调地址加到公众号后台')
  } else if (!credential.ok) {
    log.error('通道已打开，但凭据不齐（缺 %s）', credential.missing ?? 'unknown')
    if (files.credential !== '') log.info(credentialTemplate(files.credential))
  } else {
    log.info(
      '公众号通道已打开：路由 %s，单条上限 %d 字，预算 %d ms，客服消息窗口 %d 小时（AppID %s）',
      settings.routePath,
      settings.chunkMax,
      settings.replyBudgetMs,
      settings.windowHours,
      maskAppId(credential.value?.appId ?? ''),
    )
  }

  log.info(
    '公众号后台的服务器地址只能填 80 / 443：请把宿主 webServer 绑到 443（或前置反代），回调地址填 https://<你的域名>%s；Token 与凭据文件里的 token 必须逐字一致',
    settings.routePath,
  )

  if (settings.allowOpenIds.length === 0) {
    log.warn('openid 白名单为空 → 所有关注者都能触发她。公众号是公开入口，请确认这是你要的')
  }
  if (push === null) {
    log.warn('没有推送实现：5 秒超时后的真回复发不出去（只剩降级话术），原因见上一条凭据提示')
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
      // 全部字段都能安全补全（越界夹紧、坏路径回退、空话术回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
