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
import { IconChevronDown, IconCopy, IconQuote } from './icons.ts'
import { ScrollArea } from './ScrollArea.tsx'
import { useToast } from './Toast.tsx'
import type { ChatMessage } from '../lib/useAppState.ts'

/** 星期名。中文界面只用中文，不出现 `Thu` 这种。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 距底部多少像素内算「在底部」。 */
const STICK_THRESHOLD = 80

/** 一天的毫秒数。 */
const DAY = 24 * 60 * 60 * 1000

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

/** 时间轴里的一段：一条消息，或一条日期分隔。 */
type Row =
  | { kind: 'day'; key: string; at: number; label: string; dayIndex: number | undefined }
  | { kind: 'message'; key: string; message: ChatMessage; last: boolean }

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
}: TimelineProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 是否贴底。用 ref 而不是 state：`onScroll` 每帧都可能触发，不该引起重渲染。 */
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  /** 当前显示操作条的消息 id。同一时刻只显示一条。 */
  const [active, setActive] = useState<string | undefined>(undefined)
  const toast = useToast()

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

  /** 记录是否贴底，并决定浮标是否出现。 */
  const onScroll = useCallback((): void => {
    const node = scrollRef.current
    if (node === null) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    stick.current = distance < STICK_THRESHOLD
    setShowJump(!stick.current && messages.length > 0)
  }, [messages.length])

  /**
   * 新消息或生成中变化时决定是否跟随。
   *
   * 依赖里放 `messages.length` 与 `busy`：前者管「来了新的一条」，
   * 后者管「开始生成」——生成开始时用户通常刚发完消息，应当跟到底。
   */
  useEffect(() => {
    if (stick.current) scrollToBottom(false)
  }, [messages.length, busy, scrollToBottom])

  /** 首帧无条件贴底：打开一个历史会话时应停在最新一条，不是最旧一条。 */
  useEffect(() => {
    scrollToBottom(false)
  }, [scrollToBottom])

  /**
   * 复制整条消息的正文。
   *
   * 反馈走 Toast「已复制」1.6s——但 Toast 的成功态是 2.4s（§5.10）。
   * 两者冲突时按 §5.10：提示条只有一种成功时长，为复制单独开一个
   * 1.6s 的例外会让「提示条多久消失」变成一件不可预期的事。
   */
  const copy = useCallback((text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => { toast('已复制') },
      () => { toast({ text: '复制失败', tone: 'error' }) },
    )
  }, [toast])

  return (
    <div className="timeline">
      <ScrollArea
        viewportRef={scrollRef}
        className="timeline__scroll"
        onScroll={onScroll}
        remeasureKey={messages.length}
      >
        <div className="timeline__measure">
          {empty ? <p className="timeline__empty">从哪儿说起都行</p> : null}

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
                  {row.message.content}
                  {row.message.pending === true ? (
                    <span className="message__dots" aria-label="正在回复">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                </div>

                {/*
                  悬停操作条。`data-actions` 挂在 article 上，CSS 用它控制
                  显隐——把显隐放在 CSS 而不是条件渲染，是为了让淡入淡出
                  真的有 120ms，而不是「节点出现即完成」。

                  只做复制与引用两项。§5.4 还列了朗读 / 重答 / 删除，
                  但宿主的协议里没有对应的三个接口（没有删除消息、没有
                  单条重答、没有 TTS 通道）。放三个点了会失败的按钮，
                  比不放更糟——用户会以为坏了。等协议补齐再加，位置预留。
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
                </div>
              </article>
            ),
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
