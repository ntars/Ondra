/**
 * 选路、超时、重试、降级 —— 本插件唯一有状态的部分。
 *
 * 三条顺序纪律，写在这里防后人改回去：
 *
 * 1. **先重试，再换来源。** 同一条来源的抖动（限流、瞬时 5xx）先自己扛；
 *    一失败就换来源会让「在线 API 偶发限流」变成「悄悄切到本地模型」，
 *    而用户只会觉得「她今天说话变笨了」，永远查不到原因。
 * 2. **首块之后一律不重试、不换来源。** 已经吐出去的字收不回来，
 *    重放会让用户看到两遍开头——流式场景下这是最难查的重复文本来源。
 * 3. **显式指定来源时不做任何降级。** 用户点名了就不该偷偷换。
 */

import type { Config } from './settings.js'
import { GatewayError } from './types.js'
import type {
  CredentialLike,
  FinishLike,
  GatewayCallOptions,
  GatewayChunk,
  GatewayFailureCode,
  GatewayRequest,
  GatewayTrace,
  GatewayUsage,
  LlmRuntimeLike,
  LogLike,
  SourceSpec,
  SourceState,
} from './types.js'

/** 统计上报口。实现放 `service.ts`，本文件只上报不存储。 */
export interface GatewayMetrics {
  /** 一次尝试开始。 */
  attempt(sourceId: string): void
  /** 一次尝试失败。 */
  failure(sourceId: string, code: string): void
  /** 一次尝试成功。 */
  success(sourceId: string): void
  /** 发生一次跨来源降级。 */
  fallback(): void
  /** 因凭据缺失跳过一条来源。 */
  credentialSkip(): void
  /** 记一次用量。 */
  usage(sourceId: string, usage: GatewayUsage): void
  /** 记一次端到端耗时。 */
  latency(sourceId: string, ms: number): void
  /** 记一次网关层失败码。 */
  fail(code: GatewayFailureCode): void
}

/** 构造一次调用所需的全部依赖。**每次 `stream()` 新建一个**，避免跨调用串状态。 */
export interface RunnerInput {
  /** 上游 LLM 服务（已确认在位）。 */
  readonly runtime: LlmRuntimeLike
  /** 配置。 */
  readonly settings: Config
  /** 来源状态（已按优先级排序）。 */
  readonly states: readonly SourceState[]
  /** 取凭据服务；缺席返回 `undefined`。 */
  readonly credentials: () => CredentialLike | undefined
  /** 统计上报口。 */
  readonly metrics: GatewayMetrics
  /** 日志。 */
  readonly log: LogLike
  /** 时钟（便于将来替换成 O-003 的时钟服务）。 */
  readonly now: () => number
}

/** 单次尝试的共享状态：让「有没有吐过字」这件事能被外层看见。 */
interface AttemptState {
  emitted: number
}

/** 定时器句柄。浏览器与 Worker 里是数字，所以用 `unknown` 收。 */
function unref(handle: unknown): void {
  const candidate = handle as { unref?: () => void } | undefined
  // 不直接调：数字句柄上调用会抛，探测一次再决定。
  if (candidate !== undefined && typeof candidate.unref === 'function') candidate.unref()
}

/** 取一个未知值的消息文本。 */
function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return String(value)
  } catch {
    return '未知错误'
  }
}

/**
 * 取上游机器码。
 *
 * 只读自有数据属性，不触发 getter：某些 SDK 的错误对象上 `code` 是访问器，
 * 读它可能抛，而这段代码跑在错误处理路径上——再抛一次就没人接得住了。
 */
