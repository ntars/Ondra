/**
 * 微信客服的 HTTP 实现（拉取 + 发送）。
 *
 * ## 三个接口，一条链路
 *
 * ```
 * GET  /cgi-bin/gettoken?corpid=..&corpsecret=..     → access_token（7200 秒）
 * POST /cgi-bin/kf/sync_msg?access_token=..          → 一批消息 + next_cursor + has_more
 * POST /cgi-bin/kf/send_msg?access_token=..          → 发一条文本
 * ```
 *
 * 手册 §9.11 只给了「拉取式 sync_msg 每 5s + cursor」这一行，没给接口路径。
 * 这三个路径与字段来自企业微信 / 微信客服的公开文档（`cursor` / `token` /
 * `open_kfid` / `limit`；`touser` / `msgtype` / `text.content`），
 * **本仓内没有副本、本轮也不允许实装运行**，所以：
 *
 * - 发送出去的东西按公开文档写，任何一处改名都会以 `errcode` 原样带回，
 *   不会静默产出「以为发了」；
 * - 收到的东西**按需取字段、缺了就退化**（`msgid` 缺失 → 用内容哈希兜底，
 *   见 `cursor.ts`），绝不因为多一个字段就整批失败。
 *
 * ## 只发三个字段给 sync_msg，不是漏了
 *
 * 公开文档里 `sync_msg` 还接受 `token`（回调 token，用于过滤）与
 * `voice_format`。本插件默认**不传**：不传 = 平台按默认处理，
 * 而传错一个语义不明的字段，症状是「拉了但永远是空的」，比不传更难查。
 * 需要按回调过滤时再开（见 README 已知限制）。
 *
 * ## `access_token` 全局唯一
 *
 * 同一次刷新会让旧 token 失效——尤其在别的实例也在刷的时候。所以只在
 * `expires_in − 300s` 之后才刷新，不做「每次拉都取一次」：5 秒一轮的拉取
 * 会把 gettoken 打成热接口，而它有自己的频率限制。
 */

import type { FetchLike, KfMessage, KfTransport, SendResult, SyncFailure, SyncResult } from './types.js'
import { TOKEN_SAFETY_MS } from './types.js'

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

/** 传输依赖。 */
export interface KfTransportDeps {
  /** 接口基址。 */
  readonly apiBase: string
  /** 企业 id。 */
  readonly corpId: string
  /** 应用 Secret（永不进日志）。 */
  readonly secret: string
  /** 客服号 id。 */
  readonly openKfId: string
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** 时间源。 */
  now(): number
  /** fetch 实现（默认取全局；测试可注入）。 */
  fetchImpl?: FetchLike
}

/** token 无效的错误码：刷新后重试一次。 */
const TOKEN_ERROR_CODES: ReadonlySet<number> = new Set([40001, 40014, 42001])

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
 * 归一化一条消息。**取不到的字段给空，不抛错。**
 * @param raw 平台给的一条。
 */
function normalizeMessage(raw: unknown): KfMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>

  const text = (() => {
    const holder = record['text']
    if (typeof holder !== 'object' || holder === null) return ''
    const content = (holder as Record<string, unknown>)['content']
    return typeof content === 'string' ? content : ''
  })()

  const event = (() => {
    const holder = record['event']
    if (typeof holder !== 'object' || holder === null) return { name: '', type: '' }
    const inner = holder as Record<string, unknown>
    return {
      name: typeof inner['event_name'] === 'string' ? (inner['event_name'] as string) : '',
      type: typeof inner['event_type'] === 'string' ? (inner['event_type'] as string) : '',
    }
  })()

  const origin = typeof record['origin'] === 'number' && Number.isFinite(record['origin']) ? record['origin'] : 0
  const sendTime =
    typeof record['send_time'] === 'number' && Number.isFinite(record['send_time']) ? record['send_time'] : 0

  return {
    messageId: textOf(record, 'msgid'),
    openKfId: textOf(record, 'open_kfid'),
    externalUserId: textOf(record, 'external_userid'),
    origin,
    msgType: textOf(record, 'msgtype'),
    text,
    sendTime,
    eventName: event.name,
    eventType: event.type,
  }
}

/** 微信客服 HTTP 实现。 */
export class HttpKfTransport implements KfTransport {
  readonly id = 'http'

  private readonly deps: KfTransportDeps
  private cache: TokenCache | null = null

  constructor(deps: KfTransportDeps) {
    this.deps = deps
  }

  /** 丢掉缓存的 access_token（换凭据后调用）。 */
  invalidate(): void {
    this.cache = null
  }

  /**
   * 拉一批。
   * @param request 游标与条数。
   */
  async sync(request: {
    readonly cursor: string
    readonly limit: number
    readonly openKfId: string
  }): Promise<SyncResult> {
    const first = await this.syncOnce(request)
    if (first.ok) return first
    if (first.errcode !== undefined && TOKEN_ERROR_CODES.has(first.errcode)) {
      this.cache = null
      return this.syncOnce(request)
    }
    return first
  }

