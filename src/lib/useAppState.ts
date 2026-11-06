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
  onConnectionChange,
  setConnection,
  setConnectionFailure,
  waitForHost,
} from './host.ts'
import { invokeShell, listenShell } from './shell.ts'
import type { HostReadyPayload, ShellHostState } from './shell.ts'
import {
  abortInference,
  createSession,
  fetchHealth,
  getConfig,
  getMessages,
  listModels,
  listSessions,
  runInference,
  selectModel,
} from './api.ts'
import type { ModelDescriptor, PermissionLevel, SessionMessage, SessionMeta, ThemeMode } from './api.ts'
import { setPreferences, usePreferences } from './preferences.ts'
import type { Attachment, BondStats, ComposerUsage, LogEntry, MemoryItem, MoodState } from './types.ts'

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
}

/** 应用状态。 */
export interface AppState {
  phase: ConnectionPhase
  /** 失败原因，仅在 phase 为 failed 时有值。 */
  error: string | undefined

  /** 当前会话 id。undefined 表示停在首页。 */
  sessionId: string | undefined
  /** 当前会话标题。 */
  title: string
  /** 当前会话的消息。 */
  messages: ChatMessage[]
  /** 历史会话。 */
  sessions: SessionMeta[]

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

  /** 已选附件。 */
  attachments: Attachment[]
  /** 弹出系统文件选择并附加。无壳时静默无操作。 */
  addFiles(): void
  /** 移除一条附件。 */
  removeAttachment(id: string): void

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
  /** 右栏「记得的事」。 */
  memories: MemoryItem[]
  /** 右栏状态块的更新时间。 */
  companionUpdatedAt: number
  /** 本轮用量。没有则 undefined。 */
  usage: ComposerUsage | undefined

  /** 是否已进入对话（三栏视图）。 */
  inConversation: boolean
  /** 叫出桌宠。 */
  summonPet(): void
  /** 进入会话：无会话则新建，有则打开最近的。 */
  enterSession(): void
  /** 新建会话。失败时抛错，由调用方决定怎么报告。 */
  newSession(): Promise<void>

  setDraft(value: string): void
  send(): Promise<void>
  stop(): Promise<void>
  /** 回到首页（新对话）。 */
  goHome(): void
  /** 打开一个历史会话。失败时抛错，由调用方决定怎么报告。 */
  openSession(sessionId: string): Promise<void>
  setPermission(permission: PermissionLevel): void
  dismissChatError(): void
  /** 重试连接。 */
  retry(): void
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
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [chatError, setChatError] = useState<string | undefined>(undefined)
  const [permission, setPermissionState] = useState<PermissionLevel>('full')

  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [modelId, setModelId] = useState<string | undefined>(undefined)
  const [attachments, setAttachments] = useState<Attachment[]>([])
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
  /** 是否已进入对话。进入后不再回首页，三栏常驻。 */
  const [entered, setEntered] = useState(false)
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
  const pushLog = useCallback((entry: Omit<LogEntry, 'id'>): void => {
    logSeq.current += 1
    const id = `log-${String(logSeq.current)}`
    setLogs((previous) => [...previous, { ...entry, id }])
  }, [])

