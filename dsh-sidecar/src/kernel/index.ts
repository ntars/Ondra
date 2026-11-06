/**
 * dsh 内核装配。
 *
 * ## 这个进程做什么
 *
 * 只做四件事：推理循环、工具调用、会话存储、模型适配。
 * 它**不加载任何界面代码**，**不监听端口**，只通过标准输入输出与宿主的
 * `dsh-client` 插件通信。这样它可以被单独替换、单独升级、单独重启，
 * 而壳与宿主不受影响。
 *
 * ## 为什么用 stdio 而不是本地端口
 *
 * 1. **没有端口冲突**：本机同时开多个实例也不会抢占。
 * 2. **天然的生命周期绑定**：父进程退出，管道断开，子进程立刻收到 EOF 并退出，
 *    不会留下孤儿进程。
 * 3. **不需要鉴权**：管道只对父进程可见，不像 TCP 端口会对本机所有进程开放。
 *
 * 代价是不能跨机连接——本项目是桌面应用，不需要跨机。
 */

import { PROTOCOL_VERSION, EventName, KernelErrorCode, Method, RpcErrorCode } from '../protocol.js'
import { RpcDispatcher, RpcHandlerError, stdoutSink } from '../rpc/dispatcher.js'
import { ChatAdapter, ECHO_MODEL_ID, type ModelProfile } from './models.js'
import { DEFAULT_TITLE, FileSessionStore, type MemorySessionStore } from './sessions.js'
import { ToolRegistry } from './tools.js'
import type { KernelParts, SessionStore } from './types.js'

/** 内核版本，与根 `package.json` 保持一致。 */
export const KERNEL_VERSION = '2.0.1'

/** 装配参数。比 {@link KernelParts} 多出"数据放哪里"这类进程级配置。 */
export interface KernelOptions {
  /** 会话数据目录。不传则使用内存存储（仅测试）。 */
  dataDir?: string
  /** 初始供应商配置。 */
  profiles?: readonly ModelProfile[]
}

/** 内核运行态。 */
export interface Kernel {
  /** 请求分发器，调用方用它喂字节与推送事件。 */
  dispatcher: RpcDispatcher
  /** 是否已完成初始化。 */
  isReady(): boolean
  /** 标记内核就绪并向对端推送 `event.ready`。 */
  markReady(): void
}

/**
 * 装配内核。
 *
 * @param options 数据目录与初始模型配置。
 * @param parts 四项职责的替换实现，主要用于测试。
 * @returns 装配好的内核实例。
 */
