/**
 * 输入区（Composer）。
 *
 * ## 它是「一句话的盒子」，不是一张表单
 *
 * 卡片里只有两件事：你要说的话，和一个发送键。附件是话的一部分（贴在上面），
 * 加号与麦克风是话的工具（贴在下面一行）；**模型与权限不在卡里**——它们
 * 回答的是「跟谁说话、能走多远」，是说话之前的前置决定，所以排在卡外的
 * 一行脚注里。
 *
 * 上一版把模型名放在卡内工具行左端，与加号并排。结果是「换模型」和
 * 「加附件」在视觉上成了同一件事，而它们的频率差两个数量级。
 *
 * ## 两列地板
 *
 * 正文占左、动作占右，发送键与文字**同处一行**，不在文字下方。
 * 这样卡片读起来是「一句话 + 一个动作」，而不是「一个输入框 + 一条工具栏」。
 * 文字多行时发送键贴着底边（`align-items: flex-end`），不会浮到中间。
 *
 * ## 发送键的三个状态
 *
 * | 状态 | 图形 | 含义 |
 * | --- | --- | --- |
 * | 可发 | 带凹口的实心三角 | 方向 |
 * | 生成中且草稿为空 | 圆角方块 | 停下这一轮 |
 * | 生成中且有草稿 | 三角 | 按设置：排队或打断后发出 |
 *
 * 空草稿时按钮保留在原位、降到 40% 不透明度：位置不动，用户不必重新找它。
 *
 * ## 十条输入细则落在哪
 *
 * | 细则 | 落点 |
 * | --- | --- |
 * | 空输入时发送键保留但降透明度 | `aria-disabled` + CSS |
 * | 首次聚焦边框转焦点环 | CSS `:focus-within` |
 * | 高度 1→3 行逐级增长 | `useEffect` 按 `scrollHeight` 算，封顶 3 行 |
 * | 粘贴多行不自动发送 | 不拦文本粘贴 |
 * | 粘贴图片转附件 | `lib/paste.ts` + `onPaste` |
 * | 粘贴超长先确认 | `pending` + `Dialog` |
 * | 生成中输入框仍可编辑 | 只有发送键换语义，textarea 不禁用 |
 * | 生成中按 Enter | 按 `sendMode` 排队或打断 |
 * | 草稿跨会话保留 | 状态在 `useAppState` |
 * | 超长提示 | 底部行出现计数 |
 *
 * ## 为什么 `isComposing` 要判 `nativeEvent`
 *
 * React 的合成事件不带 `isComposing`，它在原生 `KeyboardEvent` 上。
 * 不判这一条，中文输入法选词时按回车会把半截拼音发出去——这是中文界面
 * 最容易出、也最难在英文环境复现的缺陷。
 *
 * ## 焦点为什么不交给按钮
 *
 * 点加号、点停止时浏览器会把焦点搬到按钮上，输入法状态与光标位置一起丢。
 * 所有按钮的 `onMouseDown` 都 `preventDefault`，焦点留在 textarea 里，
 * 用户松手就能接着打下一个字。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose, IconChevronDown, IconMic, IconPlus } from './icons.ts'
import { Dialog } from './Dialog.tsx'
import { QueueDock } from './QueueDock.tsx'
import { CONFIRM_LIMIT, imagesOf, toPastedImages } from '../lib/paste.ts'
import type { Attachment, ComposerUsage, QueuedMessage } from '../lib/types.ts'
import type { ModelDescriptor, PermissionLevel } from '../lib/api.ts'
import { usePreferences } from '../lib/preferences.ts'
import { invokeShell } from '../lib/shell.ts'

/**
 * 单条上限：底部行出现计数的阈值，也是发送前确认的阈值。
 *
 * 定义在 `lib/paste.ts`——那里是「多少字算长」这条规则的唯一真源，
 * 而计数与确认是它的两种表现。定义两遍就会出现「计数跳了但不问」。
 */
const SOFT_LIMIT = CONFIRM_LIMIT

