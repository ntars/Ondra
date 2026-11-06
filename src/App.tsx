/**
 * 应用根组件。
 *
 * ## 两种形态
 *
 * 首页（`inConversation === false`）：居中 logo + slogan + 输入框。
 * 会话态（`true`）：Rail + 主列（Timeline + Composer）+ Spine。
 *
 * ## 为什么抽屉与检查器都挂在 `.workspace` 里
 *
 * 它们覆盖主列但不改主列宽度（§3.4），所以定位参照必须是 workspace
 * 而不是 column。挂在 column 里会被 column 的 `overflow: hidden` 裁掉，
 * 挂在 shell 里则会让「top: 0」跑到标题栏下面去。
 *
 * ## 本批范围（第 5 批）
 *
 * 前半：完整 Composer（§5.6）、overlay 滚动条（§12.1）、Toast（§5.10）、
 * 消息悬停操作（§5.7 §12.7）、拖拽提示（§12.14）、窗口失焦暂停呼吸（§12.9）。
 *
 * 后半：关闭确认（§2.7 §12.10）、托盘联动（§12.10）、
 * 错误四级分级（§12.13）与 8 秒连接超时。
 * Windows 安装器在 Rust 产物侧，不在这个文件。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from './lib/useAppState.ts'
import { TitleBar } from './components/TitleBar.tsx'
import { Rail } from './components/Rail.tsx'
import type { DrawerKey } from './components/Rail.tsx'
import { Spine } from './components/Spine.tsx'
import { Inspector } from './components/Inspector.tsx'
import { Drawer } from './components/Drawer.tsx'
import { Timeline } from './components/Timeline.tsx'
import { Composer } from './components/Composer.tsx'
import { Mark } from './components/Mark.tsx'
import { Settings } from './components/Settings.tsx'
import { Dialog } from './components/Dialog.tsx'
import { ToastProvider, useToast } from './components/Toast.tsx'
import { invokeShell, isDesktopShell, listenShell } from './lib/shell.ts'
import { isMac } from './lib/platform.ts'

/** 渲染应用。外层只包一个 Toast 提供者。 */
export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

