/**
 * 内核客户端：管理 dsh 子进程的生命周期，并把 JSON-RPC 请求转发给它。
 *
 * ## 这个插件为什么叫 dsh-client 而不是 dsh-bridge
 *
 * "bridge"容易被理解为双向翻译层（把 A 协议翻成 B 协议）。这里不做翻译：
 * 宿主内部与内核之间**说的是同一套 JSON-RPC**，本插件只负责进程管理与
 * 请求配对，不做语义转换。名字叫 client 更准确。
 *
 * ## 生命周期
 *
 * `start()` → 子进程就绪 → `handshake()` → 可用 → `stop()`。
 * 任何一步失败都进入 failed 状态，并且在 `stop()` 前不再自动重启：
 * 自动重启会掩盖"内核崩溃是因为配置写错了"这类问题，让排查变难。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  KernelErrorCode,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type HandshakeResult,
  type RequestId,
  type RpcErrorObject,
} from '@ondra/dsh-sidecar/protocol'
import type { EventNameValue } from '@ondra/dsh-sidecar/protocol'

/** 内核子进程的启动参数。 */
export interface DshClientOptions {
  /** Node 可执行文件路径。默认用当前进程的 `process.execPath`。 */
  nodePath?: string
  /** 内核入口脚本的绝对路径。 */
  entryPath: string
  /** 子进程工作目录。 */
  cwd?: string
  /** 单次请求的默认超时，毫秒。默认 30 秒。 */
  requestTimeoutMs?: number
  /** 握手超时，毫秒。默认 10 秒——启动慢于此值说明环境有问题。 */
  handshakeTimeoutMs?: number
}

/** 内核发来的事件。 */
export interface KernelEvent {
  method: EventNameValue | string
  params: unknown
}

/** 事件监听器。 */
export type KernelEventListener = (event: KernelEvent) => void

/** 内核连接状态。 */
export type DshClientState = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'

/**
 * 内核客户端。
 *
 * 每个实例对应一个内核子进程。不要共享实例给多个宿主实例——
 * 一个子进程只有一条 stdin/stdout，无法被多方安全复用。
 */
export class DshClient {
  /**
   * 已归一化的配置。`nodePath` 与 `cwd` 在构造时就填好默认值/去掉 undefined，
   * 让下游读取时不必再做可选性判断——可选字段散落使用时，每一次调用点都要
   * 重新收窄，pool 里漏一处就是运行期 `undefined` 传给 spawn。
   */
  private readonly options: {
    nodePath: string
    entryPath: string
    requestTimeoutMs: number
    handshakeTimeoutMs: number
    cwd: string | undefined
  }

  private child: ChildProcessWithoutNullStreams | undefined
  private state: DshClientState = 'idle'

  /** 等待响应的请求，按 id 索引。 */
  private readonly pending = new Map<RequestId, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  /** 下一次请求使用的 id。单调递增，回绕时不复用仍在等待的 id。 */
  private nextId = 1

  private readonly listeners = new Set<KernelEventListener>()

  constructor(options: DshClientOptions) {
    this.options = {
      // 默认用当前可执行文件：桌面应用已内置 Node 运行时，
      // 依赖用户机器上恰好装了 node 是不可接受的。
      nodePath: options.nodePath ?? process.execPath,
      entryPath: options.entryPath,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      cwd: options.cwd,
    }
  }

  /** 当前状态。 */
  getState(): DshClientState {
    return this.state
  }

