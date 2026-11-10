/**
 * 应用根组件。
 *
 * ## 只有一种形态
 *
 * 三栏常驻：左栏（Rail）+ 主列（Timeline + Composer）+ 右栏（Spine）。
 * 早先还有一个独立的首页（居中字标 + 大输入框），打开应用先落在那儿，
 * 说第一句话才切进三栏。那个页面在一次走查里被判定为纯多余——用户打开
 * 应用就是要说话，而它只多出一次点击和一块要重新认的布局。删掉之后，
 * 空会话本身就是开场：时间线的空态承担了原来首页的那句话。
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
import { TopBar } from './components/TopBar.tsx'
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
import { Settings } from './components/Settings.tsx'
import { requestPreferences } from './components/Preferences.tsx'
import { usePreferences } from './lib/preferences.ts'
import { formatClock, isMuted, muteFor, unmute, useMuted } from './lib/mute.ts'
import { absenceHint } from './lib/absence.ts'
import { Dialog } from './components/Dialog.tsx'
import { ToastProvider, useToast } from './components/Toast.tsx'
import { invokeShell, isDesktopShell, listenShell } from './lib/shell.ts'
import { getPlatform } from './lib/platform.ts'
import { isTypingTarget, keyContext, matches } from './lib/shortcuts.ts'
import { useProactiveTick } from './lib/useProactiveTick.ts'
import { useQuietToday } from './lib/proactive.ts'
import { registerDebugActions, startDebugAgent } from './lib/debugAgent.ts'
import { keepAwake } from './lib/wakelock.ts'
import type { ThemeMode } from './lib/api.ts'

/** 渲染应用。外层只包一个 Toast 提供者。 */
export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

/**
 * 顶部两条横条：窗口标题栏 + 手机顶栏。
 *
 * ## 为什么两个都渲染
 *
 * 由 CSS 的容器查询决定谁可见（见 `styles/compact.css`）。用 JS 读宽度
 * 会多一次测量、多一帧延迟：窗口从 700 拖到 560 时会先渲染错的顶栏
 * 再换，肉眼看到一次横条高度跳动。CSS 在同一个帧里完成切换。
 *
 * 代价是两边都挂载。未显示的那一条只是一个空 `<header>`，不跑逻辑、
 * 也不进 Tab 顺序（`display: none` 的元素不可聚焦）。
 *
 * ## 无障碍
 *
 * 隐藏的那一条对读屏同样不可见，不会出现「标题被念两遍」。
 */