  /** 刷新历史会话列表。 */
  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const list = await listSessions()
      setSessions(list)
      return
    } catch (caught) {
      // 列表拉取失败不该打断对话，静默留痕即可。
      console.error('拉取会话列表失败', caught)
    }
  }, [])

  // 订阅壳事件：宿主就绪/失败。
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
     */
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
        await refreshSessions()
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
  }, [phase, refreshSessions])

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
  const send = useCallback(async (): Promise<void> => {
    const input = draft.trim()
    // 空内容不发送；但若附带了文件，空文字也允许发出（纯附件消息）。
    if (input === '' && attachments.length === 0) return
    if (busy) return

    // 把附件名折叠进正文，作为可见的结构化前缀。内核当前只持久化
    // role + content，附件元数据走这条最简路径，既可见又不改动协议。
    const prefix = attachments.length > 0
      ? `[附件] ${attachments.map((item) => item.name).join('、')}\n`
      : ''
    const text = `${prefix}${input}`.trim()

    setDraft('')
    setAttachments([])
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
        summary: attachments.length > 0 ? '收到一条消息，带附件' : '收到一条消息',
        chars: text.length,
        ...(text.length > 0 ? { detail: text } : {}),
      })
    }

    // 助手那条先占位，收到第一个增量时再填充。
    const replyId = `reply-${String(Date.now())}`
    setMessages((previous) => [...previous, { id: replyId, role: 'assistant', content: '', pending: true, at: startedAt }])

    const abort = new AbortController()
    controller.current = abort
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
            setSessionId(id)
          },
          onDelta(text): void {
            // 正文第一帧落地时收一条「想完了」，记录思考的字数与耗时。
            // 这条是日志面板里唯一能读到"想了多久"的地方——推理过程
            // 不落盘，落盘的只有正文，过了这一刻时长就再也算不出来了。
            if (answerAt === undefined) {
              answerAt = Date.now()
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
          onError(message): void {
            setChatError(message)
            pushLog({
              round,
              at: Date.now(),
              channel: 'rhythm',
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
        setChatError(caught instanceof Error ? caught.message : '发送失败')
        pushLog({
          round,
          at: Date.now(),
          channel: 'rhythm',
          actor: 'system',
          summary: '这一轮失败',
        })
        setMessages((previous) => previous.filter((message) => message.id !== replyId))
      }
    } finally {
      controller.current = undefined
      setBusy(false)
      // 生成结束后会话标题可能已经由内核改过（首轮自动命名），重新拉一次。
      await refreshSessions()
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
  }, [draft, busy, sessionId, refreshSessions, pushLog])

  /** 停止生成。 */
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

  /** 回到首页。 */
  const goHome = useCallback((): void => {
    controller.current?.abort()
    setSessionId(undefined)
    setTitle('')
    setMessages([])
    setChatError(undefined)
    setLogs([])
    roundRef.current = 0
  }, [])

  /**
   * 打开历史会话。
   *
   * 返回 Promise 并**把失败抛出去**：界面既要在这里显示内联错误，
   * 也要让调用方决定是否弹顶部提示。内部吞掉异常会让上层永远
   * 以为成功了——上一版正是这样，"点了没反应"没有任何声音。
   */
  const openSession = useCallback(async (id: string): Promise<void> => {
    controller.current?.abort()
    setBusy(true)
    try {
      // 两个请求并发：消息给正文，列表给标题（标题在元信息里，不在消息里）。
      const [raw, list] = await Promise.all([getMessages(id), listSessions()])
      const meta = list.find((item) => item.id === id)
      const display = withTimestamps(raw)
      setSessionId(id)
      setTitle(meta?.title ?? '')
      setMessages(display)
      // 历史轮次的日志从消息推导，替换掉上一轮会话的实时日志。
      const derived = deriveLogs(display)
      setLogs(derived)
      // 轮次号对齐到推导出的最大值，下一次发送接着往下数，
      // 否则新消息会重新从第 1 轮开始，与历史撞号。
      roundRef.current = derived.reduce((max, entry) => Math.max(max, entry.round), 0)
      setChatError(undefined)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '打开会话失败'
      setChatError(message)
      throw new Error(message, { cause: caught })
    } finally {
      setBusy(false)
      void refreshSessions()
    }
  }, [refreshSessions])

  /** 切换权限。 */
  const setPermission = useCallback((next: PermissionLevel): void => {
    setPermissionState(next)
  }, [])

  /** 切换模型：先更新本地，再通知宿主持久化。 */
  const setModel = useCallback((id: string): void => {
    setModelId(id)
    void selectModel(id).catch((caught) => {
      console.error('切换模型失败', caught)
    })
  }, [])

  /** 弹出系统文件选择并附加。无壳（浏览器开发态）时静默无操作。 */
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
        // 不在壳内或用户取消都会落到这里，无需提示打断对话。
        console.debug('附加文件未生效', caught)
      }
    })()
  }, [])

  /** 移除一条附件。 */
  const removeAttachment = useCallback((id: string): void => {
    setAttachments((previous) => previous.filter((item) => item.id !== id))
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

  /**
   * 从首页进入三栏。
   *
   * ## 不在这里打开旧会话
   *
   * 早先的实现是「有会话就打开最近那个」，但首页那个输入框的语义是
   * **新对话**：在这里打的字如果进了三天前那个会话，用户是察觉不到的。
   * 更糟的是它会和紧跟着的 `send()` 抢着写消息与日志——
   * 一个在异步拉历史、一个在同步追加，实测日志里会出现两套
   * 「开始这一轮」，同一轮被记了两遍。
   *
   * 所以这里只做一件同步的事：切到三栏、把上一轮的内容清空。
   * 会话由首轮推理自己创建（`runInference` 拿到空 sessionId 时
   * 由宿主建会话、建工作区，再通过 `onSession` 回传 id），
   * 这样"进入"与"发出第一句话"是同一个动作，没有中间态可抢。
   *
   * 想继续旧对话，走左栏的会话列表——那是明确的、用户主动的动作。
   */
  const enterSession = useCallback((): void => {
    setEntered(true)
    setSessionId(undefined)
    setTitle('')
    setMessages([])
    setLogs([])
    roundRef.current = 0
    setUsage(undefined)
    setChatError(undefined)
  }, [])

  /**
   * 新建会话并留在三栏视图里。
   *
   * 同样把失败抛出去。宿主拒绝建会话时（插件未就绪、persona 未启动等），
   * 这是用户唯一能知道原因的机会——上一版把异常吞进 `chatError`，
   * 而三栏下那个位置在输入框上方，很容易被忽略成"没反应"。
   */
  const newSession = useCallback(async (): Promise<void> => {
    try {
      const created = await createSession('')
      setSessionId(created.id)
      setTitle(created.title)
      setMessages([])
      setUsage(undefined)
      setChatError(undefined)
      // 新会话的日志从零开始，不复用上一个会话的轮次编号。
      setLogs([])
      roundRef.current = 0
      await refreshSessions()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '创建会话失败'
      setChatError(message)
      throw new Error(message, { cause: caught })
    }
  }, [refreshSessions])

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
    sessions,
    busy,
    draft,
    chatError,
    permission,
    models,
    modelId,
    setModel,
    attachments,
    addFiles,
    removeAttachment,
    voiceActive,
    toggleVoice,
    theme,
    setTheme,
    logs,
    mood: deriveMood(),
    bond: deriveBond(),
    memories: deriveMemories(),
    companionUpdatedAt,
    usage,
    inConversation: entered,
    summonPet,
    enterSession,
    newSession,
    setDraft,
    send,
    stop,
    goHome,
    openSession,
    setPermission,
    dismissChatError,
    retry,
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
      // createdAt 缺失（老数据）时给 0：日志里会显示成 1970，
      // 但那比用 Date.now() 把所有历史都挤到"现在"更诚实。
      at: message.createdAt,
    })
  }
  return result
}

