/**
 * 钉钉 HTTP 实现。**两条出口，各自独立**。
 *
 * ## 出口一：`sessionWebhook`（每条来信自带）
 *
 * ```
 * POST <sessionWebhook>   {"msgtype":"text","text":{"content":"…"},"at":{"atUserIds":["…"]}}
 * ← {"errcode":0,"errmsg":"ok"}
 * ```
 *
 * 优点是**不用换 token、不用 appKey**：地址里带着这次会话的票据。
 * 缺点是它有有效期（报文里的 `sessionWebhookExpiredTime`）。过期之后
 * 这个地址就是个死链，`errcode` 会告诉你，但那时这轮回答已经白跑了。
 *
 * ## 出口二：机器人主动接口（要 `appKey` + `robotCode`）
 *
 * ```
 * POST /v1.0/oauth2/accessToken                  {appKey, appSecret}      → accessToken（约 7200 秒）
 * POST /v1.0/robot/oToMessages/batchSend         {robotCode,userIds,…}    → 私聊
 * POST /v1.0/robot/groupMessages/send            {robotCode,openConversationId,…} → 群
 * ```
 *
 * 三个路径与字段来自钉钉开放平台公开文档，**仓内无副本、未实跑**。
 * 任何一处改名都会以 `code` 原样带回日志，不会静默「以为发了」。
 *
 * ## `msgParam` 是「字符串里套 JSON」
 *
 * 与飞书的 `content` 同一个坑：`msgParam` 的值是 `"{\"content\":\"…\"}"`——
 * 正文要**再 `JSON.stringify` 一层**。少这一层会以参数错误被拒，
 * 而错误信息不会告诉你「少了一层序列化」。
 *
 * ## 为什么两条出口不合并成一个带 `mode` 的方法
 *
 * 因为两条的**失败含义不同**：`expired-session` 的处置是「换出口」，
 * `no-app-key` 的处置是「去填凭据」——换了也没用。合成一个方法之后，
 * 调用方要在同一个分支里区分这两种，而它们的下一步动作正好相反。
 */

import type {
  ActivePushRequest,
  DingTalkPush,
  FetchLike,
  FetchResponseLike,
  PushResult,
  SendReason,
  SessionPushRequest,
} from './types.js'

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** accessToken 的提前续期余量（毫秒）：5 分钟。 */
const TOKEN_SAFETY_MS = 300_000

/** token 缓存。 */
interface TokenCache {
  /** token 原文。 */
  readonly value: string
  /** 到期时刻（毫秒，已扣掉安全余量）。 */
  readonly expiresAt: number
}

/** 传输依赖。 */
export interface DingTalkPushDeps {
  /** 接口基址（主动接口用；sessionWebhook 是绝对地址，不受它影响）。 */
  readonly apiBase: string
  /** 应用 AppKey（可能为空：只走 sessionWebhook 时不需要）。 */
  readonly appKey: string
  /** 应用 AppSecret（永不进日志）。 */
  readonly appSecret: string
  /** 机器人 robotCode（可能为空）。 */
  readonly robotCode: string
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** 时间源。 */
  now(): number
  /** fetch 实现（默认取全局；测试可注入）。 */
  readonly fetchImpl?: FetchLike
}

/** 一次请求的结论。 */
type CallResult =
  | { readonly ok: true; readonly status: number; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly reason: SendReason; readonly errmsg: string }

/** 钉钉消息实现。 */
export class HttpDingTalkPush implements DingTalkPush {
  readonly id = 'http'

  private readonly deps: DingTalkPushDeps
  private cache: TokenCache | null = null

  constructor(deps: DingTalkPushDeps) {
    this.deps = deps
  }

  /** 丢掉缓存的 accessToken（换凭据后调用）。 */
  invalidate(): void {
    this.cache = null
  }

  /**
   * 走 sessionWebhook 发一条。
   * @param request 回信地址、正文、要 @ 的人。
   */
  async pushSession(request: SessionPushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }
    const webhook = request.webhook.trim()
    if (webhook === '') return { ok: false, reason: 'expired-session' }

    const body: Record<string, unknown> = {
      msgtype: 'text',
      text: { content: text },
    }
    const atUserIds = request.atUserIds ?? []
    if (atUserIds.length > 0) body['at'] = { atUserIds, isAtAll: false }

    const called = await this.request(webhook, { method: 'POST', body: JSON.stringify(body) })
    if (!called.ok) return { ok: false, reason: called.reason, errmsg: called.errmsg }

    // 老接口（oapi）成功一定回 `{"errcode":0}`。**没有 errcode 不等于成功**：
    // 那更可能是中间件回了一个空对象——按成功处理就会「以为发了」。
    if (!('errcode' in called.payload)) {
      return {
        ok: false,
        reason: 'http',
        errmsg: '响应里没有 errcode（HTTP ' + String(called.status) + '）：无法确认是否已送达',
      }
    }

