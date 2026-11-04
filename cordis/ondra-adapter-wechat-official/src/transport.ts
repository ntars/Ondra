/**
 * 客服消息的 HTTP 实现（公众号公开接口）。
 *
 * ## 两个接口，一条链路
 *
 * ```
 * GET  /cgi-bin/token?grant_type=client_credential&appid=..&secret=..   → access_token（7200 秒）
 * POST /cgi-bin/message/custom/send?access_token=..                     → 发一条文本
 * ```
 *
 * 手册 §9.11 只写了「真回复走客服消息 48h」，没有给接口路径。这两个路径与字段
 * 来自公众号公开文档（`touser` / `msgtype` / `text.content`），**本仓内没有副本、
 * 本轮也不允许实装运行**，所以：参数按公开文档写，任何一处改名都会以
 * `errcode` 原样带回日志，不会静默产出「以为发了」。
 *
 * ## 三个必须自己兜住的细节
 *
 * 1. **`access_token` 全局唯一**：同一次刷新会让旧 token 失效（尤其在别的实例也在刷时）。
 *    所以只在 `expires_in - 300s` 之后才刷新，不做「每次发都取一次」。
 * 2. **`errcode 40001 / 42001` 是「token 过期/无效」**：刷一次再重试一次，
 *    第**二**次还失败就报出去——不无限重试，否则一个配错的 AppSecret 会变成刷接口的机器。
 * 3. **超时用 `AbortController`**：请求要真停，不能只是不再等（那会一直占着连接与额度）。
 */

import type { PushRequest, PushResult, SendReason, WechatPush } from './types.js'

/** 最小 fetch 形状（不引 `lib.dom`，也不写 `any`）。 */
export interface FetchResponseLike {
  /** 状态码。 */
  readonly status: number
  /** 解析 JSON；解析失败由调用方吞掉。 */
  json(): Promise<unknown>
}

/** 最小 fetch 形状。 */
export type FetchLike = (
  url: string,
  init?: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
  },
) => Promise<FetchResponseLike>

/** 传输依赖。 */
export interface PushDeps {
  /** 接口基址（`https://api.weixin.qq.com`，可在配置里换）。 */
  readonly apiBase: string
  /** AppID。 */
  readonly appId: string
  /** AppSecret（永不进日志）。 */
  readonly appSecret: string
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** 时间源。 */
  now(): number
  /** fetch 实现（默认取全局；测试可注入）。 */
  fetchImpl?: FetchLike
}

/** token 有效期内的安全余量（毫秒）：5 分钟。 */
const TOKEN_SAFETY_MS = 300_000

/** token 无效的两个错误码：刷新后重试一次。 */
const TOKEN_ERROR_CODES: ReadonlySet<number> = new Set([40001, 42001])

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** token 缓存。 */
interface TokenCache {
  /** token 原文。 */
  readonly value: string
  /** 到期时刻（毫秒，已扣掉安全余量）。 */
  readonly expiresAt: number
}

/** 客服消息 HTTP 实现。 */
export class HttpWechatPush implements WechatPush {
  readonly id = 'http'

  private readonly deps: PushDeps
  private cache: TokenCache | null = null

  constructor(deps: PushDeps) {
    this.deps = deps
  }

  /** 丢掉缓存（换凭据或确认失效后调用）。 */
  invalidate(): void {
    this.cache = null
  }

  /**
   * 发一条文本。
   * @param request 请求。
   */
  async push(request: PushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }

    const first = await this.sendOnce(request.openId, text)
    if (first.ok) return first
    // 只有「token 失效」才刷一次重试：其他错误重试只会把一次失败变成两次。
    if (first.errcode !== undefined && TOKEN_ERROR_CODES.has(first.errcode)) {
      this.cache = null
      return this.sendOnce(request.openId, text)
    }
    return first
  }

  /**
   * 发一次（含取 token）。
   * @param openId 收信人。
   * @param text 正文。
   */
  private async sendOnce(openId: string, text: string): Promise<PushResult> {
    const token = await this.accessToken()
    if (!token.ok) return { ok: false, errcode: token.errcode, errmsg: token.errmsg, reason: token.reason }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch' }

    const url = this.deps.apiBase + '/cgi-bin/message/custom/send?access_token=' + encodeURIComponent(token.value)
    const body = JSON.stringify({ touser: openId, msgtype: 'text', text: { content: text } })
    const called = await this.call(fetchImpl, url, 'POST', body)
    if (!called.ok) return called.result

    const payload = called.payload
    const errcode = typeof payload['errcode'] === 'number' ? payload['errcode'] : 0
    if (errcode !== 0) {
      return {
        ok: false,
        errcode,
        errmsg: typeof payload['errmsg'] === 'string' ? payload['errmsg'] : '',
        reason: 'http',
      }
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
      '/cgi-bin/token?grant_type=client_credential&appid=' +
      encodeURIComponent(this.deps.appId) +
      '&secret=' +
      encodeURIComponent(this.deps.appSecret)
    const called = await this.call(fetchImpl, url, 'GET', undefined)
    if (!called.ok) {
      const result = called.result
      return { ok: false, reason: result.reason ?? 'http', errcode: result.errcode, errmsg: result.errmsg }
    }

    const payload = called.payload
    const token = payload['access_token']
    if (typeof token !== 'string' || token === '') {
      const errcode = typeof payload['errcode'] === 'number' ? payload['errcode'] : undefined
      return {
        ok: false,
        reason: 'token',
        errcode,
        errmsg: typeof payload['errmsg'] === 'string' ? payload['errmsg'] : '',
      }
    }
    const expiresIn = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : 7_200
    this.cache = { value: token, expiresAt: now + Math.max(60_000, expiresIn * 1000 - TOKEN_SAFETY_MS) }
    return { ok: true, value: token }
  }

  /**
   * 发一个请求并解析 JSON。
   *
   * 三种失败各归各的码：超时（`timeout`）、网络（`http`）、JSON 坏（`http`）。
   * 把它们压成一个「失败」，排查时就只能靠猜。
   * @param fetchImpl fetch 实现。
   * @param url 地址。
   * @param method 方法。
   * @param body 请求体。
   */
  private async call(
    fetchImpl: FetchLike,
    url: string,
    method: 'GET' | 'POST',
    body: string | undefined,
  ): Promise<
    | { readonly ok: true; readonly payload: Record<string, unknown> }
    | { readonly ok: false; readonly result: PushResult }
  > {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    try {
      const response = await fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json; charset=utf-8' },
        body,
        signal: controller.signal,
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return { ok: false, result: { ok: false, reason: 'http', errmsg: 'HTTP ' + response.status + ' 且响应不是 JSON' } }
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false, result: { ok: false, reason: 'http', errmsg: '响应不是对象' } }
      }
      return { ok: true, payload: payload as Record<string, unknown> }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        result: {
          ok: false,
          reason: aborted ? 'timeout' : 'http',
          errmsg: aborted ? '请求超时' : error instanceof Error ? error.message : String(error),
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
