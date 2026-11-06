/**
 * Telegram HTTP 实现。**三个方法，一个拼 URL 的地方。**
 *
 * ## token 只在 URL 里，所以这里只有一个出口
 *
 * ```
 * GET  ${apiBase}/bot<token>/getUpdates?offset=…&timeout=50&limit=100
 * POST ${apiBase}/bot<token>/sendMessage      {"chat_id":…,"text":"…"}
 * GET  ${apiBase}/bot<token>/getMe
 * ```
 *
 * 三条路径都经 `urlOf()` 拼出来，**并且所有向上流出的文本都过 `redactToken()`**：
 * 平台给的 `description`、`fetch` 抛的错、我们自己拼的诊断串。
 * 这不是洁癖——`fetch` 在 URL 非法时抛的错**会把整条 URL 带出去**，
 * 而那条 URL 里就是机器人。
 *
 * ## 为什么 `403` / `401` / `409` 各有各的码
 *
 * 三个码的处置完全不同：
 *
 * - `401` → token 不对（去改凭据）；
 * - `403` → token 对，但这个机器人被用户拉黑/被踢出群（去问用户）；
 * - `409` → **另有一个消费者**（同 token 上还有 webhook 或另一个轮询）。
 *   `409` 是最容易误判的一个：不区分就得靠「一直失败」去猜。
 *
 * 其余错误码一律 `http`，原样带回 `description`——猜着归类只会把一次配置错
 * 变成一串重复请求。
 *
 * ## 为什么 `disable_web_page_preview`
 *
 * 回答里常带链接。开着预览会让一条消息在群里展开成一张大卡片，
 * 把「她在说话」变成「她在发广告」。关掉它不改变内容，只改变形态。
 */

import { redactToken } from './credential.js'
import type {
  FetchLike,
  FetchResponseLike,
  MeResult,
  PushRequest,
  PushResult,
  SendReason,
  TelegramPush,
  UpdatesRequest,
  UpdatesResult,
  UpdateView,
} from './types.js'

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** 传输依赖。 */
export interface HttpTelegramPushDeps {
  /** 接口基址。 */
  readonly apiBase: string
  /** Bot token（**永不进日志**）。 */
  readonly token: string
  /** 单次请求超时（毫秒；长轮询时应该远大于 `timeoutSec`）。 */
  readonly timeoutMs: number
  /** 求值函数：每轮现取，避免长轮询期间超时值被冻结。 */
  readonly timeoutMsOf?: () => number
  /** fetch 实现（默认取全局；测试可注入）。 */
  readonly fetchImpl?: FetchLike
}

/** 一次请求的结论。 */
type CallResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly reason: SendReason; readonly errcode?: number; readonly errmsg: string }

/**
 * 从 Telegram 的错误体里取一个原因码。
 * @param status HTTP 状态。
 * @param payload 响应体。
 */
function reasonOf(status: number, payload: Record<string, unknown>): SendReason {
  const code = typeof payload['error_code'] === 'number' ? payload['error_code'] : status
  if (code === 401) return 'unauthorized'
  if (code === 403) return 'forbidden'
  if (code === 409) return 'conflict'
  return 'http'
}

/** Telegram HTTP 实现。 */
export class HttpTelegramPush implements TelegramPush {
  readonly id = 'http'

  private readonly deps: HttpTelegramPushDeps

  constructor(deps: HttpTelegramPushDeps) {
    this.deps = deps
  }

  /**
   * 拼一条接口地址。**token 只在这一处进字符串。**
   * @param method 方法名（`getUpdates` / `sendMessage` / `getMe`）。
   */
  private urlOf(method: string): string {
    return this.deps.apiBase + '/bot' + this.deps.token + '/' + method
  }

  /**
   * 拉一批更新。
   * @param request offset / 超时 / 条数 / 取消信号。
   */
  async getUpdates(request: UpdatesRequest): Promise<UpdatesResult> {
    const query =
      '?offset=' +
      String(Math.max(0, Math.trunc(request.offset))) +
      '&timeout=' +
      String(Math.max(0, Math.trunc(request.timeoutSec))) +
      '&limit=' +
      String(Math.max(1, Math.trunc(request.limit))) +
      // 只要消息类更新；其余（回调查询、成员变动…）由 `wire.ts` 丢弃。
      '&allowed_updates=' +
      encodeURIComponent(JSON.stringify(['message']))

    const called = await this.request(this.urlOf('getUpdates') + query, { method: 'GET', signal: request.signal })
    if (!called.ok) return { ok: false, updates: [], reason: called.reason, errmsg: called.errmsg, ...errcodeOf(called) }

    const result = called.payload['result']
    if (!Array.isArray(result)) {
      return { ok: true, updates: [] }
    }
    const updates: UpdateView[] = []
    for (const item of result) {
      const raw = asRecord(item)
      if (raw === null) continue
      const updateId = typeof raw['update_id'] === 'number' ? raw['update_id'] : 0
      if (updateId <= 0) continue
      updates.push({ updateId, raw })
    }
    return { ok: true, updates }
  }