/** 应用本体。分出来是为了能用到 `useToast`。 */
function Shell(): React.JSX.Element {
  const state = useAppState()
  const toast = useToast()

  /** 当前抽屉。undefined 表示都收起。 */
  const [drawer, setDrawer] = useState<DrawerKey | undefined>(undefined)
  /** 检查器是否展开。 */
  const [inspector, setInspector] = useState(false)
  /**
   * 设置面板是否展开。
   *
   * ## 为什么设置也是 workspace 里的一个覆盖层而不是独立窗口
   *
   * §5.13 把设置分成两层：偏好设置是独立窗口（主题、语言、字号），
   * 检查器设置是「抽屉，宽 300 可扩至 420」。后者管 1168 项插件参数，
   * 用户改它时往往正在看会话——独立窗口会让「改一下、回来看」变成反复切窗。
   */
  const [settings, setSettings] = useState(false)
  /** 窗口是否失焦。失焦时呼吸暂停、水位降不透明度（§12.9）。 */
  const [blurred, setBlurred] = useState(false)
  /** 是否正有一个文件被拖到窗口上。 */
  const [dragging, setDragging] = useState(false)
  /** 拖动是否停在窗口内。`dragleave` 在子元素之间移动时也会触发，需要计数。 */
  const dragDepth = useRef(0)
  /**
   * 是否要弹「关闭窗口 = 隐藏到托盘」的确认框。
   *
   * 由壳在拦截到关闭请求时通过 `close-requested` 事件触发（§2.7）。
   * 首次关闭必须解释——Windows 用户按 × 时认为程序结束了，
   * 默默把它藏到托盘等于骗他。
   */
  const [closing, setClosing] = useState(false)
  /** 确认框里「以后直接退出」的勾选状态。 */
  const [rememberClose, setRememberClose] = useState(false)

  /**
   * 点击 Rail 入口。
   *
   * ## 为什么「点同一个收起、点另一个原地替换」在这里判而不是组件内
   *
   * 判断需要当前值。放在 Rail 里就要把状态在两层各存一份，两份迟早不同步。
   *
   * ## 为什么展开抽屉要收起检查器
   *
   * §3.4 的规则是「抽屉覆盖主列，不改变主列宽度」。但抽屉 300 + 检查器 300
   * 同时展开时，716 宽的主列只剩 348 到 464 之间 116px 可见——名义上仍是
   * 覆盖，实际效果等同挤压。所以两者互斥：任何时刻最多一个覆盖层。
   */
  const toggleDrawer = useCallback((key: DrawerKey): void => {
    setDrawer((previous) => (previous === key ? undefined : key))
    setInspector(false)
    setSettings(false)
  }, [])

  /** 展开检查器同理：收起抽屉与设置。 */
  const toggleInspector = useCallback((): void => {
    setInspector((previous) => !previous)
    setDrawer(undefined)
    setSettings(false)
  }, [])

  /** 打开设置：三个覆盖层互斥，任何时刻最多一个。 */
  const openSettings = useCallback((): void => {
    setSettings((previous) => !previous)
    setDrawer(undefined)
    setInspector(false)
  }, [])

  /**
   * 键盘与 Esc。
   *
   * §9.3 的层级：正在生成 → 停止；有浮层 → 关浮层；抽屉 → 关抽屉；
   * 检查器 → 关检查器；其余无操作（不退出应用）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return

      // 关闭确认框打开时不处理：那一层自己接管 Esc（它用 capture 阶段
      // 并且会 stopPropagation，这里是第二道防线）。
      if (closing) return

      // 生成中优先停生成，此时不关任何层。
      if (state.busy) {
        void state.stop()
        return
      }
      if (drawer !== undefined) {
        setDrawer(undefined)
        return
      }
      if (settings) {
        setSettings(false)
        return
      }
      if (inspector) {
        setInspector(false)
        return
      }
      // 其余无操作。刻意不退出应用（§9.3 第 8 条）。
    }

    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [state.busy, state.stop, drawer, inspector, settings, closing])

  /**
   * 壳发来的窗口级事件。
   *
   * 三条，各对应一个「界面看得见、但决定权在壳手里」的动作：
   *
   * - `close-requested`：首次点关闭。壳拦下了，问用户想隐藏还是退出。
   * - `close-degraded`：托盘不可用（Linux 无 StatusNotifier），
   *   关闭降级为最小化。得告诉用户原因，否则他以为窗口丢了。
   * - `open-drawer` / `toggle-mute`：托盘菜单里的两项。
   *
   * 这个 effect 只注册在桌面壳里。浏览器开发态没有这些事件，
   * 注册了也永远不会触发，白占一个监听。
   */
  useEffect(() => {
    if (!isDesktopShell()) return

    const offClose = listenShell<null>('close-requested', () => {
      setRememberClose(false)
      setClosing(true)
    })
    const offDegraded = listenShell<null>('close-degraded', () => {
      toast({ text: '这台机器没有托盘，关闭改为最小化', tone: 'error' })
    })
    const offDrawer = listenShell<string>('open-drawer', (key) => {
      if (key === 'today' || key === 'week' || key === 'memory' || key === 'theater') {
        setDrawer(key)
        setInspector(false)
        setSettings(false)
      }
    })
    /*
     * 静音 1 小时（§12.12）。
     *
     * 真正的静音状态机还没接（声音模块整体待做），这里只给反馈。
     * 假装已经静音而不改任何东西，比明确说「还没接」更糟——
     * 用户会以为按了没反应。
     */
    const offMute = listenShell<null>('toggle-mute', () => {
      toast('声音还没接上，暂时没有可静音的')
    })

    return () => {
      offClose()
      offDegraded()
      offDrawer()
      offMute()
    }
  }, [toast])

  /**
   * 在关闭确认框里做出选择。
   *
   * 两个动作都要交给壳执行：隐藏窗口与退出进程都不是前端能做的事。
   * 调用失败时退回「什么都不做」——窗口留在原地，用户能再点一次，
   * 比一个卡住的确认框好。
   */
  const resolveClose = useCallback((action: 'hide' | 'quit'): void => {
    setClosing(false)
    void invokeShell<null>('resolve_close', { action, remember: rememberClose }).catch((caught: unknown) => {
      console.error('关闭方式未能生效', caught)
      toast({ text: '没能关掉窗口，再试一次', tone: 'error' })
    })
  }, [rememberClose, toast])

  /** `Cmd/Ctrl + Shift + I` 开关检查器（§9.1）。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.shiftKey) return
      if (event.key !== 'I' && event.key !== 'i') return
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      event.preventDefault()
      toggleInspector()
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [toggleInspector])

  /** `Cmd/Ctrl + ,` 开关设置（§9.1）。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ',') return
      const modifier = isMac() ? event.metaKey : event.ctrlKey
      if (!modifier) return
      event.preventDefault()
      openSettings()
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [openSettings])

  /**
   * 窗口失焦与重获焦点（§12.9）。
   *
   * 失焦时暂停呼吸、水位降到 60% 不透明度。用 `window` 的 blur/focus
   * 而不是 visibilitychange：切到另一个应用时页面仍可见，visibility
   * 不会变，但呼吸确实该停——用户看不见它，一直在动是浪费电。
   */
  useEffect(() => {
    const onBlur = (): void => { setBlurred(true) }
    const onFocus = (): void => { setBlurred(false) }
    globalThis.addEventListener('blur', onBlur)
    globalThis.addEventListener('focus', onFocus)
    return () => {
      globalThis.removeEventListener('blur', onBlur)
      globalThis.removeEventListener('focus', onFocus)
    }
  }, [])

  /**
   * 拖文件进窗口（§12.14）。
   *
   * ## 为什么需要计数
   *
   * `dragenter` 与 `dragleave` 在子元素之间移动时会成对触发。只用一个
   * 布尔标记，鼠标从标题栏移到主列时就判定「离开了」，虚线框闪一下。
   * 计数抵消掉内部的进出，只有真正离开窗口时才归零。
   *
   * ## 为什么必须 preventDefault
   *
   * 不拦的话 WebView 会直接把文件当导航目标打开，整个应用被一个
   * 本地文件替代，且回不来。
   */
  useEffect(() => {
    const onDragEnter = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      // 这一条是「允许放置」的必要条件，缺了 drop 永远不触发。
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (): void => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      /*
       * 落地的文件暂时只给提示，不真的上传：宿主还没有附件上传接口
       * （`api.ts` 里没有 upload）。假装收下再静默丢弃，比明确说
       * 「还不能收」更伤信任。
       */
      const count = event.dataTransfer?.files.length ?? 0
      if (count > 0) {
        toast({ text: `还不能直接接收文件，用加号选吧（${String(count)} 个）`, tone: 'error' })
      }
    }

    globalThis.addEventListener('dragenter', onDragEnter)
    globalThis.addEventListener('dragover', onDragOver)
    globalThis.addEventListener('dragleave', onDragLeave)
    globalThis.addEventListener('drop', onDrop)
    return () => {
      globalThis.removeEventListener('dragenter', onDragEnter)
      globalThis.removeEventListener('dragover', onDragOver)
      globalThis.removeEventListener('dragleave', onDragLeave)
      globalThis.removeEventListener('drop', onDrop)
    }
  }, [toast])

  /**
   * 引用一段文字：插进草稿。
   *
   * 格式按 §12.7：`> 摘录` + 空行 + 光标。多行摘录每行都加 `>`，
   * 否则第二行会掉出引用块。
   */
  const quote = useCallback((text: string): void => {
    const excerpt = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    state.setDraft(`${excerpt}\n\n${state.draft}`)
  }, [state])

  if (state.phase === 'failed') {
    /*
     * 第四级：故障页（§12.13）。
     *
     * 替换主列内容、保留双脊——但此刻还没有会话，双脊无从谈起，
     * 所以只留标题栏。判据是「连不上宿主」，此时用户什么都做不了，
     * 唯一有用的信息是「什么没连上」与三个出口：重试、看日志、退出。
     *
     * 不给「转圈 + 重试」：转圈在故障态是骗人的，它暗示还在努力。
     */
    return (
      <div className="shell">
        <TitleBar title="" />
        <div className="fatal">
          <p className="fatal__title">没能连接上后台服务</p>
          <p className="fatal__detail">{state.error ?? '未知原因'}</p>
          <div className="fatal__actions">
            <button type="button" className="button button--primary" onClick={state.retry}>
              重试
            </button>
            {/*
              「查看日志」：壳会把日志目录在文件管理器里打开。
              不在壳内（浏览器开发态）时这个命令会抛，静默降级为提示——
              开发者在浏览器里也看不到应用日志，给他一个假按钮更糟。
            */}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                void invokeShell<string>('open_log_dir').catch(() => {
                  toast('不在桌面壳里，看不到应用日志')
                })
              }}
            >
              查看日志
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (state.phase === 'connecting') {
    /*
     * 第一级：骨架（§12.13）。
     *
     * 三块纯色矩形，**不写任何「正在连接」文字**。本地宿主启动通常不到
     * 一秒，一行会闪一下就没的提示比没有更让人焦虑——用户会读到一半
     * 被抽走。8 秒超时前一律只有骨架（阈值见 `CONNECT_TIMEOUT_MS`）。
     */
    return (
      <div className="shell">
        <TitleBar title="" />
        <div className="skeleton">
          <div />
          <div />
          <div />
        </div>
      </div>
    )
  }

  const title = state.inConversation ? (state.title === '' ? '新对话' : state.title) : ''

  /**
   * 第二级：内联错误（§12.13）。
   *
   * 发送失败、模型报错归这一级——用户还在这个对话里，他要的是
   * 「这一条怎么了」加一个重试，不是整屏的道歉。
   *
   * `chatError` 与 `phase.error` 是两件事：后者是通道断了（第四级），
   * 前者是这一轮没说成（第二级）。混用会让「模型超时」看起来像
   * 「应用崩了」。
   */
  const inlineError = state.chatError === undefined
    ? undefined
    : {
      text: state.chatError,
      onRetry: (): void => { void state.send() },
      onDismiss: state.dismissChatError,
    }

  return (
    <div className="shell" data-window-blurred={blurred ? '' : undefined}>
      <TitleBar title={title} />

      {state.inConversation ? (
        <div className="workspace">
          <Rail
            active={drawer}
            onToggle={toggleDrawer}
            onOpenSettings={() => {
              /*
               * Rail 的齿轮开偏好设置（主题、语言、字号），那是独立窗口。
               * 这里不弹任何东西——比弹一个空壳诚实。
               * 1168 项插件参数不在这里，它们从检查器底部的「全部设置」进。
               */
              setDrawer(undefined)
              toast('偏好设置窗口还没做好')
            }}
          />

          <main className="column">
            <Timeline
              messages={state.messages}
              busy={state.busy}
              empty={state.messages.length === 0 && !state.busy}
              onQuote={quote}
              /*
                条件展开而不是 `error={inlineError}`：项目开了
                `exactOptionalPropertyTypes`，可选属性不接受显式 undefined。
              */
              {...(inlineError === undefined ? {} : { error: inlineError })}
            />
            <Composer
              value={state.draft}
              onChange={state.setDraft}
              onSend={() => { void state.send() }}
              onStop={() => { void state.stop() }}
              busy={state.busy}
              attachments={state.attachments}
              onAddFiles={state.addFiles}
              onRemoveAttachment={state.removeAttachment}
              models={state.models}
              modelId={state.modelId}
              onSelectModel={state.setModel}
            />          </main>

          <Spine
            mood={state.mood.mood}
            energy={state.mood.energy}
            memoryCount={state.memories.length}
            hasData={state.mood.label !== undefined && state.mood.label !== ''}
            busy={state.busy}
            inspectorOpen={inspector}
            resting={false}
            onToggle={toggleInspector}
          />

          <Drawer
            view={drawer}
            sessions={state.sessions}
            currentSessionId={state.sessionId}
            memories={state.memories}
            onOpenSession={(id) => {
              void state.openSession(id)
              setDrawer(undefined)
            }}
            onClose={() => { setDrawer(undefined) }}
          />

          {inspector ? (
            <Inspector
              mood={state.mood}
              bond={state.bond}
              memories={state.memories}
              activity={state.busy ? '正在想' : ''}
              tension={undefined}
              hasData={state.mood.label !== undefined && state.mood.label !== ''}
              onClose={() => { setInspector(false) }}
              onOpenSettings={() => {
                setInspector(false)
                setSettings(true)
              }}
            />
          ) : null}

          {/* 设置与检查器、抽屉三者互斥，任何时刻最多一个覆盖层。 */}
          {settings ? <Settings onClose={() => { setSettings(false) }} /> : null}
        </div>
      ) : (
        <div className="welcome">
          <span className="welcome__mark">
            <Mark size={64} variant="tile" label="空谷 Ondra" />
          </span>
          <div className="welcome__title">空谷 Ondra</div>
          <div className="welcome__slogan">于无声处，听见共鸣。</div>
          {/*
            首页的输入框直接进入会话：点一下或打一个字就走 `enterSession`。
            这不违反「首页不显示会话列表」——它只是入口，不是列表。
          */}
          <div className="welcome__composer">
            <button
              type="button"
              className="button button--ghost welcome__start"
              onClick={state.enterSession}
            >
              说点什么
            </button>
          </div>
        </div>
      )}

      {/*
        拖拽提示（§12.14）：全窗 2px teal 虚线框 + 居中提示。
        用 `pointer-events: none` 让它不吃事件，否则拖拽过程中
        它自己会成为 dragenter 的目标，形成「进入就离开」的循环。
      */}
      {dragging ? (
        <div className="dropzone" aria-hidden="true">
          <div className="dropzone__frame" />
          <span className="dropzone__hint">松手添加附件</span>
        </div>
      ) : null}

      {/*
        首次关闭的解释框（§2.7）。
        §12.10 要求「关闭 = 隐藏到托盘」，而 Windows 用户默认认为关闭
        即退出——两个预期冲突，只能当场解释一次，并让他记住选择。
      */}
      {closing ? (
        <Dialog
          title="关掉窗口，她还在"
          confirmLabel="隐藏到托盘"
          cancelLabel="退出应用"
          onConfirm={() => { resolveClose('hide') }}
          onCancel={() => { resolveClose('quit') }}
          /* Esc 与点遮罩 = 「先别关」，不是「退出应用」。 */
          onDismiss={() => { setClosing(false) }}
          extra={
            <label className="dialog__check">
              <input
                type="checkbox"
                checked={rememberClose}
                onChange={(event) => { setRememberClose(event.target.checked) }}
              />
              记住我的选择，以后不再问
            </label>
          }
        >
          空谷会继续在托盘里待着，点一下图标就能回来。想在托盘菜单里彻底退出，选「退出」。
        </Dialog>
      ) : null}
    </div>
  )
}
