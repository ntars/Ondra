/**
 * O-063 `ondra-adapter-wecom`：企业微信自建应用通道。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 读凭据（决定能不能验签、能不能发应用消息）；
 * 3. **真的注册一条宿主路由** `ctx.webServer.register({kind:'exact', path})`——
 *    企业微信是「平台打过来」的模型，没有这条路由就没有这个通道；
 * 4. `provide` 服务。
 *
 * ## 为什么这不是「独立 HTTP 服务」
 *
 * 手册 §12.4 允许的形态是 app 插件。这里的路由注册在**宿主的 webServer 上**
 * （`desktop/docs/subsystems/web-server.zh.md`：`register(route)` 返回 disposer），
 * 插件自己不 listen、不占端口、卸载即撤。
 *
 * ## 端口归宿主，不归插件
 *
 * master-plan §9.11 记的 3455 是旧项目的本机端口。企业微信后台填的是
 * 「`https://<域名><routePath>`」（可以带端口，但必须是它够得着的公网地址），
 * 所以实际部署是「宿主 webServer 绑 443 或前置反代」——**本插件不替用户改端口**。
 */

import { TextDecoder } from 'node:util'
import type { Context } from '@ntars/cordis'
import { WecomAdapter, messageOf } from './adapter.js'
import type { LogLike } from './adapter.js'
import { credentialTemplate, maskCorpId, readCredentials } from './credential.js'
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
import { HttpWecomPush } from './transport.js'
import { parseQuery } from './wire.js'
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
  RouterLike,
  WecomService,
  WebServerLike,
} from './types.js'
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  CREDENTIAL_FILE_SUFFIX,
  MAX_BODY_BYTES,
  STATE_FILE_SUFFIX,
  WECOM_SERVICE_KEY,
} from './types.js'

export type * from './types.js'
export {
  WECOM_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_MIN,
  ACK_TEXT,
  AES_KEY_CHARS,
  AES_KEY_BYTES,
  AES_BLOCK_BYTES,
  PKCS7_BLOCK_BYTES,
  FRAME_PREFIX_BYTES,
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
  DEDUPE_FLOOR,
  DEDUPE_CEIL,
  CONCURRENCY_CEIL,
  REQUEST_TIMEOUT_CEIL,
  PERSIST_MS,
  completeConfig,
  configDriftOf,
  isUsablePath,
} from './settings.js'
export {
  sha1Hex,
  signatureOf,
  safeEqual,
  decodeAesKey,
  decryptFrame,
  openPayload,
} from './crypt.js'
export type { CryptFailure, DecryptOutcome } from './crypt.js'
export {
  extractTag,
  hasDtd,
  parseQuery,
  parseEnvelope,
  parseInbound,
  dedupeKeyOf,
} from './wire.js'
export type { Envelope } from './wire.js'
export { HttpWecomPush } from './transport.js'
export type { WecomPushDeps } from './transport.js'
export { readCredentials, credentialTemplate, maskCorpId } from './credential.js'
export { WecomAdapter, conversationOf, parseConversation } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-wecom'

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
 *
 * 注册失败不阻断：退回「插件实例配置」也能用，只是面板上不会出现这个段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-wecom: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

/**
 * 读请求体（有上限）。
 *
 * 上限是防「打错端口」的：回调报文是几百字节量级，几十 KB 已经异常。
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
 *
 * 刻意不在这里判「是不是已经发过」：`ServerResponse` 没有可靠的「已 end」标志，
 * 猜一个只会引入新分支。调用方（路由处理体的 try/catch）已经兜住 `ERR_HTTP_HEADERS_SENT`。
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
    /** 企业微信通道；未装载本插件时为 undefined。 */
    'ondra-adapter-wecom'?: WecomService
  }
}

/**
 * Cordis 入口：解析配置、读凭据、注册路由与服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('adapter.wecom') : 'ondra.adapter.wecom')

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

  // 3. 推送实现：凭据齐才建（缺 corpId 时建了也只会在发的时候失败，不如现在就说清楚）。
  const push =
    credential.ok && credential.value !== undefined
      ? new HttpWecomPush({
          apiBase: settings.apiBase,
          corpId: credential.value.corpId,
          secret: credential.value.secret,
          agentId: credential.value.agentId,
          timeoutMs: settings.requestTimeoutMs,
          now,
        })
      : null

  const adapter = new WecomAdapter({
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

  // 4. 登记能力。自建应用回调只有成员与应用的私聊，没有群消息。
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
          // 群里 @ 应用属于「智能机器人」产品，不走自建应用回调——所以这里恒 false。
          groupChat: false,
          mentionRequired: false,
          // 只做文字：图/语音/文件都还没验证过协议。
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
    'ondra-adapter-wecom: 登记通道能力',
  )

  // 5. 注册服务。
  ctx.effect(
    () => {
      const dispose = ctx.provide(WECOM_SERVICE_KEY, adapter)
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
    'ondra-adapter-wecom: 注册企业微信通道服务',
  )

  // 6. 真的注册路由。**没有 webServer 时如实说清楚**，不假装在听。
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    log.error('没有 webServer 服务：企业微信打过来的请求没人接，这个通道现在完全收不到消息')
  } else {
    ctx.effect(
      () => {
        try {
          const dispose = webServer.register({
            kind: 'exact',
            path: settings.routePath,
            handler: async (req, res) => {
              try {
                const query = parseQuery(req.url)
                const method = (req.method ?? 'GET').toUpperCase()

                if (method === 'GET') {
                  // 后台「保存」时的验证：原样回 echostr 的**明文**（不是 XML 壳）。
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
                // 路由处理里的任何异常都不能让宿主留下一个挂着的响应。
                log.warn('处理企业微信请求抛错：%s', messageOf(error))
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
      'ondra-adapter-wecom: 注册回调路由',
    )
  }

  // 7. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('企业微信通道默认关闭（enable=false）：打开前先填凭据，并把回调地址写进企业微信后台')
  } else if (!credential.ok) {
    log.error('通道已打开，但凭据不齐（缺 %s）', credential.missing ?? 'unknown')
    if (files.credential !== '') log.info(credentialTemplate(files.credential))
  } else {
    log.info(
      '企业微信通道已打开：路由 %s，单条上限 %d 字，并发 %d（企业 %s，AgentId %d）',
      settings.routePath,
      settings.chunkMax,
      settings.maxConcurrent,
      maskCorpId(credential.value?.corpId ?? ''),
      credential.value?.agentId ?? 0,
    )
  }

  log.info(
    '企业微信后台的「接收消息服务器配置」必须填 EncodingAESKey：本插件只接受加密回调，明文报文会被拒（回调地址填 https://<你的域名>%s）',
    settings.routePath,
  )

  if (settings.allowUserIds.length === 0) {
    log.warn('UserID 白名单为空 → 全企业成员都能触发她。企业应用里这是可见性决定，请确认这是你要的')
  }
  if (push === null) {
    log.warn('没有推送实现：验签能过、消息能收，但回答发不出去（原因见上一条凭据提示）')
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
      // 全部字段都能安全补全（越界夹紧、坏路径回退、空名单回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
