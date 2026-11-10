/**
 * Cordis 宿主的 HTTP 与事件通道。
 *
 * ## 这个模块存在的理由
 *
 * 前端（Tauri 的 WebView）需要向宿主取数据。两种可行做法：
 * 1. 前端 → Tauri 命令 → 壳转发 → 宿主。多一跳，且壳要为每个接口写一次转发代码。
 * 2. 前端 → 宿主本地 HTTP。前端直接说业务语言，壳只管开窗。
 *
 * 选 2。壳因此保持"只开窗、不管业务"，前端与宿主的接口演进不需要改 Rust。
 *
 * ## 安全边界
 *
 * 只监听 127.0.0.1，且启动时生成一次性令牌放在页面 URL 的 fragment 里。
 * fragment 不会发给服务器也不会进 Referer，因此令牌不会被日志或外链带走。
 * 每个请求校验 `Authorization: Bearer <token>`，防止同机其他进程冒充前端。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { ChannelWebServer } from './channel-server.js'

/**
 * 默认起始端口。
 *
 * 原先传 0 让系统随机分配，好处是永不冲突，坏处每次启动地址都变：
 * 调试时收藏的 `http://127.0.0.1:53xxx` 下次就失效，日志里的端口也
 * 无法用于事后核对。改成固定起点 + 占用顺延，兼顾"地址可预期"与
 * "同时开两个实例不炸"。
 */
export const DEFAULT_PORT = 9060

/** 从起始端口往后最多试几个。20 个够覆盖同时开几个实例的常见情况。 */
const PORT_SCAN_LIMIT = 20

/** 判断一个错误是不是"端口已被占用"。 */
function isPortInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EADDRINUSE'
}

/** 一条路由的处理函数。 */
export type RouteHandler = (request: RouteRequest) => Promise<RouteResponse> | RouteResponse

/** 路由请求。已解析好的查询串与请求体，处理函数不必再碰原始流。 */
export interface RouteRequest {
  /** 路径参数，按 `:name` 模式从路径中提取。 */
  params: Record<string, string>
  /** 查询串参数。同名多值时只保留最后一个。 */
  query: Record<string, string>
  /** 已解析的 JSON 请求体。非 JSON 或无请求体时为 undefined。 */
  body: unknown
}

/** 路由响应。 */
export interface RouteResponse {
  /** HTTP 状态码。 */
  status?: number
  /** 响应体，会被序列化为 JSON。 */
  body?: unknown
  /**
   * 流式响应。
   *
   * 存在时忽略 {@link RouteResponse.status} 与 {@link RouteResponse.body}：
   * 服务器先发送流式响应头，再把这个发射器交给处理函数，由它决定何时写、何时结束。
   *
   * ## 为什么用流而不是"先返回、再轮询"
   *
   * 模型输出是逐字到达的。若接口只返回最终结果，界面要么长时间空白，
   * 要么用轮询去猜"现在生成到哪了"——轮询既浪费又慢一步。
   * 流式响应让"模型说一个字、界面显示一个字"成为同一个动作。
   */
  stream?: (emit: StreamEmitter) => Promise<void> | void
}

/** 流式响应的帧发射器。 */
export interface StreamEmitter {
  /**
   * 发送一帧。
   *
   * @param event 事件名，前端据此分支。
   * @param data 载荷，会被序列化为 JSON。
   */
  send(event: string, data: unknown): void
  /** 结束流。调用后连接关闭，未发出的帧丢弃。 */
  close(): void
}

/** 启动参数。 */
export interface WebServerOptions {
  /**
   * 起始端口。默认 {@link DEFAULT_PORT}。
   *
   * 传 0 表示完全交给系统分配（随机端口）。
   * 传正数与 `maxPortAttempts` 配合时，会从该端口起逐个试到空位。
   */
  port?: number
  /** 监听地址。默认 127.0.0.1。 */
  host?: string
  /**
   * 从起始端口往后最多试几个端口。默认 {@link PORT_SCAN_LIMIT}。
   *
   * 只试一段而不无限递增：连续几十个端口都占着，说明这台机器上跑着
   * 别的东西，继续往后撞只会拖长启动时间，不如明确报错让人看见。
   */
  maxPortAttempts?: number
  /**
   * 通道回调注册表。
   *
   * 有它时，**未命中宿主令牌校验之前**先问它一次：命中就整条交给适配器。
   * 这是 8 条通道里 4 条回调式适配器唯一的入站入口，原因见
   * `channel-server.ts` 的文件头（外部服务器不可能带上我们的本地令牌）。
   */
  channels?: ChannelWebServer
}

