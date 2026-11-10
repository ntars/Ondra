/**
 * 网络出口：本插件**唯一**发 HTTP 的地方（目前只有 GPT-SoVITS 一条用得到）。
 *
 * 背景：`desktop/packages` 与 `desktop/docs` 里没有可消费的 HTTP 服务键
 * （与 O-047 同一处境），所以这里用运行时的 `globalThis.fetch` 直连。
 * 日后宿主提供 transport 服务时，只替换这个文件，`FetchLike` 就是替换点。
 *
 * ## 为什么用「正文首字节」判错误体，而不是看 Content-Type
 *
 * GPT-SoVITS 的 `api_v2` 出错时回的是 JSON（`{"message": ...}`）而不是音频，
 * 但它的 Content-Type 在多数版本里仍是 `audio/wav`——照 Content-Type 判，
 * 一段 JSON 会被写成 `.wav` 文件，然后播放器报「文件损坏」。
 * 那是最难查的一类错：合成「成功」了，文件也在，就是不出声。
 *
 * 音频的容器头里不可能出现 `{` 或 `[`（RIFF/ID3/ID3v2 起步就是字母），
 * 所以拿首字节判定既便宜又准。
 */

import type { FetchLike, HttpResponseLike, LogLike } from './types.js'

/** 失败原因（TtsReason 的子集）。 */
export type HttpFailure = 'network' | 'timeout' | 'http' | 'payload'

/** 一次取音频的结果。 */
export type HttpAudio =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: HttpFailure; readonly detail: string }

/** 出口依赖。 */
export interface HttpDeps {
  /** 运行时 `fetch`；运行时被裁剪过时为 `undefined`。 */
  readonly fetch: FetchLike | undefined
  readonly timeoutMs: number
  readonly log: LogLike
}

/** 从一段字节里取可读预览（给日志与原因码用）。 */
function preview(bytes: Uint8Array, limit = 240): string {
  try {
    return new TextDecoder('utf-8').decode(bytes.slice(0, limit)).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/**
 * POST 一段 JSON，把响应当音频收下来。
 *
 * **永不抛错**：网络、超时、非 2xx、回的不是音频，各自给原因码。
 * @param url 地址。
 * @param body 请求体（会被 `JSON.stringify`）。
 * @param deps 出口依赖。
 */
export async function postJsonForAudio(
  url: string,
  body: unknown,
  deps: HttpDeps,
): Promise<HttpAudio> {
  const fetchImpl = deps.fetch
  if (fetchImpl === undefined) {
    return { ok: false, reason: 'network', detail: '运行时没有 fetch' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, deps.timeoutMs)

  let response: HttpResponseLike
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/*' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const message = error instanceof Error ? error.message : String(error)
    // AbortError 与「真的连不上」要分开：前者是超时（调大 timeoutMs），
    // 后者是服务没起（去启动 GPT-SoVITS）。两者给同一句话会误导排查方向。
    if (controller.signal.aborted) {
      deps.log.warn('GPT-SoVITS 超时（%dms）', deps.timeoutMs)
      return { ok: false, reason: 'timeout', detail: '等待 ' + String(deps.timeoutMs) + 'ms 未响应' }
    }
    return { ok: false, reason: 'network', detail: message }
  }

  clearTimeout(timer)

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'payload', detail: '读响应体失败：' + message }
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'http',
      detail: 'HTTP ' + String(response.status) + '：' + preview(bytes),
    }
  }

  if (bytes.length === 0) {
    return { ok: false, reason: 'payload', detail: '响应体为空' }
  }

  const head = bytes[0]
  if (head === 0x7b || head === 0x5b) {
    // `{` 或 `[`：这是 JSON，不是音频。
    return { ok: false, reason: 'payload', detail: '返回的是 JSON：' + preview(bytes) }
  }

  return { ok: true, bytes }
}

/** 解析 `globalThis.fetch`（裁剪过的运行时会没有）。 */
export function resolveFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return candidate as FetchLike
}
