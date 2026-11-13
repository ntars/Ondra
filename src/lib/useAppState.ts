/**
 * 应用状态。
 *
 * ## 为什么把状态放在一个钩子里
 *
 * 这个应用有一个"当前正在聊的那个会话"贯穿多个组件：输入框要发消息进它、
 * 对话区要显示它、设置面板要在历史列表里标出它。若各组件各自持有，
 * 就会出现在 A 组件里切换了会话、B 组件还显示旧的。
 *
 * ## 视图如何决定
 *
 * 没有路由。视图由两个事实推出：有没有会话、有没有消息。
 * 这样"从首页打字"和"从历史里点开一个对话"走的是同一条代码路径——
 * 它们本来就是一回事，只是入口不同。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getConnection,
  getConnectionError,
  isLocalMode,
  onConnectionChange,
  setConnection,
  setConnectionFailure,
  waitForHost,
} from './host.ts'
import { invokeShell, isShellUnavailable, listenShell } from './shell.ts'
import type { HostReadyPayload, ShellHostState } from './shell.ts'
import {
  abortInference,
  checkProactive,
  clearSession,
  declineProactive as declineProactiveCall,
  deleteMessage as deleteMessageCall,
  fetchHealth,
  getCompanionState,
  getConfig,
  getCurrentSession,
  getMessages,
  getSessionLogs,
  getSessionStats,
  listMemory,
  listModels,
  runInference,
  selectModel,
} from './api.ts'
import type { CompanionState, ModelDescriptor, PermissionLevel, SessionMessage, SessionStats, ThemeMode } from './api.ts'
import { setPreferences, usePreferences } from './preferences.ts'
import { relativeTime } from './time.ts'
import { moodWord } from './moodColor.ts'
import { playCue } from './sound.ts'
import { notify } from './notify.ts'
import { DECLINE_LIMIT, UNDO_WINDOW_MS, noteDecline, clearDeclines } from './proactive.ts'
import type {
  Attachment, BondStats, ComposerUsage, LogEntry, MemoryItem, MoodState, QueuedMessage,
} from './types.ts'

/**
 * 语音识别实例的最小形状。
 *
 * Web Speech API 在 TypeScript 标准库里没有完整类型，且 Safari 上挂在
 * `webkitSpeechRecognition`。这里只声明用到的四个回调与两个方法，
 * 其余不关心的字段一律不写，避免引入一份不可靠的全局声明。
 */
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  stop(): void
}

/** 一次识别的结果。 */
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}

/** 语音识别构造器。 */
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/**
 * 取语音识别构造器。
 *
 * 标准 API 在 `window.SpeechRecognition`，但 Safari 只实现了带前缀的
 * `webkitSpeechRecognition`。两者都试，都没有时返回 undefined，
 * 调用方据此给出"不支持"的提示而不是抛错。
 */
function getSpeechRecognition(): SpeechRecognitionCtor | undefined {
  const w = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/** 连接阶段。 */
export type ConnectionPhase = 'connecting' | 'ready' | 'failed'

/**
 * 连接超时阈值：8 秒（§12.13）。
 *
 * ## 为什么是 8 而不是更大或更小
 *
 * 本地宿主冷启动实测 1–3 秒（Node 起来 + 加载插件 + 绑端口）。
 * 8 秒留了两倍余量，够慢机器用；再长用户会开始怀疑应用坏了，
 * 而那段时间界面只有骨架，没有任何进度可看。
 *
 * ## 这个数只用于「判定失败」，不用于「显示进度」
 *
 * 超时之前**不显示任何「正在连接」文字**（§12.13 明文）。本地启动
 * 通常不到一秒，一行会闪一下就没的提示比没有更让人焦虑。
 */
const CONNECT_TIMEOUT_MS = 8_000

/** 一条待渲染的消息。 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 落盘时间。日志按它排序，缺失时用 0 兜住（老数据没有该字段）。 */
  at: number
  pending?: boolean
  /**
   * 本轮的思考过程（推理模型的思维链）。
   *
   * 只存在于"正在生成"的那条消息上，不落盘、不进历史。
   * 对话区不显示它——主人要求「对话界面保持干净」，
   * 完整思考过程去左栏「日志」看。
   */
  reasoning?: string
  /**
   * 她主动开口时的判据摘要（§6.4 E）。
   *
   * `undefined` = 普通回复。**空串是有意义的取值**：它表示「这条是主动
   * 开口，但门控没给出可读理由」。用 `undefined` 表达「没有理由」会让
   * 「普通回复」与「主动但没理由」两件事混在一起，前者不该显示那一行，
   * 后者必须显示（否则用户会觉得她莫名其妙开口）。
   *
   * 只存在于内存与本次渲染：宿主不落这个字段，所以刷新后主动标记消失。
   * 这是刻意的——判据说的是「当时为什么开口」，事后重看没有意义，
   * 而把它落盘就要在协议里加一个只为回忆存在的字段。
   */
  proactive?: string
}

/** 应用状态。 */
export interface AppState {
  phase: ConnectionPhase
  /** 失败原因，仅在 phase 为 failed 时有值。 */
  error: string | undefined

  /** 当前会话 id。undefined 表示还没有会话（新装应用，或刚清空的那一瞬）。 */
  sessionId: string | undefined
  /** 当前会话标题。 */
  title: string
  /** 当前会话的消息。 */
  messages: ChatMessage[]
  /**
   * 从磁盘重新读一遍当前会话。
   *
   * 只有一个调用方：设置里的「导入对话」。那条路会让**宿主**换掉当前段
   * （归档旧段、建新段），而界面手里的消息还是旧的。这里不重做一遍
   * "导入"的逻辑，只把界面对齐到宿主的事实上——两处各算一次必然漂开。
   */
  reload(): Promise<void>
  /**
   * 当前会话统计。
   *
   * `undefined` 表示还没有会话。**不在这里自己算**：已归档段数只有内核
   * 的会话总表知道，界面手里只有当前这一段。
   */
  stats: SessionStats | undefined

  /** 是否正在生成。 */
  busy: boolean
  /** 输入框内容。 */
  draft: string
  /** 对话中的错误提示（与 phase 的 error 分开：这个不影响连接状态）。 */
  chatError: string | undefined
  /** 权限档位。 */
  permission: PermissionLevel

  /** 可选模型列表。 */
  models: ModelDescriptor[]
  /** 当前模型 id。 */
  modelId: string | undefined
  /** 切换模型。 */
  setModel(id: string): void
  /**
   * 重拉模型列表与当前选中项。
   *
   * ## 为什么需要它
   *
   * 列表与选中项都在宿主就绪时只拉一次。而「模型与 API」设置页可以随时
   * 增删供应商——那之后不重拉，用户会看到「设置里明明加了、选择器里
   * 没有」，只能重启应用才认。设置页存完就调这个。
   *
   * 读的是宿主的事实（`GET /api/config` + `GET /api/models`），不在前端
   * 自己拼一份：拼出来的那份迟早与宿主的 `currentModel` 漂开。
   */
  refreshModels(): Promise<void>

  /** 已选附件。 */
  attachments: Attachment[]
  /** 弹出系统文件选择并附加。无壳时静默无操作。 */
  addFiles(): void
  /**
   * 直接附加一批（粘贴图片用，§12.14）。
   *
   * 与 `addFiles` 分开而不是加一个可选参数：那条路走系统选择器、
   * 拿回来的是路径；这条路不走选择器、拿回来的是内存里的缩略图。
   * 硬合成一个函数，内部就要按「有没有 path」分叉两次，
   * 而两条路的入参形状根本没有交集。
   */
  addAttachments(items: readonly { name: string; thumb?: string }[]): void
  /** 移除一条附件。 */
  removeAttachment(id: string): void

  /** 排队等这一轮结束的消息，按发送顺序。 */
  queue: QueuedMessage[]
  /** 把当前草稿排进队列（生成中按 Enter、点发送都会走这里）。 */
  enqueue(): void
  /** 移除一条排队消息。 */
  dropQueued(id: string): void
  /** 改一条排队消息的正文。 */
  editQueued(id: string, text: string): void
  /** 上移 / 下移一条排队消息。 */
  moveQueued(id: string, direction: -1 | 1): void

  /** 是否正在录音。 */
  voiceActive: boolean
  /** 切换语音输入（仅在支持的环境下有效）。 */
  toggleVoice(): void

  /** 主题模式。默认跟随系统。 */
  theme: ThemeMode
  /** 切换主题。 */
  setTheme(theme: ThemeMode): void

  /** 日志时间轴。由当前会话消息推导。 */
  logs: LogEntry[]
  /** 右栏「此刻」读数。 */
  mood: MoodState
  /** 右栏「TA 对你」统计。 */
  bond: BondStats
  /**
   * 右栏「此刻」的张力，0..1 单极量。
   *
   * `undefined` 表示这一路没有读数（情绪服务缺席，或还没测量）。
   * 0 是有意义的真值——它是静息态（没有冲突锁），**不是**「没测到」。
   * 心情与精力也在 0..100 / 0..1 这套单极刻度里，三者不必再分开记刻度。
   */
  tension: number | undefined
  /** 右栏「记得的事」。 */
  memories: MemoryItem[]
  /** 记忆读不到的原因码。undefined 表示读取正常（空列表是真的没有）。 */
  memoryFault: string | undefined
  /** 右栏状态块的更新时间。 */
  companionUpdatedAt: number
  /** 本轮用量。没有则 undefined。 */
  usage: ComposerUsage | undefined

  /** 叫出桌宠。 */
  summonPet(): void

