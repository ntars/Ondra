/**
 * 内核四类职责的公共类型。
 *
 * ## 为什么要单独一个类型文件
 *
 * 会话、推理、工具、模型四者互相引用：推理要读会话、要调模型、要跑工具，
 * 工具的结果又要写回会话。若各模块各自定义类型，会形成循环依赖。
 * 把共用的类型提到这里，四个模块都只依赖本文件，依赖方向保持单向：
 * `types ← 各模块 ← 分发器装配`。
 */

/**
 * 一个会话的元信息。
 *
 * 只含元信息，不含消息正文——会话可能有几百轮，列表页不需要正文，
 * 让 `session.list` 返回全文会让一次列表请求变成几 MB 的传输。
 */
export interface SessionMeta {
  /** 会话 id。由内核生成，调用方不可指定。 */
  id: string
  /** 会话标题。未由用户指定时由首轮内容截取生成。 */
  title: string
  /** 创建时间，Unix 毫秒。 */
  createdAt: number
  /** 最后更新时间，Unix 毫秒。 */
  updatedAt: number
  /** 已归档的会话不出现在默认列表里，但数据保留。 */
  archived: boolean
  /**
   * 该会话绑定的工作区绝对路径。
   *
   * 空串表示没有绑定——老版本存下的会话文件没有这个字段，
   * 读回来时是空串。界面据此决定"要不要显示路径"，
   * 而不是假装它有一个其实不存在的位置。
   *
   * 路径**由调用方算出并传入**，内核只负责存。理由与配置放在宿主同一层：
   * 内核不该知道自己在哪台机器上、用户主目录长什么样，它只记住
   * "这条会话被允许在哪个目录里活动"。这样内核可以被塞进任何沙箱，
   * 而路径策略（按日期分、根目录在哪）全在宿主一处决定。
   */
  workspace: string
}

/** 会话中的一条消息。 */
export interface SessionMessage {
  /** 消息 id，会话内唯一。 */
  id: string
  /** 角色。`tool` 用于承载工具执行结果。 */
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** 文本内容。多模态内容在后续版本扩展，当前只有文本。 */
  content: string
  /** 产生该消息的时间，Unix 毫秒。 */
  createdAt: number
  /** 当 role 为 `tool` 时，指向被调用的工具名。 */
  toolName?: string
}

/**
 * 会话存储接口。
 *
 * 定义成接口而非具体类：当前骨架用内存实现，正式版会换成持久化实现，
 * 而上层代码不该因存储介质变化而改动。
 */
export interface SessionStore {
  /**
   * 创建一个空会话。
   *
   * @param title 标题。空串时用占位标题，首轮对话后自动替换。
   * @param workspace 绑定的工作区绝对路径。不传则为空串（无绑定）。
   */
  create(title: string, workspace?: string): Promise<SessionMeta>
  /** 按 id 取会话元信息，不存在时返回 undefined。 */
  get(id: string): Promise<SessionMeta | undefined>
  /** 列出会话。默认不含已归档的。 */
  list(includeArchived: boolean): Promise<SessionMeta[]>
  /** 归档会话。幂等：重复归档不报错。 */
  archive(id: string): Promise<boolean>
  /** 追加一条消息，并同步更新会话的 `updatedAt`。 */
  append(
    sessionId: string,
    message: Omit<SessionMessage, 'id' | 'createdAt'>,
    /**
     * 可选的元信息覆盖。
     *
     * 存在的理由：首轮对话要顺手把默认标题换成用户说的第一句话。若不做成一个
     * 参数，调用方就得"append 之后再改标题再落盘一次"，一次对话写三次磁盘。
     */
    override?: { title?: string },
  ): Promise<SessionMessage>
  /** 读取会话内的全部消息，按时间升序。 */
  messages(sessionId: string): Promise<SessionMessage[]>
  /**
   * 删除会话里的第 `seq` 条消息（0 基，按 {@link messages} 的返回顺序）。
   *
   * 越界返回 `false` 而不是抛错：界面连点两次删除时，第二次要找的那条
   * 已经不在了，那是正常竞态。
   */
  deleteMessage(sessionId: string, seq: number): Promise<boolean>
  /**
   * 清空会话的全部消息，保留会话本身。
   *
   * @returns 实际删掉的消息条数。
   */
  clear(sessionId: string): Promise<number>
}

/** 模型描述。只描述"是什么"，不含调用方式——调用方式由适配器负责。 */
export interface ModelDescriptor {
  /** 模型标识，形如 `provider/model-name`。 */
  id: string
  /** 展示名。 */
  label: string
  /** 上下文窗口大小，单位 token。 */
  contextWindow: number
  /** 是否支持工具调用。界面据此决定是否展示工具开关。 */
  supportsTools: boolean
  /** 是否支持流式输出。 */
  supportsStreaming: boolean
}

/**
 * 模型适配器接口。
 *
 * 命名用"适配器"而非"客户端"：每个模型供应商的协议差异都被这个接口吸收，
 * 内核其余部分只知道 `ModelDescriptor` 与 `InferenceRequest`。
 */
export interface ModelAdapter {
  /** 列出该适配器可用的模型。 */
  list(): Promise<ModelDescriptor[]>
  /**
   * 执行一轮推理。
   *
   * 返回异步迭代器而不是最终字符串：流式输出是陪伴体体验的核心，
   * 若接口只给最终结果，上层就无法边生成边显示。
   * 需要非流式时，调用方自行拼合全部增量即可。
   */
  run(request: InferenceRequest): AsyncIterable<InferenceChunk>
}

/** 一次推理请求。 */
export interface InferenceRequest {
  /** 目标模型 id。 */
  model: string
  /** 完整对话历史，按时间升序。 */
  messages: readonly SessionMessage[]
  /** 本轮允许使用的工具名。空数组表示禁用工具。 */
  tools: readonly string[]
}

/** 推理输出的一个增量。 */
export interface InferenceChunk {
  /**
   * 增量类型：
   * - `text`：正文。
   * - `reasoning`：推理模型的思考过程（思维链）。
   * - `tool-call`：模型请求调用工具。
   * - `done`：结束标记。
   */
  type: 'text' | 'reasoning' | 'tool-call' | 'done'
  /** 当 type 为 `text` 或 `reasoning` 时的文本片段。 */
  text?: string
  /** 当 type 为 `tool-call` 时的工具名。 */
  toolName?: string
  /** 当 type 为 `tool-call` 时的参数（未经校验的原始对象）。 */
  toolArgs?: unknown
}

/**
 * 工具定义。
 *
 * `parameters` 用 JSON Schema 描述，而不是自定义 DSL：模型侧普遍按 JSON Schema
 * 理解参数，换成别的格式要在适配层做一次翻译，而翻译是最容易出错的地方。
 */
export interface ToolDefinition {
  /** 工具名，全局唯一，须匹配 `^[a-z][a-z0-9_]*$`。 */
  name: string
  /** 给模型看的说明。写不清模型就会乱调，这部分属于产品文案。 */
  description: string
  /** 参数的 JSON Schema。 */
  parameters: Record<string, unknown>
  /**
   * 执行函数。
   *
   * @param args 已通过 {@link ToolDefinition.parameters} 校验的参数。
   * @returns 工具结果，会被序列化为字符串写回会话。
   */
  execute(args: unknown): Promise<unknown>
}

/** 内核的四项职责汇总，装配时一次性注入。 */
export interface KernelParts {
  sessions: SessionStore
  models: ModelAdapter
  tools: readonly ToolDefinition[]
}
