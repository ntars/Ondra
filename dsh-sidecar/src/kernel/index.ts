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
import type { ImportedMessage, KernelParts, SessionMessage, SessionStore } from './types.js'

/** 内核版本，与根 `package.json` 保持一致。 */
export const KERNEL_VERSION = '2.1.2'

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

  /*
   * 删一条消息。`seq` 由调用方从 `session.messages` 的返回位置取得，
   * 是**存储里的下标**而不是消息 id——理由见协议里 SessionDeleteMessage。
   *
   * 会话不存在走 InvalidParams（与 readMessages 一致），序号越界返回
   * `removed: false`。两者分开：前者是调用方用错了 id，后者是竞态。
   */
  dispatcher.register(Method.SessionDeleteMessage, async (params) => {
    assertReady()
    const sessionId = readRequiredString(params, 'sessionId')
    const seq = readRequiredInteger(params, 'seq')
    await assertSession(sessionId)
    return { removed: await sessions.deleteMessage(sessionId, seq) }
  })

  /** 清空全部消息。会话本身保留，`updatedAt` 随之刷新。 */
  dispatcher.register(Method.SessionClear, async (params) => {
    assertReady()
    const sessionId = readRequiredString(params, 'sessionId')
    await assertSession(sessionId)
    return { cleared: await sessions.clear(sessionId) }
  })

  /**
   * 导入一段对话：建会话 + 批量写消息。
   *
   * ## 为什么整段放进内核而不是让宿主拼
   *
   * 「建会话」与「写消息」必须原子地落在同一个存储上：宿主若先
   * `session.create` 再逐条 `session.importMessages`，两次调用之间
   * 进程被中断，就会留下一个空会话。放在内核里，一次 RPC 完成两件事。
   *
   * ## 为什么要读回会话
   *
   * 标题在三处可能被改写（空标题回落占位、首轮自动命名、调用方指定），
   * 只有存储知道最后是什么。返回 `session` 让宿主不必再查一次。
   */
  dispatcher.register(Method.SessionImport, async (params) => {
    assertReady()
    const title = readOptionalString(params, 'title') ?? ''
    const workspace = readOptionalString(params, 'workspace') ?? ''
    const raw = (params as Record<string, unknown>)['messages']
    const messages = Array.isArray(raw) ? (raw as ImportedMessage[]) : []

    const meta = await sessions.create(title, workspace)
    const imported = await sessions.importMessages(meta.id, messages)
    return { session: await sessions.get(meta.id), imported }
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

    /*
     * 主动开口的临时提示（`nudge`）。
     *
     * ## 为什么需要它
     *
     * 用户没说话时，历史里最后一条是**她自己**说过的话。把这段历史原样
     * 交给模型，它只会「接着自己的话往下说」——那不是主动开口，是自问自答。
     * 主动开口需要一句只在本次运行存在的指令，告诉她「现在轮到你开口了」。
     *
     * ## 为什么是 `nudge` 而不是新增一个 RPC 方法
     *
     * 主动与回话在**推理这一层没有区别**：同样的历史、同样的模型、同样的
     * 流式回调、同样的落盘规则。为了「谁发起」多开一条链路，会让两边的
     * 中断、错误、事件推送各写一遍——而它们必须完全一致，否则主动消息
     * 的异常态与普通回复不一样，用户会看到两种坏法。
     *
     * ## 为什么不落盘
     *
     * 它是**指令**不是**对话**。存进历史后，下次读消息会把它当成一条
     * 系统消息再喂回去，模型就会以为「她每隔一轮都被要求主动开口」，
     * 回话也会变得像主动。这条提示的生命周期严格等于本次运行。
     */
    const nudge = readOptionalString(params, 'nudge')

    /*
     * 本轮的系统提示词（人格 + 器官片段）。
     *
     * ## 为什么由调用方递进来，内核不自己拼
     *
     * 内核是独立进程，**不加载插件系统**——它拿不到 `ctx.get('ondra-persona-assemble')`。
     * 人格与片段都在宿主那一侧，所以拼装归宿主（见 `cordis-host/src/system-prompt.ts`
     * 的归属判定），内核只负责「把它放在哪」。
     *
     * ## 为什么插在历史最前，而不是追加在尾部
     *
     * `system` 是模型的**身份前提**，必须在它读到第一句对话之前就在位。
     * 追加到尾部会变成「说完一轮之后再被告知你是谁」——那是纠正，不是设定。
     *
     * ## 为什么不落盘
     *
     * 与 `nudge` 同一条理由：它是**指令**不是**对话**。存进历史后，下次读消息
     * 会把它当成一条普通 system 消息再喂一遍，三轮之后就积累了三条相同的人格，
     * 而会话文件也会膨胀到不该有的体积。
     */
    const system = readOptionalString(params, 'system')

    try {
      const history = await readMessages(sessionId)
      /*
       * 拼装顺序：系统提示词 → 历史 → 临时提示。
       *
       * 顺序不可换。把 `nudge` 放在 `system` 之前，模型读到的第一句是
       * 「现在轮到你开口」，人设还没到位——主动开口那一轮的语气会明显
       * 比回话时生硬，而这种差异极难归因。
       */
      const messages = [
        ...(system !== undefined && system.trim() !== ''
          ? [{ id: 'system', role: 'system' as const, content: system, createdAt: Date.now() }]
          : []),
        ...history,
        ...(nudge !== undefined && nudge.trim() !== ''
          ? [{ id: 'nudge', role: 'system' as const, content: nudge, createdAt: Date.now() }]
          : []),
      ]
      const chunks: string[] = []
      /** 思考过程的累计。只用于诊断与最终返回值，不写进会话正文。 */
      const thoughts: string[] = []
      let call: { name: string; args: unknown } | undefined

      // 逐块消费适配器的输出：文本即时推送，工具调用留到流结束后执行
      // （工具可能改变后续对话，必须在模型本轮说完之后再跑）。
      //
      // `signal` 必须传进去。只在循环里 `break` 是不够的：那只让内核不再
      // 要下一块，适配器自己还在读上游流，`running` 上的锁要等它自然结束
      // 才释放——用户点一次「停止生成」就再也发不出下一句。详见
      // `InferenceRequest.signal` 的注释。
      for await (const chunk of models.run({ model, messages, tools: [], signal: abort.signal })) {
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

  /*
   * 一次性补全（非流式）。
   *
   * 存在的唯一理由：宿主的记忆提炼与做梦**需要模型，但不需要上屏**，
   * 而模型配置（端点、密钥、模型名）只住在内核这里。宿主自己发 HTTP 就要
   * 把密钥与请求体再实现一遍，两条链路迟早不一致（见 `Method.ModelComplete`
   * 的注释）。
   *
   * 与 `inference.run` 的三处不同，每一处都是刻意的：
   *
   * | 差异 | `inference.run` | 这里 |
   * | --- | --- | --- |
   * | 落盘 | 写用户与助手消息 | **一个字都不写**（提炼的提示词不是对话） |
   * | 推送 | 逐块推 delta | 不推任何事件（没有第二个观看者） |
   * | 返回值 | 本轮答复 | 拼好的整段文本 |
   *
   * 它**不检查 `currentModel`**：提炼该用哪个模型由调用方指定，
   * 不跟随界面当前选中的那一个——用户在界面上换模型不该改变记忆提炼的走向。
   */
  dispatcher.register(Method.ModelComplete, async (params) => {
    assertReady()
    const model = readOptionalString(params, 'model') ?? currentModel ?? ECHO_MODEL_ID
    const raw = readOptionalField(params, 'messages')
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new RpcHandlerError(RpcErrorCode.InvalidParams, 'messages 必须是非空数组')
    }
    const messages: SessionMessage[] = []
    for (const [index, item] of raw.entries()) {
      if (typeof item !== 'object' || item === null) {
        throw new RpcHandlerError(RpcErrorCode.InvalidParams, `messages[${String(index)}] 不是对象`)
      }
      const role = (item as { readonly role?: unknown }).role
      const content = (item as { readonly content?: unknown }).content
      if (role !== 'user' && role !== 'assistant' && role !== 'system') {
        throw new RpcHandlerError(RpcErrorCode.InvalidParams, `messages[${String(index)}].role 只能是 user / assistant / system`)
      }
      if (typeof content !== 'string') {
        throw new RpcHandlerError(RpcErrorCode.InvalidParams, `messages[${String(index)}].content 必须是字符串`)
      }
      messages.push({ id: `complete-${String(index)}`, role, content, createdAt: Date.now() })
    }
    // 系统提示插在最前：它说明"你是谁、按什么格式答"，必须在模型读到第一条内容之前在位。
    const system = readOptionalString(params, 'system')
    const withSystem: SessionMessage[] = system !== undefined && system.trim() !== ''
      ? [{ id: 'complete-system', role: 'system', content: system, createdAt: Date.now() }, ...messages]
      : messages

    const pieces: string[] = []
    // 不复用 `inference.run` 的中断登记：这条调用短、无人观看、也不会被用户按停止。
    // 登记进 `running` 反而会让同一会话的下一轮对话被误判成"正在进行一轮对话"。
    for await (const chunk of models.run({ model, messages: withSystem, tools: [] })) {
      if (chunk.type === 'text' && chunk.text !== undefined) pieces.push(chunk.text)
    }
    return { text: pieces.join(''), model }
  })

  /** 未就绪时拒绝业务请求，但不拒绝 handshake 与 ping——否则调用方无法探测状态。 */
  function assertReady(): void {
    if (!ready) {
      throw new RpcHandlerError(KernelErrorCode.KernelNotReady, '内核尚未完成启动')
    }
  }

  /**
   * 会话必须存在。
   *
   * 删除与清空都要先过这一道：存储层对不存在的会话抛的是普通 `Error`，
   * 落到分发器会变成 InternalError，界面上只能显示"内部错误"。
   * 在这里换成 InvalidParams，用户看到的是"这个会话不在了"。
   */
  async function assertSession(sessionId: string): Promise<void> {
    const meta = await sessions.get(sessionId)
    if (meta === undefined) {
      throw new RpcHandlerError(RpcErrorCode.InvalidParams, `会话不存在：${sessionId}`)
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

/**
 * 取必填整数。
 *
 * 不用 `readRequiredString` + `Number()`：那样 `"2abc"` 会得到 NaN、
 * `"2.5"` 会得到一个不是下标的数，而 `splice` 对这两种输入都不会报错，
 * 只会删错位置或者什么都不删。
 */
function readRequiredInteger(params: unknown, key: string): number {
  const value = readOptionalField(params, key)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RpcHandlerError(RpcErrorCode.InvalidParams, `参数 ${key} 必须是整数`)
  }
  return value
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
