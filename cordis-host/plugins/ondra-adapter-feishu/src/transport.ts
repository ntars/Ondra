/**
 * 飞书 HTTP 实现（发消息）。
 *
 * ## 两个接口，一条链路
 *
 * ```
 * POST /open-apis/auth/v3/tenant_access_token/internal   → tenant_access_token（约 7200 秒）
 * POST /open-apis/im/v1/messages?receive_id_type=chat_id → 往会话里发一条文本
 * ```
 *
 * master-plan §9.11 只给了「先 200 再异步」这一行，没给接口路径。
 * 这两个路径与字段（`app_id` / `app_secret` / `receive_id` / `msg_type` / `content`）
 * 来自飞书开放平台公开文档，**仓内没有副本、本轮也不允许实装运行**，所以：
 *
 * - 发出去的东西按公开文档写，任何一处改名都会以 `code` 原样带回，不会静默「以为发了」；
 * - 收到的响应**按需取字段、缺了就退化**，绝不因为多一个字段就整条失败。
 *
 * ## `content` 是「字符串里套 JSON」
 *
 * 飞书的文本消息体是 `{"msg_type":"text","content":"{\"text\":\"…\"}"}`——
 * 正文要**再 `JSON.stringify` 一层**。少这一层会以 `code=230001`（参数错误）被拒，
 * 而错误信息不会告诉你「少了一层序列化」。收信侧同理（见 `wire.ts` 的注释）。
 *
 * ## `receive_id_type=chat_id`
 *
 * 用 `chat_id` 而不是 `open_id`：群里被 @ 时，`open_id` 是那个人，`chat_id` 是那个群。
 * 用 `open_id` 回复等于发**私聊**——他会在另一个会话里看到，群里的人什么都看不到。
 */

import type {
  FeishuPush,
  FetchLike,
  FetchResponseLike,
  PushRequest,
  PushResult,
  SendReason,
} from './types.js'
import { TOKEN_SAFETY_MS } from './types.js'

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/**
 * token 失效的错误码。
 *
 * 只放公开文档里明确表示「token 无效/过期」的两个；其余错误原样带回日志——
 * 猜着把一堆码当「过期」重试，只会把一次配置错误变成一串重复请求。
 */
const TOKEN_ERROR_CODES: ReadonlySet<number> = new Set([99991661, 99991663])

/** token 缓存。 */
interface TokenCache {
  /** token 原文。 */
  readonly value: string
  /** 到期时刻（毫秒，已扣掉安全余量）。 */
  readonly expiresAt: number
}

/** 传输依赖。 */
export interface FeishuPushDeps {
  /** 接口基址。 */
  readonly apiBase: string
  /** 应用 App ID。 */
  readonly appId: string
  /** 应用 App Secret（永不进日志）。 */
  readonly appSecret: string
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** 时间源。 */
  now(): number
  /** fetch 实现（默认取全局；测试可注入）。 */
  readonly fetchImpl?: FetchLike
}

/**
 * 从响应里读一个字符串字段。
 * @param payload 响应对象。
 * @param key 字段名。
 */
function textOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 从响应里读一个数字字段。
 * @param payload 响应对象。
 * @param key 字段名。
 */
