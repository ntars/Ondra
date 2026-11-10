/**
 * dsh 内核与外界之间的线上协议（唯一真源）。
 *
 * ## 这个文件为什么存在
 *
 * 空谷 2.1.2 有三个进程：Tauri 壳（Rust）、Cordis 宿主（Node）、dsh 内核（Node）。
 * 三者之间只要各写一份协议定义，迟早会漂移成三份不一致的"差不多"。
 * 所以协议只在这里定义一次：内核实现它，`dsh-client` 插件引用它，
 * 壳侧只按它转发字节，不解释内容。
 *
 * ## 为什么用 JSON-RPC 2.0 而不是自定义格式
 *
 * 1. **请求与响应靠 id 配对**，并发请求不会串话，不需要自己发明序号管理。
 * 2. **错误对象有标准结构**（code / message / data），失败原因能机器判定。
 * 3. **通知（notification）不带 id**，服务端主动推送事件时不会被误当作请求。
 * 4. 规范足够小，一屏能读完，实现不需要第三方库。
 *
 * 参考规范：https://www.jsonrpc.org/specification
 */

/**
 * 协议版本。
 *
 * 语义为「主版本.次版本」：
 * - 主版本变化 = 不兼容改动，旧客户端必须拒绝连接，而不是"尽力兼容"。
 * - 次版本变化 = 只增不改，旧客户端可以继续工作。
 *
 * 握手时双方交换此值；主版本不一致即拒绝，避免用错误的语义解析消息。
 */
export const PROTOCOL_VERSION = '1.0'

/**
 * 单条消息的字节上限（16 MiB）。
 *
 * 存在的理由：内核与宿主之间走管道，若不设上限，一个写错的循环能在几秒内
 * 吃掉整机内存。16 MiB 足以容纳最长的对话上下文，又远小于失控增长的量级。
 * 超限按协议错误处理并断开连接，而不是截断——截断会产生无法定位的解析错误。
 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/**
 * JSON-RPC 2.0 标准错误码。
 *
 * 数值范围是规范规定的，不可自创同义码：
 * - -32700 解析失败：收到的字节不是合法 JSON。
 * - -32600 请求无效：是合法 JSON，但不是合法的 JSON-RPC 请求对象。
 * - -32601 方法不存在：方法名未注册。
 * - -32602 参数无效：方法存在，但参数不符合其签名。
 * - -32603 内部错误：方法执行中抛出未捕获异常。
 *
 * 应用级错误必须使用 -32000 至 -32099 区间，见 {@link KernelErrorCode}。
 */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

export type RpcErrorCodeValue = (typeof RpcErrorCode)[keyof typeof RpcErrorCode]

/**
 * 本协议特有的错误码，落在规范的保留区间 -32000 ~ -32099 内。
 *
 * 与标准码分开的原因：调用方需要对"重试有没有用"做判断。
 * 协议版本不符重试无用，内核忙则稍后重试有用——混在同一个码里就无法区分。
 */
export const KernelErrorCode = {
  /** 协议主版本不兼容。重试无用，必须升级其中一端。 */
  ProtocolMismatch: -32000,
  /** 内核尚未完成启动，暂时无法处理请求。稍后重试有效。 */
  KernelNotReady: -32001,
  /** 内核正在关闭，拒绝新请求。重试无用。 */
  KernelShuttingDown: -32002,
  /** 请求超时。可重试。 */
  Timeout: -32003,
  /** 该能力在当前版本尚未实现。重试无用。 */
  NotImplemented: -32004,
} as const

export type KernelErrorCodeValue = (typeof KernelErrorCode)[keyof typeof KernelErrorCode]

/** 请求 id。规范允许字符串、数字或 null，本项目只使用数字与字符串，禁止 null 作为请求 id。 */
export type RequestId = string | number

