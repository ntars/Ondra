/**
 * 网络出口：本插件**唯一**发 HTTP 的地方（只有云端兜底一条用得到）。
 *
 * ## 为什么要单独一个文件
 *
 * 本仓 `desktop/packages` 与 `desktop/docs` 里没有可消费的 HTTP 服务键
 * （与 O-047 / O-050 / O-126 同一处境），所以只能用运行时的 `globalThis.fetch`。
 * 日后宿主提供 transport 服务时，**只替换这个文件**：`FetchLike` 就是替换点。
 *
 * ## 为什么发 `FormData` 而不是手工拼 multipart
 *
 * 手工拼 multipart 要自己造边界串、算 `Content-Length`、把二进制塞进字符串
 * （一旦用 `TextEncoder` 走一遍，非 UTF-8 字节就被改了）。那是另一类
 * 「看起来能跑、偶尔传坏一个字节」的活。运行时有 `FormData` / `Blob` 就用它。
 *
 * 没有就报 `no-transport`：**不退化**成手工拼。云端转写是兜底路径，
 * 兜底路径上再叠一层自研协议实现，出错时根本分不清是哪一层的错。
 *
 * ## 为什么超时与取消要分开记
 *
 * 调用方给的 `signal` 是「用户取消」，超时是「等太久了」。两者都要能中断，
 * 但原因不同：取消不该记成失败（会污染 `byReason`，面板上看起来像故障），
 * 超时要如实报 `timeout`。混成一个的后果是永远分不清「网断了」与「模型太慢」。
 */

import type { AsrReason, FetchLike, FetchResponseLike } from './types.js'

/** 响应体上限（字符）。转写结果正常几十 KB，4 MiB 已经宽到能发现「这不是接口」。 */
export const MAX_RESPONSE_CHARS = 4 * 1024 * 1024

/** 一次请求的结果。 */
export type TextResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | {
    readonly ok: false
    readonly reason: AsrReason
    readonly detail: string
    readonly status?: number
  }

/** 请求依赖。日志归调用方（它知道是哪个动作失败了）。 */
export interface TransportDeps {
  readonly fetch: FetchLike | undefined
}

/**
 * 取运行时的 `fetch`。
 *
 * 刻意不 polyfill：没有 `fetch` 的运行时里硬塞一个自研 HTTP 客户端，
 * 等于把「协议实现」自研一次（§1.8 明令禁止）。拿不到就 `no-transport`。
 */
export function resolveFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}

/** 运行时有没有 `FormData` 与 `Blob`（发 multipart 的两个前提）。 */
export function hasFormData(): boolean {
  const scope = globalThis as { FormData?: unknown; Blob?: unknown }
  return typeof scope.FormData === 'function' && typeof scope.Blob === 'function'
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
 * 发一次 multipart 请求。**永不抛错**。
 * @param deps 出口依赖。
 * @param url 完整地址。
 * @param form 表单（含文件）。
 * @param headers 附加头（鉴权）。
 * @param timeoutMs 超时。
 * @param external 调用方的取消信号。
 */
export async function sendForm(
  deps: TransportDeps,
  url: string,
  form: unknown,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<TextResult> {
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
    // 刻意不设 content-type：multipart 的边界必须由运行时自己生成并写进头里。
    response = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal })
  } catch (error) {
    clearTimeout(timer)
    if (external !== undefined) external.removeEventListener('abort', forward)
    if (timedOut) return { ok: false, reason: 'timeout', detail: `超过 ${timeoutMs} 毫秒没有响应` }
    if (external?.aborted === true) {
      return { ok: false, reason: 'network', detail: '调用方取消了这次请求' }
    }
    return { ok: false, reason: 'network', detail: textOf(error) }
  }

  let body = ''
  try {
    body = await response.text()
  } catch (error) {
    if (timedOut) return { ok: false, reason: 'timeout', detail: `读响应体时超过 ${timeoutMs} 毫秒` }
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
      detail: `响应体 ${body.length} 字符，超过上限（这个地址可能不是转写接口）`,
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

  return { ok: true, status: response.status, body }
}
