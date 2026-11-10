/**
 * 时间轴（Timeline）。
 *
 * ## 它与旧 `Thread.tsx` 的区别
 *
 * 旧组件是「气泡 + 头像 + 时间戳」，这一版全都没有（§5.4 明确列出「没有」）。
 * 用户消息靠右侧一条 2 × 36 的玄青竖线标记，助手消息什么都不加。
 * 这不是省事，是刻意的减法：气泡会把注意力引到容器上，而这里要引到字上。
 *
 * ## 为什么日期分隔行要算「第几天」
 *
 * 「第 12 天」是相处天数，只在首屏日期行右侧出现一次（§12.6）。
 * 它由最早一条消息与本条日期的天数差算出，不是从安装日算——
 * 从安装日算会把「装了两周但只聊过三天」写成「第 14 天」。
 *
 * ## 滚动到底的策略
 *
 * 新消息到达时，若用户已在底部 80px 内就自动滚；否则出现浮标，不抢位置
 * （§5.3）。判断依据是「用户当前离底部多远」，不是「有没有滚动过」——
 * 后者会把「用户只往上滚了 10px」也判成「他在读历史」。
 *
 * ## 消息悬停操作
 *
 * 复制 / 引用 / 删除出现在右上角，`--motion-fast` 淡入（§5.4）。
 * 它们**不进 Tab 顺序**：每条消息都有五个按钮的话，键盘用户要按几十次
 * 才能走过一屏。键盘可达走另一条路——消息本身可聚焦，聚焦后按
 * `Enter` 打开同一个小工具条。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { Mark } from './Mark.tsx'
import { IconChevronDown, IconCopy, IconQuote, IconTrash } from './icons.ts'
import { ReasonLine } from './ReasonLine.tsx'
import { RichText, toPlainText } from './RichText.tsx'
import { ScrollArea } from './ScrollArea.tsx'
import { useToast } from './Toast.tsx'
import type { ChatMessage } from '../lib/useAppState.ts'
import { UNDO_WINDOW_MS } from '../lib/proactive.ts'

/** 星期名。中文界面只用中文，不出现 `Thu` 这种。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 距底部多少像素内算「在底部」。 */
const STICK_THRESHOLD = 80

/** 一天的毫秒数。 */
const DAY = 24 * 60 * 60 * 1000

/**
 * 焦点是否落在可编辑内容里。
 *
 * 翻页键在输入框里有原生含义（某些编辑器用它移动光标），抢过来会让
 * 长文本编辑没法用。这里只判输入类元素，不判整条消息——消息本身
 * 是要能翻页的。
 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 把一个时间戳归到当天 0 点。
 *
 * 用本地时区而不是 UTC：用户说「今天」指的是他自己那天，
 * 用 UTC 会让东八区的人在 0–8 点看到「昨天」。
 */
function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 日期分隔行的文字。
 *
 * 三档（§12.6）：今天 / 昨天 / `11 月 6 日 周四`。
 * 跨年时补年份，否则「11 月 6 日」在两年前的对话里会有歧义。
 */
function dayLabel(ts: number, now: number): string {
  const day = startOfDay(ts)
  const today = startOfDay(now)
  if (day === today) return '今天'
  if (day === today - DAY) return '昨天'
  const date = new Date(ts)
  const base = `${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日 ${WEEKDAYS[date.getDay()] ?? ''}`
  return date.getFullYear() === new Date(now).getFullYear()
    ? base
    : `${String(date.getFullYear())} 年 ${base}`
}

/**
 * 一条消息的时刻，写成 `14:32`。
 *
 * 只给悬停时浮现的时间沟槽用（见 `timeline.css` 的 `.message::after`）。
 * 不显示秒：对话里没人需要知道是 14:32:07。
 */