/** 已启动的服务器。 */
export interface WebServer {
  /** 实际监听的端口。端口传 0 时必须从这里读真实值。 */
  port: number
  /** 协议，恒为 http（本地回环不需要 TLS，加 TLS 只会引入自签证书问题）。 */
  protocol: 'http'
  /** 访问令牌。前端必须在 Authorization 头里带上。 */
  token: string
  /** 关闭服务器。 */
  close(): Promise<void>
}

/**
 * 创建并启动服务器。
 *
 * @param routes 路由表，键形如 `GET /api/sessions/:id`。
 * @param options 启动参数。
 * @returns 已就绪的服务器信息。
 */
export async function startWebServer(
  routes: ReadonlyMap<string, RouteHandler>,
  options: WebServerOptions = {},
): Promise<WebServer> {
  const host = options.host ?? '127.0.0.1'
  const token = randomBytes(32).toString('base64url')

  const create = (): Server => createServer((request, response) => {
    void handle(request, response, routes, token, options.channels)
  })

  const { server, port } = await listenWithFallback(
    create,
    host,
    options.port ?? DEFAULT_PORT,
    options.maxPortAttempts ?? PORT_SCAN_LIMIT,
  )

  return {
    port,
    protocol: 'http',
    token,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { error === undefined ? resolve() : reject(error) })
      })
    },
  }
}

/**
 * 监听端口；被占用就往后顺延，直到找到空位。
 *
 * 为什么不是简单地传 0 给系统分配：那样端口每次启动都不同，
 * 调试地址、日志核对、以及"我知道它在 9060"这类肌肉记忆全部失效。
 * 固定起点 + 顺延则让绝大多数情况下端口是稳定的，同时保留多实例能力。
 *
 * 每次重试都用工厂新建一个服务器实例。Node 的 Server 在 `listen` 报错后会
 * 残留内部状态，拿同一个实例再 `listen` 一次行为没有文档保证——新建是最省
 * 心也最不容易在某个 Node 小版本上出岔子的做法。
 *
 * @param create 建服务器的工厂，每次重试调用一次
 * @param host 监听地址
 * @param start 起始端口
 * @param attempts 最多试几个
 */
async function listenWithFallback(
  create: () => Server,
  host: string,
  start: number,
  attempts: number,
): Promise<{ server: Server; port: number }> {
  // 传 0 时按随机端口处理，不扫描：调用方明确要了系统分配。
  if (start === 0) {
    const server = create()
    return { server, port: await listenOnce(server, host, 0) }
  }

  let lastError: unknown
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = start + offset
    const server = create()
    try {
      return { server, port: await listenOnce(server, host, candidate) }
    } catch (error) {
      if (!isPortInUse(error)) throw error
      lastError = error
      // 顺延只在"被别的进程占了"时发生。其他错误（权限不足、
      // 地址不可用）与端口号无关，继续试下去只会重复失败。
      if (offset < attempts - 1) {
        process.stderr.write(`[host] 端口 ${String(candidate)} 已被占用，顺延到 ${String(candidate + 1)}\n`)
      }
    }
  }

  throw new Error(
    `从 ${String(start)} 起的 ${String(attempts)} 个端口全部被占用，宿主无法启动。`
    + `请关闭占用这些端口的程序，或用 ONDRA_PORT 指定其他端口。`
    + `（最后一个错误：${lastError instanceof Error ? lastError.message : String(lastError)}）`,
  )
}

/** 在指定端口监听一次，返回实际端口。 */
async function listenOnce(server: Server, host: string, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: unknown): void => { reject(error) }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('服务器地址不可读'))
        return
      }
      resolve(address.port)
    })
  })
}