/** JSON-RPC 2.0 请求对象。必须带 id，服务端须回响应。 */
export interface RpcRequest {
  jsonrpc: '2.0'
  id: RequestId
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 通知对象。不带 id，服务端不得回响应。 */
export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 错误对象。 */
export interface RpcErrorObject {
  code: number
  message: string
  data?: unknown
}

/** JSON-RPC 2.0 成功响应。result 与 error 二者必有其一。 */
export interface RpcSuccessResponse {
  jsonrpc: '2.0'
  id: RequestId
  result: unknown
}

/** JSON-RPC 2.0 失败响应。 */
export interface RpcErrorResponse {
  jsonrpc: '2.0'
  id: RequestId | null
  error: RpcErrorObject
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

/** 线上流动的任意一条消息。 */
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse

// ---------------------------------------------------------------------------
// 方法名（内核对外暴露的能力）
// ---------------------------------------------------------------------------

/**
 * 全部方法名集中在此，避免调用方与实现方各写一份字符串字面量而拼错。
 *
 * 约定：`<域>.<动作>`，域只有四个，对应内核的四项职责。
 */
export const Method = {
  /** 握手。双方确认协议版本与内核能力范围。 */
  Handshake: 'kernel.handshake',
  /** 优雅关闭。内核完成收尾后退出进程。 */
  Shutdown: 'kernel.shutdown',
  /** 健康检查。壳侧用于判断内核是否仍然活着。 */
  Ping: 'kernel.ping',

  /** 会话：创建。 */
  SessionCreate: 'session.create',
  /** 会话：读取元信息。 */
  SessionGet: 'session.get',
  /** 会话：列出全部会话。 */
  SessionList: 'session.list',
  /** 会话：归档。不删除数据，只从活跃列表移出。 */
  SessionArchive: 'session.archive',
  /**
   * 会话：读取全部消息。
   *
   * 与 `session.get` 分开的理由：列表页只要标题与时间，一次拉几十个会话的
   * 元信息是几百字节；而一旦把消息正文塞进同一个方法，列表请求会变成几 MB。
   * 两件事的数据量相差三个数量级，不该共用一个方法。
   */
  SessionMessages: 'session.messages',
  /**
   * 会话：删除单条消息。
   *
   * `seq` 是消息在 `session.messages` 返回数组里的下标（0 基）。用下标
   * 而不是消息 id，是因为删除要落到存储的 `splice` 上，而下标正是存储
   * 自己的顺序——先查 id 再换算下标的那一次读取，会与并发写入抢跑。
   *
   * 越界不报错，返回 `{ removed: false }`：连点两次删除时第二次落空是
   * 正常竞态，把它当故障会让界面弹一条没有意义的错误。
   */
  SessionDeleteMessage: 'session.deleteMessage',
  /**
   * 会话：清空全部消息。
   *
   * 与 {@link SessionArchive} 的区别：归档把整段移出活跃列表但正文不删，
   * 清空是真的把消息删掉。返回 `{ cleared: 删除条数 }`。
   */
  SessionClear: 'session.clear',

  /**
   * 推理：发起一轮对话。返回本轮最终答复。
   *
   * `input` 可省略（= 不追加用户消息）。省略时它是「她主动开口」：模型接着
   * 已有历史往下说。配合可选的 `nudge`（本次运行临时存在的 system 提示，
   * 不落盘）才能让她真的开口，否则模型只会接着自己上一句自问自答。
   *
   * `system` 是**本轮的系统提示词**（人格 + 片段），同样不落盘，插在整段
   * 历史之前。它与 `nudge` 分开而不是合并成一句：`system` 说明「她是谁」，
   * `nudge` 说明「这次为什么开口」。合并会让主动开口那一轮的人格也变成
   * 一次性提示，下一轮回话时人格就没了。
   */
  InferenceRun: 'inference.run',
  /** 推理：中断正在进行的一轮。幂等，未在运行时调用无副作用。 */
  InferenceAbort: 'inference.abort',

  /** 工具：列出当前已注册的工具。 */
  ToolList: 'tool.list',
  /** 工具：调用单个工具。 */
  ToolInvoke: 'tool.invoke',

  /** 模型：列出可用模型。 */
  ModelList: 'model.list',
  /** 模型：设置当前使用的模型。 */
  ModelSelect: 'model.select',
  /**
   * 模型：写入供应商配置。
   *
   * 为什么配置由外部推进来而不是内核自己读配置文件：内核不接触磁盘路径，
   * 就能被放进任何沙箱里运行；配置的持久化归宿主（它能写用户目录），
   * 内核只负责"给定端点与密钥，怎么把话说出去"这一件事。
   * 传入的列表会整体替换旧配置——增量合并会让"删掉一个模型"无法表达。
   */
  ModelConfigure: 'model.configure',
  /**
   * 模型：一次性补全（非流式）。
   *
   * ## 为什么它必须由内核提供，而不能由宿主自己发 HTTP
   *
   * 宿主里有两条「要模型但不要流」的调用：记忆提炼（O-011）与做梦（O-019）。
   * 它们的模型从哪来？答案只能是**用户已经配好的那份**——供应商清单住在
   * 内核的 `ChatAdapter` 里（`model.configure` 推过去的），密钥也在那里。
   * 宿主自己发请求就得把密钥再复制一份、把"请求体怎么拼"再实现一遍，
   * 于是同一个供应商在两个地方各有一套超时与错误处理，迟早不一致。
   *
   * 所以这里把「已经能说话的那条链路」开一个非流式口子：请求照旧走
   * `ChatAdapter`，宿主只拿来一段文本。
   *
   * ## 为什么与 `inference.run` 分开
   *
   * `inference.run` 会**落盘**：写用户消息、写助手消息、推 delta 事件。
   * 提炼与做梦的提示词是**内部指令**，不是对话，落盘会让下次读历史时
   * 把它们当成用户说过的话再喂回去（`nudge` 那段注释里记过同一个坑）。
   *
   * 参数：`{ model?, messages: Array<{role,content}>, system?, temperature?, maxTokens? }`
   * 返回：`{ text, model }`。
   */
  ModelComplete: 'model.complete',
} as const

export type MethodName = (typeof Method)[keyof typeof Method]

// ---------------------------------------------------------------------------
// 内核主动推送的事件（notification）
// ---------------------------------------------------------------------------

/**
 * 内核推送的事件名。
 *
 * 与 {@link Method} 分开命名：这些是内核单向发出的，调用方不能"请求"它们，
 * 只能订阅处理。命名前缀 `event.` 让日志里一眼能分辨方向。
 */
export const EventName = {
  /** 内核已完成启动，可以接收请求。 */
  Ready: 'event.ready',
  /** 一轮推理产生了正文增量。 */
  InferenceDelta: 'event.inference.delta',
  /**
   * 推理模型的思考过程增量。
   *
   * 与正文分成两个事件而不是塞进 {@link InferenceDelta} 加个标记：
   * 客户端对这两者的处理完全不同（正文要落盘、思考不该落盘；
   * 正文按段渲染、思考要折叠）。分成两个事件让"该不该存"这件事
   * 在协议层就清楚，客户端不必再看字段判断。
   */
  InferenceReasoning: 'event.inference.reasoning',
  /** 一轮推理结束（正常或中断）。 */
  InferenceDone: 'event.inference.done',
  /** 工具调用开始。 */
  ToolStarted: 'event.tool.started',
  /** 工具调用结束。 */
  ToolFinished: 'event.tool.finished',
  /** 内核即将关闭。 */
  ShuttingDown: 'event.shutting-down',
} as const

export type EventNameValue = (typeof EventName)[keyof typeof EventName]

// ---------------------------------------------------------------------------
// 握手载荷
// ---------------------------------------------------------------------------

/**
 * 握手请求参数。
 *
 * `clientVersion` 只用于日志与诊断，不参与兼容判定——真正决定能否通信的是
 * {@link PROTOCOL_VERSION}。要求客户端版本会迫使每次发版都同步改内核，得不偿失。
 */
export interface HandshakeParams {
  protocolVersion: string
  /** 发起方标识，用于区分是壳直连还是宿主代理。 */
  client: 'shell' | 'host'
  /** 调用方版本号，仅用于诊断。 */
  clientVersion: string
}

/** 握手响应结果。 */
export interface HandshakeResult {
  protocolVersion: string
  /** 内核名称，固定为 `dsh`，用于确认连对了进程。 */
  kernel: 'dsh'
  /** 内核版本。 */
  version: string
  /** 内核当前支持的方法名列表，调用方据此裁剪 UI，而不是逐个试探。 */
  methods: readonly string[]
  /** 内核是否已完成初始化。为 false 时除 handshake 与 ping 外的方法都会失败。 */
  ready: boolean
}

// ---------------------------------------------------------------------------
// 类型守卫
// ---------------------------------------------------------------------------

/**
 * 判断一个已解析的值是否为合法请求。
 *
 * 严格按规范检查：`jsonrpc` 必须是字面量 `'2.0'`，`method` 必须是非空字符串，
 * `id` 必须是字符串或数字。`id: null` 被归为非法——本项目不用 null 作请求 id，
 * 否则无法把它与"响应里的 null id"区分开。
 */
export function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.jsonrpc !== '2.0') return false
  if (typeof candidate.method !== 'string' || candidate.method.length === 0) return false
  const id = candidate.id
  return typeof id === 'string' || typeof id === 'number'
}

/**
 * 判断是否为合法通知。
 *
 * 关键判据是**没有 id 字段**，而不是 `id` 为假值：规范明确规定
 * 带 `id: null` 的是请求（须回响应），不带 id 的才是通知（不得回响应）。
 * 用 `!('id' in value)` 而非 `value.id === undefined` 才能正确区分两者。
 */
export function isRpcNotification(value: unknown): value is RpcNotification {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.jsonrpc !== '2.0') return false
  if (typeof candidate.method !== 'string' || candidate.method.length === 0) return false
  return !('id' in candidate)
}