function Chrome(props: {
  title: string
  mood: number
  energy: number
  hasData: boolean
  resting: boolean
  onOpenDrawer(): void
  onOpenInspector(): void
}): React.JSX.Element {
  return (
    <>
      <TitleBar title={props.title} />
      <TopBar
        title={props.title}
        mood={props.mood}
        energy={props.energy}
        hasData={props.hasData}
        resting={props.resting}
        onOpenDrawer={props.onOpenDrawer}
        onOpenInspector={props.onOpenInspector}
      />
    </>
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
   * 检查器设置是「抽屉，宽 300 可扩至 420」。后者管 1116 项插件参数，
   * 用户改它时往往正在看会话——独立窗口会让「改一下、回来看」变成反复切窗。
   */
  const [settings, setSettings] = useState(false)
  /**
   * 打开三层面板时要定位到的配置段。
   *
   * 只有扩展抽屉的「配置」会设它——那里用户点的就是某个包，打开面板还要
   * 自己在 60 多个段里再找一遍，等于让上一步白点。其它入口（检查器底部的
   * 「全部设置」）必须把它清空，否则会莫名停在上一段的搜索词上。
   */
  const [settingsAt, setSettingsAt] = useState<string | undefined>(undefined)
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
   * 三层面板（121 段 / 1116 项插件参数）。用户按 `Cmd+,` 期待换深浅色，
   * 得到的是一千多项插件参数——**两个入口指向了同一件事，其中一件还
   * 没做**。现在按 §5.13 分开：
   *
   * | 入口 | 打开什么 |
   * | --- | --- |
   * | `Cmd/Ctrl + ,`、Rail 齿轮 | 偏好设置独立窗口 |
   * | 检查器底部「全部设置」 | 三层面板（1116 项） |
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
   * 把「浮层在哪一侧」反映到根节点（供 Toast 避让，§5.10）。
   *
   * ## 为什么必须写在根节点上
   *
   * Toast 挂在 `ToastProvider` 里，而 Provider 包着整个 `<Shell/>`——
   * 提示条容器是 `.shell` 的**兄弟节点**，`.shell` 上的属性级联不到它。
   * 根节点是两者唯一的公共祖先，`dialog.css` 用
   * `[data-right-overlay] .toast` / `[data-left-overlay] .toast` 就能读到。
   *
   * 沿的是本项目已有的做法：`platform`、`input`、`theme` 都写在
   * `documentElement.dataset` 上（见 `lib/platform.ts`）。
   *
   * ## 为什么要分左右两个量，而不是一个「有没有浮层」
   *
   * 提示条默认落在视口正中。避让的含义是「落到剩下那块空地的正中」，
   * 而空地会因浮层在哪一侧而落在正中的不同方向：右浮层 → 往左挪，
   * 左抽屉 → 往右挪。上一版把左抽屉也算进 `rightOverlay`，于是抽屉
   * 打开时提示条反而被往左推到抽屉标题上——方向错了，越避越压。
   *
   * 三个浮层互斥（开设置会先收抽屉、检查器），所以两个量不会同时为真；
   * 保留两个量是为了让 CSS 只写两种方向各一条规则，而不是三条几乎相同
   * 的规则——后者改一处容易漏两处。
   */
  const rightOverlay = inspector || settings
  const leftOverlay = drawer !== undefined
  useEffect(() => {
    const root = document.documentElement
    if (rightOverlay) root.setAttribute('data-right-overlay', '')
    else root.removeAttribute('data-right-overlay')
    if (leftOverlay) root.setAttribute('data-left-overlay', '')
    else root.removeAttribute('data-left-overlay')
  }, [rightOverlay, leftOverlay])

  /*
   * ---------- 调试动作（默认关闭） --------------------------------------------
   *
   * 宿主开了调试（`ONDRA_DEBUG=1` 或数据目录有 `debug.enable`）时，
   * `lib/debugAgent.ts` 会连上来取指令；关闭时这条通道根本不存在，
   * 下面这些闭包只是躺在注册表里，一行都不执行。
   *
   * ## 为什么用 ref 存状态
   *
   * effect 只在挂载时跑一次。若把 `state` 放进依赖数组，每次渲染都会
   * 「撤销注册 → 重新注册」，而撤销与注册之间有一个极短的窗口——
   * 一条指令恰好落在那时就会得到「未知动作」。用 ref 让闭包读最新值，
   * 注册表自始至终不变。
   *
   * ## 为什么发送走真实按钮而不是 `state.send()`
   *
   * 调试的价值在于「验证用户会走的那条路」。直接调 send 会绕过输入卡里的
   * 空白校验、附件处理与禁用态判断，测出来的成功不代表用户点得动。
   */
  const liveRef = useRef({ state, drawer, inspector, settings, sheetOpen })
  liveRef.current = { state, drawer, inspector, settings, sheetOpen }

  useEffect(() => {
    /** 抽屉的合法键。运行时无法靠类型挡住，这里显式列一份。 */
    const drawerKeys: readonly DrawerKey[] = ['session', 'log', 'extension']

    const dispose = registerDebugActions({
      'state.get': () => {
        const live = liveRef.current
        return {
          phase: live.state.phase,
          sessionId: live.state.sessionId,
          title: live.state.title,
          messageCount: live.state.messages.length,
          /*
           * 单会话制之后没有「会话数」这个读数了。这里给的是**归档段数**
           * ——它回答「清空过几次」，是同一栏里唯一还有意义的计数。
           */
          archivedSegments: live.state.stats?.archivedSegments ?? 0,
          busy: live.state.busy,
          draft: live.state.draft,
          modelId: live.state.modelId,
          models: live.state.models.map((model) => model.id),
          permission: live.state.permission,
          theme: live.state.theme,
          chatError: live.state.chatError,
          panels: {
            drawer: live.drawer ?? null,
            inspector: live.inspector,
            settings: live.settings,
            shortcuts: live.sheetOpen,
          },
        }
      },

      'panel.open': (args) => {
        const panel = typeof args['panel'] === 'string' ? args['panel'] : ''
        if (panel === 'inspector') {
          setDrawer(undefined)
          setSettings(false)
          setInspector(true)
        } else if (panel === 'settings') {
          setDrawer(undefined)
          setInspector(false)
          setSettings(true)
        } else if (panel === 'shortcuts') {
          setSheetOpen(true)
        } else if (panel === 'preferences') {
          requestPreferences()
        } else if ((drawerKeys as readonly string[]).includes(panel)) {
          setInspector(false)
          setSettings(false)
          setDrawer(panel as DrawerKey)
        } else {
          throw new Error(`未知面板：${panel}（可用：inspector / settings / shortcuts / preferences / ${drawerKeys.join(' / ')}）`)
        }
        return { opened: panel }
      },

      'panel.close': (args) => {
        const panel = typeof args['panel'] === 'string' ? args['panel'] : ''
        if (panel === 'inspector') setInspector(false)
        else if (panel === 'settings') setSettings(false)
        else if (panel === 'shortcuts') setSheetOpen(false)
        else if ((drawerKeys as readonly string[]).includes(panel)) setDrawer(undefined)
        else if (panel === 'all') {
          setDrawer(undefined)
          setInspector(false)
          setSettings(false)
          setSheetOpen(false)
        } else throw new Error(`未知面板：${panel}`)
        return { closed: panel }
      },

      'theme.set': (args) => {
        const mode = args['mode']
        if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
          throw new Error('mode 只能是 light / dark / system')
        }
        liveRef.current.state.setTheme(mode)
        return { theme: mode }
      },

      'composer.set': (args) => {
        const text = typeof args['text'] === 'string' ? args['text'] : ''
        liveRef.current.state.setDraft(text)
        composerRef.current?.focus()
        return { draft: text }
      },

      'composer.send': () => {
        const button = document.querySelector<HTMLButtonElement>('.composer__send')
        if (button === null) throw new Error('找不到发送键（可能在首页或输入为空）')
        button.click()
        return { sent: true }
      },

      /*
       * 调试动作的语义要与快捷键一致，否则调试器会看到与用户不同的世界。
       *
       * 单会话制之后只剩「清空」这一个动作：`session.new` 把这一段归档成段、
       * 再开一段空的，等同 `Cmd+N` 与返回键的最后一层。
       *
       * 原来的 `session.open` 已删除：没有第二段会话可打开，留着只会让外部
       * 脚本以为「打开某个历史会话」仍然成立。
       */
      'session.new': () => {
        void liveRef.current.state.newChat()
        return { cleared: true }
      },

      'session.home': () => {
        void liveRef.current.state.newChat()
        return { cleared: true }
      },

      'model.set': (args) => {
        const id = typeof args['id'] === 'string' ? args['id'] : ''
        if (id === '') throw new Error('缺少参数 id')
        liveRef.current.state.setModel(id)
        return { model: id }
      },

      'reply.stop': () => {
        liveRef.current.state.stop()
        return { stopped: true }
      },

      'toast': (args) => {
        const text = typeof args['text'] === 'string' ? args['text'] : ''
        if (text === '') throw new Error('缺少参数 text')
        if (args['tone'] === 'error') toast({ text, tone: 'error' })
        else toast(text)
        return { text }
      },
    })

    // 探测宿主是否开了调试。没开就每 30 秒静默重探一次，不产生可见噪音。
    startDebugAgent()
    return dispose
  }, [toast])

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
         * `Cmd/Ctrl + K` 原本是「打开记忆抽屉并聚焦搜索框」。
         *
         * 记忆抽屉随左栏四抽屉改造取消，记忆本身移到了右栏检查器
         * （「记得的事」+「记忆维护」）。这一条因此改指检查器：用户按这个键
         * 要找的仍然是记忆，只是它现在住在右栏。键位不变，语义跟着内容走。
         */
        setDrawer(undefined)
        setSettings(false)
        setInspector(true)
        return
      }
      if (matches(context, 'newSession')) {
        event.preventDefault()
        /*
         * `Cmd+N` = 清空当前会话，三栏原地不动。
         *
         * 首页删掉之后，这一条不再有「切形态」的职责，只剩「清干净」。
         * 清完直接把焦点放进输入框：用户按这个键的目的就是马上说一句新话，
         * 再让他自己点一下输入框是多余的一步。
         */
        setAbsence(undefined)
        void state.newChat()
        composerRef.current?.focus()
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
      // 托盘菜单里的入口与 Rail 的三个同名。认不出的键不打开任何抽屉：
      // 壳侧若还是旧的 `today` / `week`，静默落空比打开一个空面板好。
      if (key === 'session' || key === 'log' || key === 'extension') {
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
   * Android / 鸿蒙的返回键（§10.7.1）。
   *
   * ## 为什么必须接管
   *
   * iOS 靠侧滑手势，Android 有实体/虚拟返回键。不接管时按一下直接
   * **退出应用**——而用户的本意通常只是「从抽屉退回去」。
   *
   * ## 为什么用 `popstate` 而不是别的
   *
   * WebView 里没有原生的返回键事件。`popstate` 是唯一一条：系统返回键
   * 在历史栈非空时触发它。所以启动后要先 `pushState` 一条占位记录，
   * 否则栈是空的，返回键直接穿到 Activity 层。
   *
   * ## 顺序与 §9.3 的 Esc 同构
   *
   * 抽屉 → 检查器 → 设置 → 退出会话。**每一层都先 `pushState` 补回
   * 那一条**：`popstate` 已经把历史弹掉了，不补的话下一层就退不回去。
   *
   * ## 为什么最后一层是「留在首页」而不是 `history.back()`
   *
   * 首页已经是应用的根。再退就只能退出应用——而 §10.7.1 的顺序是
   * 「最后才退出」，交回系统默认行为即可（不再补 state，让下一次
   * 返回键穿出去）。
   */
  useEffect(() => {
    /*
     * 判据是「认不出桌面平台 + 粗指针」，不是 `isDesktopShell()`。
     *
     * 移动端的 Tauri 同样会注入 `__TAURI__`，用壳判会把 Android 一起挡掉；
     * 而带触摸屏的 Windows 笔记本平台能认出来，不该装（桌面上没有返回键，
     * 多一条 history 记录只会让浏览器手势变奇怪）。
     */
    if (getPlatform() !== 'unknown') return
    if (!globalThis.matchMedia('(pointer: coarse)').matches) return

    /** 补一条占位记录，让下一次返回键仍能被接住。 */
    const arm = (): void => { globalThis.history.pushState({ ondra: true }, '') }
    arm()

    const onPop = (): void => {
      if (drawer !== undefined) {
        arm()
        setDrawer(undefined)
        return
      }
      if (inspector) {
        arm()
        setInspector(false)
        return
      }
      if (settings) {
        arm()
        setSettings(false)
        return
      }
      /*
       * 最后一层：清空当前会话。
       *
       * 这里不给浏览器补一条历史记录——`arm()` 只在上面的覆盖层分支里调，
       * 因为那是「关掉一个弹层」；清空会话不是弹层，再补一条会让浏览器
       * 返回键从此多出一次「撤销新对话」。
       */
      if (state.messages.length > 0 || state.sessionId !== undefined) {
        void state.newChat()
        return
      }
      // 最后一层：不补记录，把控制权交回系统。
    }

    globalThis.addEventListener('popstate', onPop)
    return () => { globalThis.removeEventListener('popstate', onPop) }
  }, [drawer, inspector, settings, state])

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

  /*
   * 主动开口的时机（§7.4）。
   *
   * ## 四个 arm 条件，每一条都有具体的打扰含义
   *
   * | 条件 | 不满足时的后果 |
   * | --- | --- |
   * | 在会话里 | 首页没有上下文，她开口只能是一句空话 |
   * | 不在生成中 | 她会跟自己的回复抢同一轮，两条助手消息交织 |
   * | 草稿是空的 | 用户正在打字时她先开口，是最典型的打断 |
   * | 今天还没到「安静」 | §7.4：连续拒绝 3 次 → 当天停止 |
   *
   * 「窗口在前台」那一条不在这里判，在 `useProactiveTick` 内部按
   * `document.hidden` / `hasFocus()` 现查：它是**时刻性**的，
   * 放进依赖会让每次切窗口都拆挂一次定时器，而那时 `lastAt` 并没过期。
   */
  const quiet = useQuietToday()
  const lastMessageAt = state.messages.at(-1)?.at ?? 0
  useProactiveTick({
    armed:
      !state.busy
      && state.draft.trim() === ''
      && !quiet
      && state.messages.length > 0,
    lastAt: lastMessageAt,
    onSpeak: state.speakUp,
    deferMsOf: state.lastDeferMs,
  })

  /**
   * 生成中保持屏幕常亮（§10.7.3 第三条）。
   *
   * 挂在这里而不是时间轴里：`busy` 的生命周期比消息流的挂载更长——
   * 用户切到记忆抽屉时消息流仍在（只是被覆盖），但若将来真的卸载，
   * 锁会被提前释放，而生成还在继续。
   *
   * 桌面上 `navigator.wakeLock` 通常不存在，`keepAwake` 会静默跳过，
   * 不产生任何开销，所以不需要按平台条件调用。
   */
  useEffect(() => keepAwake(state.busy), [state.busy])

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
   */  const quote = useCallback((text: string): void => {
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

  const title = state.title === '' ? '新对话' : state.title

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
      <Chrome
        title={title}
        mood={state.mood.mood}
        energy={state.mood.energy}
        hasData={state.mood.label !== undefined && state.mood.label !== ''}
        resting={false}
        onOpenDrawer={() => { toggleDrawer('session') }}
        onOpenInspector={toggleInspector}
      />

        <div className="workspace" {...(inspector ? { 'data-inspector': '' } : {})}>
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
              onDelete={(messageId) => { void state.deleteMessage(messageId) }}
              onHandle={(handle) => { timelineRef.current = handle }}
              /*
                条件展开而不是 `error={inlineError}`：项目开了
                `exactOptionalPropertyTypes`，可选属性不接受显式 undefined。
              */
              {...(inlineError === undefined ? {} : { error: inlineError })}
              {...(absence === undefined ? {} : { absence })}
              {...(state.undoable === undefined ? {} : { undoable: state.undoable })}
              onDeclineProactive={(messageId) => { void state.declineProactive(messageId) }}
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
              onAddAttachments={state.addAttachments}
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
            quietToday={quiet}
            onToggle={toggleInspector}
          />

          <Drawer
            view={drawer}
            stats={state.stats}
            sessionId={state.sessionId}
            title={state.title}
            logs={state.logs}
            busy={state.busy}
            onClearAll={() => {
              /*
                清空全部：那行「刚才这里没人」量的是**这一段**末尾的空白，
                清空之后这段不存在了，这句话也就没有指向。
              */
              setAbsence(undefined)
              void state.newChat()
            }}
            onConfigure={(sectionId) => {
              /*
                扩展抽屉里的「配置」：关掉抽屉，打开三层面板并定位到那一段。

                与 Rail 齿轮不是同一件事——齿轮开偏好设置（主题、字号、模型），
                这里开 1116 项插件参数。两个入口分开，因为用户找它们时想的是
                两件不同的事：「改这个应用」与「改她」。
              */
              setDrawer(undefined)
              setInspector(false)
              setSettingsAt(sectionId)
              setSettings(true)
            }}
            onNote={(text) => { toast(text) }}
            onClose={() => { setDrawer(undefined) }}
          />

          {inspector ? (
            <Inspector
              mood={state.mood}
              bond={state.bond}
              memories={state.memories}
              memoryFault={state.memoryFault}
              activity={state.busy ? '正在想' : ''}
              tension={undefined}
              hasData={state.mood.label !== undefined && state.mood.label !== ''}
              onClose={() => { setInspector(false) }}
              onOpenSettings={() => {
                setInspector(false)
                // 这里进的是「全部设置」总入口，不该继承扩展抽屉上次定位的段。
                setSettingsAt(undefined)
                setSettings(true)
              }}
            />
          ) : null}

        </div>

      {/*
        设置与检查器、抽屉三者互斥，任何时刻最多一个覆盖层。

        ## 为什么挂在最外层

        它原先是写在「首页 / 会话态」那个三元分支**内部**的。于是首页上按
        `panel.open settings` 或 `Cmd+,` 时，`settings` 状态确实变成了 true
        ——`ui state` 也照实报 `settings: true`——但那个分支根本没被渲染，
        界面上什么都不会出现。

        首页删掉之后这个坑本身没有了，但位置仍留在最外层：设置面板不归属
        任何一个栏位，将来再加任何形态也不该被裹进某个分支里。

        这类缺陷最难查的地方在于**没有任何报错**：指令成功、状态正确、
        日志全绿，只有去 DOM 里数节点才发现 `.settings` 一个都不在。
        覆盖层是「整个窗口的一层」，不归属任何一个主区，所以它必须挂在
        外层——顺便也保证了「首页能开设置」与「会话里能开设置」走的是
        同一份代码，不会各自漂开。
      */}
      {settings ? (
        <Settings
          /* 条件展开而不是传 undefined：项目开了 exactOptionalPropertyTypes。 */
          {...(settingsAt === undefined ? {} : { initialSection: settingsAt })}
          onClose={() => {
            setSettings(false)
            setSettingsAt(undefined)
          }}
        />
      ) : null}

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