  /**
   * 启动内核子进程并完成握手。
   *
   * @returns 握手结果，含内核支持的方法列表。
   * @throws 进程启动失败、握手超时或版本不兼容时抛出。
   */
  async start(): Promise<HandshakeResult> {
    if (this.state === 'ready') throw new Error('内核已在运行')
    if (this.state === 'starting') throw new Error('内核正在启动中')
    this.state = 'starting'

    // 先落一个局部引用再赋给字段：`this.child` 是可选字段，
    // 直接链式调用会让类型系统认为中间可能被置空（实际不会，但收窄更稳）。
    const spawned = spawn(this.options.nodePath, [this.options.entryPath], {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 上用 shell 会引入额外的 cmd.exe 进程，导致 kill 只杀掉 shell
      // 而留下内核；这里显式关闭。
      shell: false,
    })
    this.child = spawned

    spawned.on('error', (error) => { this.fail(`内核进程启动失败：${error.message}`) })
    spawned.on('exit', (code, signal) => {
      if (this.state === 'stopped') return
      this.fail(`内核进程退出（code=${String(code)}, signal=${String(signal)}）`)
    })

    // stderr 是诊断通道，逐行转发到宿主日志。
    // 不用 readline 直接 pipe 到 process.stderr：要让日志带上内核前缀，
    // 才能在混合日志里区分来源。
    spawned.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') process.stderr.write(`[dsh] ${line}\n`)
      }
    })

    this.readLoop()

    const result = await this.handshake()
    this.state = 'ready'
    return result
  }

  /**
   * 停止内核。
   *
   * 先请求优雅关闭，超时后强制结束。顺序不能反：
   * 直接 SIGKILL 会让内核没机会刷写会话数据。
   */
  async stop(): Promise<void> {
    if (this.child === undefined) { this.state = 'stopped'; return }
    const child = this.child
    this.state = 'stopped'

    // 先礼后兵：请求关闭，给 2 秒收尾，再强制终止。
    try {
      await Promise.race([
        this.call('kernel.shutdown', undefined, 2_000),
        new Promise((resolve) => { setTimeout(resolve, 2_000) }),
      ])
    } catch {
      // 内核可能已经死了，忽略。
    }

    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })

    this.rejectAll(new Error('内核已停止'))
    this.child = undefined
  }

  /**
   * 调用一个内核方法。
   *
   * @param method 方法名。
   * @param params 参数。
   * @param timeoutMs 覆盖默认超时。
   * @returns 内核返回的 `result`。
   * @throws 内核返回错误、超时或进程已停止时抛出。
   */
  async call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const child = this.child
    if (child === undefined || !child.stdin.writable) {
      throw new Error('内核未运行')
    }

    const id = this.nextId++
    const timeout = timeoutMs ?? this.options.requestTimeoutMs

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`内核请求超时：${method}（${String(timeout)} ms）`))
      }, timeout)

      this.pending.set(id, { resolve, reject, timer })

      // 这里是唯一写入点，格式必须与内核侧 LineDecoder 的期望完全一致。
      // 回调参数在 Node 类型里是可选的，用 `!= null` 同时挡住 undefined 与 null。
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error != null) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new Error(`写入内核失败：${error.message}`))
        }
      })
    })
  }

  /** 订阅内核主动推送的事件。返回取消订阅函数。 */
  onEvent(listener: KernelEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 握手：确认协议版本，取得能力清单。 */
  private async handshake(): Promise<HandshakeResult> {
    const raw = await this.call('kernel.handshake', {
      protocolVersion: PROTOCOL_VERSION,
      client: 'host',
      clientVersion: '2.0.1',
    }, this.options.handshakeTimeoutMs)
    // 内核的返回也是外部输入，逐字段校验后再断言类型。
    if (!isHandshakeResult(raw)) {
      throw new Error('内核返回了无法识别的握手结果')
    }
    return raw
  }

  /** 逐行读取内核输出并分发。 */
  private readLoop(): void {
    const child = this.child
    if (child === undefined) return
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line: string) => {
      if (line.trim() === '') return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        process.stderr.write(`[dsh-client] 内核输出不是合法 JSON：${line.slice(0, 200)}\n`)
        return
      }
      this.handleMessage(parsed)
    })
  }

  /** 处理一条来自内核的消息：响应或事件。 */
  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const record = message as Record<string, unknown>

    // 有 id 且有 result/error → 是响应，配对给等待方。
    if ('id' in record && (record.id === null || typeof record.id === 'string' || typeof record.id === 'number')
      && ('result' in record || 'error' in record)) {
      const id = record.id
      if (id === null) return
      const waiter = this.pending.get(id)
      if (waiter === undefined) return
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      if ('error' in record && isRpcErrorObject(record.error)) {
        waiter.reject(toError(record.error))
      } else {
        waiter.resolve(record.result)
      }
      return
    }

    // 无 id 且有 method → 是事件。
    if (!('id' in record) && typeof record.method === 'string') {
      const event: KernelEvent = { method: record.method, params: record.params }
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch (error) {
          // 单个监听器抛错不能拖垮整个读取循环，否则其余订阅者永久失聪。
          process.stderr.write(`[dsh-client] 事件监听器抛错：${String(error)}\n`)
        }
      }
      return
    }

    // 其余形态既不合法也不可配对，留痕即可。
    process.stderr.write(`[dsh-client] 无法识别的内核消息：${JSON.stringify(message).slice(0, 200)}\n`)
  }

  /** 进入失败状态并拒绝所有等待中的请求。 */
  private fail(reason: string): void {
    if (this.state === 'stopped') return
    this.state = 'failed'
    process.stderr.write(`[dsh-client] ${reason}\n`)
    this.rejectAll(new Error(reason))
  }

  /** 拒绝全部等待中的请求。 */
  private rejectAll(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

/** 校验握手结果结构。 */
function isHandshakeResult(value: unknown): value is HandshakeResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.protocolVersion === 'string'
    && record.kernel === 'dsh'
    && typeof record.version === 'string'
    && Array.isArray(record.methods)
    && typeof record.ready === 'boolean'
}

/** 校验错误对象结构。 */
function isRpcErrorObject(value: unknown): value is RpcErrorObject {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.code === 'number' && typeof record.message === 'string'
}

/**
 * 把协议错误转成 Error。
 *
 * 错误码附加在 message 前缀之外单独挂在 `code` 属性上，
 * 让上层既能直接展示文案，也能据此分支（例如协议不兼容时提示升级）。
 */
function toError(error: RpcErrorObject): Error {
  const wrapped = new Error(error.message) as Error & { code?: number }
  wrapped.code = error.code
  return wrapped
}

/** 供上层判断错误是否为"协议不兼容"。 */
export function isProtocolMismatch(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: number }).code === KernelErrorCode.ProtocolMismatch
}

/** 供上层判断错误是否为"内核未就绪，可重试"。 */
export function isNotReady(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: number }).code === KernelErrorCode.KernelNotReady
}

/** 供上层判断错误是否为参数错误。 */
export function isInvalidParams(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: number }).code === RpcErrorCode.InvalidParams
}