/**
 * 单行高度，用于把内容行数换算成可视高度。
 *
 * `LINE` 是 textarea 的 `line-height`（见 `composer.css`：14px × 20/14），
 * 不是字号。两者分开写，是因为将来改字号时行高不该跟着等比缩——
 * 20px 行高在 14 与 15 两个字号下都是中文的舒适值。
 */
const LINE = 20

/**
 * textarea 的上内距，与 `composer.css` 里 `.composer__input` 的
 * `padding-top` 必须同值。
 *
 * 为什么写在这里而不是读 computed style：这条 effect 在每次输入时都跑，
 * 每帧一次 `getComputedStyle` 会把它的开销从「算一次数」变成「触发布局」。
 */
const PAD_TOP = 8

/** 最多展开 3 行，超出内部滚动。 */
const MAX_ROWS = 3

/** 权限档位的显示名。与设置页同一套说法，不在这里另起一套。 */
const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  chat: '只在对话内',
  workspace: '限于工作区',
  full: '不限制',
}

/** 上下文环的几何：14px 视窗、2px 描边。 */
const RING_RADIUS = 5.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export interface ComposerProps {
  /** 当前草稿。 */
  value: string
  /** 草稿变化。 */
  onChange(value: string): void
  /** 空闲时发送。 */
  onSend(): void
  /**
   * 生成中「打断并发送」。
   *
   * 抽成一个动作而不是让组件依次调 stop + send：两步之间有竞态
   * （`stop` 是异步的，`send` 在 `busy` 还是 true 时会自己挡回去，
   * 结果就是消息静默消失）。这一条由数据层实现，组件只表达意图。
   */
  onInterruptSend(): void
  /** 生成中「排队」：把草稿放进队列，这一轮结束后自动发出。 */
  onEnqueue(): void
  /** 停止生成。 */
  onStop(): void
  /** 是否正在生成。 */
  busy: boolean
  /** 已选附件。 */
  attachments: Attachment[]
  /** 弹出文件选择。 */
  onAddFiles(): void
  /** 直接附加一批（粘贴图片）。 */
  onAddAttachments(items: readonly { name: string; thumb?: string }[]): void
  /** 移除一条附件。 */
  onRemoveAttachment(id: string): void
  /** 可选模型。 */
  models: ModelDescriptor[]
  /** 当前模型 id。 */
  modelId: string | undefined
  /** 切换模型。 */
  onSelectModel(id: string): void
  /** 当前权限档位。 */
  permission: PermissionLevel
  /** 切换权限档位。 */
  onSelectPermission(next: PermissionLevel): void
  /** 本轮用量。没有则 undefined（此时不画上下文环）。 */
  usage: ComposerUsage | undefined
  /** 排队中的消息。 */
  queue: QueuedMessage[]
  /** 移除一条排队消息。 */
  onDropQueued(id: string): void
  /** 改一条排队消息的正文。 */
  onEditQueued(id: string, text: string): void
  /** 上移 / 下移一条排队消息。 */
  onMoveQueued(id: string, direction: -1 | 1): void
  /**
   * 生成中按 Enter 的行为。
   *
   * `queue` 入队等这一轮结束，`interrupt` 立刻停下并发出。
   */
  sendMode: 'queue' | 'interrupt'
  /**
   * 输入框节点交给上层。
   *
   * `Cmd/Ctrl + N` 与 `↑`（编辑上一条）都要把焦点送回输入框，
   * 而这两个键的处理在 `App` 里——只有它知道该回填哪一条。
   */
  onInputRef?(node: HTMLTextAreaElement | null): void
}

/**
 * 渲染一个上下文占用环。
 *
 * ## 为什么是环而不是数字
 *
 * 「还剩多少上下文」是一个**比例**。数字要读、要跟一个基数比；环只要瞟一眼。
 * 百分比仍然写着——环给的是形状，字给的是精度，两者不重复。
 *
 * ## 为什么没有点开的分段构成
 *
 * 上一版点开能看到「系统提示 / 工具定义 / 对话内容」三段各占多少。本版的
 * 宿主只回一个整轮估算值（见 `useAppState` 的注解），拆不出三段。
 * 与其画一个假的三段饼，不如只给总量：**少一个功能，不多一句假话**。
 *
 * @param props.percent 0–100。
 * @returns 环 + 百分比。
 */
