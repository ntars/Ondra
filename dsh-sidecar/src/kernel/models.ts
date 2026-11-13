/**
 * 模型适配器。
 *
 * ## 为什么只有"OpenAI 兼容"一种适配器
 *
 * 当前主流供应商（OpenAI、DeepSeek、Moonshot、智谱、通义、本地 Ollama / vLLM /
 * LM Studio）都实现了 `/chat/completions` 这一套接口。写一个适配器就能覆盖这些，
 * 而每多写一个"官方 SDK 适配器"就多一份要跟着对方发版走的维护成本。
 *
 * 因此这里只实现协议本身，供应商差异用配置表达（`baseUrl` + `model` + `apiKey`）。
 *
 * ## 为什么没有可配置项时也要有一个能说话的模型
 *
 * 用户第一次打开应用时手上没有任何密钥。此时如果推理直接报"未配置模型"，
 * 界面就只剩一个不能按的按钮——用户无法判断是软件坏了还是自己没配。
 * 所以内置一个**本地回声模型**：它不联网、不产生智能，但会把收到的内容
 * 按完整链路（会话落盘 → 流式推送 → 界面逐字显示）走一遍，
 * 让"装好了、链路是通的"这件事可被直接看到。
 *
 * 它的名字与描述都写明是演示用途，不伪装成真实模型。
 */

import { KernelErrorCode } from '../protocol.js'
import { RpcHandlerError } from '../rpc/dispatcher.js'
import type {
  InferenceChunk,
  InferenceRequest,
  ModelAdapter,
  ModelDescriptor,
} from './types.js'

/** 本地演示模型的 id。固定值，界面据此判断"当前没有真实模型"。 */
export const ECHO_MODEL_ID = 'local/echo'

/** 一条供应商配置。 */
export interface ModelProfile {
  /** 稳定标识。会话里记录的是它，改展示名不会让历史会话失联。 */
  id: string
  /** 展示名。 */
  label: string
  /** 形如 `https://api.deepseek.com/v1`。不带尾部斜杠也能用。 */
  baseUrl: string
  /** 该供应商要用的模型名，例如 `deepseek-chat`。 */
  model: string
  /** 密钥。本地服务（Ollama 等）可以为空。 */
  apiKey: string
  /** 上下文窗口，仅用于界面提示。 */
  contextWindow?: number
}

/** 适配器的构造参数。 */
export interface ChatAdapterOptions {
  /** 供应商配置。空数组时只剩本地演示模型。 */
  profiles: readonly ModelProfile[]
  /** 单次请求的整体超时，毫秒。默认 180 秒——长回答需要时间。 */
  timeoutMs?: number
}

/** 默认超时。 */
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * OpenAI 兼容适配器。
 *
 * 管理工作在 {@link setProfiles}：配置可以热替换，但正在进行的推理
 * 用的是它启动时读到的那份配置——中途换 key 不该影响已经发出的请求。
 */
export class ChatAdapter implements ModelAdapter {
  private profiles: ModelProfile[] = []
  private readonly timeoutMs: number