  /**
   * 发一条文本。
   * @param request 会话与正文。
   */
  async sendMessage(request: PushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }

    const body = JSON.stringify({
      chat_id: request.chatId,
      text,
      disable_web_page_preview: true,
    })
    const called = await this.request(this.urlOf('sendMessage'), { method: 'POST', body })
    if (!called.ok) return { ok: false, reason: called.reason, errmsg: called.errmsg, ...errcodeOf(called) }

    const ok = called.payload['ok'] === true
    if (ok) return { ok: true }
    return {
      ok: false,
      reason: reasonOf(200, called.payload),
      errmsg: descriptionOf(called.payload),
    }
  }

  /** 确认 token。 */
  async getMe(): Promise<MeResult> {
    const called = await this.request(this.urlOf('getMe'), { method: 'GET' })
    if (!called.ok) {
      return { ok: false, reason: called.reason, errmsg: called.errmsg, ...errcodeOf(called) }
    }
    const result = asRecord(called.payload['result'])
    if (called.payload['ok'] !== true || result === null) {
      return {
        ok: false,
        reason: reasonOf(200, called.payload),
        errmsg: descriptionOf(called.payload),
      }
    }
    const id = typeof result['id'] === 'number' ? result['id'] : 0
    const username = typeof result['username'] === 'string' ? result['username'] : ''
    return { ok: true, id, username }
  }

  /**
   * 真正发出请求。三种失败各归各的码：超时、网络、JSON 坏。
   * @param url 地址。
   * @param init 方法、请求体、取消信号。
   */
  private async request(
    url: string,
    init: { readonly method: string; readonly body?: string; readonly signal?: AbortSignal },
  ): Promise<CallResult> {
    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch', errmsg: '没有全局 fetch' }

    const timeoutMs = this.deps.timeoutMsOf === undefined ? this.deps.timeoutMs : this.deps.timeoutMsOf()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    // 外部取消（卸载）与自身超时都要能中断：两路都接在同一个 controller 上。
    const outer = init.signal
    const onOuterAbort = (): void => controller.abort()
    if (outer !== undefined) {
      if (outer.aborted) controller.abort()
      else outer.addEventListener('abort', onOuterAbort, { once: true })
    }

    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'

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
      const record = asRecord(payload)
      if (record === null) return { ok: false, reason: 'http', errmsg: '响应不是对象' }

      // 平台只在 `ok:false` 时给错误码；HTTP 层也可能是 4xx（此时 body 仍是这个形状）。
      if (response.status >= 400 || record['ok'] === false) {
        return {
          ok: false,
          reason: reasonOf(response.status, record),
          errcode: typeof record['error_code'] === 'number' ? record['error_code'] : response.status,
          errmsg: descriptionOf(record),
        }
      }
      return { ok: true, payload: record }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        // **一律先报 timeout**：取消与超时在这里分不开（同一个 controller）。
        // 由 `adapter.ts` 判「是不是我们自己按了停止」再翻成 `aborted`。
        reason: aborted ? 'timeout' : 'http',
        errmsg: aborted ? '请求超时' : redactToken(error instanceof Error ? error.message : String(error)),
      }
    } finally {
      clearTimeout(timer)
      if (outer !== undefined) outer.removeEventListener('abort', onOuterAbort)
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
 * 取平台的错误说明（**已脱敏**）。
 * @param payload 响应体。
 */
function descriptionOf(payload: Record<string, unknown>): string {
  const value = payload['description']
  return typeof value === 'string' ? redactToken(value) : ''
}

/**
 * 把可选的 `errcode` 拼成可展开的片段（避免在返回里写 `errcode: undefined`）。
 * @param called 请求结论。
 */
function errcodeOf(called: { readonly errcode?: number }): { readonly errcode?: number } {
  return called.errcode === undefined ? {} : { errcode: called.errcode }
}