  setDraft(value: string): void
  send(): Promise<void>
  stop(): Promise<void>
  /**
   * 清空全部：把当前段归档成一段，再开一段空的。
   *
   * 名称沿用 `newChat`（快捷键、调试动作、返回键都在调它），语义在单会话制
   * 下只剩「清干净」——不再有第二个容器可以「换过去」。
   */
  newChat(): Promise<void>
  /**
   * 删除一条消息。
   *
   * @param messageId 消息 id。本地还没落盘的消息（`local-` / `reply-` 开头）
   *   删不掉——宿主的消息表里没有它，如实返回失败。
   */
  deleteMessage(messageId: string): Promise<void>
  setPermission(permission: PermissionLevel): void
  dismissChatError(): void
  /** 重试连接。 */
  retry(): void

  /**
   * 让她主动开口（§6.4 E、§7.4）。
   *
   * ## 为什么是「界面主动去问」而不是「宿主推过来」
   *
   * 宿主推的话需要一条常驻定时器，而 §14.2 要求零常驻。更要紧的是：
   * 用户此刻在不在看、上一次开口过了多久、会话是不是晾着——这些判断
   * 有一半只有界面知道。界面在「这一个会话安静下来了」时问一次，
   * 时机天然正确，且没有任何东西在没有用户时白跑。
   *
   * 方法内部依次做三件事：问门控 → 生成 → 上图并挂判据。
   * 门控说不行就**安静地什么都不做**：这不是错误，不该弹提示
   * （§7.5「除用户主动操作外无 2 级以上打扰」）。
   *
   * @returns 是否真的开口了。`false` 表示门控没放行或生成失败。
   */
  speakUp(): Promise<boolean>

  /**
   * 用户点了「这次不用」（§6.4 E）。
   *
   * 撤下那条消息、记一次拒绝。连续三次后当日不再主动（§7.4）。
   *
   * @param messageId 要撤下的那条消息 id。
   */
  declineProactive(messageId: string): Promise<void>

  /**
   * 还没有被撤下的那条主动消息的 id。
   *
   * 同一时刻最多一条：§7.4 的预算是「一次打扰」，两条同时挂着撤回按钮
   * 会让「这次不用」变成「这两个哪个」。新的一条出现时旧的自动收起窗口，
   * 消息本身留着。
   */
  undoable: string | undefined

  /**
   * 上一次门控建议的等待时长（毫秒）。`0` 表示它没说。
   *
   * 由 `speakUp` 写入，给 `useProactiveTick` 决定下次何时再问。
   * 之所以要把它递出来、而不是让界面自己定一个重试间隔：
   * 「多久之后可以再问」是插件算出来的（静默时段还剩几分钟、冷却还剩
   * 多久），界面猜一个数就是在两处维护同一份算术。
   */
  lastDeferMs(): number
}

/**
 * 主状态钩子。
 *
 * @returns 应用状态与操作方法。
 */
