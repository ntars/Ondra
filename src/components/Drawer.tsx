/**
 * 抽屉（Drawer）。
 *
 * ## 一个容器，四种内容
 *
 * §5.2 的四个入口（今天 / 周 / 记忆 / 剧场）共用同一个容器：左贴、
 * 宽 300、覆盖主列左半。点另一个入口时内容**原地替换**，不先收起再展开
 * ——那样是两次 180ms，用户会感到一顿（§5.2 交互细则）。
 *
 * 所以这里的做法是：容器常挂，`data-open` 控制进出场，内容按键切换。
 * React 侧不需要卸载重挂，也就没有「收起动画没跑完就换内容」的中间态。
 *
 * ## 为什么宽度写死在 CSS 而不是内联
 *
 * 宽 300 是 §5.9 的定值。写内联会让「窄屏时改 100%」这类断点规则
 * 无法覆盖（内联优先级最高），而移动端恰恰要把抽屉改成全屏 Sheet。
 *
 * ## 焦点
 *
 * 打开时把焦点移进抽屉（§9.5「抽屉内第一个可聚焦项」），关闭时由上层
 * 还原到触发元素。这里只负责「进来」，因为「回到哪」只有上层知道。
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'
import type { DrawerKey } from './Rail.tsx'
import type { SessionMeta } from '../lib/api.ts'
import type { MemoryItem } from '../lib/types.ts'

/** 抽屉标题。与 Rail 的 aria-label 一致，不另起说法。 */
const TITLES: Record<DrawerKey, string> = {
  today: '今天',
  week: '本周',
  memory: '记忆',
  theater: '剧场',
}

/**
 * 把时间戳写成相对时间。
 *
 * §12.6 定了六档：刚刚 / N 分钟前 / 昨天 / 上周 / 上个月 + 绝对日期。
 * 这里只服务会话列表，用其中前四档即可，超过一周直接给日期——
 * 「3 周前」这种说法用户还得自己换算，不如给日期。
 */