/** 处理单个请求。 */
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  routes: ReadonlyMap<string, RouteHandler>,
  token: string,
  channels: ChannelWebServer | undefined,
): Promise<void> {
  // CORS 必须在鉴权之前处理，原因见 applyCors 的注释。
  if (applyCors(request, response)) return

  /*
   * 通道回调先于令牌校验。
   *
   * 外部平台（飞书 / 钉钉 / 微信）不可能携带本机启动时随机生成的令牌，
   * 所以这 4 条回调路径必须绕开它，安全性由适配器自己的签名 / token 校验负责。
   *
   * ## 为什么必须在 `applyCors` 之后
   *
   * 预检请求不携带 authorization，也不该被当成回调处理。`applyCors`
   * 已经把 OPTIONS 就地答掉了，走到这里的一定是真实请求。
   *
   * ## 为什么未命中就先继续往下走
   *
   * `dispatch()` 返回 false 表示「这个路径不归通道管」，于是照常走宿主
   * 路由与令牌校验。**绝不**因为「装了通道插件」就把整个接口面放开。
   */
  if (channels !== undefined && channels.size > 0) {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (channels.match(pathname) !== undefined) {
      try {
        await channels.dispatch(request, response, pathname)
      } catch (error) {
        process.stderr.write(
          `[host] 通道回调处理失败（${pathname}）：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        )
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('channel-handler-failed')
        } else {
          response.end()
        }
      }
      return
    }
  }

  // 令牌校验放在最前：未授权请求不解析请求体，避免为攻击者做无用的解析工作。
  const auth = request.headers.authorization ?? ''
  if (auth !== `Bearer ${token}`) {
    sendJson(response, 401, { error: '未授权' })
    return
  }

  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  // 方法 + 路径精确匹配优先，其次是带参数的模式匹配。
  // 不用通配 `/api/*` 兜底：显式路由表能在编译期发现拼错的路由。
  let handler: RouteHandler | undefined
  let params: Record<string, string> = {}
  for (const [pattern, candidate] of routes) {
    const spaceAt = pattern.indexOf(' ')
    if (spaceAt === -1) continue
    if (pattern.slice(0, spaceAt) !== method) continue
    const matched = matchPath(pattern.slice(spaceAt + 1), url.pathname)
    if (matched !== undefined) {
      handler = candidate
      params = matched
      break
    }
  }

  if (handler === undefined) {
    sendJson(response, 404, { error: '路由不存在' })
    return
  }

  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams) query[key] = value

  let body: unknown
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readJsonBody(request)
    } catch (error) {
      // 请求体不是合法 JSON 属于调用方错误，回 400 而不是 500。
      sendJson(response, 400, { error: error instanceof Error ? error.message : '请求体无法解析' })
      return
    }
  }

  try {
    const result = await handler({ params, query, body })
    if (result.stream !== undefined) {
      await runStream(response, result.stream)
      return
    }
    sendJson(response, result.status ?? 200, result.body ?? null)
  } catch (error) {
    // 处理函数内的异常一律 500，且不把堆栈发给前端：堆栈含本机路径。
    process.stderr.write(`[host] 路由处理失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    // 流已经开始时不能再发 JSON 头（响应头已经发出去了），只能结束连接。
    if (response.headersSent) {
      response.end()
      return
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : '内部错误' })
  }
}

/**
 * 以 SSE 形式执行一个流式响应。
 *
 * ## 为什么选 SSE 而不是 WebSocket
 *
 * 这一路数据是**单向**的（宿主 → 界面），WebSocket 的双向能力用不上，
 * 却要额外处理握手、心跳、重连三条逻辑，还要在 CSP 里放行 `ws://`。
 * SSE 就是一个不结束的 `text/event-stream` 响应，浏览器原生按帧切分，
 * 断开后 `EventSource` 还会自动重连。
 *
 * 这里不用 `EventSource` 的自动重连而是自己控制：因为令牌要放在请求头里，
 * 而 `EventSource` 无法自定义请求头。改用 `fetch` + `ReadableStream` 读帧，
 * 格式仍然是标准 SSE。
 */
async function runStream(
  response: ServerResponse,
  produce: (emit: StreamEmitter) => Promise<void> | void,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // no-store 与 no-cache 都要：前者挡缓存保存，后者挡中间层复用。
    'cache-control': 'no-store, no-cache, must-revalidate',
    connection: 'keep-alive',
    // 关掉 nginx 一类反向代理的缓冲（本地没有，但语义上必须声明）。
    'x-accel-buffering': 'no',
  })

  let closed = false
  const emitter: StreamEmitter = {
    send(event: string, data: unknown): void {
      if (closed) return
      // SSE 的帧格式固定为「event: 名字\n data: 载荷\n\n」。
      // 载荷里的换行必须转义，否则一个含换行的字符串会被前端当成两帧。
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close(): void {
      if (closed) return
      closed = true
      response.end()
    },
  }

  // 客户端断开（用户切走页面、关窗口）时要立刻停止生产，
  // 否则推理会继续跑完、写完整个会话才结束，白白花掉额度。
  response.on('close', () => {
    closed = true
  })

  try {
    await produce(emitter)
  } catch (error) {
    // 流已经开始，无法改状态码。用一条 error 帧把原因送到前端。
    emitter.send('error', { message: error instanceof Error ? error.message : '未知错误' })
  } finally {
    emitter.close()
  }
}

/**
 * 匹配路径模式。
 *
 * @param pattern 形如 `/api/sessions/:id` 的模式。
 * @param pathname 实际路径。
 * @returns 匹配到时返回提取的参数，否则 undefined。
 */
function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/').filter((part) => part !== '')
  const pathParts = pathname.split('/').filter((part) => part !== '')
  if (patternParts.length !== pathParts.length) return undefined

  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index] ?? ''
    const pathPart = pathParts[index] ?? ''
    if (patternPart.startsWith(':')) {
      // 参数值必须解码：路径里的中文与空格会被百分号编码，
      // 不解码会让下游拿到 `%E4%BC%9A%E8%AF%9D` 这样的字符串当 id 用。
      params[patternPart.slice(1)] = decodeURIComponent(pathPart)
    } else if (patternPart !== pathPart) {
      return undefined
    }
  }
  return params
}

/**
 * 处理跨源请求。返回 true 表示这个请求已经被处理完，调用方应立即返回。
 *
 * ## 为什么本地接口也需要 CORS
 *
 * 宿主只监听 `127.0.0.1`，看起来"同机就是同源"——但这个假设是错的。
 * 打包后的页面来源是 `tauri://localhost`（macOS/Linux）或
 * `http://tauri.localhost`（Windows），而接口在 `http://127.0.0.1:9060`。
 * 协议加主机都不同，浏览器一律按**跨源**处理：
 *
 * - `POST` 且带 `content-type: application/json` 与 `authorization`，
 *   两个都不是 CORS 安全列表里的值 → 浏览器先发 `OPTIONS` 预检。
 * - 预检不过，真正的请求根本不会发出，`fetch` 直接抛
 *   `TypeError: Load failed`（WebKit 的措辞）。
 *
 * 这个错误特别容易误判成"宿主没起来"，因为界面上只看到加载失败，
 * 而宿主的日志里连一条记录都没有——预检被浏览器拦在了本地，
 * 请求压根没发出去。
 *
 * ## 为什么放行任意来源也不会削弱安全
 *
 * 这道接口的访问控制不靠源，靠 `Authorization: Bearer <token>`：
 * 令牌是启动时随机生成的 32 字节，只交给壳，壳再注入页面。
 * 别的网页即使能从 `http://127.0.0.1:9060` 拿到响应，也拿不到令牌；
 * 而带上 `authorization` 头就会触发预检，预检之后仍然要过令牌校验。
 *
 * 反过来，如果这里按来源做白名单，就得枚举
 * `tauri://localhost`、`http://tauri.localhost`、`http://localhost:5173`
 * 等一堆开发态/安装态的组合，任何一端换域名都会静默失效——
 * 换来的安全性提升是零（令牌那关没变），维护成本却是持续的。
 */
function applyCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin

  // 只对带 Origin 的跨源请求回 CORS 头。同源请求（比如 curl 或壳内部调用）
  // 没有 Origin，回一堆 Allow-* 没有意义，还会让响应看起来像配置错了。
  if (origin !== undefined) {
    response.setHeader('access-control-allow-origin', origin)
    // 带上这个头，响应才能被缓存按源区分。没有它某些代理会把 A 源的
    // 响应喂给 B 源。
    response.setHeader('vary', 'origin')
    // 允许令牌头，否则前端带 authorization 的那个请求过不了预检。
    response.setHeader('access-control-allow-headers', 'authorization, content-type')
    response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    // 预检结果缓存 10 分钟：每个请求都预检一次会让首次交互明显变慢，
    // 而本地场景下来源不会变，缓存是安全的。
    response.setHeader('access-control-max-age', '600')
  }

  // 预检请求到此为止：它只是问"能不能发"，不该进入鉴权与路由。
  // 注意这里**必须回 204 而不是 401**——预检请求按规范不携带
  // authorization 头（浏览器只在真正的请求里带），
  // 用鉴权拦预检会让所有跨源请求永久失败。
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return true
  }

  return false
}

/** 读取并解析 JSON 请求体。 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return undefined
  return JSON.parse(raw)
}

/** 发送 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // 本地接口不应被任何缓存保存：令牌与会话数据混在缓存里会泄漏。
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}