export function useAppState(): AppState {
  const [phase, setPhase] = useState<ConnectionPhase>(() => {
    // 初始值直接读模块状态：壳可能在 React 挂载前就发出了 ready 事件，
    // 此时若还从 'connecting' 起步，界面会白 wait 一轮。
    if (getConnection() !== undefined) return 'ready'
    if (getConnectionError() !== undefined) return 'failed'
    return 'connecting'
  })
  const [error, setError] = useState<string | undefined>(() => getConnectionError())
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  /** 当前会话统计。单会话制下只有这一份。 */
  const [stats, setStats] = useState<SessionStats | undefined>(undefined)
  const [memories, setMemories] = useState<MemoryItem[]>([])
  /**
   * 记忆读不到时的原因码。
   *
   * 与「列表为空」分开存：`no-memory-core` 意味着记忆引擎没装，
   * `list-failed` 意味着库读挂了。两种都不该在界面上显示成
   * 「她还没记住什么」——那是把故障说成了状态。
   */
  const [memoryFault, setMemoryFault] = useState<string | undefined>(undefined)
  /**
   * 她的此刻：情绪六维与关系七阶的宿主读数。
   *
   * `undefined` 表示**还没读到**（首帧、宿主未就绪），它与「读到了但
   * 没测量」是两件事：前者不该让侧写闪一次「尚未测量」，后者必须显示它。
   */
  const [companion, setCompanion] = useState<CompanionState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [chatError, setChatError] = useState<string | undefined>(undefined)
  const [permission, setPermissionState] = useState<PermissionLevel>('workspace')

  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [modelId, setModelId] = useState<string | undefined>(undefined)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  /**
   * 排队等这一轮结束的消息。
   *
   * ## 为什么需要它（这是一个真缺陷的修复）
   *
   * 设置里可以选「生成中按 Enter = 排队」。但上一版的实现里，`send` 的第一
   * 句就是 `if (busy) return`——于是「排队」这个档位的实际行为是**消息消失**：
   * 输入框被清空、什么都没发出去、界面上也没有任何一处显示它去了哪。
   *
   * 用户选了「排队」，得到的是「静默丢弃」。这个队列就是补上那一段。
   *
   * ## 自动发送的时机
   *
   * 上一轮**正常结束**之后（`finally` 里 `setBusy(false)` 之后由 effect 放行）。
   * 不在这里判「成功还是失败」：失败也有 `chatError` 显示着，而把排队的
   * 那句话继续压着不发，用户会以为它也丢了。
   */
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  /** 防止 drain effect 在同一帧里连发两条。 */
  const draining = useRef(false)
  const [voiceActive, setVoiceActive] = useState(false)
  /** 最近一轮的用量统计。没有真实数据时保持 undefined，界面不显示这一行。 */
  const [usage, setUsage] = useState<ComposerUsage | undefined>(undefined)
  /**
   * 日志时间轴。
   *
   * 双来源：本轮正在发生的事由 `send()` 实时追加，历史轮次由消息推导。
   * 只靠推导拿不到「想了 1.2 秒」——推理时长只存在于流的过程中，
   * 落盘的只有最终正文。只靠实时也会丢历史（重开会话就没了）。
   * 所以两者合流：实时写的进 state，打开会话时用推导结果重置。
   */
  const [logs, setLogs] = useState<LogEntry[]>([])
  /** 当前轮次号。发送时自增，打开历史会话时对齐到已推导出的最大轮次。 */
  const roundRef = useRef(0)
  /** 右栏状态块的更新时间。 */
  const [companionUpdatedAt, setCompanionUpdatedAt] = useState(() => Date.now())

  /**
   * 正在挂着撤回窗口的那条主动消息。
   *
   * 同一时刻最多一条（见 `AppState.undoable` 的注释）。用一个 id 而不是
   * 一个布尔：撤回按钮要知道自己属于哪一条，否则两条主动消息相邻时
   * 会撤错。
   */
  const [undoable, setUndoable] = useState<string | undefined>(undefined)

  /**
   * 撤回窗口的倒计时器。
   *
   * 放 ref 里而不是 state：它变化不该触发渲染（渲染只看 `undoable`
   * 与剩余时间快照），而且要在新的一条出现时把上一条的计时器清掉。
   */
  const undoRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  /**
   * 上一次她主动开口的时刻。
   *
   * 冷却判据在宿主（`ondra-proactive-gate` 有自己的 `lastByConversation`），
   * 这里这一份**只用于界面侧的一个判断**：同一会话在两分钟内不重复请求。
   * 那不是在复刻九道闸，而是避免「界面每次重渲染都去问一遍门控」——
   * 一次请求会消耗额度，反复问就会把额度问光。
   */
  const spokeAtRef = useRef(0)

  /**
   * 门控建议的下次可问时刻（毫秒时间戳）。`0` 表示它没说。
   *
   * 存成 ref 而不是 state：它只在 `useProactiveTick` 的重试逻辑里被读一次，
   * 不参与渲染。放 state 会让每次被拦下都触发一次整树重渲染——而被拦下
   * 恰恰是最不该有界面变化的情况。
   */
  const deferUntilRef = useRef(0)

  /*
   * 主题不再是本文件的状态。
   *
   * ## 为什么让出去
   *
   * 偏好设置是独立窗口。主题、字号、发送方式三件事现在由
   * `lib/preferences.ts` 统一持有并跨窗口同步。若这里再存一份，
   * 用户在偏好窗口点「深色」时主窗口这份不会变——`data-theme` 会被
   * 两个来源来回写，谁后写谁赢，表现为「按了但有时不生效」。
   *
   * `setTheme` 保留同名，是因为调用点（快捷键、Composer）不该关心
   * 数据存在哪；它只是转发。
   */
  const preferences = usePreferences()
  const theme = preferences.theme

  /** 当前流式请求的取消器。 */
  const controller = useRef<AbortController | undefined>(undefined)
  /** 语音识别实例。浏览器/WebView 不支持时为 undefined。 */
  const recognizer = useRef<SpeechRecognitionLike | undefined>(undefined)

  /**
   * 往日志时间轴追加一条。
   *
   * 用 ref 计数器生成 id 而不是 Math.random：日志 id 只做 React key 与
   * 展开状态的小键，保证同一次运行内稳定递增即可，且便于测试时断言顺序。
   */
  const logSeq = useRef(0)
  /** 排队消息的本地序号。与日志 id 同理：只做 key，自增即可。 */
  const queueSeq = useRef(0)
  const pushLog = useCallback((entry: Omit<LogEntry, 'id'>): void => {
    logSeq.current += 1
    const id = `log-${String(logSeq.current)}`
    setLogs((previous) => [...previous, { ...entry, id }])
  }, [])

  /**
   * 把界面上的消息同步成落盘版本。
   *
   * ## 为什么只同步消息，不重新拉日志
   *
   * 实时日志里有「想了多久」，那是落盘数据推不出来的（思考过程不存）。
   * 这一条只负责 id：本轮刚发出的消息在界面上是 `local-` / `reply-` 开头的
   * 临时 id，拿它去问后端删消息会找不到人。换成内核的 UUID，删除才成立。
   *
   * ## 为什么可以整表替换
   *
   * 旧消息的 id 本来就是 UUID，替换后 React key 不变、DOM 不重建；
   * 只有本轮那两条会换 key，而它们的内容与样式完全一样，看不出重排。
   *
   * ## 为什么定义在 `send` 之前
   *
   * `send` 与 `speakUp` 的 finally 都要调它。`const` 的初值在声明语句执行前
   * 不可访问，若把这条放到文件后半段，那两处在首次渲染时就会命中 TDZ。
   *
   * @param id 会话 id。省略时用当前会话。
   * @param keepProactive 若给出，把它补回**最后一条助手消息**的 `proactive`。
   *
   * ## `keepProactive` 为什么必须存在
   *
   * 内核落盘的是一条纯消息（id / role / 正文 / 时间），**没有「她为什么
   * 开口」这个字段**——理由只存在于界面状态里。而她主动说完话之后必须换
   * 一次 id（否则「删除」对它无效：界面上是 `proactive-…`，盘上是 UUID，
   * 拿前者的 id 去问后端会找不到人）。整表替换会把那行判据一起冲掉，
   * 用户只来得及看一眼「她主动开口 · 想问你雨停了没」，几百毫秒后它就没了。
   * 所以这里在替换后把判据补回最后一条助手消息上。
   */
  const syncMessages = useCallback(async (id?: string, keepProactive?: string): Promise<void> => {
    const current = id ?? sessionId
    if (current === undefined || current === '') return
    try {
      const rows = withTimestamps(await getMessages(current))
      /*
       * 只在「最后一条确实是助手消息」时补回判据：用户可能在她说完之后
       * 紧接着发了一条，此刻最后一条是用户消息，把那行理由挂上去就是错标。
       */
      const last = rows[rows.length - 1]
      if (keepProactive === undefined || last === undefined || last.role !== 'assistant') {
        setMessages(rows)
        return
      }
      setMessages(rows.map((row, index) => (
        index === rows.length - 1 ? { ...row, proactive: keepProactive } : row
      )))
      /*
       * 三秒撤回窗口认的是**消息 id**。替换之后 id 从 `proactive-…` 变成内核
       * 的 UUID，不跟着挪的话「这次不用」会立刻消失——用户根本没机会按，
       * 而 §7.4 承诺的正是「三秒内可撤回」。
       */
      setUndoable((previous) => (previous === undefined ? previous : last.id))
    } catch (caught) {
      // 同步失败只影响删除按钮，不该打断正在进行的对话。
      console.error('同步消息 id 失败', caught)
    }
  }, [sessionId])

  /**
   * 完整载入当前会话：元信息、消息、日志、统计。
   *
   * ## 为什么启动就要载入
   *
   * 单会话制下没有「首页」这个不显示对话的形态。打开应用看到的就是那一段
   * 对话的末尾——若还要用户再点一次才能看见，那个点击没有任何信息量。
   *
   * ## 为什么四项并发
   *
   * 它们描述同一段会话。串行会让时间线先出现、统计后跳出来，抽屉里那四项
   * 数在几百毫秒内先是旧的——用户读到的是「怎么对不上」。
   */
  const refreshCurrent = useCallback(async (): Promise<void> => {
    try {
      const meta = await getCurrentSession()
      if (meta === null) {
        // 还没有会话。这不常见，但清空之后到第一次说话之间就是这个状态。
        setSessionId(undefined)
        setTitle('')
        setMessages([])
        setStats(undefined)
        setLogs([])
        roundRef.current = 0
        return
      }
      const [rows, derived, nextStats] = await Promise.all([
        getMessages(meta.id),
        getSessionLogs(meta.id),
        getSessionStats(meta.id),
      ])
      setSessionId(meta.id)
      setTitle(meta.title)
      setMessages(withTimestamps(rows))
      // 日志由服务端派生，界面只负责渲染。轮次对齐到最大一条，
      // 下一次发送接着往下数，否则新消息会重新从第 1 轮开始、与历史撞号。
      setLogs(derived)
      roundRef.current = derived.reduce((max, entry) => Math.max(max, entry.round), 0)
      setStats(nextStats)
    } catch (caught) {
      // 读取失败不打断主链路：界面仍可发消息，发送那一路会自己建会话。
      console.error('载入当前会话失败', caught)
    }
  }, [])

  /**
   * 只刷新元信息与统计。
   *
   * 一轮回答结束后用这条，而不是上面那条完整的：那时消息已经由流式回调
   * 写在界面上，重新拉一遍会把它整体替换成落盘版本，气泡 id 跟着变，
   * 列表会闪一次。标题与统计才是这一轮真正可能变了的东西。
   */
  const refreshSessionMeta = useCallback(async (): Promise<void> => {
    try {
      const meta = await getCurrentSession()
      if (meta === null) return
      setSessionId((previous) => previous ?? meta.id)
      setTitle(meta.title)
      setStats(await getSessionStats(meta.id))
    } catch (caught) {
      console.error('刷新会话统计失败', caught)
    }
  }, [])

  /**
   * 刷新「记得的事」。
   *
   * ## 什么时候拉
   *
   * 就绪后一次、每次一轮回答结束一次。不做定时轮询：记忆只在对话里长，
   * 没有对话就没有新条目，轮询只会让一个静态列表持续打库。
   *
   * ## 失败不抛
   *
   * 记忆面板是旁路信息，它读不到不该让主对话报错。失败时把原因码记进
   * `memoryFault`，界面据此说「读不到她的记忆」，而不是显示空列表。
   */
  const refreshMemories = useCallback(async (): Promise<void> => {
    try {
      const result = await listMemory()
      setMemories(
        result.items.map(row => ({
          id: row.id,
          summary: row.text,
          relative: relativeTime(row.createdAt),
        })),
      )
      setMemoryFault(result.reason)
    } catch (caught) {
      console.error('拉取记忆失败', caught)
      setMemoryFault('request-failed')
    }
  }, [])

  /**
   * 读她的此刻（情绪六维 + 关系阶与四维）。
   *
   * ## 为什么失败不写错误码
   *
   * 记忆那一路有 `memoryFault`，因为「读不到记忆」是用户能理解且能修的
   * 一件事。这一路不同：宿主没就绪、情绪插件没装，界面上已经有各说各话
   * 的出口（侧写里写「尚未测量」、诊断接口里写原因）。再往界面上塞一个
   * 错误码，只会让右栏变成一个报错框。
   *
   * ## 为什么轮询 30 秒
   *
   * 情绪是**会自己衰减的**：不吃不喝 6 小时后心情回基线，这个变化没有
   * 事件可订阅。30 秒的本地请求换来「开着窗口不动，数值也会变」，而
   * 这一屏本来就不追求毫秒级实时。
   */
  const refreshCompanion = useCallback(async (): Promise<void> => {
    try {
      setCompanion(await getCompanionState())
    } catch {
      /* 宿主没起来或接口缺席：保持上一次的读数，不写假数据。 */
    }
  }, [])

  useEffect(() => {
    void refreshCompanion()
    const timer = globalThis.setInterval(() => { void refreshCompanion() }, 30_000)
    return () => { globalThis.clearInterval(timer) }
  }, [refreshCompanion])

  /*
   * 一轮说完立刻刷新。
   *
   * 情绪与关系都是在**轮末**结算的（`feel()` / `touch()` 之后），等下一次
   * 轮询最多差 30 秒——而用户刚聊完就打开侧写，看到的是聊天前的数，
   * 那会让他以为「这个面板根本没在更新」。
   */
  useEffect(() => {
    if (!busy) void refreshCompanion()
  }, [busy, refreshCompanion])

  useEffect(() => {
    const offReady = listenShell<HostReadyPayload>('host-ready', (payload) => {
      setConnection(payload)
      setError(undefined)
      setPhase('ready')
    })
    const offFailed = listenShell<string>('host-failed', (message) => {
      setConnectionFailure(message)
      setError(message)
      setPhase('failed')
    })

    /**
     * 主动拉一次当前状态。
     *
     * ## 为什么光靠事件不够
     *
     * 壳在 `setup()` 里就 `spawn` 了宿主启动任务，而页面（webview）的 JS
     * 要等前端 bundle 下载、解析、React 挂载之后才会注册监听。这段窗口期
     * 通常几百毫秒，冷启动时宿主可能已经就绪并把 `host-ready` 发出去了——
     * 事件是**一次性广播**，错过就没有第二次，界面会永远停在"正在连接"，
     * 而实际上宿主好得很。
     *
     * 主动查询不受这个时序影响：无论事件有没有被听到，都能拿到最新状态。
     * 这也顺带解决了"用户手动重启宿主后界面不更新"的问题。
     *
     * ## 与 `host.ts` 里 `ensureConnection()` 的分工（别写第三份）
     *
     * 那边管的是**连不上**：任何窗口第一次发请求时自动补拉一次连接信息，
     * 专治「偏好设置这个第二窗口收不到一次性广播」。
     * 这里管的是**界面阶段**：把 `ready` / `failed` 落进 React 状态，
     * 还负责「用户手动重启宿主后界面跟着变」。
     *
     * 两处的目的不同，所以都留着；但**只有这里能动 `phase`**，
     * 也只有那边能动 `connection`。谁也别顺手把另一件的活干了。
     */
    /*
     * 本地模式（手机端 / 浏览器预览）：没有壳也没有宿主进程。
     *
     * 直接置 ready，不等任何事件。`host.ts` 里的 `request()` 会在本地
     * 模式下把请求交给本地实现，所以「ready」在这里的含义是
     * 「界面可以开始拉数据了」，而不是「连上了宿主」。
     *
     * 不这样做的话会卡在骨架屏：`pullState()` 拿不到 `get_host_state`
     * 就 return，然后等 `waitForHost` 超时（10 秒），而手机端永远等不到
     * 那个事件——用户看到的是十秒空白后一句「无法连接后台服务」。
     */
    if (isLocalMode()) {
      setPhase('ready')
      setError(undefined)
      return
    }

    const pullState = async (): Promise<void> => {
      let snapshot: ShellHostState
      try {
        snapshot = await invokeShell<ShellHostState>('get_host_state')
      } catch (caught) {
        // 不在壳内（`vite dev` 的普通浏览器）会走到这里。不算错误：
        // 下面还会尝试直连一次宿主，开发者可能已经手动起了宿主。
        console.debug('无法从壳读取宿主状态', caught)
        return
      }

      if (snapshot.state === 'ready') {
        setConnection(snapshot)
        setError(undefined)
        setPhase('ready')
      } else if (snapshot.state === 'failed') {
        setConnectionFailure(snapshot.message)
        setError(snapshot.message)
        setPhase('failed')
      }
      // `idle` / `starting` 不处理：宿主还在路上，继续等事件即可。
    }

    void pullState()

    // 不在壳内（浏览器开发态）时没有事件可听，直接尝试连一次宿主：
    // 开发者可能已经手动启动了宿主，此时不该让界面一直停在连接中。
    if (getConnection() === undefined && getConnectionError() === undefined) {
      void waitForHost(CONNECT_TIMEOUT_MS).then(
        () => { setPhase('ready') },
        (caught: unknown) => {
          setPhase('failed')
          setError(caught instanceof Error ? caught.message : '无法连接宿主')
        },
      )
    }

    return () => {
      offReady()
      offFailed()
    }
  }, [])

  // 订阅模块级连接状态，兜住"事件先于组件挂载"的时序。
  useEffect(() => {
    return onConnectionChange(() => {
      if (getConnection() !== undefined) {
        setPhase('ready')
        setError(undefined)
      } else if (getConnectionError() !== undefined) {
        setPhase('failed')
        setError(getConnectionError())
      }
    })
  }, [])

  // 就绪后做一次健康检查并拉取初始数据。
  useEffect(() => {
    if (phase !== 'ready') return
    void fetchHealth().then(
      async () => {
        // 会话与记忆各拉一次，互不阻塞：记忆读失败不该拖住会话载入。
        await Promise.all([refreshCurrent(), refreshMemories()])
        try {
          const [config, modelList] = await Promise.all([getConfig(), listModels()])
          setPermissionState(config.permission)
          setModels(modelList)
          setModelId(config.currentModel || modelList[0]?.id)
        } catch (caught) {
          console.error('读取配置或模型失败', caught)
        }
      },
      (caught: unknown) => {
        console.error('健康检查失败', caught)
        // 健康检查失败说明宿主虽然报告了就绪，但实际不响应。
        setPhase('failed')
        setError(caught instanceof Error ? caught.message : '宿主无响应')
      },
    )
  }, [phase, refreshCurrent, refreshMemories])

  /**
   * 发送一条消息。
   *
   * ## 乐观更新
   *
   * 用户消息立刻上图，不等后端确认。理由：用户按下回车后界面上必须立刻
   * 出现自己说的话，否则会有"没发出去"的错觉，导致重复按。
   * 若后端真的失败，错误提示会显示在输入框上方，且那条消息仍保留——
   * 用户能直接重发，不用重新打字。
   */
  const send = useCallback(async (
    /**
     * 覆盖本次发送的内容。
     *
     * 排队消息从队列里取出时必须走这条路：那一刻 `draft` 已经清空，
     * 而队列里的文字不在草稿里。用参数传进来，比"先把草稿写回去再发"
     * 少一次渲染，也不会和用户此刻正在打的新字打架。
     */
    override?: { text: string; attachments: readonly Attachment[] },
    /**
     * 跳过 `busy` 闸门。
     *
     * 只有队列放行时用：上一轮的 `finally` 里 `setBusy(false)` 刚提交，
     * 而闭包里的 `busy` 仍是旧值，不放行就会被自己挡回去。
     */
    force = false,
  ): Promise<void> => {
    const source = override ?? { text: draft, attachments }
    const input = source.text.trim()
    // 空内容不发送；但若附带了文件，空文字也允许发出（纯附件消息）。
    if (input === '' && source.attachments.length === 0) return
    if (busy && !force) return

    /*
     * 用户开口了 → 连续拒绝清零（§7.4 的「连续」）。
     *
     * 放在这里而不是 `send` 的末尾：清计数是「用户做了这件事」的结果，
     * 与这一轮成不成功无关。等发完再清的话，一次网络失败会让计数留着，
     * 而她并没有再被拒绝一次。
     */
    clearDeclines()

    /*
     * 他一开口，那条还挂着的「这次不用」就该收了。
     *
     * 理由不是「窗口到期」，而是**用户已经用行动回答了**：他在跟她说
     * 话，说明这次开口没打扰到他。此时那个按钮还挂着，会让人怀疑
     * 「我是不是还得点一下才不算被打扰」。
     */
    if (undoRef.current !== undefined) {
      globalThis.clearTimeout(undoRef.current)
      undoRef.current = undefined
    }
    setUndoable(undefined)

    // 把附件名折叠进正文，作为可见的结构化前缀。内核当前只持久化
    // role + content，附件元数据走这条最简路径，既可见又不改动协议。
    const prefix = source.attachments.length > 0
      ? `[附件] ${source.attachments.map((item) => item.name).join('、')}\n`
      : ''
    const text = `${prefix}${input}`.trim()

    /*
     * 发送音（§12.12）。放在清空输入之后、请求之前。
     *
     * 为什么不放在 `onSession`（那时才知道宿主任了会话）：那一刻距按键
     * 已经过去几十到几百毫秒，声音会落在"我已经松手了"之后，听起来像
     * 别的什么东西在响。提示音的价值在**即时**，不在准确。
     */
    playCue('send')

    /* 排队消息发送时草稿是空的，不必（也不该）再清一次：清的是用户此刻的字。 */
    if (override === undefined) {
      setDraft('')
      setAttachments([])
    }
    setChatError(undefined)
    setBusy(true)

    // 本轮开始。轮次号自增后用局部变量固定下来：回调里的异步更新
    // 若去读 roundRef.current，会读到后面那一轮的值。
    roundRef.current += 1
    const round = roundRef.current
    const startedAt = Date.now()

    pushLog({
      round,
      at: startedAt,
      channel: 'rhythm',
      actor: 'system',
      summary: '开始这一轮',
    })

    // 用户消息先上图。id 用时间戳而非 uuid：它只用于 React 的 key，
    // 不出现在任何持久化数据里，简单即可。
    const localId = `local-${String(Date.now())}`
    setMessages((previous) => [...previous, { id: localId, role: 'user', content: input, at: startedAt }])

    if (text !== '') {
      pushLog({
        round,
        at: startedAt,
        channel: 'channel',
        actor: 'user',
        summary: source.attachments.length > 0 ? '收到一条消息，带附件' : '收到一条消息',
        chars: text.length,
        ...(text.length > 0 ? { detail: text } : {}),
      })
    }

    // 助手那条先占位，收到第一个增量时再填充。
    const replyId = `reply-${String(Date.now())}`
    setMessages((previous) => [...previous, { id: replyId, role: 'assistant', content: '', pending: true, at: startedAt }])

    const abort = new AbortController()
    controller.current = abort
    /**
     * 本轮实际落到的会话 id。
     *
     * 首轮发送时 `sessionId` 还是空的，id 由宿主的 `session` 帧给出。
     * 用它而不是闭包里的 `sessionId`：后者在本轮开始时就固定了，
     * 结束时要同步消息 id，指的必须是刚刚真正写进去的那一段。
     */
    let liveSessionId = sessionId ?? ''
    /** 本轮最终文本。用它覆盖占位内容，确保界面与落盘一致。 */
    let finalText = ''
    /** 本轮思考过程的累计。只用于界面展示，不进入 finalText。 */
    let thought = ''
    /** 思考开始时刻。undefined 表示还没开始想（非推理模型）。 */
    let thoughtAt: number | undefined
    /** 正文开始时刻。用它算"想了多久"。 */
    let answerAt: number | undefined

    try {
      await runInference(
        text,
        sessionId ?? '',
        {
          onSession(id): void {
            // 首页直接打字时由宿主创建会话，这里接住 id 并切到对话视图。
            liveSessionId = id
            setSessionId(id)
          },
          onDelta(text): void {
            // 正文第一帧落地时收一条「想完了」，记录思考的字数与耗时。
            // 这条是日志面板里唯一能读到"想了多久"的地方——推理过程
            // 不落盘，落盘的只有正文，过了这一刻时长就再也算不出来了。
            if (answerAt === undefined) {
              answerAt = Date.now()
              /*
               * 「她开口」音（§12.12）。只在这一轮的第一帧响，不是每段都响。
               *
               * 收在这一处而不是 `onReasoning`：思考过程不是"开口"，
               * 它甚至可能最终没有正文。用户等的那个声音，是"她开始说话了"。
               */
              playCue('speak')
              if (thoughtAt !== undefined) {
                pushLog({
                  round,
                  at: answerAt,
                  channel: 'model',
                  actor: 'assistant',
                  // 文案只写事实，秒数交给 ms 字段——界面把它渲染在
                  // 第一行右端，比写进句子里更好对齐也更好扫读。
                  summary: '想完了',
                  chars: thought.length,
                  ms: answerAt - thoughtAt,
                  detail: thought,
                })
              }
            }
            finalText += text
            setMessages((previous) => previous.map((message) =>
              message.id === replyId ? { ...message, content: finalText } : message,
            ))
          },
          onReasoning(text): void {
            // 思考逐字累积到同一条消息的 reasoning 字段。
            // 每条都重算整个字符串而不是追加到 state 里：并发更新下
            // 追加会丢字，而 reasoning 只有一条消息在写，重算成本可忽略。
            if (thoughtAt === undefined) {
              thoughtAt = Date.now()
              pushLog({
                round,
                at: thoughtAt,
                channel: 'model',
                actor: 'assistant',
                summary: '开始思考',
              })
            }
            thought += text
            setMessages((previous) => previous.map((message) =>
              message.id === replyId ? { ...message, reasoning: thought } : message,
            ))
          },
          onDone(result): void {
            // 用服务端的完整文本覆盖，而不是继续累加：两者理论上相同，
            // 但以服务端为准能消除任何丢失增量导致的偏差。
            finalText = result.text === '' ? finalText : result.text
            const endedAt = Date.now()

            // 收尾日志：把这一轮的结果记一条。
            // 放在 onDone 而不是 finally，是因为只有正常结束才有完整字数；
            // 中断时 finalText 是半截，记下来会误导。
            // 「说完了」的耗时是**正文输出用了多久**，不是整轮耗时。
            // 起始点取正文第一帧（answerAt）：思考的那几秒属于上一条日志，
            // 算进来会让两个数字重复，也说不清"说完"到底指什么。
            // 没有 answerAt（比如服务端一次性返回）时退回本轮起点。
            if (finalText !== '') {
              pushLog({
                round,
                at: endedAt,
                channel: 'model',
                actor: 'assistant',
                summary: '说完了',
                chars: finalText.length,
                ms: endedAt - (answerAt ?? startedAt),
                detail: finalText,
              })
            }
            pushLog({
              round,
              at: Date.now(),
              channel: 'rhythm',
              actor: 'system',
              summary: `这一轮结束了，用了 ${formatSeconds(Date.now() - startedAt)}`,
            })

            setMessages((previous) => previous.map((message) => {
              if (message.id !== replyId) return message
              // 生成结束后清掉 reasoning：它只服务于日志面板，
              // 留着会让用户以为那是可以反复回看的对话内容。
              // 用解构剔除而不是赋 undefined：项目开了
              // exactOptionalPropertyTypes，显式赋 undefined 不合法。
              const { reasoning: _dropped, ...rest } = message
              return { ...rest, content: finalText, pending: false }
            }))
          },
          /**
           * 她的阶段变了（思考 / 打字 / 走神 / 空闲）。
           *
           * ## 这一格此前是死帧
           *
           * 宿主早就在发 `presence` 帧、`api.ts` 也声明了 `onPresence`，
           * 但**没有任何界面代码消费它**——于是「她在开口前想的那半拍」
           * 在界面上不存在：用户按了发送，一秒半里气泡是空的、
           * 三点也没亮，看起来像卡住。
           *
           * ## 为什么只「开」不「关」
           *
           * 占位消息创建时就是 `pending: true`（三点在跳），这是「正在回复」
           * 的缺省表现。本方法把它保持住即可。
           *
           * 反过来「按 `show=false` 关掉」是错的：`done` 之后宿主会补一帧
           * `idle`（`show=false`），而那时 `pending` 已被 `onDone` 关过，
           * 再关一次无害；但如果正文还没来时收到一帧 `paused`，关掉三点
           * 会让气泡彻底空白——比一直亮着更假。走神不该在界面上表现为
           * 「她消失了」，而是「她还在，只是慢」。
           */
          onPresence(view): void {
            if (!view.show) return
            setMessages((previous) => previous.map((message) => {
              if (message.id !== replyId) return message
              // 正文已经开始出现之后不再被 presence 改动：那时三点由
              // 正文本身代表，反复开关会让气泡闪。
              if (message.content !== '') return message
              return { ...message, pending: true }
            }))
          },
          onError(message): void {
            playCue('error')
            setChatError(message)
            pushLog({
              round,
              at: Date.now(),
              channel: 'error',
              actor: 'system',
              summary: `这一轮中断了：${message}`,
            })
            // 出错的占位消息要移除，否则会留下一条空白的"空谷"。
            setMessages((previous) => previous.filter((message) => message.id !== replyId))
          },
        },
        abort.signal,
      )
    } catch (caught) {
      // 用户主动停止不算错误，不弹提示。
      const aborted = caught instanceof DOMException && caught.name === 'AbortError'
      if (!aborted) {
        playCue('error')
        setChatError(caught instanceof Error ? caught.message : '发送失败')
        pushLog({
          round,
          at: Date.now(),
          channel: 'error',
          actor: 'system',
          summary: `这一轮失败：${caught instanceof Error ? caught.message : '未知原因'}`,
        })
        setMessages((previous) => previous.filter((message) => message.id !== replyId))
      }
    } finally {
      controller.current = undefined
      setBusy(false)
      /*
       * 三个刷新，各有各的原因：
       * - 消息：把本轮两条临时 id 换成内核 UUID，删除按钮才拿得到人；
       * - 元信息：标题可能刚被内核自动命名，统计也多了这一轮；
       * - 记忆：这一轮说的话里可能刚提炼出新事实。
       */
      await Promise.all([syncMessages(liveSessionId), refreshSessionMeta(), refreshMemories()])
    }

    // 用量按字符数估算。内核当前没有回传 usage（magpie 的流里带，
    // 但透传它要改协议），这里用"字数 / 2"近似 token 数：
    // 中文大致 1 字 1 token，英文约 4 字符 1 token，取中间值。
    // 估算值用于让用户感知"这轮聊了多少"，不需要精确。
    const totalChars = text.length + finalText.length
    setUsage({
      tokens: Math.round(totalChars / 2),
      // 缓存命中需要供应商回传，估算时按"多轮对话大多命中"取 0 更诚实。
      cacheHit: 0,
      // 上下文占用按 token 数对 32K 窗口的比例。
      context: Math.min(99, Math.round((totalChars / 2 / 32_768) * 100)),
    })
    setCompanionUpdatedAt(Date.now())

    // 标题：本地先按首句更新，避免等网络往返时顶部还显示"未命名"。
    setTitle((previous) => {
      if (previous !== '') return previous
      const firstLine = input.split('\n')[0]?.trim() ?? ''
      return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine
    })
  }, [draft, busy, sessionId, attachments, refreshSessionMeta, refreshMemories, pushLog, syncMessages])

  /** 停止生成。 */
  /**
   * 把当前草稿排进队列。
   *
   * ## 为什么在这里清空草稿
   *
   * 与 `send` 同一个原则：用户按下回车之后，输入框里那个东西已经"交出去"了。
   * 留着它，用户会以为没排上，于是再按一次——队列里就出现两条一样的消息。
   */
  const enqueue = useCallback((): void => {
    const text = draft.trim()
    if (text === '' && attachments.length === 0) return
    queueSeq.current += 1
    const item: QueuedMessage = {
      id: `queue-${String(queueSeq.current)}`,
      text,
      attachments,
      at: Date.now(),
    }
    setQueue((previous) => [...previous, item])
    setDraft('')
    setAttachments([])
  }, [draft, attachments])

  /** 从队列里取走一条。 */
  const dropQueued = useCallback((id: string): void => {
    setQueue((previous) => previous.filter((item) => item.id !== id))
  }, [])

  /** 改一条排队消息的正文。空正文且没有附件时视为删除。 */
  const editQueued = useCallback((id: string, text: string): void => {
    setQueue((previous) => previous.map((item) => {
      if (item.id !== id) return item
      return { ...item, text }
    }))
  }, [])

  /**
   * 调整一条排队消息的位置。
   *
   * 用方向而不是目标下标：界面上的操作是「上移 / 下移」两个按钮，
   * 传下标就得在组件里先算出目标位置，而那个算法只属于队列自己。
   */
  const moveQueued = useCallback((id: string, direction: -1 | 1): void => {
    setQueue((previous) => {
      const index = previous.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= previous.length) return previous
      const next = [...previous]
      const [moved] = next.splice(index, 1)
      /* v8 ignore next -- index 已判在范围内，splice 必然取出一项。 */
      if (moved === undefined) return previous
      next.splice(target, 0, moved)
      return next
    })
  }, [])

  /**
   * 队列放行：一轮结束后把队首发出去。
   *
   * 依赖里带 `queue` 与 `busy`：`busy` 变 false 的那一帧就是唯一的放行时机。
   * `draining` 挡掉"同一帧里 `setBusy(false)` 触发两次"的极端情况
   * （React 18 的自动批处理下不会发生，但这是一个便宜的保险）。
   */
  useEffect(() => {
    if (busy || queue.length === 0 || draining.current) return
    const next = queue[0]
    /* v8 ignore next -- length 已判大于 0。 */
    if (next === undefined) return
    draining.current = true
    setQueue((previous) => previous.slice(1))
    void send({ text: next.text, attachments: next.attachments }, true)
      .catch((caught: unknown) => {
        console.error('排队消息发送失败', caught)
      })
      .finally(() => { draining.current = false })
  }, [busy, queue, send])

  const stop = useCallback(async (): Promise<void> => {
    // 先撤本地连接，界面立刻停下；再通知宿主让内核中断，
    // 否则内核会继续把整轮跑完、白花额度。
    controller.current?.abort()
    if (sessionId !== undefined) {
      await abortInference(sessionId).catch(() => {
        // 已经结束的情况下中断是幂等的，失败无需提示。
      })
    }
  }, [sessionId])

  /**
   * 让她主动开口（§6.4 E、§7.4）。
   *
   * ## 顺序为什么不能换
   *
   * 1. **先问门控**，再生成。反过来的话每一条被拦下的消息都已经花了
   *    一次模型调用，而拦下的原因往往正是「现在不该打扰」——那条消息
   *    生成出来是要扔掉的。
   * 2. **先拿到判据，再上图**。判据要跟着消息一起显示（`proactive` 字段）。
   *    消息先上图、判据后补，中间那一帧用户会看到一条没有解释的主动消息，
   *    而那正是他最想问「你为什么突然说话」的时刻。
   *
   * ## 为什么失败不弹提示
   *
   * 「她这次没开口」对用户不是错误，是没发生。弹一条「主动开口失败」
   * 等于把一次不存在的打扰变成一次真的打扰（§7.5 第一条）。
   * 失败只进日志，用户去日志里能查到。
   */
  const speakUp = useCallback(async (): Promise<boolean> => {
    if (busy) return false
    if (sessionId === undefined || sessionId === '') return false
    if (messages.length === 0) return false

    /*
     * 两分钟内不重复问。
     *
     * 这不是复刻宿主的冷却（那在插件里，按会话记）。这里防的是另一个
     * 问题：`speakUp` 由 effect 驱动，而 effect 的依赖里可能有会频繁
     * 变化的会话状态。没有这道闸，一次挂载抖动就会连着问三次门控，
     * 三次都放行——于是她在一分钟内说了三句。
     *
     * 取两分钟而不是更长：用户的耐心尺度是「我刚放下手机，她过一会儿
     * 说句话」，两分钟足够让一次误触发被吸收，又不至于让正常间隔被吃掉。
     */
    const now = Date.now()
    if (now - spokeAtRef.current < 120_000) return false

    // 会话闲置多久。取最后一条消息的时间：那是「上一次有人说话」，
    // 也正是 §5.5 `min_idle_seconds` 想量的东西。
    const last = messages.at(-1)
    const idleMinutes = last === undefined ? 0 : Math.floor((now - last.at) / 60_000)

    let verdict: Awaited<ReturnType<typeof checkProactive>>
    try {
      verdict = await checkProactive({ sessionId, idleMinutes })
    } catch {
      // 宿主没应答：不开口，也不打扰。
      spokeAtRef.current = now
      return false
    }

    if (!verdict.allow) {
      /*
       * 门控不放行。**什么都不做**，连日志都不写。
       *
       * 记下时刻：`defer` 类原因（静默时段、冷却、空闲不够）本来就会
       * 在到期后被重新问一次；不记的话每个 effect 都会再问一遍，
       * 把「等一会儿」变成「一直问」。
       *
       * 为什么不区分 `drop` 与 `defer`：界面这一层判断不了，也不该判断——
       * `deferMs` 已经把那件事表达清楚了（`0` 表示不用等）。
       * 重试间隔由 `useProactiveTick` 按它决定。
       */
      spokeAtRef.current = now
      /*
       * 存下它建议的等待。用绝对时刻而不是时长：时长在「界面切后台
       * 五分钟」之后会算错，绝对时刻不会。
       */
      deferUntilRef.current = verdict.deferMs > 0 ? now + verdict.deferMs : 0
      return false
    }

    spokeAtRef.current = now
    setBusy(true)
    const startedAt = Date.now()
    roundRef.current += 1
    const round = roundRef.current
    const reason = verdict.reason
    /*
     * 由头：判定那一刻选中的那件事。
     *
     * 存进局部常量而**不再问一次宿主**：`plan()` 每次调用都可能因为新写入的
     * 待办而选出不同候选，判定与生成之间隔了一次网络往返，再问一次就可能
     * 变成「判据说的是 A，说的却是 B」。
     */
    const cause = verdict.text ?? ''

    /*
     * 占位消息带上判据。
     *
     * 为什么是占位而不是等 `onDone` 再上图：她要先「出现」，文字随后
     * 才流出来。先上图才能让那行判据在第一时间可见——用户看到她开口
     * 的同时就知道为什么。
     */
    const replyId = `proactive-${String(startedAt)}`
    setMessages((previous) => [...previous, {
      id: replyId,
      role: 'assistant',
      content: '',
      pending: true,
      at: startedAt,
      proactive: reason,
    }])

    const abort = new AbortController()
    controller.current = abort
    let finalText = ''

    try {
      await runInference(
        '',
        sessionId,
        {
          /*
           * 会话 id 必定是已知的（`speakUp` 开头就判过）。这个回调不该
           * 被调到——主动开口不允许新建会话。留一个空实现而不是省略：
           * 它是 `InferenceHandlers` 的必填项，省略会在类型上不成立。
           */
          onSession(): void { /* 主动开口不新建会话 */ },
          onDelta(text): void {
            finalText += text
            setMessages((previous) => previous.map((message) =>
              message.id === replyId ? { ...message, content: finalText } : message,
            ))
          },
          onReasoning(): void {
            // 主动开口不展示思考过程：它没有对应的日志轮次可挂，
            // 而且用户此刻关心的是「她说了什么」，不是「她想了什么」。
          },
          onDone(result): void {
            const done = result.text.trim() === '' ? finalText : result.text
            setMessages((previous) => previous.map((message) => {
              if (message.id !== replyId) return message
              return { ...message, content: done, pending: false }
            }))
            if (done.trim() === '') {
              // 模型什么都没说：把空消息撤掉，不留一条空白。
              setMessages((previous) => previous.filter((message) => message.id !== replyId))
              return
            }
            playCue('speak')
            /*
             * 窗口看不见时补一条系统通知（§7.4「应用未开」那一行）。
             *
             * ## 判在 `onDone` 而不是在进 `speakUp` 时
             *
             * 从「决定开口」到「说出完整一句」隔着一次模型调用，通常几秒，
             * 长的时候几十秒。用户完全可能在这中间把窗口关掉——按进
             * `speakUp` 时的状态判，通知会漏发；按此刻的状态判才对。
             *
             * ## 只发正文，不发别的
             *
             * §12.10：「通知内容 只显示一句正文，不显示模型名、不显示插件名」。
             * 标题固定用应用名，让用户一眼知道是谁在说话；判据（为什么此刻
             * 开口）留在时间轴上，它是一句给用户回来看的解释，不该塞进
             * 通知栏那种只能扫一眼的地方。
             *
             * 通知发不出去（没开、没授权、静音）时**什么都不做**：
             * 她的话仍在时间轴上，用户回来就看得到。这是降级，不是失败。
             */
            notify({ title: '空谷', body: done })
            pushLog({
              round,
              at: Date.now(),
              channel: 'rhythm',
              actor: 'assistant',
              summary: `主动发言 · ${reason === '' ? '未提供原因' : reason}`,
              chars: done.length,
              detail: done,
            })
            /*
             * 开三秒撤回窗口（§7.4）。
             *
             * 从**她说出完整一句**开始计时，不是从占位出现开始：
             * 占位那一刻正文还是空的，用户看到一条空消息加一个「这次不用」，
             * 只能盲点。从说完开始，他读了一遍、判断「这句我不需要」，
             * 再决定撤——这才是「3 秒内可撤回」想保护的那个决定。
             */
            setUndoable(replyId)
            if (undoRef.current !== undefined) globalThis.clearTimeout(undoRef.current)
            undoRef.current = globalThis.setTimeout(() => {
              undoRef.current = undefined
              setUndoable(undefined)
            }, UNDO_WINDOW_MS)
          },
          onError(): void {
            // 生成失败：撤掉占位，不留半条。日志留一行线索。
            setMessages((previous) => previous.filter((message) => message.id !== replyId))
            pushLog({
              round,
              at: Date.now(),
              channel: 'rhythm',
              actor: 'system',
              summary: '这次主动开口没说完，已撤下',
            })
          },
        },
        abort.signal,
        true,
        cause,
      )
      return true
    } catch {
      setMessages((previous) => previous.filter((message) => message.id !== replyId))
      return false
    } finally {
      controller.current = undefined
      setBusy(false)
      setCompanionUpdatedAt(Date.now())
      // 主动开口也是真落盘的一条助手消息：换成内核 id，「删除」才找得到它。
      // 理由（`reason`）不在盘上，替换后由 `syncMessages` 补回最后一条。
      void syncMessages(sessionId, reason)
    }
  }, [busy, sessionId, messages, pushLog, syncMessages])

  /**
   * 「这次不用」（§6.4 E）。
   *
   * ## 三件事，顺序要紧
   *
   * 1. 关掉撤回窗口（`undoable` 置空）。先关窗再做网络请求：窗口是
   *    可以立刻兑现的，而请求要几十毫秒。反过来会让按钮在点击后
   *    还挂着不动的样子。
   * 2. 撤下那条消息。淡出 180ms 交给 `ReasonLine` 的 CSS，这里直接移除。
   * 3. 告诉宿主记账。失败不提示——用户已经表达了「不要」，再弹一条
   *    「记账失败」是在他已经烦了的时候再烦一次。
   */
  const decline = useCallback(async (messageId: string): Promise<void> => {
    if (undoRef.current !== undefined) {
      globalThis.clearTimeout(undoRef.current)
      undoRef.current = undefined
    }
    setUndoable(undefined)
    setMessages((previous) => previous.filter((message) => message.id !== messageId))

    const count = noteDecline()
    if (count >= DECLINE_LIMIT) {
      pushLog({
        round: roundRef.current,
        at: Date.now(),
        channel: 'rhythm',
        actor: 'system',
        summary: `主动发言今日已被拒绝 ${String(count)} 次，今日不再主动发言`,
      })
    } else {
      pushLog({
        round: roundRef.current,
        at: Date.now(),
        channel: 'rhythm',
        actor: 'system',
        summary: '这次主动开口被撤下了',
      })
    }

    if (sessionId !== undefined) {
      await declineProactiveCall(sessionId).catch(() => { /* 见上 */ })
    }
  }, [sessionId, pushLog])

  /**
   * 清空全部。
   *
   * ## 单会话制下它是唯一的「重开」动作
   *
   * 没有「新建会话」了。用户想重新开始，只能把这一段清掉。默认清法是
   * **归档成段**：旧消息留在数据目录里、不再出现在界面上，一次误点还能
   * 捞回来。直接删是不可逆的，留一条 `archive: false` 的路给将来更明确的
   * 操作，界面上不默认暴露。
   *
   * ## 为什么失败时不动界面
   *
   * 先清空界面再请求，一旦请求失败，用户会看到「记录没了」而后端其实还在
   * ——下次启动它们又回来，那种反复最伤信任。所以顺序是：先请求，成功之后
   * 才清本地。代价是点下去到清空之间有一个往返的延迟，通常几十毫秒。
   *
   * ## 不清草稿与附件
   *
   * 这两样属于「用户已经准备好的东西」。清空会话只是换了一段上下文，
   * 把附件一起抹掉会让用户白选一次文件。
   */
  const newChat = useCallback(async (): Promise<void> => {
    controller.current?.abort()
    setChatError(undefined)
    setUndoable(undefined)

    const current = sessionId
    if (current === undefined || current === '') {
      // 还没有会话：本地归零即可，不必往返一次网络。
      setTitle('')
      setMessages([])
      setLogs([])
      setUsage(undefined)
      setStats(undefined)
      roundRef.current = 0
      return
    }

    try {
      const result = await clearSession(current)
      setSessionId(result.sessionId === '' ? undefined : result.sessionId)
      setTitle(result.session?.title ?? '')
      setMessages([])
      setLogs([])
      setUsage(undefined)
      roundRef.current = 0
      setStats(result.sessionId === '' ? undefined : await getSessionStats(result.sessionId))
    } catch (caught) {
      setChatError(caught instanceof Error ? caught.message : '清空失败')
    }
  }, [sessionId])

  /**
   * 删除一条消息。
   *
   * ## 为什么先等后端再动界面
   *
   * 删除不可逆。先本地移除、后端失败再补回来，会有一瞬间「它不在了」的错觉，
   * 而补回来时位置已经变了。先请求、成功后移除，代价只是几十毫秒。
   */
  const removeMessage = useCallback(async (messageId: string): Promise<void> => {
    const current = sessionId
    if (current === undefined || current === '') {
      setMessages((previous) => previous.filter((message) => message.id !== messageId))
      return
    }
    try {
      const removed = await deleteMessageCall(current, messageId)
      if (!removed) {
        setChatError('这条消息已经不在了')
        await syncMessages()
        return
      }
      setMessages((previous) => previous.filter((message) => message.id !== messageId))
      // 删掉的若是用户消息，日志的轮次划分会跟着变，重新派生一次。
      setLogs(await getSessionLogs(current))
      setStats(await getSessionStats(current))
    } catch (caught) {
      setChatError(caught instanceof Error ? caught.message : '删除失败')
    }
  }, [sessionId, syncMessages])

  /** 切换权限。 */
  const setPermission = useCallback((next: PermissionLevel): void => {
    setPermissionState(next)
  }, [])

  /**
   * 切换模型。
   *
   * ## 为什么失败必须回滚
   *
   * 上一版是「先改本地、再异步通知宿主，失败只 `console.error`」。于是当
   * 用户从一条连不上的供应商切到「本地演示」时：界面立刻显示「本地演示」，
   * 而宿主那次 `model.select` 若失败（内核里没有这个 id），内核的
   * `currentModel` 还是原来那条坏的——下一句话照旧
   * `无法连接供应商（http://127.0.0.1:3425/v1）：fetch failed`。
   *
   * 用户看到的是「明明选了本地演示，还是报供应商的错」。这个界面与事实
   * 不一致的窗口可以无限长，因为没有任何东西会把它纠正回来。
   *
   * 现在等宿主确认：成功才落本地，失败就把选中项退回原值并把原因显示在
   * 输入框上方。宁可让用户看到「切不过去」，也不要让界面撒谎。
   */
  const setModel = useCallback((id: string): void => {
    const previous = modelId
    setChatError(undefined)
    void (async () => {
      try {
        await selectModel(id)
        setModelId(id)
      } catch (caught) {
        // 回滚到切换前的值。`previous` 为 undefined 时保持 undefined，
        // 界面会显示「未选择模型」——那也是事实，好过一个假的选中态。
        setModelId(previous)
        setChatError(caught instanceof Error ? caught.message : '切换模型失败')
      }
    })()
  }, [modelId])

  /**
   * 重拉模型列表与当前选中项。
   *
   * 与就绪时那段初始化走同一对接口，不另写一份逻辑：两处各算一次，
   * 迟早会出现「重启后对了、设置里改完不对」。
   */
  const refreshModels = useCallback(async (): Promise<void> => {
    try {
      const [config, modelList] = await Promise.all([getConfig(), listModels()])
      setModels(modelList)
      /*
       * 宿主说选中的那条若已不在列表里（被删了、或换了机器），退回列表
       * 第一条。内核自己也会做同样的回落，但界面得先跟它对齐，否则
       * 选择器上会挂一个已经不存在的高亮项。
       */
      const listed = modelList.some((model) => model.id === config.currentModel)
      setModelId(listed ? config.currentModel : modelList[0]?.id)
    } catch (caught) {
      console.error('重拉模型列表失败', caught)
    }
  }, [])

  /**
   * 弹出系统文件选择并附加。
   *
   * ## 「用户取消」与「能力缺席」必须分开
   *
   * 上一版把两者都吞进一句 `console.debug`，理由是"不必提示打断对话"。
   * 对**取消**来说这是对的——用户自己按了取消，弹一句提示是噪音。
   * 但对**不在壳内**来说，静默就是缺陷：用户点了「附加文件」，界面
   * 毫无反应，既没有文件也没有解释，他会以为按钮坏了，再点几次。
   *
   * 所以这里只吞取消，其余照实说一句。提示走 `setChatError` 而不是
   * toast：它与发送失败同一个槽位，用户已经知道去那里看原因。
   */
  const addFiles = useCallback((): void => {
    void (async () => {
      try {
        const result = await invokeShell<{ paths: string[] }>('pick_files', {
          multiple: true,
          directory: false,
          extensions: [],
          title: '附加文件',
        })
        const next: Attachment[] = result.paths.map((path) => ({
          // id 只用在本组件内做 key，无需全局唯一规则。
          id: `att-${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`,
          name: path.split(/[\\/]/).pop() ?? path,
        }))
        if (next.length > 0) setAttachments((previous) => [...previous, ...next])
      } catch (caught) {
        if (isShellUnavailable(caught)) {
          setChatError('附加文件需要桌面端：文件选择由应用外壳负责，浏览器预览里没有这个能力。')
          return
        }
        /*
         * 剩下的大概率是用户按了取消（壳侧以错误形式返回）。
         * 这条路径不该打扰对话，留一行调试痕迹即可。
         */
        console.debug('附加文件未生效', caught)
      }
    })()
  }, [])

  /** 移除一条附件。 */
  const removeAttachment = useCallback((id: string): void => {
    setAttachments((previous) => previous.filter((item) => item.id !== id))
  }, [])

  /**
   * 直接附加一批（§12.14 粘贴图片）。
   *
   * ## 为什么 id 仍在这里生成
   *
   * 调用方（`Composer` 的 paste 处理）已经在做「读剪贴板 → 解码 → 缩放」
   * 三件异步的事，再让它拼 id 就得知道 id 的格式。格式是数据层的约定，
   * 留在这里，调用方只交「名字与图」。
   *
   * 与 `addFiles` 共用同一个前缀与随机后缀规则，两处的 key 不会撞。
   */
  const addAttachments = useCallback((items: readonly { name: string; thumb?: string }[]): void => {
    if (items.length === 0) return
    const stamp = Date.now()
    setAttachments((previous) => [
      ...previous,
      ...items.map((item, index) => ({
        /*
         * 后缀带序号：同一毫秒内加六张图时，`Math.random` 理论上能撞，
         * 而 React 的 key 撞了会静默丢一条附件——用户看到五个，
         * 发送时却提示六个。序号把这条概率压成零。
         */
        id: `att-${String(stamp)}-${String(index)}-${Math.random().toString(36).slice(2, 7)}`,
        name: item.name,
        ...(item.thumb === undefined || item.thumb === '' ? {} : { thumb: item.thumb }),
      })),
    ])
  }, [])

  /**
   * 切换语音输入。
   *
   * 不支持的环境（多数 WebView）直接提示，而不是假装能录。
   * 支持时每次识别结果整体替换输入框内容——语音是口述，
   * 与手打是两种互斥的输入方式，叠加反而难以预期。
   */
  const toggleVoice = useCallback((): void => {
    const Ctor = getSpeechRecognition()
    if (Ctor === undefined) {
      setChatError('当前环境不支持语音输入')
      return
    }
    // 正在录音则停止。
    if (recognizer.current !== undefined) {
      recognizer.current.stop()
      return
    }
    const instance = new Ctor()
    instance.lang = 'zh-CN'
    instance.continuous = false
    instance.interimResults = true
    instance.onresult = (event) => {
      let text = ''
      for (let i = 0; i < event.results.length; i++) {
        // 双重可选链：列表项与项内的候选都可能不存在（取决于引擎实现）。
        text += event.results[i]?.[0]?.transcript ?? ''
      }
      setDraft(text)
    }
    instance.onend = () => {
      setVoiceActive(false)
      recognizer.current = undefined
    }
    instance.onerror = () => {
      setVoiceActive(false)
      recognizer.current = undefined
    }
    recognizer.current = instance
    setVoiceActive(true)
    try {
      instance.start()
    } catch {
      // 某些浏览器在权限未授予时 start 会抛，归为"已停止"。
      setVoiceActive(false)
      recognizer.current = undefined
    }
  }, [])

  const dismissChatError = useCallback((): void => { setChatError(undefined) }, [])

  /**
   * 切换主题。转发给偏好层。
   *
   * 这里不写 `data-theme`，也不写 localStorage——两件事都在
   * `preferences.ts` 里做，且那次写入会广播到偏好窗口。
   * 若这里也写一遍，就成了第二个真源。
   */
  const setTheme = useCallback((next: ThemeMode): void => {
    setPreferences({ theme: next })
  }, [])

  const retry = useCallback((): void => {
    setPhase('connecting')
    setError(undefined)
    // 重试用同一个阈值：手动重试的用户耐心更少，不该比首次等得更久。
    void waitForHost(CONNECT_TIMEOUT_MS).then(
      () => { setPhase('ready') },
      (caught: unknown) => {
        setPhase('failed')
        setError(caught instanceof Error ? caught.message : '仍然无法连接')
      },
    )
  }, [])

  /** 叫出桌宠。当前版本没有独立桌宠进程，给出明确提示而不是静默。 */
  const summonPet = useCallback((): void => {
    setChatError('桌宠功能尚未接入')
  }, [])

  return {
    phase,
    error,
    sessionId,
    title,
    messages,
    stats,
    busy,
    draft,
    chatError,
    permission,
    models,
    modelId,
    setModel,
    refreshModels,
    attachments,
    queue,
    enqueue,
    dropQueued,
    editQueued,
    moveQueued,
    addFiles,
    addAttachments,
    removeAttachment,
    voiceActive,
    toggleVoice,
    theme,
    setTheme,
    logs,
    mood: moodOf(companion),
    bond: bondOf(companion),
    /*
     * 张力单列，不塞进 `MoodState`。
     *
     * ## 刻度：0–1 单极，原样透出，不做双极映射
     *
     * 上一版这里写的是 `axes.tension * 2 - 1`，把一个 0–1 的量硬掰成
     * −1..1。后果是静息态（`AXIS_SPEC.tension.baseline = 0`，见
     * `ondra-emotion-core/src/types.ts`）被映射成 **−1.00**，界面上读起来
     * 像「张力拉满」。而它的真实含义恰恰相反：**0 就是没有张力**。
     *
     * 心情那一档能这么映射，是因为它的中性点确实在 0.5（`baseline: 0.5`），
     * 减半再乘二才落回双极原点。张力没有「中点」这回事——它是冲突锁的
     * 燃料，只会从 0 往上烧。拿心情的公式套张力，等于假设它也有一个
     * 「比 0 更低」的负向状态，而那个状态在数据模型里不存在。
     *
     * 所以这里**不做任何换算**：0–1 进，0–1 出。界面按单极轨道画，
     * 与精力同一套刻度。刻度统一之后，「这个字段刻度不一样」的额外记忆
     * 负担也一并消失。
     */
    tension: companion !== undefined && companion.measured
      ? companion.axes.tension
      : undefined,
    memories,
    memoryFault,
    companionUpdatedAt,
    usage,
    summonPet,
    setDraft,
    send,
    stop,
    newChat,
    /*
     * 从磁盘重新读一遍当前会话。
     *
     * 只有一个调用方：设置里的「导入对话」。那条路会让**宿主**换掉当前段
     * （归档旧段、建新段），而界面手里的消息还是旧的。这里不重做一遍
     * "导入"的逻辑，只把界面对齐到宿主的事实上——两处各算一次必然漂开。
     */
    reload: refreshCurrent,
    deleteMessage: removeMessage,
    setPermission,
    dismissChatError,
    retry,
    speakUp,
    declineProactive: decline,
    undoable,
    lastDeferMs: () => {
      const until = deferUntilRef.current
      if (until === 0) return 0
      const left = until - Date.now()
      return left > 0 ? left : 0
    },
  }
}