/**
 * 从落盘的消息推导日志时间轴。
 *
 * ## 用途
 *
 * 只用于**打开历史会话**：那时没有实时流可采，只能从消息反推。
 * 本轮正在发生的事由 `send()` 实时写入，不走这里——实时数据比推导准，
 * 比如「想了 1.2 秒」是推不出来的，消息里只有最终正文。
 *
 * ## 一轮的划分
 *
 * 以用户消息为界。用户说一句，到下一个用户消息之前，算一轮。
 * 这样「第 N 轮」与用户的心智一致：他数自己说了几句。
 *
 * ## 缺失的信息就留空
 *
 * 历史轮次没有思考记录，因此没有「想完了」这条。不补一条假数据——
 * 日志的价值在于可信，宁可少一行也不编一行。
 */
function deriveLogs(messages: ChatMessage[]): LogEntry[] {
  const entries: LogEntry[] = []
  let round = 0
  /** 这一轮最早的时刻。用于「开始这一轮」那一条。 */
  let roundAt = 0

  for (const message of messages) {
    if (message.role === 'user') {
      round += 1
      roundAt = message.at
      entries.push({
        id: `derived-${message.id}-rhythm`,
        round,
        at: roundAt,
        channel: 'rhythm',
        actor: 'system',
        summary: '开始这一轮',
      })
      entries.push({
        id: `derived-${message.id}-channel`,
        round,
        at: message.at,
        channel: 'channel',
        actor: 'user',
        summary: '收到一条消息',
        chars: message.content.length,
        ...(message.content !== '' ? { detail: message.content } : {}),
      })
      continue
    }

    // 助手消息挂在当前轮下。还没有用户消息时（不该出现）归到第 1 轮。
    const owner = Math.max(1, round)
    entries.push({
      id: `derived-${message.id}-model`,
      round: owner,
      at: message.at,
      channel: 'model',
      actor: 'assistant',
      summary: '说完了',
      chars: message.content.length,
      // 单轮总时长无法从消息还原（不知道何时开始想），
      // 因此只在这里用「与用户消息的时间差」作为粗略的回复耗时。
      ...(message.at > roundAt && roundAt > 0 ? { ms: message.at - roundAt } : {}),
      detail: message.content,
    })
  }

  return entries
}

