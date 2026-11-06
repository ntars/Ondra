/**
 * 与宿主通信的唯一入口。
 *
 * ## 为什么所有请求都要经过这里
 *
 * 界面里会有几十个地方要拿数据。若各处直接 `fetch`，会出现三类问题：
 * 1. 令牌要抄几十遍，改一次得全局搜。
 * 2. 错误处理各写一套，有的弹提示有的静默，用户感受到的是"有时有反应有时没有"。
 * 3. 宿主没就绪时的处理散落各处，容易出现"打开就报错"。
 *
 * 收敛到一处后，上面三件事只在一个文件里定义。
 *
 * ## 就绪等待
 *
 * 宿主由壳在后台拉起，页面加载完时宿主可能还没就绪。这里不假设"页面好了
 * 宿主就好了"，而是显式等待壳发来的 `host-ready` 事件，并保留等待队列。
 */

/** 宿主连接信息。 */
export interface HostConnection {
  url: string
  token: string
  port: number
}

/** 请求失败时抛出的错误，携带 HTTP 状态码便于界面分支。 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 请求选项。 */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  /** 覆盖默认超时。 */
  timeoutMs?: number
}

/**
 * 宿主的单次请求默认超时（30 秒）。
 *
 * 存在的理由：宿主若因故卡住，没有超时的话界面会永远转圈，
 * 用户无法判断是慢还是死了。30 秒足够覆盖最慢的本地推理配置。
 */
const DEFAULT_TIMEOUT_MS = 30_000

/** 全局连接状态。 */
let connection: HostConnection | undefined
let connectionFailed: string | undefined

/** 等待连接就绪的回调队列。 */
const waiters: Array<{ resolve: (value: HostConnection) => void; reject: (error: Error) => void }> = []

/** 供界面订阅状态变化的监听器。 */
const stateListeners = new Set<() => void>()

/** 读取当前连接。未就绪时为 undefined。 */
export function getConnection(): HostConnection | undefined {
  return connection
}

/** 读取连接失败原因。 */
export function getConnectionError(): string | undefined {
  return connectionFailed
}