    const errcode = readNumber(called.payload, 'errcode')
    if (errcode !== 0) {
      return {
        ok: false,
        errcode,
        errmsg: readText(called.payload, 'errmsg'),
        reason: 'http',
      }
    }
    return { ok: true }
  }

  /**
   * 走机器人主动接口发一条。
   * @param request 会话类型、会话 id / 收信人、正文。
   */
  async pushActive(request: ActivePushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }
    if (this.deps.appKey === '') return { ok: false, reason: 'no-app-key' }
    if (this.deps.robotCode === '') return { ok: false, reason: 'no-robot-code' }
    if (request.kind === 'private' && request.userId.trim() === '') {
      return { ok: false, reason: 'no-sender' }
    }

    const token = await this.accessToken()
    if (!token.ok) return { ok: false, reason: token.reason, errmsg: token.errmsg }

    // `msgParam` 是字符串里套 JSON（见文件头）。
    const msgParam = JSON.stringify({ content: text })
    const group = request.kind === 'group'

    const payload: Record<string, unknown> = {
      robotCode: this.deps.robotCode,
      msgKey: 'sampleText',
      msgParam,
    }
    let path: string
    if (group) {
      const openConversationId = request.conversationId.trim()
      // 群发没有 openConversationId 就是一条注定失败的请求，提前说清楚。
      if (openConversationId === '') return { ok: false, reason: 'no-sender' }
      payload['openConversationId'] = openConversationId
      path = '/v1.0/robot/groupMessages/send'
    } else {
      payload['userIds'] = [request.userId.trim()]
      path = '/v1.0/robot/oToMessages/batchSend'
    }

    const called = await this.request(this.deps.apiBase + path, {
      method: 'POST',
      body: JSON.stringify(payload),
      authorization: token.value,
    })
    if (!called.ok) return { ok: false, reason: called.reason, errmsg: called.errmsg }
    if (called.status >= 400) {
      return {
        ok: false,
        errcode: readNumber(called.payload, 'code'),
        errmsg: readText(called.payload, 'message') || readText(called.payload, 'code'),
        reason: 'http',
      }
    }
    return { ok: true }
  }

  /**
   * 取 accessToken（带缓存）。
   */
  private async accessToken(): Promise<
    { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: SendReason; readonly errmsg: string }
  > {
    const now = this.deps.now()
    if (this.cache !== null && this.cache.expiresAt > now) return { ok: true, value: this.cache.value }

    const body = JSON.stringify({ appKey: this.deps.appKey, appSecret: this.deps.appSecret })
    const called = await this.request(this.deps.apiBase + '/v1.0/oauth2/accessToken', {
      method: 'POST',
      body,
    })
    if (!called.ok) return { ok: false, reason: called.reason, errmsg: called.errmsg }
    if (called.status >= 400) {
      return {
        ok: false,
        reason: 'http',
        errmsg: readText(called.payload, 'message') || '换 accessToken 失败（HTTP ' + String(called.status) + '）',
      }
    }

    const token = readText(called.payload, 'accessToken')
    if (token === '') return { ok: false, reason: 'http', errmsg: '响应里没有 accessToken' }

    // `expireIn` 是秒；缺省按 7200 秒。
    const expireIn = readNumber(called.payload, 'expireIn') || 7_200
    this.cache = { value: token, expiresAt: now + Math.max(60_000, expireIn * 1000 - TOKEN_SAFETY_MS) }
    return { ok: true, value: token }
  }

  /**
   * 真正发出请求。三种失败各归各的码：超时、网络、JSON 坏。
   * @param url 地址（sessionWebhook 是绝对地址，其余是 apiBase + path）。
   * @param init 方法、请求体、可选 access token。
   */
  private async request(
    url: string,
    init: { readonly method: string; readonly body?: string; readonly authorization?: string },
  ): Promise<CallResult> {
    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch', errmsg: '没有全局 fetch' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
    if (init.authorization !== undefined) headers['x-acs-dingtalk-access-token'] = init.authorization

    try {
      const response: FetchResponseLike = await fetchImpl(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return {
          ok: false,
          reason: 'http',
          errmsg: 'HTTP ' + String(response.status) + ' 且响应不是 JSON',
        }
      }
      const record =
        typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {}
      return { ok: true, status: response.status, payload: record }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'http',
        errmsg: aborted ? '请求超时' : error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 读一个字符串字段。
 * @param payload 响应。
 * @param key 键名。
 */
function readText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 读一个数字字段（有些错误体把码写成字符串）。
 * @param payload 响应。
 * @param key 键名。
 */
function readNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    if (/^-?\d{1,12}$/.test(value)) return Number(value)
    return 0
  }
  return 0
}