function relative(ts: number, now: number): string {
  const diff = now - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${String(Math.floor(diff / minute))} 分钟前`
  if (diff < day) return `${String(Math.floor(diff / hour))} 小时前`
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return `${String(Math.floor(diff / day))} 天前`
  const date = new Date(ts)
  return `${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日`
}

/** 会话标题为空时给一个占位，空行比「未命名」更难看。 */
function sessionTitle(meta: SessionMeta): string {
  const trimmed = meta.title.trim()
  return trimmed === '' ? '未命名的一轮' : trimmed
}

export interface DrawerProps {
  /** 当前内容。undefined 表示收起。 */
  view: DrawerKey | undefined
  /** 历史会话。 */
  sessions: SessionMeta[]
  /** 当前会话 id，用于高亮。 */
  currentSessionId: string | undefined
  /** 记忆列表。 */
  memories: MemoryItem[]
  /** 打开一个会话。 */
  onOpenSession(id: string): void
  /** 关闭。 */
  onClose(): void
}

/**
 * 渲染抽屉。
 *
 * 收起时用 `inert` 而不是 `display: none`：`display: none` 会让退场动画
 * 直接被裁掉（元素立刻消失，没有 240ms 的位移），而 `inert` 只是禁止
 * 交互与读屏访问，视觉上仍能播完退场。
 */
export function Drawer({
  view,
  sessions,
  currentSessionId,
  memories,
  onOpenSession,
  onClose,
}: DrawerProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const open = view !== undefined
  /** 搜索词。故意只在本地：它不是会话状态，切抽屉即弃。 */
  const [query, setQuery] = useState('')

  /**
   * 打开时把焦点移进来。
   *
   * §9.5：「打开抽屉 → 抽屉内第一个可聚焦项（搜索框）」。
   * 所以搜索框必须排在 DOM 里第一个，否则焦点会落到关闭键上——
   * 用户按 Esc 之前的第一个 Tab 就到了「关闭」，像在催他走。
   *
   * 收起时不主动抢焦点：焦点该由上层还原到触发按钮。
   */
  useEffect(() => {
    if (!open) return
    // 搜索框优先。没有搜索框的视图（剧场）退到第一个可聚焦项。
    const target = searchRef.current ?? panelRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    target?.focus()
  }, [open, view])

  /** 换视图时清掉搜索词：在记忆里搜的词带到会话列表里，只会得到空结果。 */
  useEffect(() => {
    setQuery('')
  }, [view])

  /**
   * 列表按时间窗过滤。
   *
   * 「今天」= 今天 0 点之后；「本周」= 最近 7 天。用日历日而不是「24 小时」
   * 是因为用户心里的「今天」是日期，不是滚动窗口。
   */
  const now = Date.now()
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const todayFrom = startOfToday.getTime()
  const weekFrom = todayFrom - 6 * 24 * 60 * 60 * 1000

  const from = view === 'today' ? todayFrom : weekFrom
  const list = sessions
    .filter((meta) => meta.updatedAt >= from)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  /*
   * 搜索只在「今天 / 本周 / 记忆」三个视图里出现。
   *
   * 剧场里是一份扩展清单，它自己的条目还没有真实数据（见下方空态），
   * 给一个筛不出东西的搜索框比不给更让人困惑。
   */
  const searchable = view === 'today' || view === 'week' || view === 'memory'

  /*
   * 过滤用「包含」而不是前缀：用户记得的是「雨」这个字，不是
   * 「关于雨的那个比喻」这整串的开头。大小写与空格一并抹平，
   * 中文没有大小写，但模型名、插件名里有英文。
   */
  const needle = query.trim().toLowerCase()
  const shown = needle === ''
    ? list
    : list.filter((meta) => sessionTitle(meta).toLowerCase().includes(needle))
  const shownMemories = needle === ''
    ? memories
    : memories.filter((memory) => memory.summary.toLowerCase().includes(needle))

  return (
    <div className="drawer" data-open={open ? '' : undefined}>
      <div className="drawer__panel" ref={panelRef} role="dialog" aria-label={view === undefined ? '抽屉' : TITLES[view]}>
        <header className="drawer__head">
          <h2 className="drawer__title">{view === undefined ? '' : TITLES[view]}</h2>
          <button type="button" className="drawer__close" aria-label="关闭" onClick={onClose}>
            <Icon icon={IconClose} size={16} />
          </button>
        </header>

        {/*
          搜索框（§9.1 的 `Cmd/Ctrl + K` 就是「打开抽屉并聚焦搜索框」）。

          放在 `drawer__body` **之外**：body 是滚动容器，放进去会随列表
          一起滚走——用户往下翻三屏后再想换词，得先滚回顶部。
          它仍排在 DOM 里第一个可聚焦位置，聚焦才会落在它上面。
        */}
        {searchable ? (
          <div className="drawer__search">
            <input
              ref={searchRef}
              type="search"
              className="drawer__search-input"
              value={query}
              placeholder={view === 'memory' ? '找一条记忆' : '找一轮对话'}
              aria-label={view === 'memory' ? '搜索记忆' : '搜索对话'}
              onChange={(event) => { setQuery(event.target.value) }}
              onKeyDown={(event) => {
                /*
                 * Esc 在搜索框里先清词、再关抽屉。
                 *
                 * §9.3 的顺序是「浮层 → 抽屉」，但搜索框是抽屉内部的
                 * 一个输入框——直接关掉整个抽屉，用户失去的是刚才打的
                 * 那半句。两级退更贴直觉：先撤一个字，再撤这一层。
                 */
                if (event.key !== 'Escape') return
                if (query !== '') {
                  event.stopPropagation()
                  setQuery('')
                }
              }}
            />
          </div>
        ) : null}

        <div className="drawer__body">
          {view === 'today' || view === 'week' ? (
            shown.length === 0 ? (
              <p className="drawer__empty">
                {needle === ''
                  ? (view === 'today' ? '今天还没说过话' : '这一周还是空的')
                  : `没找到「${query.trim()}」`}
              </p>
            ) : (
              <ul className="drawer__list">
                {shown.map((meta) => (
                  <li key={meta.id}>
                    <button
                      type="button"
                      className="drawer__row"
                      aria-current={meta.id === currentSessionId ? 'true' : undefined}
                      onClick={() => { onOpenSession(meta.id) }}
                    >
                      <span className="drawer__row-title">{sessionTitle(meta)}</span>
                      <span className="drawer__row-time">{relative(meta.updatedAt, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {view === 'memory' ? (
            shownMemories.length === 0 ? (
              <p className="drawer__empty">
                {needle === '' ? '聊两句就有了' : `没找到「${query.trim()}」`}
              </p>
            ) : (
              <ul className="drawer__list">
                {shownMemories.map((memory) => (
                  <li key={memory.id} className="drawer__memory">
                    <span className="drawer__memory-text">{memory.summary}</span>
                    <span className="drawer__row-time">{memory.relative}</span>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {view === 'theater' ? (
            /*
             * 剧场在 §6.3 里是「扩展池」的界面承载：列出可用扩展与开关。
             * 本批只做容器与空态，扩展清单等插件元信息接上再填——
             * 现在写死六个名字等于编一份不可信的数据。
             */
            <p className="drawer__empty">还没有打开任何扩展</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