function clockOf(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 时间轴里的一段：一条消息，或一条日期分隔。 */
type Row =
  | { kind: 'day'; key: string; at: number; label: string; dayIndex: number | undefined }
  | { kind: 'message'; key: string; message: ChatMessage; last: boolean }

/** 时间轴对外暴露的能力。 */
export interface TimelineHandle {
  /** 滚到最新一条。`Cmd/Ctrl + ↓` 与浮标按钮共用。 */
  jumpToLatest(smooth: boolean): void
}

export interface TimelineProps {
  /** 消息。按时间升序。 */
  messages: ChatMessage[]
  /** 正在生成。 */
  busy: boolean
  /** 会话标题为空且有消息时显示「从哪儿说起都行」的替代。 */
  empty: boolean
  /**
   * 引用一段文字。插入 Composer（§12.7）。
   *
   * 必填而不给默认值：引用要写进输入框，只有上层持有草稿。
   * 给个空实现会让「点了引用没反应」变成静默失败。
   */
  onQuote(text: string): void
  /**
   * 删除一条消息。
   *
   * 单会话制下这是唯一的「局部清理」手段：不能删整段会话，只能一条一条删，
   * 或者清空全部（会话抽屉）。所以它必须真的可用，而不是像上一版那样
   * 只留一个位置——那时协议里没有删除接口，界面上放一个点了会失败的按钮
   * 比不放更糟。
   *
   * 组件内部做**两段确认**（点一次变成「确认删除」，三秒后复原）。
   * 删除不可逆，而悬停操作条是手指最容易误触的地方。
   */
  onDelete(messageId: string): void
  /**
   * 本轮的内联错误（§12.13 第二级）。
   *
   * 渲染在消息流末尾，而不是浮在输入框上方：它说的是「上一句没发成」，
   * 属于这条流水线的一部分。挂在输入框上方会挤掉垂直预算里的 12px 间距，
   * 而且用户读到它的时候视线正在消息区。
   */
  error?: InlineErrorSpec
  /**
   * 挂载后交出「跳到最新」能力。
   *
   * 用回调而不是 `forwardRef`：`Cmd/Ctrl + ↓` 的处理在 `App` 里，
   * 而 `App` 与 `Timeline` 之间本来就有一堆 props。为一个方法引入
   * `useImperativeHandle` + `forwardRef` 两层包装，读起来比一个回调重。
   *
   * 回调在卸载时以 `undefined` 再调一次，让上层清掉引用——
   * 不清的话切换会话后会调到上一个实例的滚动节点，滚的是已经被卸掉的 DOM。
   */
  onHandle?(handle: TimelineHandle | undefined): void
  /**
   * 离开归来的一行灰字（§12.9）。
   *
   * 传一句已经算好的话，而不是传时长让这里算：阈值判定、单位换算、
   * 取整三件事在 `lib/absence.ts` 里，那是唯一真源。这里若再算一遍，
   * 改阈值就要改两处，而其中一处必然被忘。
   *
   * `undefined` 表示不留痕。
   */
  absence?: string
  /**
   * 还挂着撤回窗口的那条主动消息 id（§6.4 E）。
   *
   * 传 id 而不是布尔：那行「这次不用」只属于某一条消息。用布尔的话，
   * 一条主动消息出现后**所有**助手消息都会长出那个按钮——包括普通回复。
   *
   * 倒计时由本组件自己跑（见 `undoLeft` 的注释），上层只给「哪一条」。
   */
  undoable?: string
  /** 点「这次不用」。 */
  onDeclineProactive(messageId: string): void
}

/** 一条内联错误。 */
export interface InlineErrorSpec {
  /** 原因。一句话，不带句号。 */
  text: string
  /** 重试。 */
  onRetry(): void
  /** 关掉。 */
  onDismiss(): void
}

/**
 * 渲染时间轴。
 *
 * ## 为什么要自己接管滚动
 *
 * 容器上挂 `onScroll` 记录「是否贴底」，新消息到达时只在贴底的情况下滚。
 * 交给 `scrollIntoView` 会在用户读历史时把他拽到底部——那是聊天软件里
 * 最招人烦的一种行为。
 */
export function Timeline({
  messages,
  busy,
  empty,
  onQuote,
  onDelete,
  error,
  onHandle,
  absence,
  undoable,
  onDeclineProactive,
}: TimelineProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /**
   * 正在等第二次确认的那条消息 id。
   *
   * 删除不可逆，而悬停操作条是手指最容易误触的位置。点一次变成
   * 「确认删除」，三秒内不再点就复原——不弹窗、不改布局，与
   * 会话抽屉里的「清空全部」用同一套确认语言。
   */
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  /** 复原计时器。放 ref：它不参与渲染，且要在换一条时清掉上一条。 */
  const confirmTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (confirmTimer.current !== undefined) globalThis.clearTimeout(confirmTimer.current)
    }
  }, [])

  /** 点删除：第一次进入确认态，第二次才真的删。 */
  const askDelete = useCallback((messageId: string): void => {
    if (confirming !== messageId) {
      setConfirming(messageId)
      if (confirmTimer.current !== undefined) globalThis.clearTimeout(confirmTimer.current)
      confirmTimer.current = globalThis.setTimeout(() => { setConfirming(undefined) }, 3_000)
      return
    }
    if (confirmTimer.current !== undefined) globalThis.clearTimeout(confirmTimer.current)
    confirmTimer.current = undefined
    setConfirming(undefined)
    onDelete(messageId)
  }, [confirming, onDelete])
  /** 记录是否贴底。用 ref 而不是 state：`onScroll` 每帧都可能触发，不该引起重渲染。 */
  const stick = useRef(true)
  /**
   * 用户是否刚发起过一次滚动动作。
   *
   * 这是 `stick` 唯一的合法来源。`scroll` 事件本身不能说明任何事——
   * 它由三类完全不同的原因触发：
   *
   * 1. 用户滚轮 / 触摸 / 拖动滑块 / 按翻页键 —— 真实的「我想看别处」；
   * 2. 我们自己的 `scrollToBottom` —— 程序跟随，不该反过来否决跟随；
   * 3. 浏览器在布局阶段自行调整位置（字体加载后重排、内容插入）——
   *    与用户意图毫无关系，却表现为「`scrollTop` 变了」。
   *
   * 早期版本用「`scrollTop` 有没有变」区分，把第 3 类也算成了用户行为，
   * 于是 `stick` 被永久置 false：错误条、离开提示、新消息全落在视口外，
   * 界面上一个字都不显示，也没有任何报错——这类静默失败最难查。
   */
  const gesture = useRef(false)
  /** 内容容器，供 `ResizeObserver` 观察高度变化。 */
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [showJump, setShowJump] = useState(false)
  /** 当前显示操作条的消息 id。同一时刻只显示一条。 */
  const [active, setActive] = useState<string | undefined>(undefined)
  /**
   * 是否正在滚动。**只服务于触屏**（§10.4）。
   *
   * ## 为什么需要它
   *
   * 触屏没有悬停，消息操作条只能常驻（40% 不透明）。但滚动时手指正贴着
   * 屏幕，那一排按钮既点不到也碍眼。规范要求「滚动时隐藏，停止滚动
   * 600ms 后重新出现」。
   *
   * ## 600 为什么不是动效五档
   *
   * 它是**停留时长**（滚完到按钮回来之间隔多久），不是补间快慢。
   * 与滚动条 800ms 淡出、Rail 标签 800ms 延迟同类。
   *
   * ## 为什么用 state 而不是直接在视口上写属性
   *
   * `data-scrolling` 挂在 `.timeline` 上，CSS 靠它选择子孙。写属性不需要
   * 渲染，但清掉它的定时器要在组件卸载时撤销——那又得存一个 ref。
   * 用 state 让 React 管这一份生命周期，代码更短，代价是滚动起止各一次
   * 重渲染（不是每帧）。
   */
  const [scrolling, setScrolling] = useState(false)
  /** 滚动停止后重新显示的计时器。 */
  const scrollTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)
  const toast = useToast()

  /*
   * 撤回窗口还剩多少毫秒。
   *
   * ## 为什么在这里倒计时，而不是让上层每秒重渲染一次
   *
   * 上层的 `useAppState` 是整棵树的状态源，让它每 250ms 变一次会让整个
   * 会话视图（消息、日志、脊、输入框）全部重渲染——为一个三秒倒计时
   * 付这个代价不合理。这里只需要一个翻页效果（按钮在/不在），
   * 250ms 的粒度已经足够，且只影响时间轴这一棵子树。
   *
   * ## 为什么不是逐帧
   *
   * 那个按钮没有进度条，用户看不出 250ms 与 16ms 的差别。逐帧倒计时
   * 反而会让「还剩 0.3 秒」时按钮闪一下消失——看起来像 bug。
   */
  const [undoLeft, setUndoLeft] = useState(0)

  useEffect(() => {
    if (undoable === undefined) {
      setUndoLeft(0)
      return
    }
    const deadline = Date.now() + UNDO_WINDOW_MS
    setUndoLeft(UNDO_WINDOW_MS)
    const timer = globalThis.setInterval(() => {
      const left = deadline - Date.now()
      if (left <= 0) {
        globalThis.clearInterval(timer)
        setUndoLeft(0)
        return
      }
      setUndoLeft(left)
    }, 250)
    return () => {
      globalThis.clearInterval(timer)
    }
  }, [undoable])

  /** 把行按日期分组，中间插分隔行。 */
  const rows = useMemo<Row[]>(() => {
    const now = Date.now()
    const result: Row[] = []
    /** 首条消息所在的那一天，用来算「第 N 天」。 */
    const firstAt = messages[0]?.at
    const firstDay = firstAt === undefined ? undefined : startOfDay(firstAt)

    let lastDay: number | undefined
    messages.forEach((message, index) => {
      const day = startOfDay(message.at)
      if (day !== lastDay) {
        lastDay = day
        const dayIndex =
          firstDay === undefined ? undefined : Math.round((day - firstDay) / DAY) + 1
        result.push({
          kind: 'day',
          key: `day-${String(day)}`,
          at: message.at,
          label: dayLabel(message.at, now),
          // 「第 N 天」只在第一条日期行出现（§12.6）。
          dayIndex: result.length === 0 ? dayIndex : undefined,
        })
      }
      result.push({
        kind: 'message',
        key: message.id,
        message,
        last: index === messages.length - 1,
      })
    })
    return result
  }, [messages])

  /** 滚到底。 */
  const scrollToBottom = useCallback((smooth: boolean): void => {
    const node = scrollRef.current
    if (node === null) return
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  /**
   * 记录是否贴底，并决定浮标是否出现。
   *
   * ## 为什么不在每次 `scroll` 里重算
   *
   * 见 `gesture` 的注释：`scroll` 事件不区分「人滚的」与「机器滚的」。
   * 这里只在**检测到真实手势**时才更新 `stick`——其余情况（程序跟随、
   * 浏览器重排）一律不碰它。
   *
   * 手势标记用掉即清：一次滚轮可能产生多个 `scroll` 事件，但意图只有
   * 一个；留着不清会让之后某次布局调整被误读成用户行为。
   *
   * 距离判定用 `STICK_THRESHOLD` 而不是严格等于 0：用户滚回底部时
   * 未必精确停在最后 1px，留 80px 容差才不会「差两像素就不跟了」。
   */
  const onScroll = useCallback((): void => {
    if (!gesture.current) return
    gesture.current = false
    const node = scrollRef.current
    if (node === null) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    stick.current = distance < STICK_THRESHOLD
    setShowJump(!stick.current && messages.length > 0)
  }, [messages.length])

  /**
   * 键盘滚屏（§9.6）。
   *
   * ## 为什么需要它
   *
   * 一条消息是一个 Tab 停靠点。40 条消息就要按 40 次 Tab 才能走到输入框——
   * 规范把这一条列为「唯一的例外」，要求消息区里 `PageUp` / `PageDown`
   * 按屏跳，不必逐条走。
   *
   * ## 为什么要减掉 3 行
   *
   * 「按屏跳」不等于滚一整个 `clientHeight`：留下三行重叠，读者才能接上
   * 刚才读到的那句。整屏正好翻过去，视觉上没有任何锚点，会瞬间失去方位。
   * 这个做法与终端分页（`less`）一致，用户不需要重新学习。
   *
   * ## 为什么不自己写滚动
   *
   * 用 `scrollBy` 而不是算 `scrollTop`：滚到底部时浏览器会自动夹住
   * 目标值，自己算会溢出然后被拉回，出现一次回弹。
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return
    const node = scrollRef.current
    if (node === null) return
    // 焦点在消息内部的可编辑区时（目前没有，但将来会有）不抢翻页键。
    if (isEditable(event.target)) return
    event.preventDefault()
    const line = Number.parseFloat(getComputedStyle(node).lineHeight)
    const overlap = Number.isFinite(line) ? line * 3 : 60
    const step = Math.max(120, node.clientHeight - overlap)
    gesture.current = true
    node.scrollBy({ top: event.key === 'PageDown' ? step : -step, behavior: 'smooth' })
  }, [])

  /**
   * 标记「用户正在滚」。
   *
   * ## 为什么由 `ScrollArea` 报告而不是这里自己挂监听
   *
   * 滚轮与触屏在视口上，但拖滑块发生在视口的**兄弟节点**上，
   * 事件根本不经过视口。让这里去猜「哪个是滑块、target 是不是它」
   * 等于把 `ScrollArea` 的内部结构抄一份到时间轴里，对方一改就静默失效。
   *
   * 由 `ScrollArea` 统一报告是唯一稳的分法：它知道自己由哪几块拼成。
   *
   * ## 为什么不标 `keydown`
   *
   * 只有翻页键会滚，而它们在 `onKeyDown` 里已经标了。把整个
   * `keydown` 都标上，会让「在消息区里按 Tab、按 Cmd+C」也被当成
   * 一次滚动意图，下次布局调整就会被误判。
   */
  const markGesture = useCallback((): void => {
    gesture.current = true
    /*
     * 触屏操作条随滚动隐藏（§10.4）。
     *
     * 只在 `hover: none` 的环境里起作用——CSS 那条规则写在
     * `@media (hover: none)` 里，桌面上这个属性挂着也没有任何效果。
     * 所以不必在这里判设备，省掉一次 `matchMedia`。
     */
    setScrolling(true)
    globalThis.clearTimeout(scrollTimer.current)
    scrollTimer.current = globalThis.setTimeout(() => { setScrolling(false) }, 600)
  }, [])

  // 卸载时清掉计时器，否则会在组件消失后 setState。
  useEffect(() => {
    return () => { globalThis.clearTimeout(scrollTimer.current) }
  }, [])

  /**
   * 新消息、生成中变化、或错误条与离开提示出现时决定是否跟随。
   *
   * 依赖里放 `messages.length` 与 `busy`：前者管「来了新的一条」，
   * 后者管「开始生成」——生成开始时用户通常刚发完消息，应当跟到底。
   *
   * ## 为什么 `absence` 与 `error` 都在依赖里
   *
   * 这两样都是**在末尾追加**的一段，且出现时机正是用户视线停在
   * 最后一条消息上的那一刻。不跟着滚，它们就落在可视区下方——
   * 用户看到的仍然是「刚才那一屏」，那行字一个字都看不到，功能等于没做。
   *
   * 这个坑上一轮在 `absence` 上踩过一次（DOM 里有节点、断言全绿、
   * 但字在视口外），本轮的 `error` 是同一个坑的复现：错误条渲染了、
   * 「出现内联错误条」那条断言也绿了，但「内联错误可见」报红。
   * 所以**凡追加到流末尾的内容，都必须进这个依赖**。
   *
   * 依赖写 `error?.text` 而不是 `error` 对象：后者每次渲染都是新对象，
   * 会让这个 effect 每帧都跑一次滚动，用户往上翻的历史会被不停拽回底部。
   *
   * 只在原本就贴底时跟（`stick.current`）：用户若正在读历史，
   * 把他拽到底部是另一种打扰。这与新消息的处理用同一条判据。
   */
  useEffect(() => {
    if (stick.current) scrollToBottom(false)
  }, [messages.length, busy, absence, error?.text, scrollToBottom])

  /**
   * 内容高度变化时补一次跟随。
   *
   * ## 为什么光有上面那个 effect 不够
   *
   * 首帧挂载时正文还没排版完：字体未加载、`RichText` 刚插入、图片未撑开，
   * 此时 `scrollHeight` 可能恰好等于 `clientHeight`——滚到底也还是 0，
   * 因为**没有可滚的余地**。等字体加载完、内容撑到两倍高，那个 effect
   * 早就跑完了，没有任何东西会再滚一次。
   *
   * 实测症状：打开一个带长回复的会话，视图停在最上面第一条，
   * 而这恰恰是「打开历史会话应该停在最新一条」的反面。更麻烦的是，
   * 内容变高会触发一次 `scroll` 事件，把 `stick` 误判成 false（见
   * `onScroll` 的守卫），于是后续的错误条、离开提示全都不再跟随。
   *
   * 用 `ResizeObserver` 而不是在 `useEffect` 里量一次：高度变化可能
   * 发生多次（字体、图片、窗口缩放），只量一次抓不全。
   */
  useEffect(() => {
    const content = contentRef.current
    if (content === null) return
    const observer = new ResizeObserver(() => {
      if (stick.current) scrollToBottom(false)
    })
    observer.observe(content)
    return () => { observer.disconnect() }
  }, [scrollToBottom])

  /** 首帧无条件贴底：打开一个历史会话时应停在最新一条，不是最旧一条。 */
  useEffect(() => {
    scrollToBottom(false)
  }, [scrollToBottom])

  /*
   * 把「跳到最新」交给上层，卸载时收回。
   *
   * 依赖里放 `onHandle`：它通常是 `App` 里的 `setState` 型回调，引用稳定，
   * 但如果调用方传了内联箭头函数，不带着依赖就会一直交旧闭包。
   */
  useEffect(() => {
    onHandle?.({ jumpToLatest: (smooth: boolean) => { scrollToBottom(smooth) } })
    return () => { onHandle?.(undefined) }
  }, [onHandle, scrollToBottom])

  /**
   * 复制整条消息的正文。
   *
   * 反馈走 Toast「已复制」1.6s——但 Toast 的成功态是 2.4s（§5.10）。
   * 两者冲突时按 §5.10：提示条只有一种成功时长，为复制单独开一个
   * 1.6s 的例外会让「提示条多久消失」变成一件不可预期的事。
   *
   * ## 为什么先过一遍 `toPlainText`
   *
   * §5.4 写的是「复制纯文本，**不含 Markdown 记号**」。直接把源串写进
   * 剪贴板，粘到别处会是一堆 `**`、`| --- |` 与围栏反引号。
   */
  const copy = useCallback((text: string): void => {
    void navigator.clipboard.writeText(toPlainText(text)).then(
      () => { toast('已复制') },
      () => { toast({ text: '复制失败', tone: 'error' }) },
    )
  }, [toast])

  return (
    <div className="timeline" data-scrolling={scrolling ? '' : undefined}>
      <ScrollArea
        viewportRef={scrollRef}
        className="timeline__scroll"
        onScroll={onScroll}
        onGesture={markGesture}
        onKeyDown={onKeyDown}
        viewportProps={{
          /*
           * `role="log"` + `aria-live="polite"`（§9.7）。
           *
           * 用 `log` 而不是 `list`：这串东西是**按时间追加**的，
           * 读屏需要知道新内容是从末尾加进来的。`polite` 而非
           * `assertive`——生成中的正文是逐字落下来的，`assertive`
           * 会把用户正在读的东西反复打断。
           *
           * `aria-busy` 挂在视口上而不是整页：语义是「这个区域正在更新」，
           * 挂整页会让读屏阻塞所有播报。
           */
          role: 'log',
          'aria-live': 'polite',
          'aria-busy': busy,
          'aria-label': '对话',
          /*
           * 视口自己进 Tab 顺序。
           *
           * 这是 `PageUp` / `PageDown` 能被收到的前提——没有焦点就没有
           * 键盘事件。`tabIndex={0}` 写在视口而不是外层容器：外层是
           * `.scrollarea`（纯布局壳），它不该成为停靠点。
           */
          tabIndex: 0,
        }}
        remeasureKey={messages.length}
      >
        <div className="timeline__measure" ref={contentRef} {...(empty ? { 'data-empty': '' } : {})}>
          {/*
            空会话就是开场。

            首页删掉之后，这是用户打开应用看到的第一屏。它承担原来那个
            独立首页的全部职责，但不能长成一个首页：三栏已经在位，用户随时
            可以打字，这里只放三样东西——标志、名字、一句邀请。再多就成了
            「又一个封面」，而封面的问题正是它挡在对话前面。
          */}
          {empty ? (
            <div className="timeline__empty">
              <span className="timeline__empty-mark">
                <Mark size={32} variant="line" />
              </span>
              <p className="timeline__empty-title">
                空谷
                <span className="timeline__empty-title-en">Ondra</span>
              </p>
              <p className="timeline__empty-slogan">于无声处，听见共鸣。</p>
              <p className="timeline__empty-hint">从哪儿说起都行</p>
            </div>
          ) : null}

          {rows.map((row) =>
            row.kind === 'day' ? (
              <div className="timeline__day" key={row.key}>
                <span className="timeline__day-rule" aria-hidden="true" />
                <span className="timeline__day-label">{row.label}</span>
                {row.dayIndex === undefined ? null : (
                  <span className="timeline__day-index">第 {row.dayIndex} 天</span>
                )}
                <span className="timeline__day-rule" aria-hidden="true" />
              </div>
            ) : (
              <article
                className="message"
                key={row.key}
                data-role={row.message.role}
                data-time={clockOf(row.message.at)}
                data-pending={row.message.pending === true ? '' : undefined}
                data-actions={active === row.message.id ? '' : undefined}
                tabIndex={0}
                onPointerEnter={() => { setActive(row.message.id) }}
                onPointerLeave={() => {
                  setActive((previous) => (previous === row.message.id ? undefined : previous))
                }}
                /*
                 * 键盘路径：消息可聚焦，聚焦即显示操作条。
                 * 不做成「聚焦后 Tab 进五个按钮」——那会让一屏消息多出
                 * 几十个 Tab 停靠点。`Enter` 打开一条独立的小工具条是
                 * 更省的做法，但本期先只做聚焦显示，工具条留给对话框落地后。
                 */
                onFocus={() => { setActive(row.message.id) }}
                onBlur={() => {
                  setActive((previous) => (previous === row.message.id ? undefined : previous))
                }}
              >
                <div className="message__body">
                  <RichText source={row.message.content} />
                  {row.message.pending === true ? (
                    <span className="message__dots" aria-label="正在回复">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                </div>

                {/*
                  主动开口的可解释行（§6.4 E）。

                  ## 为什么在正文**下方** 8px
                  
                  规范原话是「正文下 8px 处」。放上方的话，用户读到的顺序
                  会变成「理由 → 她说的话」，而人真实的阅读顺序是「她说了
                  什么 → 咦为什么」。放下面正合这个顺序。
                  
                  ## 为什么只对带 `proactive` 字段的消息渲染
                  
                  `undefined` 是普通回复，不渲染；空串是「主动但没给出理由」，
                  照样渲染——后者必须显示，否则用户会觉得她莫名其妙开口。
                  
                  ## 为什么 pending 时不渲染
                  
                  正文还在流的时候，理由行已经在了，用户会先看到「她主动开口 ·
                  想知道你睡了没」再看到那句话一个字一个字冒出来。等他读完
                  理由是空的那 1.5 秒里，是在猜她到底说了什么。
                */}
                {row.message.proactive !== undefined && row.message.pending !== true ? (
                  <ReasonLine
                    reason={row.message.proactive}
                    undoLeft={undoable === row.message.id ? undoLeft : 0}
                    onDecline={() => { onDeclineProactive(row.message.id) }}
                  />                ) : null}

                {/*
                  悬停操作条。`data-actions` 挂在 article 上，CSS 用它控制
                  显隐——把显隐放在 CSS 而不是条件渲染，是为了让淡入淡出
                  真的有 120ms，而不是「节点出现即完成」。

                  三项：复制、引用、删除。§5.4 里还有朗读与重答，宿主协议
                  没有对应接口，仍不放——点了会失败的按钮比不放更糟。
                  删除这一项是本轮补上的：内核新增了 `session.deleteMessage`，
                  它从「位置预留」变成了真的可用。
                */}
                <div className="message__actions">
                  <button
                    type="button"
                    className="message__action"
                    aria-label="复制"
                    title="复制"
                    onClick={() => { copy(row.message.content) }}
                  >
                    <Icon icon={IconCopy} size={16} />
                  </button>
                  <button
                    type="button"
                    className="message__action"
                    aria-label="引用"
                    title="引用"
                    onClick={() => { onQuote(row.message.content) }}
                  >
                    <Icon icon={IconQuote} size={16} />
                  </button>
                  <button
                    type="button"
                    className="message__action"
                    data-armed={confirming === row.message.id ? '' : undefined}
                    aria-label={confirming === row.message.id ? '确认删除这条消息' : '删除'}
                    title={confirming === row.message.id ? '再点一次就删掉' : '删除'}
                    onClick={() => { askDelete(row.message.id) }}
                  >
                    {confirming === row.message.id
                      ? <span className="message__action-text">确认</span>
                      : <Icon icon={IconTrash} size={16} />}
                  </button>
                </div>
              </article>
            ),
          )}

          {/*
            离开归来的一行（§12.9）。放在消息流末尾、错误条之前：
            它是这段时间轴上的一段空白，属于流水线本身；错误条说的是
            最后一次尝试的结果，是叠加在流水线上的状态。顺序反了，
            用户会读到「你离开了 23 分钟」压在一条红色报错下面，
            像是离开导致了报错。
          */}
          {absence === undefined ? null : (
            <p className="timeline__absence">{absence}</p>
          )}

          {/*
            内联错误条。放在消息流末尾——它是这一轮的结果，
            位置就在那条本该回复的消息下面，用户视线不用跳。
          */}
          {error === undefined ? null : (
            <div className="inline-error" role="alert">
              <span className="inline-error__text">{error.text}</span>
              <button type="button" className="inline-error__action" onClick={error.onRetry}>
                重试
              </button>
              <button
                type="button"
                className="inline-error__action"
                onClick={error.onDismiss}
                aria-label="关闭提示"
              >
                关闭
              </button>
            </div>
          )}
        </div>
      </ScrollArea>

      {/*
        「有新消息」浮标。只在用户离开底部时出现，点了才滚。
        它不抢滚动位置，也不自动消失——用户没看到新消息就不该假装他看到了。
      */}
      {showJump ? (
        <button type="button" className="timeline__jump" onClick={() => { scrollToBottom(true) }}>
          <Icon icon={IconChevronDown} size={16} />
          <span>有新消息</span>
        </button>
      ) : null}
    </div>
  )
}
