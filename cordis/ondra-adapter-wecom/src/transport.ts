/**
 * 企业微信 HTTP 实现（应用消息）。
 *
 * ## 两个接口，一条链路
 *
 * ```
 * GET  /cgi-bin/gettoken?corpid=..&corpsecret=..          → access_token（7200 秒）
 * POST /cgi-bin/message/send?access_token=..              → 发一条文本给成员
 * ```
 *
 * master-plan §9.11 只给了「先回 success」这一行，没给接口路径。
 * 这两个路径与字段（`touser` / `msgtype` / `agentid` / `text.content`）来自企业微信公开文档，
 * **仓内没有副本、本轮也不允许实装运行**，所以：
 *
 * - 发出去的东西按公开文档写，任何一处改名都会以 `errcode` 原样带回，
 *   不会静默产出「以为发了」；
 * - 收到的响应**按需取字段、缺了就退化**，绝不因为多一个字段就整条失败。
 *
 * ## `agentid` 必须带
 *
 * 同一个企业里有多个自建应用，`message/send` 不带 `agentid` 会以 40056 一类错误拒绝。
 * 这个字段在凭据里（不在 `Config` 里），由适配器传进来——**传输层不读文件**。
 *
 * ## `access_token` 全局唯一
 *
 * 同一次刷新会让旧 token 失效（尤其是别的实例也在刷的时候）。所以只在
 * `expires_in − 300s` 之后才刷新，不做「每发一条取一次」：那会把 gettoken 打成热接口，
 * 而它自己的频率限制很低。
 */

import type { FetchLike, FetchResponseLike, PushRequest, PushResult, SendReason, WecomPush } from './types.js'
import { TOKEN_SAFETY_MS } from './types.js'

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** token 无效的错误码：换一次 token 再试。 */
const TOKEN_ERROR_CODES: ReadonlySet<number> = new Set([40001, 40014, 42001])

/** token 缓存。 */
interface TokenCache {
  /** token 原文。 */
  readonly value: string
  /** 到期时刻（毫秒，已扣掉安全余量）。 */
  readonly expiresAt: number
}

/** 传输依赖。 */
export interface WecomPushDeps {
  /** 接口基址。 */
  readonly apiBase: string
  /** 企业 id。 */
  readonly corpId: string
  /** 应用 Secret（永不进日志）。 */
  readonly secret: string
  /** 自建应用 AgentId。 */
  readonly agentId: number
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

/** 企业微信应用消息实现。 */
export class HttpWecomPush implements WecomPush {
  readonly id = 'http'

  private readonly deps: WecomPushDeps
  private cache: TokenCache | null = null

  constructor(deps: WecomPushDeps) {
    this.deps = deps
  }

  /** 丢掉缓存的 access_token（换凭据后调用）。 */
  invalidate(): void {
    this.cache = null
  }

  /**
   * 发一条文本。
   * @param request 收信人与正文。
   */
  async push(request: PushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }

    const first = await this.sendOnce(request.userId, text)
    if (first.ok) return first
    if (first.errcode !== undefined && TOKEN_ERROR_CODES.has(first.errcode)) {
      this.cache = null
      return this.sendOnce(request.userId, text)
    }
    return first
  }

  /**
   * 发一次（含取 token）。
   * @param userId 成员 UserID。
   * @param text 正文。
   */
  private async sendOnce(userId: string, text: string): Promise<PushResult> {
    const token = await this.accessToken()
    if (!token.ok) {
      const base: PushResult = { ok: false, reason: token.reason }
      return token.errcode === undefined ? base : { ...base, errcode: token.errcode, errmsg: token.errmsg }
    }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch' }

    const url = this.deps.apiBase + '/cgi-bin/message/send?access_token=' + encodeURIComponent(token.value)
    const body = JSON.stringify({
      touser: userId,
      msgtype: 'text',
      agentid: this.deps.agentId,
      text: { content: text },
      // safe=0：企业内部应用不需要「保密消息」形态（那会把内容变成一条加密提示）。
      safe: 0,
    })
    const called = await this.call(fetchImpl, url, body)
    if (!called.ok) {
      const base: PushResult = { ok: false, reason: called.reason }
      return called.errmsg === '' ? base : { ...base, errmsg: called.errmsg }
    }

    const errcode = numberOf(called.payload, 'errcode') ?? 0
    if (errcode !== 0) {
      return { ok: false, errcode, errmsg: textOf(called.payload, 'errmsg'), reason: 'http' }
    }
    return { ok: true }
  }

  /**
   * 取 access_token（带缓存）。
   */
  private async accessToken(): Promise<
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly reason: SendReason; readonly errcode?: number; readonly errmsg?: string }
  > {
    const now = this.deps.now()
    if (this.cache !== null && this.cache.expiresAt > now) return { ok: true, value: this.cache.value }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch' }

    const url =
      this.deps.apiBase +
      '/cgi-bin/gettoken?corpid=' +
      encodeURIComponent(this.deps.corpId) +
      '&corpsecret=' +
      encodeURIComponent(this.deps.secret)
    const called = await this.get(fetchImpl, url)
    if (!called.ok) {
      const base = { ok: false as const, reason: called.reason }
      return called.errmsg === '' ? base : { ...base, errmsg: called.errmsg }
    }

    const payload = called.payload
    const token = payload['access_token']
    if (typeof token !== 'string' || token === '') {
      return {
        ok: false,
        reason: 'token',
        errcode: numberOf(payload, 'errcode'),
        errmsg: textOf(payload, 'errmsg'),
      }
    }
    const expiresIn = numberOf(payload, 'expires_in') ?? 7_200
    this.cache = { value: token, expiresAt: now + Math.max(60_000, expiresIn * 1000 - TOKEN_SAFETY_MS) }
    return { ok: true, value: token }
  }

  /**
   * 发一个 POST 并解析 JSON。
   * @param fetchImpl fetch 实现。
   * @param url 地址。
   * @param body 请求体。
   */
  private call(
    fetchImpl: FetchLike,
    url: string,
    body: string,
  ): Promise<
    | { readonly ok: true; readonly payload: Record<string, unknown> }
    | { readonly ok: false; readonly reason: SendReason; readonly errmsg: string }
  > {
    return this.request(fetchImpl, url, { method: 'POST', body })
  }

  /**
   * 发一个 GET 并解析 JSON。
   * @param fetchImpl fetch 实现。
   * @param url 地址。
   */
  private get(
    fetchImpl: FetchLike,
    url: string,
  ): Promise<
    | { readonly ok: true; readonly payload: Record<string, unknown> }
    | { readonly ok: false; readonly reason: SendReason; readonly errmsg: string }
  > {
    return this.request(fetchImpl, url, { method: 'GET' })
  }

  /**
   * 真正发出请求。三种失败各归各的码：超时、网络、JSON 坏。
   *
   * 把它们压成一个「失败」，排查时就只能靠猜。
   * @param fetchImpl fetch 实现。
   * @param url 地址。
   * @param init 方法、请求体。
   */
  private async request(
    fetchImpl: FetchLike,
    url: string,
    init: { readonly method: string; readonly body?: string },
  ): Promise<
    | { readonly ok: true; readonly payload: Record<string, unknown> }
    | { readonly ok: false; readonly reason: SendReason; readonly errmsg: string }
  > {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    const headers: Record<string, string> =
      init.body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }
    const params: {
      readonly method: string
      readonly headers?: Readonly<Record<string, string>>
      readonly body?: string
      readonly signal?: AbortSignal
    } = init.body === undefined
      ? { method: init.method, signal: controller.signal }
      : { method: init.method, headers, body: init.body, signal: controller.signal }

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