function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'code')
    if (descriptor === undefined || !('value' in descriptor)) return undefined
    return typeof descriptor.value === 'string' && descriptor.value !== '' ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/** 夹一个整数。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export class Runner {
  private readonly input: RunnerInput

  constructor(input: RunnerInput) {
    this.input = input
  }

  /**
   * 流式调用。失败抛 `GatewayError`。
   * @param request 请求。
   * @param trace 可选回填对象。
   */
  async *stream(request: GatewayRequest, trace?: GatewayTrace): AsyncIterable<GatewayChunk> {
    if (request.messages.length === 0) {
      throw new GatewayError('bad-request', '请求里没有任何消息，网关不发空请求')
    }
    const chain = this.chainOf(request)
    if (chain.length === 0) {
      throw new GatewayError('no-source', '没有配置任何模型来源，网关无处可去')
    }
    let totalAttempts = 0
    let lastError: GatewayError | undefined
    for (let index = 0; index < chain.length; index += 1) {
      const state = chain[index]
      const spec = state.spec
      if (!state.available) {
        // 不可用的来源不当失败上报，只记一条 warn：它不是「坏了」，是「没装」。
        this.input.log.warn('跳过来源 %s：%s', spec.id, state.detail ?? state.reason ?? '不可用')
        lastError = new GatewayError(state.reason ?? 'no-source', state.detail ?? `来源 ${spec.id} 不可用`, {
          sourceId: spec.id,
        })
        continue
      }
      const credentialReady = await this.credentialCheck(spec)
      if (!credentialReady) {
        lastError = new GatewayError('credential-missing', `来源 ${spec.id} 的凭据解析不到`, { sourceId: spec.id })
        continue
      }
      const maxAttempts = clamp(
        request.maxAttempts ?? spec.maxAttempts ?? this.input.settings.maxAttempts,
        1,
        5,
      )
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        totalAttempts += 1
        this.input.metrics.attempt(spec.id)
        const attemptState: AttemptState = { emitted: 0 }
        let finishKind: string | undefined
        try {
          for await (const chunk of this.attempt(spec, request, attemptState)) {
            if (chunk.type === 'finish') finishKind = chunk.reason.kind
            if (trace !== undefined && trace.sourceId === undefined) trace.sourceId = spec.id
            yield chunk
          }
          this.input.metrics.success(spec.id)
          if (trace !== undefined) {
            trace.attempts = totalAttempts
            trace.finishKind = finishKind ?? 'stop'
          }
          return
        } catch (error) {
          const failure = error instanceof GatewayError
            ? error
            : new GatewayError('upstream-error', messageOf(error), { sourceId: spec.id })
          failure.attempts = totalAttempts
          if (failure.code === 'aborted') {
            // 调用方取消：**既不能重试，也不能换来源**。
            // 换来源会变成「用户按了停止，网关却继续在另一条链路上烧钱」——
            // 而且那条链路的输出已经没人接收了。
            this.input.metrics.failure(spec.id, failure.code)
            this.input.metrics.fail(failure.code)
            throw failure
          }
          if (failure.partial) {
            // 已经吐过字：立刻收手，重试与降级都被禁止（见文件头第 2 条）。
            this.input.metrics.failure(spec.id, failure.upstreamCode ?? failure.code)
            this.input.metrics.fail(failure.code)
            this.input.log.error('来源 %s 在已下发内容后失败（%s），不再重试：%s', spec.id, failure.upstreamCode ?? failure.code, failure.message)
            throw failure
          }
          this.input.metrics.failure(spec.id, failure.upstreamCode ?? failure.code)
          if (this.isRetryable(failure) && attempt < maxAttempts) {
            const delay = this.backoffFor(attempt)
            this.input.log.warn(
              '来源 %s 第 %d/%d 次尝试失败（%s），%dms 后重试',
              spec.id,
              attempt,
              maxAttempts,
              failure.upstreamCode ?? failure.code,
              delay,
            )
            try {
              await this.sleep(delay, request.signal)
            } catch (waitError) {
              // 退避期间被取消：与上面同理，收手。
              this.input.metrics.fail('aborted')
              throw waitError
            }
            continue
          }
          lastError = failure
          break
        }
      }
      // 走到这里说明这条来源用尽了。还有下一条就降级。
      if (index < chain.length - 1) {
        this.input.metrics.fallback()
        this.input.log.warn('来源 %s 用尽，降级到下一条来源', spec.id)
      }
    }
    const finalError = lastError ?? new GatewayError('no-source', '所有来源都不可用')
    this.input.metrics.fail(finalError.code)
    throw finalError
  }

  /**
   * 单次尝试：发请求、卡超时、转发块。
   * @param spec 来源。
   * @param request 请求。
   * @param state 共享状态（记录已下发块数）。
   */
  private async *attempt(
    spec: SourceSpec,
    request: GatewayRequest,
    state: AttemptState,
  ): AsyncIterable<GatewayChunk> {
    const firstMs = request.timeoutMs ?? spec.timeoutMs ?? this.input.settings.timeoutMs
    const idleMs = request.idleTimeoutMs ?? spec.idleTimeoutMs ?? this.input.settings.idleTimeoutMs
    const external = request.signal
    if (external !== undefined && external.aborted) {
      throw new GatewayError('aborted', '调用方已取消，本次尝试未发出', { sourceId: spec.id })
    }
    const controller = new AbortController()
    const startedAt = this.input.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timeoutCode: GatewayFailureCode | undefined
    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }
    const arm = (ms: number, code: GatewayFailureCode): void => {
      clearTimer()
      timer = setTimeout(() => {
        timeoutCode = code
        controller.abort()
      }, ms)
      unref(timer)
    }
    const onAbort = (): void => {
      controller.abort()
    }
    if (external !== undefined) external.addEventListener('abort', onAbort)
    arm(firstMs, 'first-chunk-timeout')
    try {
      const iterable = this.input.runtime.stream(this.callOptionsOf(spec, request, controller.signal))
      let pendingUsage: GatewayUsage | undefined
      let pendingFinish: Extract<GatewayChunk, { type: 'finish' }> | undefined
      for await (const chunk of iterable) {
        if (chunk.type === 'usage') {
          // 用量先扣着：首块前失败时不该记账，否则「没花出去的钱」也会进报表。
          pendingUsage = chunk.usage
          continue
        }
        if (chunk.type === 'finish') {
          pendingFinish = chunk
          break
        }
        arm(idleMs, 'idle-timeout')
        state.emitted += 1
        yield chunk
      }
      clearTimer()
      // 上游在流内报错，且此时一个字都没吐过 → 当成可重试失败。
      // 这条判断是「首块前重试」与「首块后不重试」之间唯一的分界线。
      if (pendingFinish !== undefined && pendingFinish.reason.kind === 'error' && state.emitted === 0) {
        throw this.upstreamErrorOf(pendingFinish.reason, spec.id)
      }
      if (pendingUsage !== undefined) {
        this.input.metrics.usage(spec.id, pendingUsage)
        yield { type: 'usage', usage: pendingUsage }
      }
      if (pendingFinish !== undefined) yield pendingFinish
      this.input.metrics.latency(spec.id, this.input.now() - startedAt)
    } catch (error) {
      throw this.translate(error, timeoutCode, external, state, spec, firstMs, idleMs)
    } finally {
      clearTimer()
      if (external !== undefined) external.removeEventListener('abort', onAbort)
    }
  }

  