/**
 * 把内核消息转成待渲染的消息。
 *
 * 过滤掉 `tool` 与 `system`：当前版本工具还没接入，而系统提示是给模型看的，
 * 不该出现在用户面前。空内容的助手消息也丢掉——那是上一轮中断留下的半截。
 */
function withTimestamps(raw: SessionMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const message of raw) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.role === 'assistant' && message.content === '') continue
    result.push({
      id: message.id,
      role: message.role,
      content: message.content,
      /*
       * `createdAt` 缺失（老数据、或宿主只给了 `at`）时归 0。
       *
       * 这里必须真的兜住，不能直接透传：`undefined` 进 `new Date()`
       * 会得到 Invalid Date，`getFullYear()` 返回 `NaN`，界面上直出
       * `NaN 年 NaN 月 NaN 日`；而 `startOfDay(undefined)` 得到的 `NaN`
       * 与自身不相等，会让**每条**无时间的消息各起一个日期行。
       *
       * 归 0 而不是 `Date.now()`：把历史全挤到「现在」是编造，
       * 界面那边把 0 识别为「时间未知」，如实说出来。
       */
      at: Number.isFinite(message.createdAt) ? message.createdAt : 0,
    })
  }
  return result
}

/**
 * 「此刻」的心情与精力：把宿主读数换成界面刻度。
 *
 * ## 上一版这里恒为 0，而且是对的
 *
 * 当时情绪引擎还没接线，`deriveMood()` 直接返回 `{mood:0, energy:0}`，
 * 界面显示「尚未测量」。那比编一个「按回复里的词频推算」的数诚实得多
 * ——编出来的数看着像测量结果，实际只反映用户自己用了哪些词。
 *
 * ## 现在改为读实测值
 *
 * `ondra-emotion-core` 一直在默认启用名单里，缺的只是宿主的一条路由
 * （`GET /api/companion/state`）。六维都是 0–1，这里乘 100 换成界面的
 * 百分制；`energy` 在核心里本来就是 0–100，接口已经归一过。
 *
 * `measured: false` 时仍然返回 0 与空标签——那不是「她很平静」，
 * 是「没测到」，界面据此走空态。
 */