/** 订阅连接状态变化。返回取消订阅函数。 */
export function onConnectionChange(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

/** 通知所有订阅者状态已变化。 */
function notifyChange(): void {
  for (const listener of stateListeners) {
    try {
      listener()
    } catch (error) {
      // 单个订阅者抛错不能拖垮状态广播，否则其余界面部分永久不更新。
      console.error('连接状态监听器抛错', error)
    }
  }
}

/** 由壳注入连接信息。壳通过事件把就绪信息送到页面。 */
export function setConnection(next: HostConnection): void {
  connection = next
  connectionFailed = undefined
  // 连接就绪后把等待队列一次性放行，并清空——之后来的人直接拿现成的连接。
  const pending = waiters.splice(0, waiters.length)
  for (const waiter of pending) waiter.resolve(next)
  notifyChange()
}

/** 标记连接失败。 */
export function setConnectionFailure(message: string): void {
  connectionFailed = message
  const pending = waiters.splice(0, waiters.length)
  for (const waiter of pending) waiter.reject(new Error(message))
  notifyChange()
}

/**
 * 开发态：从查询串里取连接信息。
 *
 * ## 为什么需要
 *
 * 正式运行时连接信息由 Tauri 壳通过 `host-ready` 事件注入。但在普通浏览器里
 * （`pnpm dev:web`，改样式更快）没有壳，也就永远拿不到令牌，界面只能停在
 * 「没能连接上后台服务」。这使得"在浏览器里看一眼"这件事做不到。
 *
 * ## 只在开发态生效
 *
 * `import.meta.env.DEV` 在生产构建里是常量 `false`，这段逻辑会被摇掉，
 * 装进包里的代码不含任何从 URL 取令牌的路径——令牌不会因为查询串
 * 而出现在日志、书签或分享链接里。
 *
 * 用法：`?host=http://127.0.0.1:9060&token=xxx`。
 */
export function adoptDevConnection(): void {
  if (!import.meta.env.DEV) return
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const url = params.get('host')
  const token = params.get('token')
  if (url === null || token === null) return
  setConnection({ url, token, port: Number(new URL(url).port) })
}

/**
 * 等待宿主就绪。
 *
 * @param timeoutMs 超时。默认 30 秒，覆盖宿主冷启动。
 * @returns 连接信息。
 * @throws 超时或宿主启动失败时抛出。
 */
export function waitForHost(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HostConnection> {
  if (connection !== undefined) return Promise.resolve(connection)
  if (connectionFailed !== undefined) return Promise.reject(new Error(connectionFailed))

  return new Promise<HostConnection>((resolve, reject) => {
    const timer = setTimeout(() => {
      // 超时后要把自己从队列里摘掉，否则一个已经放弃的等待者
      // 会在下次就绪时被 resolve，而它的调用方早已不关心结果。
      const index = waiters.findIndex((waiter) => waiter.resolve === wrappedResolve)
      if (index !== -1) waiters.splice(index, 1)
      reject(new Error('等待宿主就绪超时'))
    }, timeoutMs)

    const wrappedResolve = (value: HostConnection): void => {
      clearTimeout(timer)
      resolve(value)
    }
    const wrappedReject = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    waiters.push({ resolve: wrappedResolve, reject: wrappedReject })
  })
}

/**
 * 发一个请求。
 *
 * @param path 接口路径，以 `/api/` 开头。
 * @param options 请求选项。
 * @returns 已解析的响应体。
 * @throws {@link ApiError} 非 2xx 响应、超时或网络失败时抛出。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const ready = await waitForHost()
  const method = options.method ?? 'GET'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)

  try {
    const response = await fetch(`${ready.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ready.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })

    const text = await response.text()
    if (!response.ok) {
      // 宿主会把可读原因放在 JSON 的 error 字段，能取到就用它，
      // 取不到才退回状态码——用户看到"409"毫无意义，看到"会话不存在"才有用。
      throw new ApiError(response.status, extractErrorMessage(text) ?? `请求失败（${response.status}）`)
    }
    return (text === '' ? undefined : JSON.parse(text)) as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    // AbortError 与网络错误对用户的意义相同：没拿到数据。
    // 但原因要分清，否则排查时无法判断是超时还是宿主挂了。
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, `请求超时（${timeoutMs} 毫秒）`)
    }
    throw new ApiError(0, error instanceof Error ? error.message : '网络请求失败')
  } finally {
    clearTimeout(timer)
  }
}

/** 从错误响应体里提取可读消息。 */
function extractErrorMessage(text: string): string | undefined {
  if (text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const message = (parsed as Record<string, unknown>).error
      if (typeof message === 'string') return message
    }
  } catch {
    // 不是 JSON 就退回原文。宿主异常时可能返回 HTML 错误页。
  }
  return text.slice(0, 200)
}

/** 流式响应的一帧。 */
export interface StreamFrame {
  event: string
  data: unknown
}

/** 流式请求的选项。 */
export interface StreamOptions {
  /** 每一帧到达时调用。 */
  onFrame(frame: StreamFrame): void
  /** 调用方的取消信号。中止后连接关闭，宿主侧的生产也会随之停止。 */
  signal?: AbortSignal
}

/**
 * 发一个流式请求。
 *
 * ## 为什么不用 EventSource
 *
 * `EventSource` 更省事——它会自动重连、自动分帧。但它**无法自定义请求头**，
 * 而本地接口的唯一安全边界就是 `Authorization: Bearer <token>`。
 * 把令牌塞进查询串会让它出现在日志与历史里，比放进请求头差得多。
 *
 * 所以这里用 `fetch` 读响应流，自己切帧。SSE 的分帧规则只有
 * 「空行分隔帧、`event:` 取事件名、`data:` 取载荷」三条，手写足够。
 *
 * @param path 接口路径。
 * @param body 请求体。
 * @param options 帧回调与取消信号。
 */
export async function requestStream(
  path: string,
  body: unknown,
  options: StreamOptions,
): Promise<void> {
  const ready = await waitForHost()
  const response = await fetch(`${ready.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ready.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new ApiError(response.status, extractErrorMessage(text) ?? `请求失败（${response.status}）`)
  }
  if (response.body === null) throw new ApiError(0, '宿主没有返回数据')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 帧以空行分隔。用 `\n\n` 而不是逐行处理：一个 data 里可能含转义过的
      // 换行，逐行切会把一帧拆成两半。
      let at = buffer.indexOf('\n\n')
      while (at !== -1) {
        const block = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        at = buffer.indexOf('\n\n')

        let event = 'message'
        const dataLines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          // 规范允许多行 data，最终按换行拼接。
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
        }
        if (dataLines.length === 0) continue

        let data: unknown = dataLines.join('\n')
        try {
          data = JSON.parse(dataLines.join('\n'))
        } catch {
          // 不是 JSON 就原样给出，让调用方自己决定怎么处理。
        }
        options.onFrame({ event, data })
      }
    }
  } finally {
    // 主动释放：不释放的话连接会挂到 GC 才关闭，多次中断会积压连接。
    reader.releaseLock()
  }
}
