/**
 * 输入区（Composer，§5.6）。
 *
 * ## 它承载的不只是输入
 *
 * 一块 620 × 76 的卡片里有五样东西：正文输入、附件缩略图、
 * 加号、模型名、发送键。任何一样缺失，用户都会先去找它而不是先打字——
 * 「怎么换个模型」比「说什么」更常发生。
 *
 * ## 十条输入细则落在哪
 *
 * §5.6 的十条细则里，能靠 CSS 表达的在 `composer.css`，需要状态的在这里：
 *
 * | 细则 | 落点 |
 * | --- | --- |
 * | 空输入时发送键**保留**但降为 40% | `disabled` + CSS 不透明度，不移除节点 |
 * | 首次聚焦边框转 teal | CSS `:focus-within` |
 * | 高度 1→3 行逐级增长 | `rows` 由内容行数算，封顶 3 |
 * | 粘贴多行不自动发送 | 不拦文本粘贴，交给浏览器默认行为 |
 * | 粘贴图片转附件 | `lib/paste.ts` + 本文件的 `onPaste` |
 * | 粘贴超长先确认 | 本文件的 `pending` + `Dialog` |
 * | 生成中输入框仍可编辑 | `disabled` 只加在发送键上 |
 * | 生成中按 Enter | 走 `interrupt` 判断 |
 * | 草稿跨会话保留 | 状态在 `useAppState`，本组件不持有 |
 * | 超长提示 | 字数接近上限时底部行出现计数 |
 *
 * ## 为什么 `isComposing` 要判 `nativeEvent`
 *
 * React 的合成事件不带 `isComposing`，它在原生 `KeyboardEvent` 上。
 * 不判这一条，中文输入法选词时按回车会把半截拼音发出去——
 * 这是中文界面最容易出、也最难在英文环境复现的缺陷。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose, IconChevronDown, IconMic, IconPlus, IconSend } from './icons.ts'
import { Dialog } from './Dialog.tsx'
import { CONFIRM_LIMIT, imagesOf, toPastedImages } from '../lib/paste.ts'
import type { Attachment } from '../lib/types.ts'
import type { ModelDescriptor } from '../lib/api.ts'
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
 * 两处同值的代价是改一处要记得改另一处——所以两处都留了指向对方的注释，
 * 并且 `check:ui` 有一条断言拿实测几何去对。
 */
const PAD_TOP = 8

/** 最多展开 3 行，超出内部滚动（§5.6）。 */
const MAX_ROWS = 3

export interface ComposerProps {
  /** 当前草稿。 */
  value: string
  /** 草稿变化。 */
  onChange(value: string): void
  /** 发送。 */
  onSend(): void
  /** 停止生成。 */
  onStop(): void
  /** 是否正在生成。 */
  busy: boolean
  /** 已选附件。 */
  attachments: Attachment[]
  /** 弹出文件选择。 */
  onAddFiles(): void
  /**
   * 直接附加一批（粘贴图片，§12.14）。
   *
   * 与 `onAddFiles` 并列而不是复用它：那条走系统选择器，
   * 这条走内存里的缩略图，两者唯一的共同点是「都往附件列表里加东西」。
   */
  onAddAttachments(items: readonly { name: string; thumb?: string }[]): void
  /** 移除一条附件。 */
  onRemoveAttachment(id: string): void
  /** 可选模型。 */
  models: ModelDescriptor[]
  /** 当前模型 id。 */
  modelId: string | undefined
  /** 切换模型。 */
  onSelectModel(id: string): void
  /**
   * 生成中按 Enter 的行为。
   *
   * `queue` 入队等这一轮结束，`interrupt` 立刻停止并发送（§5.6）。
   * 取值来自设置；本期没有设置项时用 `interrupt`——
   * 用户按下回车时想要的通常是「我现在就要说」。
   */
  interrupt?: 'queue' | 'interrupt'
  /**
   * 输入框节点交给上层。
   *
   * `Cmd/Ctrl + N`（新建对话）与 `↑`（编辑上一条）都要把焦点送回输入框，
   * 而这两个键的处理在 `App` 里——只有它知道什么时候该回首页、
   * 回填哪一条。把 textarea 的 ref 交出去，比在组件上加两个
   * `focus()` 方法再各写一遍转发更省。
   */
  onInputRef?(node: HTMLTextAreaElement | null): void
}