  constructor(options: ChatAdapterOptions = { profiles: [] }) {
    this.setProfiles(options.profiles)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 整体替换供应商配置。
   *
   * 采用替换而非合并：合并无法表达"删掉一个模型"，而用户改配置时最常见的
   * 动作恰恰是删掉填错的那条。
   */
  setProfiles(profiles: readonly ModelProfile[]): void {
    this.profiles = profiles.filter((profile) => profile.id !== ECHO_MODEL_ID && profile.baseUrl.trim() !== '')
  }

  /** 当前配置的只读快照，供宿主持久化。 */
  getProfiles(): ModelProfile[] {
    return this.profiles.map((profile) => ({ ...profile }))
  }

  async list(): Promise<ModelDescriptor[]> {
    // 演示模型永远在列，且排在最前：它是"一定能用"的那一个，
    // 用户在没有密钥时点它至少能看到界面在动。
    const echo: ModelDescriptor = {
      id: ECHO_MODEL_ID,
      label: '本地演示（不联网）',
      contextWindow: 8192,
      supportsTools: false,
      supportsStreaming: true,
    }
    return [echo, ...this.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      contextWindow: profile.contextWindow ?? 32_768,
      supportsTools: true,
      supportsStreaming: true,
    }))]
  }

  async *run(request: InferenceRequest): AsyncIterable<InferenceChunk> {
    if (request.model === '' || request.model === ECHO_MODEL_ID) {
      yield* echoReply(request)
      return
    }

    const profile = this.profiles.find((candidate) => candidate.id === request.model)
    if (profile === undefined) {
      throw new RpcHandlerError(
        KernelErrorCode.NotImplemented,
        `模型不存在：${request.model}。请在设置里重新选择，或先添加一个供应商。`,
      )
    }
    yield* this.stream(profile, request)
  }

  /** 向供应商发起一次流式请求。 */
  private async *stream(profile: ModelProfile, request: InferenceRequest): AsyncIterable<InferenceChunk> {
    /*
     * 两层中断合并成一个信号。
     *
     * - `request.signal`：用户点了「停止生成」。
     * - 本地 `controller`：本适配器自己的超时闸。
     *
     * 为什么用 `AbortSignal.any` 而不是只传 `request.signal`：超时那条
     * 必须继续生效（远端不说话时不能永远挂着），而两者任一触发都该立刻
     * 断开连接。合成之后只留一个信号，`fetch` 与读取循环共用它，
     * 不会出现「用户中断了但超时定时器还在数」这种半开状态。
     */
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, this.timeoutMs)
    const signal = request.signal === undefined
      ? timeout.signal
      : AbortSignal.any([request.signal, timeout.signal])

    try {
      const response = await fetch(joinChatCompletionsUrl(profile.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(profile.apiKey.trim() === '' ? {} : { authorization: `Bearer ${profile.apiKey}` }),
        },
        body: JSON.stringify({
          model: profile.model,
          messages: toWireMessages(request.messages),
          stream: true,
        }),
        signal,
      })

      if (!response.ok) {
        /*
         * 供应商的原文要带回来，但**不能整段摊给用户**。
         *
         * 401 是 key 错了、404 是模型名错了、429 是额度用完了——这些都需要
         * 用户自己去改，笼统的「请求失败」确实帮不上忙。但上一版把
         * `{"error":{"message":"Authentication Fails (governor) (request_id:
         * 1fd86f7c-9cad-4520-90b4-5d2ebb434298)","type":"authentication_error"}}`
         * 原样拼进界面，用户读到的是 `governor`、`request_id` 这些对
         * 「我该改哪一项」毫无帮助的词。
         *
         * 所以只取其中的 `message` 字段——那才是供应商写给人看的一句。
         * 取不到就只留状态码那句中文，绝不把整包 JSON 顶上去。
         * `request_id` 之类仍然有用，但它属于排障日志，不属于对话界面。
         */
        const raw = (await response.text()).slice(0, 2000)
        const detail = upstreamMessage(raw)
        throw new RpcHandlerError(
          KernelErrorCode.NotImplemented,
          `供应商返回 ${String(response.status)}：${describeStatus(response.status)}${detail === '' ? '' : `（${detail}）`}`,
        )
      }

      if (response.body === null) {
        throw new RpcHandlerError(KernelErrorCode.NotImplemented, '供应商没有返回内容')
      }

      for await (const payload of readSseData(response.body, signal)) {
        if (payload === '[DONE]') break
        for (const piece of extractDeltas(payload)) {
          if (piece.text === '') continue
          yield { type: piece.reasoning ? 'reasoning' : 'text', text: piece.text }
        }
      }
      yield { type: 'done' }
    } catch (error) {
      if (error instanceof RpcHandlerError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        /*
         * 中断要分清是谁按的。
         *
         * - 用户点了「停止生成」→ 这不是错误，是一等公民的操作结果。
         *   抛一个 Timeout 会让界面在消息末尾挂一条红色「模型响应超时」，
         *   而用户明明是自己停的。所以原样返回：把已产出的部分正常收尾。
         * - 本地超时闸触发 → 这才是超时，要说清楚。
         *
         * 判据是 `request.signal.aborted` 而不是 `timeout.signal.aborted`：
         * 合成信号里两者都会让 `signal.aborted` 为真，只有分开问才分得清。
         */
        if (request.signal?.aborted === true) {
          // 用户中断：不抛，让外层按「正常结束」收尾（已产出的文本照常落盘）。
          return
        }
        throw new RpcHandlerError(
          KernelErrorCode.Timeout,
          `模型响应超时（${String(Math.round(this.timeoutMs / 1000))} 秒）`,
        )
      }
      // 网络层失败（DNS、连接被拒、TLS）统一归到"未实现"会误导，
      // 但协议里没有"网络错误"码，用 Timeout 也不对。
      // 这里用 NotImplemented 并写明这是网络问题——界面上展示的是 message，
      // 码只用于程序分支，而这一类错误不需要程序分支。
      throw new RpcHandlerError(
        KernelErrorCode.NotImplemented,
        `无法连接供应商（${profile.baseUrl}）：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 本地演示模型的回复。
 *
 * 它的价值在于把整条链路跑通：会话写入、增量推送、界面逐字渲染。
 * 文本内容刻意说明自己是什么，避免被误当成真实模型的输出。
 */
async function* echoReply(request: InferenceRequest): AsyncIterable<InferenceChunk> {
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
  const received = lastUser?.content.trim() ?? ''
  const reply = received === ''
    ? '这里是空谷的本地演示模型。在设置里填入一个模型供应商，就能真正对话了。'
    : `我收到了：${received}\n\n这是本地演示模型的回声，不联网、不产生真实回答。在左下角「设置」里填入任意 OpenAI 兼容的供应商（DeepSeek、Moonshot、本地 Ollama 都行），再选一次模型即可开始真正的对话。`

  // 按字符切片推送，而不是整段一次给出：界面据此验证流式渲染真的在工作。
  // 为什么按 4 字一组：太小组数过多会把事件通道打满，太大就看不到逐字效果。
  const size = 4
  for (let index = 0; index < reply.length; index += size) {
    const slice = reply.slice(index, index + size)
    yield { type: 'text', text: slice }
    // 15 毫秒接近人眼能分辨的最小间隔，再快就看不出是流式了。
    await new Promise((resolve) => { setTimeout(resolve, 15) })
  }
  yield { type: 'done' }
}

/** 把内部消息转成 OpenAI 协议的消息。 */
function toWireMessages(messages: InferenceRequest['messages']): Array<{ role: string; content: string }> {
  return messages
    // `tool` 角色的内容在 OpenAI 协议里必须与 tool_calls 配对出现，
    // 当前没有实现工具接续，直接丢掉比伪造配对更安全。
    .filter((message) => message.role !== 'tool')
    .map((message) => ({ role: message.role, content: message.content }))
}

/** 拼出 `/chat/completions` 完整地址，容忍用户少写或多写斜杠。 */
function joinChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
}

/**
 * 逐条读出 SSE 的 `data:` 载荷。
 *
 * 为什么手写而不引库：SSE 的分帧规则只有"按行读、以 data: 开头的取冒号后内容"
 * 一条，引一个库进来反而要处理它的重连策略。这里只需要读。
 */
/**
 * 从 SSE 流里逐条读出 `data:` 的内容。
 *
 * ## `signal` 为什么必须传进来
 *
 * `fetch` 收到 abort 只会取消**请求**，已经拿到手的 `response.body` 流不会
 * 自动报错——`reader.read()` 会继续挂着等下一块，上游不发就永远不返回。
 * 于是消费侧的 `for await` 卡在这一行，生成器不结束，内核 `finally` 里的
 * `running.delete(sessionId)` 永远跑不到。
 *
 * 实测症状：用户点一次「停止生成」，这个会话**再也发不出消息**，一直报
 * 「该会话正在进行一轮对话」。用本地模型时上游几乎瞬间结束，看不出问题；
 * 换成慢速远端就是彻底死锁，且要等到 30 秒宿主超时才"看起来恢复"。
 *
 * 所以读取循环自己也要认这个信号：abort 时立刻 `reader.cancel()` 并抛出
 * `AbortError`，让调用链以中断收尾（`stream()` 里那个 catch 会把用户中断
 * 识别成正常结束）。
 */
async function* readSseData(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /*
   * abort 时把 reader 关掉。
   *
   * ## 为什么 `cancel()` 的 rejection 必须自己接住
   *
   * `reader.cancel()` 返回 Promise。当它被用来打断一个**正在 `read()`**
   * 的流时，那个挂起的 `read()` 会以 `AbortError` 拒绝，而 `cancel()`
   * 自己也常常以同样的理由拒绝。上一版写 `void reader.cancel()` 只丢了
   * 返回值的引用，没有挂 catch —— 于是在 `void` 之外留下一个未处理的
   * 拒绝，进程级 `unhandledRejection` 会打出一行
   * 「未处理的 Promise 拒绝：AbortError」。用户只是点了停止，却看到一条
   * 像是程序出错的日志。
   *
   * 所以这里显式 `.catch(() => {})`：取消失败没有可补救的后续，
   * 真正的中断结论由下面的 `signal.aborted` 分支给出。
   */
  const onAbort = (): void => {
    reader.cancel().catch(() => { /* 取消本身失败无需上报，见上 */ })
  }
  /*
   * 监听器 `{ once: true }` 并在 finally 里摘掉：一条流可能被读很多次
   * 回调，留着不清会在长会话里累积成泄漏。
   */
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      // 每轮先看信号：已经中断就不必再等下一块。
      if (signal?.aborted === true) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).trim()
        buffer = buffer.slice(newlineAt + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload !== '') yield payload
        }
        newlineAt = buffer.indexOf('\n')
      }
    }
    // 最后一帧可能没有结尾换行，不能丢。
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim()
      if (payload !== '') yield payload
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

/**
 * 造一个与 `fetch` 抛出的同形 `AbortError`。
 *
 * 为什么不用 `new Error('aborted')`：上游 `stream()` 的 catch 是按
 * `DOMException` + `name === 'AbortError'` 判中断的，形状不对就落进
 * 「无法连接供应商」那一支——用户自己按的停止会变成一条红色网络错误。
 */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * 从一帧 JSON 里取出文本增量。
 *
 * ## 为什么要把 reasoning_content 单独拿出来
 *
 * 推理模型（DeepSeek V4.1、GLM-5.3 等）的流是两段的：先逐字吐思维链
 * （`reasoning_content`），再逐字吐正文（`content`）。实测一轮"说一句话"
 * 能产生 200 多帧 reasoning，正文只有 1 帧。
 *
 * 若只取 `content`，用户在整整十几秒里看到的是完全空白的界面——
 * 分不清是在思考、卡死了、还是发都没发出去。这属于真实可用性缺陷，
 * 不是"要不要展示思维链"的偏好问题。
 *
 * 因此这里把两者**区分开**返回，由上层决定怎么用：
 * 界面可以把 reasoning 显示成"思考中"的浅色过程，正文仍按原样铺开。
 * 混在一起则会造成"说了两遍"的观感，所以不能合并成一个 text。
 *
 * @returns 按出现顺序排列的片段，每段标明是不是思考内容。
 */
function extractDeltas(payload: string): Array<{ text: string; reasoning: boolean }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // 供应商偶尔会插入心跳或注释行（magpie 的 `: heartbeat`），跳过而非失败。
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const choices = (parsed as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return []

  const pieces: Array<{ text: string; reasoning: boolean }> = []
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const delta = (choice as Record<string, unknown>).delta
    if (typeof delta !== 'object' || delta === null) continue
    const record = delta as Record<string, unknown>

    // 一行 delta 里可能同时带 reasoning 与 content（切换到正文的那一帧）。
    // 按 reasoning 在前、content 在后的顺序输出，与阅读顺序一致。
    const reasoning = record.reasoning_content
    if (typeof reasoning === 'string' && reasoning !== '') {
      pieces.push({ text: reasoning, reasoning: true })
    }
    const content = record.content
    if (typeof content === 'string' && content !== '') {
      pieces.push({ text: content, reasoning: false })
    }
  }
  return pieces
}

/** 把状态码翻译成一句用户能照着改的话。 */
/**
 * 从供应商的错误响应里挑出**给人看的那一句**。
 *
 * ## 为什么不一整段返回
 *
 * OpenAI 兼容端点的错误体是 JSON，其中 `error.message` 是写给人看的，
 * 其余字段（`type`、`code`、`request_id`）是给支持团队定位用的。
 * 把整包 JSON 拼进对话界面，用户读到的是
 * `Authentication Fails (governor) (request_id: 1fd86f7c-…)` ——
 * 一句话里三个他既改不了也不需要知道的词。
 *
 * ## 解析失败时返回空串
 *
 * 有些网关在 502 时返回 HTML 错误页。那种内容一个字都不该进界面
 * （标签、堆栈、内网地址），所以宁可不显示细节，只留 `describeStatus`
 * 那句中文。信息少一点，但每一句都是能照着做的。
 */
function upstreamMessage(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error
      if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string' && message.trim() !== '') return trimNoise(message)
      }
      // 少数端点把话直接放在顶层 `message`。
      const top = (parsed as { message?: unknown }).message
      if (typeof top === 'string' && top.trim() !== '') return trimNoise(top)
    }
  } catch {
    // 不是 JSON：不返回原文，理由见上。
  }
  return ''
}

/**
 * 去掉供应商在 message 里夹带的排障尾巴。
 *
 * 实测 DeepSeek 的 401 原文是
 * `Authentication Fails (governor) (request_id: 1fd86f7c-…)`——
 * `governor` 是它内部的限流组件名，`request_id` 是给工单用的。
 * 这两样对「我该改哪一项」没有任何帮助，反而把一句 12 词的话撑成 40 词。
 *
 * 只剥括号里含 `request_id` / `trace_id` 的那一段，其余原样保留：
 * 供应商有时把真正的原因写在括号里（`(insufficient balance)`），
 * 一律删括号会连那句话一起删掉。
 */
function trimNoise(message: string): string {
  return message
    .replace(/\s*\((?:[^()]*?(?:request|trace)_id[^()]*?)\)/gi, '')
    .trim()
    .slice(0, 300)
}

function describeStatus(status: number): string {
  switch (status) {
    case 401: return '密钥无效或未提供'
    case 403: return '密钥无权访问该模型'
    case 404: return '接口地址或模型名不正确'
    case 429: return '请求过于频繁或额度已用尽'
    case 500: case 502: case 503: case 504: return '供应商服务暂时不可用'
    default: return '请求被拒绝'
  }
}
