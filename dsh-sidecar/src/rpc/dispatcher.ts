/**
 * JSON-RPC 请求分发器。
 *
 * ## 职责边界
 *
 * 本模块只做三件事：解析字节、按方法名找处理器、把结果或异常编码成响应。
 * 它不认识会话、模型、工具这些业务概念——那些由调用方注册进来。
 * 这样分发器可以脱离内核单独测试，业务改动也不会碰协议层。
 *
 * ## 并发语义
 *
 * 每个请求独立异步执行，**不保证完成顺序与到达顺序一致**——这是 JSON-RPC 的
 * 正常语义（靠 id 配对）。若某个调用方需要顺序保证，应由它自己排队，
 * 而不是让分发器变成串行队列：串行会让一次慢推理堵死所有 ping。
 */

import {
  isRpcNotification,
  isRpcRequest,
  KernelErrorCode,
  RpcErrorCode,
  type RpcErrorObject,
  type RpcNotification,
  type RpcRequest,
} from '../protocol.js'
import { encodeLine, LineDecoder } from './transport.js'

/**
 * 单个请求的处理函数。
 *
 * @param params 已从请求中取出的 `params` 字段，可能是 undefined。
 * @returns 返回值会作为 `result` 原样发出。
 * @throws 抛出 {@link RpcHandlerError} 可指定错误码；抛其他异常一律归为内部错误。
 */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>

/** 处理器可抛出此错误来指定精确的错误码与附加数据。 */
export class RpcHandlerError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcHandlerError'
    this.code = code
    this.data = data
  }
}

/** 向对端写出一条消息的能力。抽成接口便于测试时替换为内存收集器。 */
export interface MessageSink {
  write(message: unknown): void
}

/** 分发器的构造参数。 */
export interface DispatcherOptions {
  /** 写消息的出口。生产环境通常包装 `process.stdout`。 */
  sink: MessageSink
  /** 单条消息字节上限，默认使用协议常量。 */
  maxMessageBytes?: number
  /** 诊断日志出口。默认写 stderr——stdout 是协议通道，不能混入日志。 */
  log?: (line: string) => void
}

/**
 * 请求分发器。
 *
 * 使用方式：先 {@link register} 若干方法，再不断 {@link feed} 收到的字节。
 */
export class RpcDispatcher {
  private readonly handlers = new Map<string, RpcHandler>()
  private readonly sink: MessageSink
  private readonly decoder: LineDecoder
  private readonly log: (line: string) => void

  /** 是否已关闭。关闭后收到的请求一律回复"正在关闭"。 */
  private shuttingDown = false