export async function createKernel(
  options: KernelOptions = {},
  parts?: Partial<KernelParts>,
): Promise<Kernel> {
  // 会话存储优先用调用方注入的实现；没注入且有数据目录时落盘；两者都没有才用内存。
  const sessions: SessionStore = parts?.sessions
    ?? (options.dataDir === undefined
      ? new (await import('./sessions.js')).MemorySessionStore()
      : await FileSessionStore.open(options.dataDir))

  const chat = new ChatAdapter({ profiles: options.profiles ?? [] })
  const models = parts?.models ?? chat
  const tools = new ToolRegistry(parts?.tools ?? [])

  const dispatcher = new RpcDispatcher({ sink: stdoutSink() })

  /** 当前选中的模型 id。空字符串表示使用默认（本地演示模型）。 */
  let currentModel = ''
  /** 正在进行的推理的取消器，按会话 id 索引。 */
  const running = new Map<string, AbortController>()
  let ready = false

  // -------------------------------------------------------------------------
  // 内核生命周期
  // -------------------------------------------------------------------------

  dispatcher.register(Method.Handshake, (params) => {
    const received = readProtocolVersion(params)
    // 只比较主版本：次版本号增加表示"只增不改"，旧客户端仍可工作。
    if (majorOf(received) !== majorOf(PROTOCOL_VERSION)) {
      throw new RpcHandlerError(
        KernelErrorCode.ProtocolMismatch,
        `协议主版本不兼容：内核为 ${PROTOCOL_VERSION}，调用方为 ${received}`,
      )
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      kernel: 'dsh',
      version: KERNEL_VERSION,
      methods: dispatcher.listMethods(),
      ready,
    }
  })

  dispatcher.register(Method.Ping, () => ({ pong: true, at: Date.now() }))

  dispatcher.register(Method.Shutdown, () => {
    dispatcher.markShuttingDown()
    dispatcher.notify(EventName.ShuttingDown)
    // 不在这里直接 process.exit()：让事件先写出去，由入口层在写完后退出。
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  dispatcher.register(Method.SessionCreate, async (params) => {
    assertReady()
    const title = readOptionalString(params, 'title') ?? ''
    // 工作区路径由调用方（宿主）算好传进来。内核不推导路径——
    // 它不知道用户主目录在哪，也不该知道。
    const workspace = readOptionalString(params, 'workspace') ?? ''
    return sessions.create(title, workspace)
  })

  dispatcher.register(Method.SessionGet, async (params) => {
    assertReady()
    const id = readRequiredString(params, 'id')
    const meta = await sessions.get(id)
    if (meta === undefined) {
      throw new RpcHandlerError(RpcErrorCode.InvalidParams, `会话不存在：${id}`)
    }
    return meta
  })

  dispatcher.register(Method.SessionList, async (params) => {
    assertReady()
    const includeArchived = readOptionalBoolean(params, 'includeArchived') ?? false
    return sessions.list(includeArchived)
  })

  dispatcher.register(Method.SessionArchive, async (params) => {
    assertReady()
    const id = readRequiredString(params, 'id')
    const ok = await sessions.archive(id)
    if (!ok) throw new RpcHandlerError(RpcErrorCode.InvalidParams, `会话不存在：${id}`)
    return { ok: true }
  })

  // 消息正文单列一个方法：见协议里 SessionMessages 的注释。
  dispatcher.register(Method.SessionMessages, async (params) => {
    assertReady()
    const id = readRequiredString(params, 'sessionId')
    return await readMessages(id)
  })

  // -------------------------------------------------------------------------
  // 推理
  // -------------------------------------------------------------------------

  dispatcher.register(Method.InferenceRun, async (params) => {
    assertReady()
    const sessionId = readRequiredString(params, 'sessionId')
    if (running.has(sessionId)) {
      throw new RpcHandlerError(RpcErrorCode.InvalidParams, '该会话正在进行一轮对话')
    }

    // 用户的输入随请求一起送来。为什么不让调用方先单独 append 再调 run：
    // 那是两步操作，中间失败会留下"用户说了话但模型没回"的悬空状态。
    // 合并在一个方法里，内核能保证两件事要么都发生、要么都不发生。
    const input = readOptionalString(params, 'input')
    if (input !== undefined && input.trim() !== '') {
      // 首轮对话顺便把会话标题定下来，省掉用户手动改名。
      await sessions.append(sessionId, { role: 'user', content: input }, {
        title: titleFrom(input),
      })
    }

    const abort = new AbortController()
    running.set(sessionId, abort)
    const model = currentModel === '' ? ECHO_MODEL_ID : currentModel

    try {
      const history = await readMessages(sessionId)
      const chunks: string[] = []
      /** 思考过程的累计。只用于诊断与最终返回值，不写进会话正文。 */
      const thoughts: string[] = []
      let call: { name: string; args: unknown } | undefined

      // 逐块消费适配器的输出：文本即时推送，工具调用留到流结束后执行
      // （工具可能改变后续对话，必须在模型本轮说完之后再跑）。
      for await (const chunk of models.run({ model, messages: history, tools: [] })) {
        if (abort.signal.aborted) break
        if (chunk.type === 'text' && chunk.text !== undefined) {
          chunks.push(chunk.text)
          dispatcher.notify(EventName.InferenceDelta, { sessionId, text: chunk.text })
        } else if (chunk.type === 'reasoning' && chunk.text !== undefined) {
          // 思考过程单独推事件、单独累积，**不写进正文**。
          // 理由：思维链是模型的草稿，写进会话会让下次读历史时把它当成
          // 助手说过的话再喂回去，既不准确也会污染上下文。
          thoughts.push(chunk.text)
          dispatcher.notify(EventName.InferenceReasoning, { sessionId, text: chunk.text })
        } else if (chunk.type === 'tool-call' && chunk.toolName !== undefined) {
          call = { name: chunk.toolName, args: chunk.toolArgs }
        }
      }

      const text = chunks.join('')
      // 中断时也可能已经产出部分文本，仍然落盘：用户看到的东西和存下来的
      // 内容必须一致，否则刷新页面后刚看到的话就消失了。
      if (text !== '' || !abort.signal.aborted) {
        await sessions.append(sessionId, { role: 'assistant', content: text })
      }

      if (call !== undefined) {
        dispatcher.notify(EventName.ToolStarted, { sessionId, tool: call.name })
        const result = await tools.invoke(call.name, call.args)
        dispatcher.notify(EventName.ToolFinished, { sessionId, tool: call.name })
        await sessions.append(sessionId, { role: 'tool', content: JSON.stringify(result), toolName: call.name })
      }

      dispatcher.notify(EventName.InferenceDone, { sessionId, aborted: abort.signal.aborted })
      // reasoning 只在返回值里带上长度，不回传全文：一次推理的思维链
      // 动辄几千字，通过 stdio 回传一遍纯属浪费带宽，而调用方真正
      // 需要的是"这轮有没有思考、大概多少"。
      return { text, reasoningLength: thoughts.join('').length, aborted: abort.signal.aborted }
    } finally {
      running.delete(sessionId)
    }
  })

  dispatcher.register(Method.InferenceAbort, (params) => {
    const sessionId = readRequiredString(params, 'sessionId')
    const abort = running.get(sessionId)
    // 幂等：没在跑的时候中断是合法调用，返回 false 而不是报错。
    if (abort === undefined) return { aborted: false }
    abort.abort()
    return { aborted: true }
  })

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  dispatcher.register(Method.ToolList, () => tools.list())

  dispatcher.register(Method.ToolInvoke, async (params) => {
    assertReady()
    const name = readRequiredString(params, 'name')
    const args = readOptionalField(params, 'args')
    return tools.invoke(name, args)
  })

  // -------------------------------------------------------------------------
  // 模型
  // -------------------------------------------------------------------------

  dispatcher.register(Method.ModelList, async () => {
    assertReady()
    return models.list()
  })

  dispatcher.register(Method.ModelSelect, async (params) => {
    assertReady()
    const id = readRequiredString(params, 'id')
    // 选择时校验存在性：让"选了一个不存在的模型"在点击时就失败，
    // 而不是等到用户说完一整句话、等了半分钟才报错。
    const available = await models.list()
    if (!available.some((model) => model.id === id)) {
      throw new RpcHandlerError(RpcErrorCode.InvalidParams, `模型不存在：${id}`)
    }
    currentModel = id
    return { model: currentModel }
  })

  dispatcher.register(Method.ModelConfigure, async (params) => {
    assertReady()
    if (!(models instanceof ChatAdapter)) {
      throw new RpcHandlerError(KernelErrorCode.NotImplemented, '当前模型适配器不支持运行时配置')
    }
    const raw = readOptionalField(params, 'profiles')
    if (!Array.isArray(raw)) {
      throw new RpcHandlerError(RpcErrorCode.InvalidParams, 'profiles 必须是数组')
    }
    const profiles: ModelProfile[] = []
    for (const [index, item] of raw.entries()) {
      profiles.push(readProfile(item, index))
    }
    models.setProfiles(profiles)

    // 选中的模型可能刚被删掉。此时回落到默认模型，而不是留着一个失效 id
    // 让下一次推理才报错。
    const available = await models.list()
    if (!available.some((model) => model.id === currentModel)) {
      currentModel = ECHO_MODEL_ID
    }
    return { models: available, current: currentModel }
  })

  /** 未就绪时拒绝业务请求，但不拒绝 handshake 与 ping——否则调用方无法探测状态。 */
  function assertReady(): void {
    if (!ready) {
      throw new RpcHandlerError(KernelErrorCode.KernelNotReady, '内核尚未完成启动')
    }
  }

  /**
   * 读会话消息。
   *
   * 单独包一层是为了把"会话不存在"从存储层的普通 Error 转成带码的协议错误——
   * 否则会落到 InternalError，界面上只能显示"内部错误"。
   */
  async function readMessages(sessionId: string): Promise<Awaited<ReturnType<SessionStore['messages']>>> {
    try {
      return await sessions.messages(sessionId)
    } catch (error) {
      throw new RpcHandlerError(
        RpcErrorCode.InvalidParams,
        error instanceof Error ? error.message : `会话不存在：${sessionId}`,
      )
    }
  }

  return {
    dispatcher,
    isReady: () => ready,
    markReady(): void {
      ready = true
      dispatcher.notify(EventName.Ready, {
        protocolVersion: PROTOCOL_VERSION,
        version: KERNEL_VERSION,
        model: currentModel === '' ? ECHO_MODEL_ID : currentModel,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 参数读取工具
// ---------------------------------------------------------------------------
//
// 参数来自外部，类型一律视为未知。这里集中做"取字段 + 类型检查 + 明确报错"，
// 避免每个处理器重复三段式判断，也避免漏判导致把 undefined 当字符串用。

/** 取协议版本；缺失或类型不符按"不兼容"处理。 */
function readProtocolVersion(params: unknown): string {
  const value = readOptionalField(params, 'protocolVersion')
  if (typeof value !== 'string') {
    throw new RpcHandlerError(KernelErrorCode.ProtocolMismatch, 'handshake 缺少 protocolVersion')
  }
  return value
}

/** 从参数对象里取一个字段，取不到返回 undefined。 */
function readOptionalField(params: unknown, key: string): unknown {
  if (typeof params !== 'object' || params === null) return undefined
  return (params as Record<string, unknown>)[key]
}

/** 取必填字符串，缺失即报参数错误。 */
function readRequiredString(params: unknown, key: string): string {
  const value = readOptionalField(params, key)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcHandlerError(RpcErrorCode.InvalidParams, `缺少必填参数：${key}`)
  }
  return value
}

/** 取可选字符串。 */
function readOptionalString(params: unknown, key: string): string | undefined {
  const value = readOptionalField(params, key)
  return typeof value === 'string' ? value : undefined
}

/** 取可选布尔值。 */
function readOptionalBoolean(params: unknown, key: string): boolean | undefined {
  const value = readOptionalField(params, key)
  return typeof value === 'boolean' ? value : undefined
}

/** 取版本号的主版本部分。 */
function majorOf(version: string): string {
  return version.split('.')[0] ?? version
}

/**
 * 把外部传来的供应商配置收窄成 {@link ModelProfile}。
 *
 * 缺字段就报错而不是填默认值：一个没有 baseUrl 的配置被默默接受后，
 * 用户会在界面上看到它、选中它、然后在说话时收到一条网络错误——
 * 错误发生的位置离原因太远，排查成本极高。
 */
function readProfile(value: unknown, index: number): ModelProfile {
  if (typeof value !== 'object' || value === null) {
    throw new RpcHandlerError(RpcErrorCode.InvalidParams, `profiles[${String(index)}] 必须是对象`)
  }
  const record = value as Record<string, unknown>
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  if (baseUrl === '') {
    throw new RpcHandlerError(RpcErrorCode.InvalidParams, `profiles[${String(index)}] 缺少 baseUrl`)
  }
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (model === '') {
    throw new RpcHandlerError(RpcErrorCode.InvalidParams, `profiles[${String(index)}] 缺少 model`)
  }
  const label = typeof record.label === 'string' && record.label.trim() !== '' ? record.label.trim() : model
  const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : `${label}:${model}`
  return {
    id,
    label,
    baseUrl,
    model,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    ...(typeof record.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
  }
}

/**
 * 从首轮用户输入里生成会话标题。
 *
 * 取第一行前 24 个字符：标题是给列表辨认用的，长了会被截断，
 * 而截断位置不受控就会出现"半句话"。取第一行是因为用户常先写一句短的
 * 概括再换行展开，第一行通常最适合当标题。
 */
function titleFrom(input: string): string {
  const firstLine = input.trim().split('\n')[0]?.trim() ?? ''
  if (firstLine === '') return DEFAULT_TITLE
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine
}

/** 导出给入口层判断是否需要提示"尚未配置真实模型"。 */
export { ECHO_MODEL_ID }

/** 内存存储类型导出，供测试直接引用而不必动态 import。 */
export type { MemorySessionStore }
