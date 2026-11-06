/**
 * 网络出口：本插件**唯一**发 HTTP 的地方。
 *
 * ## 为什么要单独一个文件
 *
 * 本仓 `desktop/packages` 与 `desktop/docs` 里没有可消费的 HTTP 服务键
 * （与 O-047 / O-050 同一处境），所以只能用运行时的 `globalThis.fetch` 直连。
 * 日后宿主提供 transport 服务时，**只替换这个文件**：`FetchLike` 就是替换点。
 *
 * ## 为什么超时要自己造，而不是靠 fetch 的 signal
 *
 * 调用方给的 `signal` 是「用户取消」，超时是「等太久了」。两者必须都能中断，
 * 但**原因不同**：取消要报 `network`（或静默），超时要报 `timeout`——
 * 混成一个的后果是用户在面板上永远分不清「我的网断了」和「这家模型太慢」。
 * 所以这里用两个信号合流，并记下「是哪一个先响的」。
 *
 * ## 为什么响应体要限长
 *
 * 视觉模型的正常回复是几百字。如果一个错的地址回了一整个 HTML 首页
 * （常见于把 base-url 填成官网），`text()` 会把几 MB 读进内存再交给 `JSON.parse`。
 * 限长让它在 2 MiB 处停下并报 `payload`，而不是把进程拖慢十秒。
 */

import type { FetchLike, FetchResponseLike, VisionReason } from './types.js'

/** 响应体上限（字符）。2 MiB 足够装下任何正常的视觉回复。 */
export const MAX_RESPONSE_CHARS = 2 * 1024 * 1024

/** 一次请求的结果。 */
export type JsonResult =
  | { readonly ok: true; readonly json: Record<string, unknown>; readonly status: number }
  | {
    readonly ok: false
    readonly reason: VisionReason
    readonly detail: string
    readonly status?: number
  }

/** 请求依赖。刻意只给 `fetch`：日志归调用方（它知道是哪个动作失败了）。 */
export interface TransportDeps {
  /** 运行时 `fetch`；运行时被裁剪过时为 `undefined`。 */
  readonly fetch: FetchLike | undefined
}

/**
 * 取运行时的 `fetch`。
 *
 * 刻意不 polyfill：没有 `fetch` 的运行时（很老的 Node、被裁过的沙箱）里，
 * 硬塞一个自己写的 HTTP 客户端等于把「协议实现」自研一次（§1.8 明令禁止）。
 * 拿不到就 `no-transport`，这是一个可解释的失败。
 */
export function resolveFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 从响应头里读 content-type；取不到就是空串。 */
function contentTypeOf(response: FetchResponseLike): string {
  const headers = (response as { headers?: { get?(name: string): string | null } }).headers
  if (headers === undefined || typeof headers.get !== 'function') return ''
  return headers.get('content-type') ?? ''
}

/**
 * 发一次 JSON 请求。**永不抛错**：网络、超时、HTTP、解析四种失败各有原因码。
 * @param deps 出口依赖。
 * @param url 完整地址。
 * @param init 方法、头、体。
 * @param timeoutMs 超时（毫秒）。
 * @param external 调用方的取消信号。
 */
export async function requestJson(
  deps: TransportDeps,
  url: string,
  init: {
    readonly method: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  },
  timeoutMs: number,
  external?: AbortSignal,
): Promise<JsonResult> {
  const fetch = deps.fetch
  if (fetch === undefined) {
    return { ok: false, reason: 'no-transport', detail: '运行时没有 fetch（宿主裁剪过运行时）' }
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  // 定时器不许吊住进程：一个被卸载的插件不该让 Node 多活 30 秒。
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref(): void }).unref()
  }

  const forward = (): void => controller.abort()
  if (external !== undefined) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', forward, { once: true })
  }

  let response: FetchResponseLike
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    if (external !== undefined) external.removeEventListener('abort', forward)
    if (timedOut) {
      return { ok: false, reason: 'timeout', detail: `超过 ${timeoutMs} 毫秒没有响应` }
    }
    // 调用方主动取消：这不是故障，别记成失败（会污染 stats 与面板）。
    if (external?.aborted === true) {
      return { ok: false, reason: 'network', detail: '调用方取消了这次请求' }
    }
    return { ok: false, reason: 'network', detail: textOf(error) }
  }

  let body = ''
  try {
    body = await response.text()
  } catch (error) {
    clearTimeout(timer)
    if (external !== undefined) external.removeEventListener('abort', forward)
    if (timedOut) {
      return { ok: false, reason: 'timeout', detail: `读响应体时超过 ${timeoutMs} 毫秒` }
    }
    return { ok: false, reason: 'network', detail: `读响应体失败：${textOf(error)}` }
  } finally {
    clearTimeout(timer)
    if (external !== undefined) external.removeEventListener('abort', forward)
  }

  if (body.length > MAX_RESPONSE_CHARS) {
    return {
      ok: false,
      reason: 'payload',
      status: response.status,
      detail: `响应体 ${body.length} 字符，超过上限 ${MAX_RESPONSE_CHARS}（这个地址可能不是接口）`,
    }
  }

  if (!response.ok) {
    const hint = contentTypeOf(response).includes('html') ? '（回的是网页，base-url 可能填成了官网）' : ''
    return {
      ok: false,
      reason: 'http',
      status: response.status,
      detail: `HTTP ${response.status}${hint}：${body.slice(0, 240).replace(/\s+/g, ' ')}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      ok: false,
      reason: 'payload',
      status: response.status,
      detail: `响应不是 JSON：${body.slice(0, 160).replace(/\s+/g, ' ')}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'payload',
      status: response.status,
      detail: '响应是 JSON 但不是对象（可能是数组或裸值）',
    }
  }
  return { ok: true, json: parsed as Record<string, unknown>, status: response.status }
}