function moodOf(state: CompanionState | undefined): MoodState {
  if (state === undefined || state.axes === undefined || !state.measured) return { mood: 0, energy: 0 }
  const mood = Math.round(state.axes.mood * 100)
  return {
    mood,
    energy: Math.round(state.axes.energy * 100),
    /*
     * 标签取四档心情词（雀跃 / 平静 / 低落 / 烦躁），由实测值决定。
     *
     * 不用 `dominant`（开心 / 委屈 / 得意…）：那十个标签描述的是**成因**，
     * 而这里要的是水位线旁边的一个词。同一个位置换一套词，用户会以为
     * 两个面板在描述两件事。
     */
    label: moodWord(mood),
  }
}

/**
 * 把毫秒转成人读的时长。
 *
 * 三档：一秒内给小数（0.8 秒），分钟给一位小数，超过十分钟给整数分钟。
 * 日志里的时长是用来"感觉一下快慢"的，精确到毫秒反而干扰阅读。
 */
function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  if (seconds < 60) return `${String(Math.round(seconds))} 秒`
  const minutes = seconds / 60
  if (minutes < 10) return `${minutes.toFixed(1)} 分钟`
  return `${String(Math.round(minutes))} 分钟`
}

/**
 * 「TA 对你」：关系阶与四维。
 *
 * ## 为什么包含四个维度而不是三个
 *
 * 界面上原来打算画「好感 / 信任 / 亲密」三条。四条里的 `familiarity`
 * （熟悉度 = 累计互动 / 5000）是**唯一有客观分子分母的一条**，其余三条
 * 目前只有初始值，没有任何插件在推动它们（`adjust()` 仍然零调用方）。
 * 把一条能算的藏起来、只显示三条不动的，等于把这一栏做成纯粹的装饰。
 */