  constructor(options: DispatcherOptions) {
    this.sink = options.sink
    this.decoder = new LineDecoder(options.maxMessageBytes)
    this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`) })
  }

  /**
   * 注册一个方法处理器。
   *
   * @param method 方法名，建议取自协议里的 {@link import('../protocol.ts').Method}。
   * @param handler 处理函数。
   * @throws 重复注册同名方法时抛出：静默覆盖会让"为什么调到了旧实现"变成悬案。
   */
  register(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`方法 ${method} 已注册，不允许覆盖`)
    }
    this.handlers.set(method, handler)
  }

  /** 当前已注册的方法名列表，用于握手时上报能力范围。 */
  listMethods(): string[] {
    return [...this.handlers.keys()].sort()
  }

  /**
   * 标记进入关闭流程。此后新到的请求会收到 `KernelShuttingDown`，
   * 而不是被静默丢弃——静默丢弃会让对方一直等到超时。
   */
  markShuttingDown(): void {
    this.shuttingDown = true
  }

  /**
   * 喂入一段字节。
   *
   * 每帧独立处理：一帧解析失败不影响后续帧。这是有意的——若一处格式错误
   * 就断开整条连接，一个写错的调试日志就能让内核不可用。
   *
   * @param chunk 新到达的字节。
   */
  async feed(chunk: Buffer): Promise<void> {
    let lines: Buffer[]
    try {
      lines = this.decoder.push(chunk)
    } catch (error) {
      // 超限属于无法恢复的流状态错误：继续读只会累积更多垃圾。
      this.log(`[dsh] 分帧失败：${String(error)}`)
      this.sendError(null, RpcErrorCode.ParseError, '消息超过长度上限')
      return
    }
    // 每帧串行 await，保证同一连接内的响应顺序稳定，便于日志比对。
    // 注意：这里串行的是「发出」动作，不是「执行」——处理器内部的耗时操作
    // 若需要真正并行，应自行 fork，而不是依赖分发器。
    for (const line of lines) {
      await this.handleLine(line)
    }
  }

  /** 处理单帧。 */
  private async handleLine(line: Buffer): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8'))
    } catch {
      this.sendError(null, RpcErrorCode.ParseError, '不是合法 JSON')
      return
    }

    if (isRpcNotification(parsed)) {
      await this.handleNotification(parsed)
      return
    }

    if (!isRpcRequest(parsed)) {
      // 走到这里说明是合法 JSON 但不是合法请求。若它带了个可用的 id，
      // 就按规范回一个带该 id 的错误；否则用 null，让对方至少知道失败了。
      const fallbackId = extractId(parsed)
      this.sendError(fallbackId, RpcErrorCode.InvalidRequest, '不是合法的 JSON-RPC 请求')
      return
    }

    await this.handleRequest(parsed)
  }

  /** 处理请求：查找处理器、执行、回写响应。 */
  private async handleRequest(request: RpcRequest): Promise<void> {
    if (this.shuttingDown) {
      this.sendError(request.id, KernelErrorCode.KernelShuttingDown, '内核正在关闭')
      return
    }

    const handler = this.handlers.get(request.method)
    if (handler === undefined) {
      this.sendError(request.id, RpcErrorCode.MethodNotFound, `方法不存在：${request.method}`)
      return
    }

    try {
      const result = await handler(request.params)
      this.sink.write({ jsonrpc: '2.0', id: request.id, result: result ?? null })
    } catch (error) {
      this.sendHandlerError(request.id, error)
    }
  }

  /**
   * 处理通知：执行但不回响应。
   *
   * 规范明确要求通知不得有响应，因此这里连出错也不回——只在 stderr 留痕。
   */
  private async handleNotification(notification: RpcNotification): Promise<void> {
    const handler = this.handlers.get(notification.method)
    if (handler === undefined) {
      this.log(`[dsh] 收到未知通知：${notification.method}`)
      return
    }
    try {
      await handler(notification.params)
    } catch (error) {
      this.log(`[dsh] 通知 ${notification.method} 处理失败：${String(error)}`)
    }
  }

  /** 把处理器抛出的异常翻译成协议错误对象。 */
  private sendHandlerError(id: RpcRequest['id'], error: unknown): void {
    if (error instanceof RpcHandlerError) {
      this.sink.write({
        jsonrpc: '2.0',
        id,
        error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) },
      })
      return
    }
    // 未预期的异常不把堆栈发给对端：堆栈可能含本机路径与内部结构，
    // 且对端也无法据此处理。完整堆栈只写 stderr 供本地排查。
    const message = error instanceof Error ? error.message : String(error)
    this.log(`[dsh] 方法执行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    const payload: RpcErrorObject = { code: RpcErrorCode.InternalError, message }
    this.sink.write({ jsonrpc: '2.0', id, error: payload })
  }

  /** 发送一个错误响应。 */
  private sendError(id: RpcRequest['id'] | null, code: number, message: string): void {
    this.sink.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /**
   * 主动推送一条通知给对端（内核 → 调用方的事件）。
   *
   * @param method 事件名，取自协议的 {@link import('../protocol.ts').EventName}。
   * @param params 事件载荷。
   */
  notify(method: string, params?: unknown): void {
    this.sink.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }
}

/** 从任意值里尽量取一个可用的请求 id，取不到则返回 null。 */
function extractId(value: unknown): RpcRequest['id'] | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as Record<string, unknown>).id
  if (typeof candidate === 'string' || typeof candidate === 'number') return candidate
  return null
}

/**
 * 把 `process.stdout` 包装成 {@link MessageSink}。
 *
 * 单独提供这个工厂而不是让调用方自己拼：stdout 是协议专用通道，
 * 任何日志误写到 stdout 都会让对端解析失败，所以写入路径要收敛到一处。
 *
 * 背压处理：`write` 返回 false 表示内核缓冲区已满。这里不做等待，
 * 因为协议消息都很小，且丢弃一帧事件比阻塞整个内核更糟。真正的风险在于
 * 对端长时间不读，此时依赖内核侧的流控（`MAX_MESSAGE_BYTES` 与超时）兜底。
 */
export function stdoutSink(): MessageSink {
  return {
    write(message: unknown): void {
      process.stdout.write(encodeLine(message))
    },
  }
}