function numberOf(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 飞书消息实现。 */
export class HttpFeishuPush implements FeishuPush {
  readonly id = 'http'

  private readonly deps: FeishuPushDeps
  private cache: TokenCache | null = null

  constructor(deps: FeishuPushDeps) {
    this.deps = deps
  }

  /** 丢掉缓存的 tenant_access_token（换凭据后调用）。 */
  invalidate(): void {
    this.cache = null
  }

  /**
   * 发一条文本。
   * @param request 会话与正文。
   */
  async push(request: PushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }
    if (request.chatId === '') return { ok: false, reason: 'empty' }

    const first = await this.sendOnce(request.chatId, text)
    if (first.ok) return first
    if (first.errcode !== undefined && TOKEN_ERROR_CODES.has(first.errcode)) {
      this.cache = null
      return this.sendOnce(request.chatId, text)
    }
    return first
  }

  /**
   * 发一次（含取 token）。
   * @param chatId 会话 id。
   * @param text 正文。
   */
  private async sendOnce(chatId: string, text: string): Promise<PushResult> {
    const token = await this.accessToken()
    if (!token.ok) {
      const base: PushResult = { ok: false, reason: token.reason }
      return token.errcode === undefined ? base : { ...base, errcode: token.errcode, errmsg: token.errmsg }
    }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch' }

    const url = this.deps.apiBase + '/open-apis/im/v1/messages?receive_id_type=chat_id'
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      // 正文再序列化一层：飞书的 content 是「字符串里套 JSON」。
      content: JSON.stringify({ text }),
    })
    const called = await this.request(fetchImpl, url, {
      method: 'POST',
      body,
      authorization: token.value,
    })
    if (!called.ok) {
      const base: PushResult = { ok: false, reason: called.reason }
      return called.errmsg === '' ? base : { ...base, errmsg: called.errmsg }
    }

    const code = numberOf(called.payload, 'code') ?? 0
    if (code !== 0) {
      return { ok: false, errcode: code, errmsg: textOf(called.payload, 'msg'), reason: 'http' }
    }
    return { ok: true }
  }

  /**
   * 取 tenant_access_token（带缓存）。
   */
  private async accessToken(): Promise<
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly reason: SendReason; readonly errcode?: number; readonly errmsg?: string }
  > {
    const now = this.deps.now()
    if (this.cache !== null && this.cache.expiresAt > now) return { ok: true, value: this.cache.value }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch' }

    const url = this.deps.apiBase + '/open-apis/auth/v3/tenant_access_token/internal'
    const body = JSON.stringify({ app_id: this.deps.appId, app_secret: this.deps.appSecret })
    const called = await this.request(fetchImpl, url, { method: 'POST', body })
    if (!called.ok) {
      const base = { ok: false as const, reason: called.reason }
      return called.errmsg === '' ? base : { ...base, errmsg: called.errmsg }
    }

    const payload = called.payload
    const code = numberOf(payload, 'code') ?? 0
    if (code !== 0) {
      return {
        ok: false,
        reason: 'token',
        errcode: code,
        errmsg: textOf(payload, 'msg'),
      }
    }

    const token = payload['tenant_access_token']
    if (typeof token !== 'string' || token === '') {
      return { ok: false, reason: 'token', errcode: code, errmsg: '响应里没有 tenant_access_token' }
    }

    // `expire` 是秒（有些形态给 `expires_in`），两个都认；缺省按 7200 秒。
    const expire = numberOf(payload, 'expire') ?? numberOf(payload, 'expires_in') ?? 7_200
    this.cache = { value: token, expiresAt: now + Math.max(60_000, expire * 1000 - TOKEN_SAFETY_MS) }
    return { ok: true, value: token }
  }

  /**
   * 真正发出请求。三种失败各归各的码：超时、网络、JSON 坏。
   * @param fetchImpl fetch 实现。
   * @param url 地址。
   * @param init 方法、请求体、可选 Bearer token。
   */
  private async request(
    fetchImpl: FetchLike,
    url: string,
    init: { readonly method: string; readonly body?: string; readonly authorization?: string },
  ): Promise<
    | { readonly ok: true; readonly payload: Record<string, unknown> }
    | { readonly ok: false; readonly reason: SendReason; readonly errmsg: string }
  > {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
    if (init.authorization !== undefined) headers['Authorization'] = 'Bearer ' + init.authorization

    const params: {
      readonly method: string
      readonly headers?: Readonly<Record<string, string>>
      readonly body?: string
      readonly signal?: AbortSignal
    } = {
      method: init.method,
      headers,
      body: init.body,
      signal: controller.signal,
    }

    try {
      const response: FetchResponseLike = await fetchImpl(url, params)
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return { ok: false, reason: 'http', errmsg: 'HTTP ' + response.status + ' 且响应不是 JSON' }
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false, reason: 'http', errmsg: '响应不是对象' }
      }
      return { ok: true, payload: payload as Record<string, unknown> }
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