  /**
   * 发一条文本。
   * @param request 收信人与正文。
   */
  async send(request: {
    readonly openKfId: string
    readonly externalUserId: string
    readonly text: string
  }): Promise<SendResult> {
    const first = await this.sendOnce(request)
    if (first.ok) return first
    if (first.errcode !== undefined && TOKEN_ERROR_CODES.has(first.errcode)) {
      this.cache = null
      return this.sendOnce(request)
    }
    return first
  }

  /**
   * 拉一次（含取 token）。
   * @param request 游标与条数。
   */
  private async syncOnce(request: {
    readonly cursor: string
    readonly limit: number
    readonly openKfId: string
  }): Promise<SyncResult> {
    const token = await this.accessToken()
    if (!token.ok) {
      return { ok: false, messages: [], nextCursor: '', hasMore: false, reason: token.reason, errcode: token.errcode, errmsg: token.errmsg }
    }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) {
      return { ok: false, messages: [], nextCursor: '', hasMore: false, reason: 'no-fetch' }
    }

    const url = this.deps.apiBase + '/cgi-bin/kf/sync_msg?access_token=' + encodeURIComponent(token.value)
    const body = JSON.stringify({
      cursor: request.cursor,
      open_kfid: request.openKfId,
      limit: request.limit,
    })
    const called = await this.call(fetchImpl, url, 'POST', body)
    if (!called.ok) {
      return { ok: false, messages: [], nextCursor: '', hasMore: false, reason: called.reason, errmsg: called.errmsg }
    }

    const payload = called.payload
    const errcode = typeof payload['errcode'] === 'number' ? payload['errcode'] : 0
    const nextCursor = textOf(payload, 'next_cursor')
    const hasMore = payload['has_more'] === true || payload['has_more'] === 1

    if (errcode !== 0) {
      return {
        ok: false,
        messages: [],
        nextCursor,
        hasMore: false,
        errcode,
        errmsg: textOf(payload, 'errmsg'),
        // 平台码原样带回，但不猜它的语义：连 token 都换过了还失败，就是这条链路的问题。
        reason: 'http',
      }
    }

    const list = payload['msg_list']
    if (!Array.isArray(list)) {
      // 没有 msg_list 不等于失败：平台在「没有新消息」时可能什么都不给。
      return { ok: true, messages: [], nextCursor, hasMore }
    }

    const messages: KfMessage[] = []
    for (const item of list) {
      const message = normalizeMessage(item)
      if (message !== null) messages.push(message)
    }
    return { ok: true, messages, nextCursor, hasMore }
  }

  /**
   * 发一次（含取 token）。
   * @param request 收信人与正文。
   */
  private async sendOnce(request: {
    readonly openKfId: string
    readonly externalUserId: string
    readonly text: string
  }): Promise<SendResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'bad-body' }

    const token = await this.accessToken()
    if (!token.ok) return { ok: false, reason: token.reason, errcode: token.errcode, errmsg: token.errmsg }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch' }

    const url = this.deps.apiBase + '/cgi-bin/kf/send_msg?access_token=' + encodeURIComponent(token.value)
    const body = JSON.stringify({
      touser: request.externalUserId,
      open_kfid: request.openKfId,
      msgtype: 'text',
      text: { content: text },
    })
    const called = await this.call(fetchImpl, url, 'POST', body)
    if (!called.ok) return { ok: false, reason: called.reason, errmsg: called.errmsg }

    const errcode = typeof called.payload['errcode'] === 'number' ? (called.payload['errcode'] as number) : 0
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
    | { readonly ok: false; readonly reason: SyncFailure; readonly errcode?: number; readonly errmsg?: string }
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
    const called = await this.call(fetchImpl, url, 'GET', undefined)
    if (!called.ok) return { ok: false, reason: called.reason, errmsg: called.errmsg }

    const payload = called.payload
    const token = payload['access_token']
    if (typeof token !== 'string' || token === '') {
      const errcode = typeof payload['errcode'] === 'number' ? (payload['errcode'] as number) : undefined
      return { ok: false, reason: 'token', errcode, errmsg: textOf(payload, 'errmsg') }
    }
    const expiresIn = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : 7_200
    this.cache = { value: token, expiresAt: now + Math.max(60_000, expiresIn * 1000 - TOKEN_SAFETY_MS) }
    return { ok: true, value: token }
  }

  /**
   * 发一个请求并解析 JSON。
   *
   * 三种失败各归各的码：超时、网络、JSON 坏。把它们压成一个「失败」，
   * 排查时就只能靠猜。
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
    | { readonly ok: false; readonly reason: SyncFailure; readonly errmsg: string }
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
        return { ok: false, reason: 'bad-body', errmsg: 'HTTP ' + response.status + ' 且响应不是 JSON' }
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false, reason: 'bad-body', errmsg: '响应不是对象' }
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
