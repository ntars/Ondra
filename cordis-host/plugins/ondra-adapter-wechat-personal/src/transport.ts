/**
 * 出站：把回复 POST 到用户自备的 webhook。
 *
 * ## 为什么出站是 webhook 而不是「直接操作微信」
 *
 * 操作微信的是 wxauto（Windows 客户端 UI 自动化），它跑在用户自己的机器上，
 * 而且是**用户自己装、自己负责**的进程。本插件不引入它的任何代码
 * （手册 §12.3：协议端明确禁止衍生开发，一律以外部进程对接），
 * 所以「把话送出去」只能交给一个用户可控的地址。
 *
 * 这也解释了为什么 `reply-mode` 还有个 `sync`：桥接端如果愿意等，
 * 直接把回复读走更省事（少一个端口、少一次失败）。两条出口同一套切条与冷却，
 * 差异只在「谁把它们搬出去」。
 *
 * ## 判成功的标准
 *
 * **只有 2xx 才算发出去了。** 3xx 不算（重定向到一个登录页也会是 3xx，
 * 而那意味着消息根本没到人手里），4xx/5xx 更不算。
 * 拿不到状态码时按失败处理——「不确定」不能当成「成功」。
 */

import type { FetchLike, PersonalPush, PushRequest, PushResult } from './types.js'

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** 传输依赖。 */
export interface WebhookDeps {
  /** 出站地址（http/https）。 */
  readonly url: string
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** fetch 实现（默认取全局；测试可注入）。 */
  readonly fetchImpl?: FetchLike
}

/** 详情文本上限（避免把一整页 HTML 写进日志）。 */
const DETAIL_MAX = 200

/** HTTP webhook 实现。 */
export class HttpWebhookPush implements PersonalPush {
  readonly id = 'webhook'

  private readonly deps: WebhookDeps

  constructor(deps: WebhookDeps) {
    this.deps = deps
  }

  /**
   * 发一条。
   * @param request 收信人与正文。
   */
  async push(request: PushRequest): Promise<PushResult> {
    const text = request.text.trim()
    if (text === '') return { ok: false, reason: 'empty' }
    if (this.deps.url.trim() === '') return { ok: false, reason: 'no-webhook' }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) return { ok: false, reason: 'no-fetch' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    try {
      const response = await fetchImpl(this.deps.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ contact: request.contact, text, messageId: request.messageId }),
        signal: controller.signal,
      })

      let detail = ''
      try {
        detail = (await response.text()).slice(0, DETAIL_MAX)
      } catch {
        // 读不出正文不影响「状态码」这个判据。
      }

      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: 'http', detail: 'HTTP ' + response.status + (detail === '' ? '' : '：' + detail) }
      }
      return { ok: true, detail }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'http',
        detail: aborted ? '请求超时' : error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
