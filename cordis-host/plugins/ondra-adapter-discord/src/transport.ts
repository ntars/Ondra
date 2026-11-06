/**
 * Discord REST 实现。**两个方法，一个拼鉴权头的地方。**
 *
 * ```
 * POST ${apiBase}/channels/<channel_id>/messages   {"content":"…"}
 * GET  ${apiBase}/users/@me
 * ```
 *
 * 路径与请求体按 Discord API v10 公开文档写，**仓内无副本、未实跑**
 * （手册无 Discord 专章，见 README 已知限制 1）。
 *
 * ## token 在头里，所以脱敏对象是「字符串」不是「地址」
 *
 * `Authorization: Bot <token>`。URL 干净，于是「日志里没 URL 就安全」这个
 * 直觉在这里失效。本包的做法：**所有向上流出的文本一律过 `redactToken()`**，
 * 包括平台错误体里的 `message` 与 `fetch` 抛的错。
 *
 * ## 为什么 `429` 要单列
 *
 * `429` 有 `retry_after`（秒，浮点），而且**发一条消息被限流**与
 * **整个 bot 被限流**是完全不同的处置：前者等一两秒就好，后者再发就封。
 * 单列成 `rate-limited` 让调用方能带着这个事实去决定「这一段要不要留着重试」，
 * 而不是混进 `http` 里跟 500 一起被当成「网络问题」。
 *
 * ## 为什么 `403` 与 `404` 分开
 *
 * - `403`：**权限不够**（bot 在这个频道没有发言权限）→ 去改频道权限设置；
 * - `404`：**频道不存在**（被删了、或 bot 被踢出服务器）→ 去重新邀请 bot。
 *
 * 混成一个「发送失败」会让用户两边都查一遍。
 */

import { redactToken } from './credential.js'
import type {
  DiscordPush,
  FetchLike,
  FetchResponseLike,
  MeResult,
  PushRequest,
  PushResult,
  SendReason,
} from './types.js'

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** 取全局 AbortSignal.timeout（Node 18+）；没有就自己接一个。 */
function timeoutSignal(timeoutMs: number): { readonly signal?: AbortSignal; readonly cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const maybe = timer as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

/** 传输依赖。 */
export interface HttpDiscordPushDeps {
  /** REST 基址。 */
  readonly apiBase: string
  /** Bot token（**永不进日志**）。 */
  readonly token: string
  /** 请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** fetch 实现（默认取全局；测试可注入）。 */
  readonly fetchImpl?: FetchLike
}

/** 一次请求的结论。 */
type CallResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly reason: SendReason; readonly errcode?: number; readonly errmsg: string }

/**
 * HTTP 状态 → 原因码。
 * @param status HTTP 状态。
 */
function reasonOf(status: number): SendReason {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limited'
  return 'http'
}

/** Discord REST 实现。 */
export class HttpDiscordPush implements DiscordPush {
  readonly id = 'http'

  private readonly deps: HttpDiscordPushDeps

  constructor(deps: HttpDiscordPushDeps) {
    this.deps = deps
  }

  /**
   * 拼一条接口地址。**不含 token**（token 只在头里）。
   * @param path 以 `/` 开头的路径。
   */
  private urlOf(path: string): string {
    return this.deps.apiBase + path
  }

  /**
   * 发一条文本。
   *
   * `allowed_mentions: {parse: []}` 是刻意加的：回答里若出现 `@everyone`
   * 或 `@角色`，平台会真的把所有人叫起来。她说的话不该触发全员提醒。
   * @param request 频道与正文。
   */
  async sendMessage(request: PushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }
    if (request.channelId === '') return { ok: false, reason: 'empty' }

    const body = JSON.stringify({
      content: text,
      allowed_mentions: { parse: [] as string[] },
    })
    const called = await this.request('/channels/' + request.channelId + '/messages', 'POST', body)
    if (!called.ok) return { ok: false, reason: called.reason, errmsg: called.errmsg, ...errcodeOf(called) }
    return { ok: true }
  }

  /** 确认 token（`GET /users/@me`）。 */
  async me(): Promise<MeResult> {
    const called = await this.request('/users/@me', 'GET', undefined)
    if (!called.ok) {
      return { ok: false, reason: called.reason, errmsg: called.errmsg, ...errcodeOf(called) }
    }
    const id = typeof called.payload['id'] === 'string' ? called.payload['id'] : ''
    const username = typeof called.payload['username'] === 'string' ? called.payload['username'] : ''
    if (id === '') {
      return { ok: false, reason: 'http', errmsg: '响应里没有 id：可能不是 /users/@me 的返回' }
    }
    return { ok: true, id, username }
  }

  /**
   * 真正发出请求。三种失败各归各的码：超时、网络、JSON 坏。
   * @param path 路径。
   * @param method 方法。
   * @param body 请求体（GET 时省略）。
   */
  private async request(path: string, method: string, body: string | undefined): Promise<CallResult> {
    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch', errmsg: '没有全局 fetch' }

    const headers: Record<string, string> = {
      // 唯一一处把 token 放进字符串。别处不许再拼一次。
      Authorization: 'Bot ' + this.deps.token,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'

    const guard = timeoutSignal(this.deps.timeoutMs)
    try {
      const response: FetchResponseLike = await fetchImpl(this.urlOf(path), {
        method,
        headers,
        body,
        signal: guard.signal,
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        // 204 无正文是正常的（有些端点如此），但本项目两个端点都该有正文。
        return { ok: false, reason: reasonOf(response.status), errcode: response.status, errmsg: 'HTTP ' + String(response.status) + ' 且响应不是 JSON' }
      }
      const record = asRecord(payload)
      if (record === null) {
        return { ok: false, reason: reasonOf(response.status), errcode: response.status, errmsg: '响应不是对象' }
      }
      if (response.status >= 400) {
        return {
          ok: false,
          reason: reasonOf(response.status),
          errcode: response.status,
          errmsg: messageOf(record),
        }
      }
      return { ok: true, payload: record }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'http',
        errmsg: aborted ? '请求超时' : redactToken(error instanceof Error ? error.message : String(error)),
      }
    } finally {
      guard.cancel()
    }
  }
}

/**
 * 判一个值是不是普通对象。
 * @param value 任意值。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * 取平台错误说明（**已脱敏**）。Discord 把它放在 `message` 里。
 * @param payload 响应体。
 */
function messageOf(payload: Record<string, unknown>): string {
  const value = payload['message']
  return typeof value === 'string' ? redactToken(value) : ''
}

/**
 * 把可选的 `errcode` 拼成可展开的片段（避免在返回里写 `errcode: undefined`）。
 * @param called 请求结论。
 */
function errcodeOf(called: { readonly errcode?: number }): { readonly errcode?: number } {
  return called.errcode === undefined ? {} : { errcode: called.errcode }
}