/**
 * 渲染输入区。
 *
 * @param props 见 `ComposerProps`。
 * @returns 输入卡片。
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  attachments,
  onAddFiles,
  onAddAttachments,
  onRemoveAttachment,
  models,
  modelId,
  onSelectModel,
  interrupt = 'interrupt',
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
   * ## 为什么不能只靠 CSS 的 `--kb-h`
   *
   * CSS 那条让整个输入区上移，但**页面本身不会跟着滚**。iOS 弹出键盘时
   * 布局视口不缩小、也不自动滚动，结果是输入区被顶到屏幕外——比被键盘
   * 盖住更糟：用户连上面那半句都看不到了。
   *
   * 这里在聚焦后延一帧再滚（键盘动画约 250ms，`requestAnimationFrame`
   * 一帧就够拿到新的 `visualViewport.height`），把输入区底边对齐到
   * 可视区底边。
   *
   * ## 为什么用 `scrollIntoView` 而不是算 `scrollTop`
   *
   * 输入区不一定在「整页」里滚，而是在 `.column` 这个 flex 容器里跟着
   * 时间轴一起排。手算要猜滚动容器是谁，`scrollIntoView({ block: 'nearest' })`
   * 交给浏览器逐层处理，且 `nearest` 保证「已经可见时不动」——
   * 桌面上点输入框永远不会跳一下。
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
   * ## 为什么不直接写 `rows`
   *
   * `rows` 只是初始提示，实际高度由浏览器按内容算，会一直长到几十行。
   * 必须显式设 `height` 才能封顶。先置 `auto` 再读 `scrollHeight`，
   * 是因为不置 auto 时读到的 `scrollHeight` 只增不减——删字之后框不会缩。
   */
  useEffect(() => {
    const node = inputRef.current
    if (node === null) return
    node.style.height = 'auto'
    /*
     * 封顶 = 三行文字 + textarea 自己的上内距。
     *
     * `scrollHeight` 把 padding 算在内，所以这里的常数必须与
     * `composer.css` 里 `.composer__input` 的 `padding-top` 同值（8）——
     * 旧值是 12，多出的 4px 让三行状态下框底比文字低一档，最后一行
     * 下面空出一条谁也说不出原因的缝。
     */
    const max = LINE * MAX_ROWS + PAD_TOP
    node.style.height = `${String(Math.min(node.scrollHeight, max))}px`
  }, [value])

  /**
   * 待确认的超长草稿。
   *
   * `undefined` 表示没有待确认的东西。存的是**提交那一刻的快照**而不是
   * 「要不要确认」的布尔：确认后要发的是那一份内容，而用户在这期间
   * 完全可能又改了几个字——真发出去的是他改过的版本，确认框就成了摆设。
   */
  const [pending, setPending] = useState<{ text: string } | undefined>(undefined)

  /**
   * 回声的序号。
   *
   * 每次真正发出去时 +1，用它做 `key` 让一枚新的圆环重新播放动画。
   * 不存布尔：布尔只能触发一次，第二次发送时动画不会重来。
   * 0 表示还没发过，此时不渲染任何东西。
   */
  const [echo, setEcho] = useState(0)

  /**
   * 真正发送。抽出来是因为它有两个入口：直接发、确认后发。
   *
   * 抽出来而不是在 `submit` 里加一个 `confirmed` 参数：那个参数一旦存在，
   * 每个调用点都要想一次「我这里该传什么」，而答案永远是同一个。
   */
  const deliver = useCallback((): void => {
    if (busy) {
      if (interrupt === 'interrupt') onStop()
      else return
    }
    onSend()
    // 话出去了，给一枚回声。它只是确认，不携带任何状态。
    setEcho((previous) => previous + 1)
  }, [busy, interrupt, onStop, onSend])

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
    // Shift + Enter 与 Cmd/Ctrl + Enter 都不走默认发送路径：
    // 前者换行，后者按设置走另一种发送方式。
    if (event.shiftKey) return
    event.preventDefault()
    if ((event.metaKey || event.ctrlKey) && interrupt === 'queue') {
      // Cmd/Ctrl + Enter 在「排队」模式下才代表立即发送，其余情况同 Enter。
      submit()
      return
    }
    submit()
  }, [submit, interrupt])

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
   * ## 三种情形，只有两种需要动手
   *
   * | 剪贴板里是 | 动作 |
   * | --- | --- |
   * | 纯文字 | 什么都不做，浏览器默认粘贴（含换行、丢样式，天然满足要求） |
   * | 图片 | `preventDefault` + 转附件，文字一并不收 |
   * | 图片 + 文字 | 同上。文字是图片的元数据，不是用户要说的话 |
   *
   * ## 为什么在没有图片时直接返回
   *
   * 这是这一条最容易被写坏的地方。一旦对**所有** paste 都
   * `preventDefault` 再自己 `insertText`，就会同时丢掉：撤销栈的
   * 合并、输入法的候选上屏、原生选区替换。三样都要自己重写一遍，
   * 而收益是零——textarea 的默认粘贴本来就是我们想要的。
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

  const overLimit = value.length > SOFT_LIMIT
  /** 空输入：发送键保留但不可用（§5.6）。 */
  const empty = value.trim() === '' && attachments.length === 0

  return (
    <div className="composer">
      <div className="composer__card">
        {/*
          附件缩略图排在输入框上方，超过 6 个横向滚动（§5.6）。

          ## 两种形态：图片有图，文件没有

          图片附件画成 48 × 48 的方块（§12.14），文件附件留 24 高的胶囊。
          不是刻意不一致——胶囊里能放文件名，图片附件放不下，
          硬塞一个 48 高的方块里再叠文字会让两者都看不清。
          容器用 `align-items: center` 让它们在一条水平线上居中对齐。
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
                    缩略图用 `background-image` 而不是 `<img>`：
                    它是 48 × 48 的定方块，`background-size: cover` 一行就够，
                    而 `<img>` 要额外处理 object-fit、拖拽（图片默认可拖，
                    拖出去会变成往别的应用扔一个 data URL）与 alt 取舍。
                    装饰性图片不该有 alt——文件名已在 `title` 上。
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
                  onClick={() => { onRemoveAttachment(item.id) }}
                >
                  <Icon icon={IconClose} size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <textarea
          ref={attachInput}
          className="composer__input"
          value={value}
          rows={1}
          placeholder="输入消息…"
          aria-label="输入消息"
          onChange={(event) => { onChange(event.target.value) }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={revealOnFocus}
        />

        <div className="composer__row">
          <button
            type="button"
            className="composer__attach"
            aria-label="附加文件"
            title="附加文件"
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
              onClick={recording ? stopVoice : () => { void startVoice() }}
            >
              <Icon icon={IconMic} size={16} />
            </button>
          ) : null}
          {voiceNote === '' ? null : (
            <span className="composer__voice-note" aria-live="polite">{voiceNote}</span>
          )}

          {/*
            模型名。点击展开候选。没有可选模型时显示「未选择」并指向设置
            （§12.5 的空状态规则：显示引导语而不是「暂无数据」）。
          */}
          <div className="composer__model" ref={menuRef}>
            <button
              type="button"
              className="composer__model-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen((previous) => !previous) }}
            >
              {current === undefined ? '未选择' : current.label}
              {/*
                下拉指示。没有它时这行是「一个加号 + 一串裸文字」，
                看不出那串字可以点。箭头是菜单的唯一通用标记（§4.4）：
                它不解释"有什么"，只说"这里能展开"。
              */}
              <Icon icon={IconChevronDown} size={16} />
            </button>
            {menuOpen ? (
              <div className="composer__model-menu" role="menu">
                {models.length === 0 ? (
                  <p className="composer__model-empty">尚无可用模型，请在设置中添加</p>
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

          {/* 超长时出现计数，不超长时不显示——常驻会让人时刻在意字数。 */}
          {overLimit ? (
            <span className="composer__count" data-over="">
              {value.length} / {SOFT_LIMIT}
            </span>
          ) : null}

          <span className="composer__spacer" />

          {/*
            发送键。生成中换成「先别说」（§5.4）：用户此刻最可能想做的
            不是再发一条，而是让这一轮停下。同一个位置，两种语义。
          */}
          {busy ? (
            <button type="button" className="composer__stop" onClick={onStop}>
              停止
            </button>
          ) : (
            /*
             * 发送键。空输入时**保留在位置上**，但不可用且降为 40%（§5.6）。
             *
             * ## 用 `aria-disabled` 而不是 `disabled`
             *
             * §13 要求「禁用项用 `aria-disabled` 且可聚焦，聚焦时朗读禁用原因」。
             * 原生 `disabled` 会把按钮从 Tab 顺序里摘掉、也不进可访问性树，
             * 键盘用户既碰不到它、也听不到「为什么不能按」——只能猜。
             *
             * 代价是要自己在 `onClick` 里挡住点击（原生属性不挡了）。
             */
            <>
              <button
                type="button"
                className="composer__send"
                aria-label="发送"
                aria-disabled={empty}
                aria-describedby={empty ? 'composer-send-hint' : undefined}
                onClick={empty ? undefined : submit}
              >
                <Icon icon={IconSend} size={16} />
              </button>
              {empty ? (
                <span className="sr-only" id="composer-send-hint">
                  请先输入内容再发送
                </span>
              ) : null}
            </>
          )}
        </div>

        {/*
          回声。发送成功后从发送键位置向外扩一圈，520ms 淡出。
          它挂在卡片内、绝对定位到发送键上；`key` 变化会让节点重建，
          于是每一句话都有自己的一圈，而不是共用一条播放到一半的动画。
        */}
        {echo === 0 ? null : <span className="composer__echo" key={echo} aria-hidden="true" />}
      </div>

      {/*
        超长确认（§12.14）。

        ## 为什么用 `Dialog` 而不是 `globalThis.confirm`

        原生 `confirm` 在 macOS 上会弹出系统级模态框，**样式完全不受控制**：
        字号、圆角、按钮顺序都是系统的，与这个纸白界面放在一起像两个应用。
        更实际的问题在 Tauri 里——WebView 的 `confirm` 在部分平台会被壳拦掉
        或根本不显示，于是「超长时提示」这条静默失效，谁也不会发现。

        ## 文案按 §7.6 的三段式

        「发了什么 · 为什么值得一问 · 下一步」。不说「确定吗」，因为
        「确定/取消」是抽象词，用户读完仍不知道自己按下去会发生什么。
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