function bondOf(state: CompanionState | undefined): BondStats {
  /*
   * `state.bond === undefined` 这一条防的是**宿主比界面旧**：接口换了形状
   * 或路由 404 时，`request()` 会把一段别的 JSON 原样交回来，`bond` 就没了。
   * 类型系统这时帮不上忙——它描述的是「应该有什么」，而这里是「实际收到
   * 什么」。少一层判断，整个界面会随一个字段一起白屏。
   */
  if (state === undefined || state.bond === undefined || state.bond.stage === '') {
    return { stage: '', dimensions: [] }
  }
  return {
    stage: state.bond.stage,
    dimensions: [
      { key: 'affection', label: '好感', value: state.bond.affection },
      { key: 'trust', label: '信任', value: state.bond.trust },
      { key: 'intimacy', label: '亲密', value: state.bond.intimacy },
      { key: 'familiarity', label: '熟悉', value: state.bond.familiarity },
    ],
  }
}

/**
 * 「记得的事」的数据源在 `refreshMemories()`，不在推导函数里。
 *
 * ## 这里原来是一句 `return []`
 *
 * 它的注释是对的：不能把用户说过的话按长度挑三条冒充「她记住的事」。
 * 但结论走偏了——当时的做法是**干脆不接**，于是记忆面板从建库起
 * 一直显示「聊两句就有了」，而库里早就躺着 11 条事实。这个组合的危险在于：
 * 注释解释了「为什么不用假数据」，读起来像已经想清楚了；实际上
 * 真数据的通路根本没有，谁也不会去查一条「按设计就是空」的列表。
 *
 * 现在正文来自宿主 `/api/memory`（记忆内核 `listFacts`，按显著度降序）。
 * 没有引擎时不需要推导兜底：接口回 `reason: no-memory-core`，
 * 界面据此说「读不到她的记忆」，这比编三条出来诚实。
 */