function ContextRing({ percent }: { percent: number }): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = (clamped / 100) * RING_CIRCUMFERENCE
  return (
    <span className="composer__ring" title={`上下文已用 ${String(clamped)}%`}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
        <circle
          cx="7"
          cy="7"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${String(filled)} ${String(RING_CIRCUMFERENCE)}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span className="composer__ring-text">{String(clamped)}%</span>
      <span className="sr-only">上下文已用 {String(clamped)}%</span>
    </span>
  )
}

/**
 * 渲染输入区。
 *
 * @param props 见 `ComposerProps`。
 * @returns 输入卡片 + 脚注 + 上下文环。
 */
export function Composer({
  value,
  onChange,
  onSend,
  onInterruptSend,
  onEnqueue,
  onStop,
  busy,
  attachments,
  onAddFiles,
  onAddAttachments,
  onRemoveAttachment,
  models,
  modelId,
  onSelectModel,
  permission,
  onSelectPermission,
  usage,
  queue,
  onDropQueued,
  onEditQueued,
  onMoveQueued,
  sendMode,
  onInputRef,
}: ComposerProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  /** 语音输入（G2）。仅在设置开启时显示麦克风按钮。 */
  const prefs = usePreferences()
  const [recording, setRecording] = useState(false)
  const [voiceNote, setVoiceNote] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  /** 录音结束时可能已输入新文字，用 ref 取最新草稿拼接。 */
  const valueRef = useRef(value)
  valueRef.current = value

  /** 开始录音并转写。 */
  const startVoice = useCallback(async (): Promise<void> => {
    setVoiceNote('')
    if (typeof MediaRecorder === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
      setVoiceNote('当前环境不支持录音')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event: BlobEvent): void => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = async (): Promise<void> => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        stream.getTracks().forEach((track) => { track.stop() })
        setVoiceNote('识别中…')
        try {
          const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
          const result = await invokeShell<{ ok: boolean; text: string; reason?: string | null }>(
            'transcribe_audio',
            { audio: bytes },
          )
          if (result.ok && result.text !== '') {
            const base = valueRef.current
            onChange(base + (base !== '' && !base.endsWith(' ') ? ' ' : '') + result.text)
            setVoiceNote('')
          } else {
            setVoiceNote(result.reason ?? '识别失败')
          }
        } catch (caught) {
          setVoiceNote(caught instanceof Error ? caught.message : '语音识别失败')
        }
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch (caught) {
      setVoiceNote(caught instanceof Error ? caught.message : '无法访问麦克风')
    }
  }, [onChange])

  /** 停止录音（触发转写）。 */
  const stopVoice = useCallback((): void => {
    recorderRef.current?.stop()
    setRecording(false)
  }, [])

  /** 把节点同时挂进本地 ref 与上层的 ref。 */
  const attachInput = useCallback((node: HTMLTextAreaElement | null): void => {
    inputRef.current = node
    onInputRef?.(node)
  }, [onInputRef])

  /**
   * 聚焦时把输入区顶到软键盘上方（§10.8）。
   *
   * 不能只靠 CSS 的 `--kb-h`：CSS 让输入区上移，但页面本身不会跟着滚。
   * iOS 弹出键盘时布局视口不缩小、也不自动滚动，结果是输入区被顶到屏幕外。
   *
   * 用 `scrollIntoView({ block: 'nearest' })` 而不是算 `scrollTop`：
   * 输入区不一定在"整页"里滚，而是在 `.column` 这个 flex 容器里跟着时间轴排。
   */
  const revealOnFocus = useCallback((): void => {
    const node = inputRef.current
    if (node === null) return
    globalThis.requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }, [])

  const current = models.find((model) => model.id === modelId)

  /**
   * 高度自适应。
   *
   * `rows` 只是初始提示，实际高度由浏览器按内容算，会一直长到几十行。
   * 必须显式设 `height` 才能封顶。先置 `auto` 再读 `scrollHeight`，
   * 是因为不置 auto 时读到的 `scrollHeight` 只增不减——删字之后框不会缩。
   */
  useEffect(() => {
    const node = inputRef.current
    if (node === null) return
    node.style.height = 'auto'
    const max = LINE * MAX_ROWS + PAD_TOP
    node.style.height = `${String(Math.min(node.scrollHeight, max))}px`
  }, [value])

  /**
   * 待确认的超长草稿。
   *
   * 存的是**提交那一刻的快照**而不是「要不要确认」的布尔：确认后要发的是
   * 那一份内容，而用户在这期间完全可能又改了几个字。
   */
  const [pending, setPending] = useState<{ text: string } | undefined>(undefined)

  /**
   * 回声的序号。
   *
   * 每次真正发出去时 +1，用它做 `key` 让一枚新的圆环重新播放动画。
   * 不存布尔：布尔只能触发一次，第二次发送时动画不会重来。
   */
  const [echo, setEcho] = useState(0)

  /** 草稿为空（含无附件）。 */
  const empty = value.trim() === '' && attachments.length === 0

  /**
   * 真正发送。
   *
   * 三条路，由 `busy` 与 `sendMode` 决定，组件不做别的判断：
   * - 空闲 → 发；
   * - 生成中 + 排队 → 进队列；
   * - 生成中 + 打断 → 停下这一轮再发。
   */
  const deliver = useCallback((): void => {
    if (busy) {
      if (sendMode === 'queue') onEnqueue()
      else onInterruptSend()
    } else {
      onSend()
    }
    /* 只有真的发出去了才给回声：排队不该有"话出去了"的反馈。 */
    if (!busy || sendMode !== 'queue') setEcho((previous) => previous + 1)
  }, [busy, sendMode, onSend, onEnqueue, onInterruptSend])

  /** 发送。超长时先确认（§12.14）。 */
  const submit = useCallback((): void => {
    const text = value.trim()
    if (text === '' && attachments.length === 0) return
    if (text.length > CONFIRM_LIMIT) {
      setPending({ text })
      return
    }
    deliver()
  }, [value, attachments.length, deliver])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 组合中不发送（§12.3）。这一条必须最先判。
    if (event.nativeEvent.isComposing) return
    if (event.key !== 'Enter') return
    // Shift + Enter 换行。Cmd/Ctrl + Enter 在排队模式下越过队列立刻发。
    if (event.shiftKey) return
    event.preventDefault()
    if ((event.metaKey || event.ctrlKey) && busy && sendMode === 'queue') {
      onInterruptSend()
      setEcho((previous) => previous + 1)
      return
    }
    submit()
  }, [submit, busy, sendMode, onInterruptSend])

  // 模型菜单：点到外面就关。用 pointerdown 而不是 click：
  // click 在「按在菜单外、松在菜单内」时不会触发，菜单会留在原地。
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) return
      setMenuOpen(false)
    }
    globalThis.addEventListener('pointerdown', onPointerDown)
    return () => { globalThis.removeEventListener('pointerdown', onPointerDown) }
  }, [menuOpen])

  /**
   * 粘贴（§12.14）。
   *
   * 只有带图片时才 `preventDefault`。对**所有** paste 都拦下来自己
   * `insertText`，会同时丢掉撤销栈的合并、输入法候选上屏、原生选区替换
   * ——三样都要自己重写，而收益是零。
   */
  const onPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imagesOf(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void (async () => {
      const images = await toPastedImages(files)
      onAddAttachments(images)
    })()
  }, [onAddAttachments])

  /**
   * 按钮上按下鼠标时不让焦点离开输入框。
   *
   * 点完加号再打字，若焦点被按钮拿走，输入法会回到英文、光标位置也丢了。
   * 在 `mousedown` 上处理是唯一有效的时机：`click` 已经太晚。
   */
  const keepFocus = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const overLimit = value.length > SOFT_LIMIT
  /** 生成中且没有草稿：这个位置该是「停下」，不是「发送」。 */
  const showStop = busy && empty

  const primaryLabel = showStop ? '停止生成' : busy ? (sendMode === 'queue' ? '排队发送' : '打断并发送') : '发送'

  return (
    <div className="composer">
      {/*
        排队区在卡片**上方**：排队的东西是"还没轮到的句子"，位置应当在
        正在写的那句之前——它与时间轴同向（先排的在上，后写的在下）。
      */}
      {queue.length > 0 ? (
        <QueueDock
          items={queue}
          onDrop={onDropQueued}
          onEdit={onEditQueued}
          onMove={onMoveQueued}
        />
      ) : null}

      <div className="composer__card">
        {/*
          附件缩略图排在输入框上方，超过 6 个横向滚动。
          图片画成 48 × 48 方块，文件留 48 高的小卡放文件名。
        */}
        {attachments.length > 0 ? (
          <ul className="composer__attachments">
            {attachments.map((item) => (
              <li
                key={item.id}
                className={item.thumb === undefined
                  ? 'composer__attachment'
                  : 'composer__attachment composer__attachment--image'}
                title={item.name}
              >
                {item.thumb === undefined ? (
                  <span className="composer__attachment-name">{item.name}</span>
                ) : (
                  /*
                    缩略图用 `background-image` 而不是 `<img>`：它是 48 × 48 的
                    定方块，`background-size: cover` 一行就够，而 `<img>` 还要
                    处理 object-fit、默认可拖（拖出去会往别的应用扔一个 data URL）
                    与 alt 取舍。装饰性图片不该有 alt——文件名已在 title 上。
                  */
                  <span
                    className="composer__attachment-thumb"
                    role="img"
                    aria-label={item.name}
                    style={{ backgroundImage: `url(${item.thumb})` }}
                  />
                )}
                <button
                  type="button"
                  className="composer__attachment-remove"
                  aria-label={`移除 ${item.name}`}
                  onMouseDown={keepFocus}
                  onClick={() => { onRemoveAttachment(item.id) }}
                >
                  <Icon icon={IconClose} size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* 两列地板：正文占左，动作占右。 */}
        <div className="composer__floor">
          <textarea
            ref={attachInput}
            className="composer__input"
            value={value}
            rows={1}
            placeholder={busy ? '生成中，回车将排队发送' : '输入消息…'}
            aria-label="输入消息"
            onChange={(event) => { onChange(event.target.value) }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={revealOnFocus}
          />

          <div className="composer__sendcol">
            {/*
              生成中且草稿为空 → 停止。有草稿时保留发送语义：用户此刻想说
              下一句，而不是想停下（停下仍可用 Esc）。
            */}
            {showStop ? (
              <button
                type="button"
                className="composer__primary"
                aria-label={primaryLabel}
                title={primaryLabel}
                onMouseDown={keepFocus}
                onClick={onStop}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="2.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="composer__primary"
                aria-label={primaryLabel}
                title={primaryLabel}
                aria-disabled={empty}
                aria-describedby={empty ? 'composer-send-hint' : undefined}
                onMouseDown={keepFocus}
                onClick={empty ? undefined : submit}
              >
                {/*
                  导航三角：带凹口的实心三角，是「方向」而不是纸飞机。
                  描边 0.6 与填充同色，小尺寸下边缘才不显毛。
                */}
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                  <path d="M8 1.6 14 14.2 8 11.3 2 14.2Z" fill="currentColor" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            {empty && !showStop ? (
              <span className="sr-only" id="composer-send-hint">请先输入内容再发送</span>
            ) : null}
          </div>
        </div>

        <div className="composer__tools">
          <button
            type="button"
            className="composer__attach"
            aria-label="附加文件"
            title="附加文件"
            onMouseDown={keepFocus}
            onClick={onAddFiles}
          >
            <Icon icon={IconPlus} size={16} />
          </button>

          {prefs.voiceInput ? (
            <button
              type="button"
              className={recording ? 'composer__mic composer__mic--on' : 'composer__mic'}
              aria-label={recording ? '停止录音' : '语音输入'}
              aria-pressed={recording}
              title={recording ? '停止录音' : '语音输入'}
              onMouseDown={keepFocus}
              onClick={recording ? stopVoice : () => { void startVoice() }}
            >
              <Icon icon={IconMic} size={16} />
            </button>
          ) : null}
          {voiceNote === '' ? null : (
            <span className="composer__voice-note" aria-live="polite">{voiceNote}</span>
          )}

          {/* 超长时才出现计数：常驻会让人时刻在意字数。 */}
          {overLimit ? (
            <span className="composer__count" data-over="">
              {value.length} / {SOFT_LIMIT}
            </span>
          ) : null}

          <span className="composer__spacer" />

          {busy ? <span className="composer__busy-hint">{sendMode === 'queue' ? '回车排队' : '回车插话'}</span> : null}
        </div>

        {/*
          回声：发送成功后从发送键位置向外扩一圈，520ms 淡出。
          `key` 变化会让节点重建，于是每一句话都有自己的一圈。
        */}
        {echo === 0 ? null : <span className="composer__echo" key={echo} aria-hidden="true" />}
      </div>

      {/*
        脚注：权限 + 模型。
        
        两个都是「说话之前」的决定：跟谁说话、她能走多远。放在卡外一行、
        居中，读起来是一条脚注而不是一条工具栏——它们一天改一次，
        而输入框一秒用三次。
      */}
      <div className="composer__footnote">
        {/*
          权限用原生 `<select>`：三档、无层级、要能用键盘直接选。
          自绘菜单在这里只会多一层状态，换不来任何表达力。
        */}
        <label className="composer__select" title="本档决定可访问的操作范围">
          <select
            className="composer__select-input"
            value={permission}
            aria-label="权限档位"
            onChange={(event) => { onSelectPermission(event.target.value as PermissionLevel) }}
          >
            {(Object.keys(PERMISSION_LABEL) as PermissionLevel[]).map((level) => (
              <option key={level} value={level}>{PERMISSION_LABEL[level]}</option>
            ))}
          </select>
          <span className="composer__select-face" aria-hidden="true">
            {PERMISSION_LABEL[permission]}
            <Icon icon={IconChevronDown} size={16} />
          </span>
        </label>

        <div className="composer__model" ref={menuRef}>
          <button
            type="button"
            className="composer__model-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen((previous) => !previous) }}
          >
            {current === undefined ? '未选择模型' : current.label}
            <Icon icon={IconChevronDown} size={16} />
          </button>
          {menuOpen ? (
            <div className="composer__model-menu" role="menu">
              {models.length === 0 ? (
                <p className="composer__model-empty">尚无可用模型，请在设置中「对话」页添加</p>
              ) : (
                models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={model.id === modelId}
                    className="composer__model-item"
                    onClick={() => {
                      onSelectModel(model.id)
                      setMenuOpen(false)
                    }}
                  >
                    {model.label}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* 上下文占用：没有用量数据时不画，空环会被读成"用的是零"。 */}
      {usage === undefined ? null : (
        <div className="composer__dock">
          <ContextRing percent={usage.context} />
        </div>
      )}

      {/*
        超长确认（§12.14）。用 `Dialog` 而不是 `globalThis.confirm`：
        原生 confirm 在 macOS 上是系统级模态、样式完全不受控，且在 Tauri 里
        部分平台会被壳拦掉或根本不显示。
      */}
      {pending === undefined ? null : (
        <Dialog
          title="消息篇幅较长"
          confirmLabel="仍然发送"
          cancelLabel="返回修改"
          onConfirm={() => {
            setPending(undefined)
            deliver()
          }}
          /* Esc 与「返回修改」都只是关掉这个框，草稿原样留在输入框里。 */
          onCancel={() => { setPending(undefined) }}
          onDismiss={() => { setPending(undefined) }}
        >
          本消息共 {pending.text.length} 个字，篇幅较长，拆成两条发送通常更便于阅读。
        </Dialog>
      )}
    </div>
  )
}