/**
 * 「此刻」的心情与精力。
 *
 * ## 为什么现在一律返回 0
 *
 * 真实情绪来自情绪引擎的心跳，本版本还没接。此前的做法是**从词频编一个数**：
 * 数一数回复里有几个"开心/累"，加点轮数加成，压进 40–82，然后画成横条。
 * 那个数看着像测量结果，实际与 TA 的状态毫无关系——它只反映用户自己
 * 用了哪些词。原版对这件事的态度写在 `EMPTY` 的注释里：
 * 「一个编出合理数字的页面，比一个承认缺口的页面更糟」。
 *
 * 所以这里返回全 0：界面出"还没有心跳数据，聊两句 TA 就有了"，
 * 两条横条留在原位显示 0%。等心跳接上，改成读真实值即可，界面不用动。
 */
function deriveMood(): MoodState {
  return { mood: 0, energy: 0 }
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
 * 「TA 对你」的关系读数。
 *
 * ## 为什么是空
 *
 * 原版的形状只有两项：一个阶段标签（卡片右上角）与五个维度（0–100 横条）。
 * 这两项都由关系引擎产出，本版本还没接。
 *
 * 我此前自己补了「称谓 + 相处 N 天 · 说过 N 轮话」两行，理由是
 * 「这一栏该有这些信息」。但原版连对应的 CSS 类都不存在，
 * 而且那两个数是从会话列表里算出来的——它衡量的是**用户用了多久这个软件**，
 * 不是 TA 与用户的关系。挂上"关系"的名头展示，是拿统计冒充实测。
 */
function deriveBond(): BondStats {
  return { stage: '', dimensions: [] }
}

/**
 * 「记得的事」。
 *
 * ## 为什么是空
 *
 * 这张卡的标题是「记得的事」，指的是 TA 记住的事。此前的做法是
 * 把用户说过的话按长度挑三条填进来——那展示的是"我说过什么"，
 * 不是"TA 记住了什么"。两者差别很大：前者是聊天记录的复述，
 * 后者需要记忆引擎判断什么值得留。
 *
 * 原版没有记忆引擎时就直接出「暂无记忆」。这里同样返回空，
 * 让卡片说"暂无记忆"，而不是用会话原文冒充记忆。
 */
function deriveMemories(): MemoryItem[] {
  return []
}
