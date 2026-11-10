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
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)

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
        signal: controller.signal,
      })

      if (!response.ok) {
        // 把供应商的原文带回界面：401 是 key 错了、404 是模型名错了、
        // 429 是额度用完了——这些都需要用户自己去改，笼统的"请求失败"帮不上忙。
        const detail = (await response.text()).slice(0, 500)
        throw new RpcHandlerError(
          KernelErrorCode.NotImplemented,
          `供应商返回 ${String(response.status)}：${describeStatus(response.status)}${detail === '' ? '' : `（${detail}）`}`,
        )
      }

      if (response.body === null) {
        throw new RpcHandlerError(KernelErrorCode.NotImplemented, '供应商没有返回内容')
      }

      for await (const payload of readSseData(response.body)) {
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
async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
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
    reader.releaseLock()
  }
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