/** 把上游的 `finish{kind:'error'}` 转成可判定的错误。 */
  private upstreamErrorOf(reason: FinishLike, sourceId: string): GatewayError {
    return new GatewayError('upstream-error', reason.failure?.message ?? '上游在流内报告失败', {
      upstreamCode: reason.failure?.code,
      sourceId,
    })
  }

  /** 把任意异常翻译成 `GatewayError`，并标出「有没有吐过字」。 */
  private translate(
    error: unknown,
    timeoutCode: GatewayFailureCode | undefined,
    external: AbortSignal | undefined,
    state: AttemptState,
    spec: SourceSpec,
    firstMs: number,
    idleMs: number,
  ): GatewayError {
    const partial = state.emitted > 0
    if (error instanceof GatewayError) {
      error.partial = partial
      if (error.sourceId === undefined) {
        return new GatewayError(error.code, error.message, {
          partial,
          upstreamCode: error.upstreamCode,
          sourceId: spec.id,
        })
      }
      return error
    }
    const aborted = external !== undefined && external.aborted
    const code: GatewayFailureCode = timeoutCode ?? (aborted ? 'aborted' : 'upstream-error')
    const message = timeoutCode === 'first-chunk-timeout'
      ? `首块超时：${firstMs}ms 内没等到第一个块`
      : timeoutCode === 'idle-timeout'
        ? `块间隔超时：${idleMs}ms 内没有新内容`
        : aborted
          ? '调用方取消'
          : messageOf(error)
    return new GatewayError(code, message, {
      partial,
      upstreamCode: timeoutCode !== undefined ? 'TIMEOUT' : codeOf(error),
      sourceId: spec.id,
    })
  }

  /** 按优先级挑候选链。 */
  private chainOf(request: GatewayRequest): readonly SourceState[] {
    if (request.source !== undefined) {
      const one = this.input.states.find(state => state.spec.id === request.source)
      if (one === undefined) {
        throw new GatewayError('source-unknown', `来源 ${request.source} 不在清单里`)
      }
      return [one]
    }
    const allowFallback = request.allowFallback ?? this.input.settings.allowFallback
    return allowFallback ? this.input.states : this.input.states.slice(0, 1)
  }

  /** 凭据存在性预检。**只判有没有，不取值、不打印**。 */
  private async credentialCheck(spec: SourceSpec): Promise<boolean> {
    if (!this.input.settings.checkCredential) return true
    const ref = spec.credentialRef
    if (ref === undefined) return true
    const credentials = this.input.credentials()
    if (credentials === undefined) {
      // 凭据域没装：不假装检查过，也不因此拦下请求——适配器自己会按同一引用名解析。
      this.input.log.warn('凭据服务未装载，跳过来源 %s 的凭据预检（%s 交给适配器解析）', spec.id, ref)
      return true
    }
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved === undefined || resolved.value === '') {
        this.input.metrics.credentialSkip()
        this.input.log.warn('来源 %s 需要凭据 %s，但解析不到，已跳过（不打印凭据内容）', spec.id, ref)
        return false
      }
      return true
    } catch (error) {
      this.input.metrics.credentialSkip()
      this.input.log.warn('来源 %s 的凭据 %s 解析出错，已跳过：%s', spec.id, ref, messageOf(error))
      return false
    }
  }

  /** 这条失败值不值得重试。 */
  private isRetryable(error: GatewayError): boolean {
    if (
      error.code === 'aborted'
      || error.code === 'bad-request'
      || error.code === 'no-source'
      || error.code === 'source-unknown'
      || error.code === 'provider-missing'
      || error.code === 'credential-missing'
      || error.code === 'gateway-unavailable'
    ) {
      return false
    }
    // 超时是我们自己判的，天然可重试（上游此时连码都没给）。
    if (error.code === 'first-chunk-timeout' || error.code === 'idle-timeout') return true
    const upstream = error.upstreamCode
    if (upstream === undefined) return false
    return this.input.settings.retryableCodes.includes(upstream.toUpperCase())
  }

  /** 指数退避 + 对称抖动，封顶 `maxBackoffMs`。 */
  private backoffFor(attempt: number): number {
    const base = this.input.settings.backoffMs
    const cap = this.input.settings.maxBackoffMs
    const exponential = Math.min(cap, base * 2 ** Math.min(attempt - 1, 10))
    const jitter = 0.75 + Math.random() * 0.5
    return Math.max(0, Math.min(cap, Math.round(exponential * jitter)))
  }

  /** 可取消的等待。取消时抛 `aborted`，绝不静默继续。 */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(new GatewayError('aborted', '退避等待期间被取消'))
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup()
        reject(new GatewayError('aborted', '退避等待期间被取消'))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)
      unref(timer)
      if (signal !== undefined) signal.addEventListener('abort', onAbort)
    })
  }

  /** 组装上游调用参数。只写有值的键，避免把 `undefined` 当成「显式置空」传下去。 */
  private callOptionsOf(spec: SourceSpec, request: GatewayRequest, signal: AbortSignal): GatewayCallOptions {
    const options: {
      -readonly [K in keyof GatewayCallOptions]: GatewayCallOptions[K]
    } = {
      provider: spec.provider,
      model: spec.model,
      messages: toModelMessages(request.messages),
      signal,
    }
    if (request.system !== undefined) options.system = request.system
    if (request.temperature !== undefined) options.temperature = request.temperature
    if (request.maxTokens !== undefined) options.maxTokens = request.maxTokens
    if (request.stop !== undefined) options.stop = request.stop
    if (request.tools !== undefined) options.tools = request.tools
    if (request.reasoningEffort !== undefined) options.reasoningEffort = request.reasoningEffort
    if (request.purpose !== undefined) options.purpose = request.purpose
    return options
  }
}

/**
 * 把「插件侧的朴素消息」提升成上游 `llm` 层要的形状。
 *
 * 上游要求 `content` 是内容块数组，而插件作者最自然的写法是
 * `{ role: 'user', content: '一段话' }`。此前这里原样透传，于是那类调用在
 * 适配器里炸成 `blocks.entries is not a function`，又被包成 `TRANSPORT`——
 * 一条**格式问题**伪装成网络故障，排查时完全指错方向。
 *
 * 只做加法：字符串补成 `[{ type: 'text', text }]`，已经是数组的一律不动。
 * @param messages 调用方给的消息。
 * @returns 可以交给上游的消息。
 */
function toModelMessages(messages: readonly object[]): readonly object[] {
  return messages.map((message) => {
    const content = (message as { readonly content?: unknown }).content
    if (typeof content !== 'string') return message
    return { ...message, content: [{ type: 'text', text: content }] }
  })
}
