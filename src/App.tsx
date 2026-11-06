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
 * ## 本批范围（第 5 批前半）
 *
 * 完整 Composer（§5.6）、overlay 滚动条（§12.1）、Toast（§5.10）、
 * 消息悬停操作（§5.7 §12.7）、拖拽提示（§12.14）、窗口失焦暂停呼吸（§12.9）。
 * 托盘与 Windows 安装器属同一批的后半，下一轮做。
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
import { ToastProvider, useToast } from './components/Toast.tsx'
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
  }, [state.busy, state.stop, drawer, inspector, settings])

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
    return (
      <div className="shell">
        <TitleBar title="" />
        <div className="fatal">
          <p className="fatal__title">没能连接上后台服务</p>
          <p className="fatal__detail">{state.error ?? '未知原因'}</p>
          <button type="button" className="button button--ghost" onClick={state.retry}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (state.phase === 'connecting') {
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
            />
          </main>

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
    </div>
  )
}
