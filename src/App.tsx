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
import type { TimelineHandle } from './components/Timeline.tsx'
import { toPlainText } from './components/RichText.tsx'
import { Composer } from './components/Composer.tsx'
import { ShortcutSheet } from './components/ShortcutSheet.tsx'
import { Mark } from './components/Mark.tsx'
import { Settings } from './components/Settings.tsx'
import { requestPreferences } from './components/Preferences.tsx'
import { usePreferences } from './lib/preferences.ts'
import { formatClock, isMuted, muteFor, unmute, useMuted } from './lib/mute.ts'
import { absenceHint } from './lib/absence.ts'
import { Dialog } from './components/Dialog.tsx'
import { ToastProvider, useToast } from './components/Toast.tsx'
import { invokeShell, isDesktopShell, listenShell } from './lib/shell.ts'
import { isTypingTarget, keyContext, matches } from './lib/shortcuts.ts'
import type { ThemeMode } from './lib/api.ts'

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
  /**
   * 离开归来时那一行灰字（§12.9）。
   *
   * 与 `blurred` 分开存：后者是「现在看不看得见」，前者是「刚才离开了多久」。
   * 两者生命周期不同——`blurred` 在每次切窗口时都变，这行只在超过 10 分钟
   * 时才出现一次，且出现后要一直留在时间轴上直到用户发出下一句话。
   * 合成一个状态会让「切个窗口回来」也把这行重新算一遍。
   */
  const [absence, setAbsence] = useState<string | undefined>(undefined)
  /**
   * 失焦的时刻。`0` 表示当前没有在「离开中」。
   *
   * 用 ref 而不是 state：它只在 blur→focus 这一对回调之间传递，
   * 中间不参与渲染，放 state 会为它多跑一次无意义的渲染。
   */
  const leftAt = useRef(0)
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
  /** 快捷键总表是否展开（§9.4）。 */
  const [sheetOpen, setSheetOpen] = useState(false)
  /** 时间轴的「跳到最新」能力。由 Timeline 挂载后交回。 */
  const timelineRef = useRef<TimelineHandle | undefined>(undefined)
  /** 输入框。`Cmd/Ctrl + N` 回到首页后要把焦点送进去。 */
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

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

  /*
   * 检查器设置的打开动作没有单独的函数。
   *
   * 它只有一个入口（检查器底部「全部设置」），那条路径在 `Inspector`
   * 的 `onOpenSettings` 里一并处理，把「先关检查器再开面板」写成两步。
   * 曾经这里有一个 `openSettings` 供 `Cmd+,` 复用，现在那条键改指
   * 偏好窗口，这个函数就没有调用者了——留着会让下一个人以为
   * 哪里还能进到三层面板。
   */

  /**
   * 打开偏好设置窗口（§5.13）。
   *
   * ## 为什么它不再复用 `openSettings`
   *
   * 上一版把 `Cmd/Ctrl + ,` 接到 `openSettings`，而那是检查器设置的
   * 三层面板（123 段 / 1168 项插件参数）。用户按 `Cmd+,` 期待换深浅色，
   * 得到的是一千多项插件参数——**两个入口指向了同一件事，其中一件还
   * 没做**。现在按 §5.13 分开：
   *
   * | 入口 | 打开什么 |
   * | --- | --- |
   * | `Cmd/Ctrl + ,`、Rail 齿轮 | 偏好设置独立窗口 |
   * | 检查器底部「全部设置」 | 三层面板（1168 项） |
   */
  const openPreferences = useCallback((): void => {
    requestPreferences()
  }, [])

  /** 偏好层。发送方式与主题都要读它。 */
  const preferences = usePreferences()

  /**
   * 一键静音状态（§12.12、§5.7 静音态）。
   *
   * 用钩子订阅而不是读一次：到期解除发生在「用户没操作」的时刻，
   * 只有订阅能把那一帧推到界面上。
   */
  const muted = useMuted()

  /**
   * 把「右侧有没有浮层」反映到根节点（供 Toast 避让，§5.10）。
   *
   * ## 为什么必须写在根节点上
   *
   * Toast 挂在 `ToastProvider` 里，而 Provider 包着整个 `<Shell/>`——
   * 提示条容器是 `.shell` 的**兄弟节点**，`.shell` 上的属性级联不到它。
   * 根节点是两者唯一的公共祖先，`toast.css` 用
   * `[data-right-overlay] .toast` 就能读到。
   *
   * 沿的是本项目已有的做法：`platform`、`input`、`theme` 都写在
   * `documentElement.dataset` 上（见 `lib/platform.ts`）。
   *
   * ## 三个浮层互斥，只判"有没有"
   *
   * 抽屉 300、检查器 300、设置 360，同时最多出现一个。所以只需一个
   * 布尔量，不需要记录"是哪一个"——后者会让 CSS 出现三条几乎相同的
   * 规则，改一处容易漏两处。
   */
  const rightOverlay = drawer !== undefined || inspector || settings
  useEffect(() => {
    const root = document.documentElement
    if (rightOverlay) root.setAttribute('data-right-overlay', '')
    else root.removeAttribute('data-right-overlay')
  }, [rightOverlay])

  /**
   * 全部快捷键的单一入口。
   *
   * ## 为什么收成一个 effect
   *
   * 原先 `Cmd+,`、`Cmd+Shift+I`、Esc 各挂一个 `keydown` 监听，Rail 里
   * 还挂了第四个。四个监听器都在 `window` 上，谁先跑取决于注册顺序——
   * 于是「按 Esc 时抽屉先关还是设置先关」取决于组件挂载先后，而不是
   * §9.3 的层级。合成一处后，顺序由代码里的 `if` 排列决定。
   *
   * ## 三层判定顺序
   *
   * 1. **输入法组合中一律不拦**（§12.3）：组合期间 `key` 是 `Process`，
   *    但 `Esc` 会以 `'Escape'` 出现——用户按 Esc 是想取消候选词，
   *    此时关抽屉会让他刚打的字白打了。
   * 2. **Esc 走 §9.3 的八层**，最后一层无操作。
   * 3. **其余键先判「在不在输入」**：`Cmd+B` 这类在输入框里通常有原生
   *    含义（加粗），但本项目的发送/换行由 Composer 自己处理，
   *    全局只剩「不与输入冲突」的那些。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 输入法正在选词。`keydown` 的 `isComposing` 在 Safari 上是 false，
      // 但 `keyCode === 229` 覆盖了那一路。
      if (event.isComposing || event.keyCode === 229) return

      const context = keyContext(event)

      if (context.key === 'escape') {
        // 关闭确认框自己接管 Esc（capture 阶段 + stopPropagation），
        // 这里是第二道防线，防止事件从别的路径漏进来。
        if (closing) return
        // 快捷键总表自己接管（同样是 capture 阶段）。
        if (sheetOpen) return
        // §9.3 第 1 条：生成中优先停生成，此时不关任何层。
        if (state.busy) {
          void state.stop()
          return
        }
        // 第 3–6 条：抽屉 → 检查器 → 设置。设置放最后，
        // 因为它是用户主动打开的、意图最明确的一层。
        if (drawer !== undefined) {
          setDrawer(undefined)
          return
        }
        if (inspector) {
          setInspector(false)
          return
        }
        if (settings) {
          setSettings(false)
          return
        }
        // 第 8 条：无操作。刻意不退出应用。
        return
      }

      /*
       * `↑` 编辑上一条（§9.1）。它**没有平台修饰键**，所以必须排在下面
       * 那道 `if (!context.mod) return` 之前——放在后面永远走不到。
       *
       * 触发条件两重：焦点在输入框里、且输入框为空。有字时 `↑` 是
       * 正常的光标上移，抢过来会让多行编辑没法用方向键。
       */
      if (matches(context, 'editLast')) {
        if (isTypingTarget(event.target) && event.target instanceof HTMLTextAreaElement && event.target.value === '') {
          const lastUser = [...state.messages].reverse().find((message) => message.role === 'user')
          if (lastUser !== undefined) {
            event.preventDefault()
            state.setDraft(lastUser.content)
          }
        }
        return
      }

      // 下面每一条都要求平台修饰键，先挡掉不带的。
      if (!context.mod) return

      if (matches(context, 'shortcutSheet')) {
        event.preventDefault()
        setSheetOpen(true)
        return
      }
      if (matches(context, 'inspector')) {
        event.preventDefault()
        toggleInspector()
        return
      }
      if (matches(context, 'preferences')) {
        event.preventDefault()
        openPreferences()
        return
      }
      if (matches(context, 'searchMemory')) {
        event.preventDefault()
        /*
         * 打开记忆抽屉并把焦点送进搜索框（§9.1）。
         *
         * 抽屉按 `view` 决定内容。若记忆抽屉已经开着，再 `setDrawer('memory')`
         * 不会重挂组件、焦点也就不会重新进来，所以先清空再设——这与
         * 「点另一个图标原地替换」不冲突：那条规则管的是不同抽屉之间，
         * 这里是同一个抽屉的「我要搜」，重新聚焦比省一次渲染重要。
         */
        setInspector(false)
        setSettings(false)
        setDrawer(undefined)
        // 下一帧再设：让 `data-open` 先落到 false，组件重挂后才会执行聚焦。
        globalThis.requestAnimationFrame(() => { setDrawer('memory') })
        return
      }
      if (matches(context, 'newSession')) {
        event.preventDefault()
        // 新会话是一段全新的对话，上一段那句「你离开了 23 分钟」指的不是这里。
        setAbsence(undefined)
        void state.newSession().catch((caught: unknown) => {
          console.error('新建对话失败', caught)
          toast({ text: '没能新建对话', tone: 'error' })
        })
        return
      }
      if (matches(context, 'jumpLatest')) {
        event.preventDefault()
        timelineRef.current?.jumpToLatest(true)
        return
      }
      if (matches(context, 'cycleTheme')) {
        event.preventDefault()
        // 三态循环：跟随系统 → 浅 → 深 → 跟随系统。
        const next: ThemeMode = state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system'
        state.setTheme(next)
        toast(next === 'system' ? '跟系统走' : next === 'light' ? '浅色' : '深色')
        return
      }
      if (matches(context, 'copyLast')) {
        event.preventDefault()
        const last = [...state.messages].reverse().find((message) => message.role === 'assistant')
        if (last === undefined) {
          toast('还没有回复可复制')
          return
        }
        void navigator.clipboard.writeText(last.content).then(
          () => { toast('已复制最后一条回复') },
          () => { toast({ text: '复制失败', tone: 'error' }) },
        )
        return
      }
    }

    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [
    closing, sheetOpen, state, drawer, inspector, settings,
    toggleInspector, openPreferences, toast,
  ])

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
     * ## 为什么要看当前状态再决定动作
     *
     * 托盘菜单项的文字在静音后会变成「取消静音」（壳侧 `set_tray_muted`
     * 改的）。用户看到哪个字就期待哪个动作，所以这里必须按同一份状态分岔：
     * 没静音 → 静音一小时；已静音 → 取消。不看状态一律 "mute" 的话，
     * 用户点了写着「取消静音」的那一项，静音却被延长了一小时。
     */
    const offMute = listenShell<null>('toggle-mute', () => {
      if (isMuted()) {
        unmute()
        toast('已取消静音')
        return
      }
      const until = muteFor()
      toast(`静音到 ${formatClock(until)}`)
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

  /**
   * 窗口失焦与重获焦点（§12.9）。
   *
   * 失焦时暂停呼吸、水位降到 60% 不透明度。用 `window` 的 blur/focus
   * 而不是 visibilitychange：切到另一个应用时页面仍可见，visibility
   * 不会变，但呼吸确实该停——用户看不见它，一直在动是浪费电。
   *
   * ## 顺便量一次「离开了多久」
   *
   * 同一对事件顺手记时刻，回来时算差值。放在这里而不是单开一个监听：
   * blur/focus 已经在处理「用户离没离开」这个事实，再挂一对监听会让
   * 「谁先跑」变成注册顺序问题——而这两个回调都必须先知道时刻才能判。
   *
   * ## 为什么算出来要清掉 `leftAt`
   *
   * 不清的话，下一次「窗口失焦但不到 10 分钟」时，`leftAt` 还留着上一次
   * 的旧值，会算出一次根本没有发生的长时间离开。每次 focus 都是
   * 一次结算，结算完这个数就作废。
   */
  useEffect(() => {
    const onBlur = (): void => {
      setBlurred(true)
      leftAt.current = Date.now()
    }
    const onFocus = (): void => {
      setBlurred(false)
      const hint = absenceHint(leftAt.current, Date.now())
      leftAt.current = 0
      // 只有超过 10 分钟才有话。不到阈值的切窗口不该在时间轴上留痕——
      // 那会让用户在一天里看到十几行「你离开了 2 分钟」。
      if (hint !== undefined) setAbsence(hint)
    }
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
   *
   * ## 为什么先过 `toPlainText`
   *
   * 摘录的意义是「把这段话摆到输入框里，我接着往下说」。原文里的
   * `**`、`| --- |`、围栏反引号是**渲染用的记号**，不是用户想引用的话。
   * 带着记号插进去，用户还得先删一遍才能写自己的句子。
   */
  const quote = useCallback((text: string): void => {
    const excerpt = toPlainText(text)
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
            onOpenSettings={openPreferences}
          />

          <main className="column">
            <Timeline
              messages={state.messages}
              busy={state.busy}
              empty={state.messages.length === 0 && !state.busy}
              onQuote={quote}
              onHandle={(handle) => { timelineRef.current = handle }}
              /*
                条件展开而不是 `error={inlineError}`：项目开了
                `exactOptionalPropertyTypes`，可选属性不接受显式 undefined。
              */
              {...(inlineError === undefined ? {} : { error: inlineError })}
              {...(absence === undefined ? {} : { absence })}
            />
            <Composer
              value={state.draft}
              onChange={state.setDraft}
              onSend={() => {
                // 用户开口了，这行离开提示就完成使命了：它说的是「刚才这里没人」，
                // 而此刻人已经在这里说话了。留着会变成一句永远挂在末尾的废话。
                setAbsence(undefined)
                void state.send()
              }}
              onStop={() => { void state.stop() }}
              busy={state.busy}
              attachments={state.attachments}
              onAddFiles={state.addFiles}
              onRemoveAttachment={state.removeAttachment}
              models={state.models}
              modelId={state.modelId}
              onSelectModel={state.setModel}
              interrupt={preferences.sendMode}
              onInputRef={(node) => { composerRef.current = node }}
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
            muted={muted}
            onToggle={toggleInspector}
          />

          <Drawer
            view={drawer}
            sessions={state.sessions}
            currentSessionId={state.sessionId}
            memories={state.memories}
            onOpenSession={(id) => {
              /*
                换会话就丢掉这行。它量的是「你在**这个**会话的末尾离开了多久」，
                换到另一段对话后这句话指向的空白根本不存在——留着会让用户
                以为自己在那个会话里也离开了 23 分钟。
              */
              setAbsence(undefined)
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
              onClick={() => {
                setAbsence(undefined)
                state.enterSession()
              }}
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
        快捷键总表（§9.4）。Sheet 不是 Dialog——查阅不该阻断用户。
        渲染在 Dialog 之前、拖拽提示之后：它与关闭确认框永远不会同时出现
        （要看总表时不会正在关窗口），两者层级相同不影响。
      */}
      {sheetOpen ? <ShortcutSheet onClose={() => { setSheetOpen(false) }} /> : null}

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
