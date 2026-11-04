/**
 * 回复桥（`replyWebhook`）的 HTTP 实现。
 *
 * ## 为什么「发短信」是桥，不是 `adb shell am start`
 *
 * master-plan §9.11 写得很直白：**发短信不做**，靠 `replyWebhook` + 用户自备
 * Intent 桥。理由不是懒：
 *
 * 1. 设备侧发短信要么走 `am start -a SENDTO`（弹系统短信界面，需要人点发送），
 *    要么走 `service call isms`（不同厂商的 transaction code 不同，属未公开接口）。
 *    前者不算「发出去」，后者是「猜厂商」。
 * 2. 这两条都会往设备里塞**写操作**，而本包的整个安全模型建立在「只读」上。
 *
 * 所以边界画在：**本包只把文本送到用户自己的桥**，桥怎么发由用户决定。
 *
 * ## 载荷是我们定义的契约，不是任何平台的既有协议
 *
 * `POST <replyWebhook>`，body `{"to":"…","body":"…"}`，`Content-Type: application/json`。
 * 桥接端按这个形状接收即可。**这一点必须说清**：它不是微信、不是短信网关的
 * 既有接口，本仓也没有第二份实现可以对拍。
 *
 * ## 默认只允许回环
 *
 * `127.0.0.1 / localhost / [::1]`。理由：桥接端通常是本机的
 * `adb forward` 端口或用户自己起的小服务，不该把「她说的话」默认发到公网。
 * 要发外网必须显式 `allowRemoteBridge: true`（这是一个有意设计的摩擦）。
 */

import type { FetchLike, ReplyOutcome, ReplyPush } from './types.js'
import { REPLY_TIMEOUT_MS } from './types.js'

/** 回环主机名（含 IPv6 的两种写法）。 */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]']

/** 地址检查结论。 */
export interface BridgeUrlCheck {
  /** 可用不可用。 */
  readonly ok: boolean
  /** 不可用的原因码（与 `ReplyReason` 共用词汇）。 */
  readonly reason: 'ok' | 'no-bridge' | 'bad-url' | 'loopback-only'
  /** 一句中文说明（含主机名，不含任何凭据）。 */
  readonly detail: string
}

/**
 * 检查桥接地址。
 * @param url 地址（可空）。
 * @param allowRemote 是否允许非回环。
 */
export function checkBridgeUrl(url: string, allowRemote: boolean): BridgeUrlCheck {
  const text = url.trim()
  if (text === '') {
    return { ok: false, reason: 'no-bridge', detail: '没有配 replyWebhook：只读模式，短信不会被回复' }
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, reason: 'bad-url', detail: 'replyWebhook 不是合法地址（要 http:// 或 https:// 开头）' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'bad-url', detail: 'replyWebhook 只接受 http / https，收到的是 ' + parsed.protocol }
  }
  if (!allowRemote && !LOOPBACK_HOSTS.includes(parsed.hostname)) {
    return {
      ok: false,
      reason: 'loopback-only',
      detail: '桥接地址指向 ' + parsed.hostname + '，默认只允许回环。确要外发请打开 allowRemoteBridge',
    }
  }
  return { ok: true, reason: 'ok', detail: '桥接地址可用（' + parsed.hostname + '）' }
}

/** 取全局 fetch（Node 18+）。 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** 构造依赖。 */
export interface HttpReplyPushDeps {
  /** 桥接地址。 */
  readonly webhook: string
  /** 超时（毫秒）。 */
  readonly timeoutMs?: number
  /** fetch 实现（默认取全局；测试可注入）。 */
  readonly fetchImpl?: FetchLike
}

/** HTTP 回复桥。 */
export class HttpReplyPush implements ReplyPush {
  readonly id = 'http'

  private readonly deps: HttpReplyPushDeps

  constructor(deps: HttpReplyPushDeps) {
    this.deps = deps
  }

  /**
   * 投递一条。**永不抛错**。
   * @param input 号码与正文。
   */
  async send(input: { readonly to: string; readonly body: string }): Promise<ReplyOutcome> {
    const to = input.to.trim()
    const body = input.body.trim()
    if (to === '') return { ok: false, reason: 'empty', detail: '收信号码为空' }
    if (body === '') return { ok: false, reason: 'empty', detail: '正文为空（不发明不存在的半句话）' }

    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    if (fetchImpl === undefined) {
      return { ok: false, reason: 'error', detail: '运行环境没有 fetch（Node 18+ 才有）' }
    }

    const timeoutMs = this.deps.timeoutMs ?? REPLY_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const maybeTimer = timer as unknown as { unref?: () => void }
    if (typeof maybeTimer.unref === 'function') maybeTimer.unref()

    try {
      const response = await fetchImpl(this.deps.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body }),
        signal: controller.signal,
      })
      if (!response.ok) {
        // 只记状态码，不记响应体：桥接端的回显里可能有号码。
        return { ok: false, reason: 'http', detail: '桥接端返回 HTTP ' + String(response.status) }
      }
      return { ok: true, reason: 'ok', detail: '已交给桥接端' }
    } catch (error) {
      const aborted = controller.signal.aborted
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'error',
        detail: aborted ? '桥接端 ' + String(timeoutMs) + ' 毫秒内没有响应' : textOf(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 把异常折成一句文本（不含请求体）。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
