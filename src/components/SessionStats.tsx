/**
 * 会话抽屉：这一段对话的账。
 *
 * ## 为什么这里不放消息列表
 *
 * 消息就在主列上，抽屉一旦复述它，用户就得在两个地方读同一段话，而且
 * 抽屉只有 300px，读起来比主列更差。这一屏要回答的是**主列回答不了的**
 * 四件事：聊了多少轮、从什么时候开始、一共写了多少字、清空过几次。
 *
 * ## 四个数的口径
 *
 * | 读数 | 口径 | 为什么是这个口径 |
 * | --- | --- | --- |
 * | 轮数 | 用户消息条数 | 与日志「第 N 轮」一致，用户数自己说了几句 |
 * | 开始时间 | 会话创建时间 | 不是首条消息时间：会话可以先建后说 |
 * | 总字数 | 用户与助手正文合计 | 不含工具与系统消息，那些不是「说过的话」 |
 * | 已归档段数 | 归档会话数 | 每次「清空全部」留下一段，等于清空过几次 |
 *
 * 四个数全部来自宿主 `/api/sessions/:id/stats`，界面不自己算——已归档段数
 * 只有内核的会话总表知道。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionStats } from '../lib/api.ts'

/** 把时间戳写成 `YYYY-MM-DD HH:mm`。 */
function formatMoment(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 千分位。总字数会到五位数，不分节读起来要数位。 */
function grouped(value: number): string {
  return value.toLocaleString('zh-Hans-CN')
}

export interface SessionPanelProps {
  /** 统计。undefined 表示还没有会话。 */
  stats: SessionStats | undefined
  /** 当前会话标题。空串时显示「新对话」。 */
  title: string
  /** 是否正在生成。清空时要先停下来，否则清完这一轮还会写回去。 */
  busy: boolean
  /**
   * 清空全部。
   *
   * 由上层执行（它会先归档成段再开新段）。这里只负责**问一次**
   * ——清空是不可逆的界面动作，不该点一下就发生。
   */
  onClearAll(): void
}

/**
 * 渲染会话抽屉。
 *
 * ## 清空为什么是两段式而不是弹窗
 *
 * `Dialog` 是模态的，会盖住整屏、打断阅读。清空只是一次「确认」，
 * 用按钮自身变成「再点一次确认」，三秒内没点就复原：
 * - 误点一次不会清；
 * - 不需要为它开一个新浮层；
 * - 第三秒后自己回到原样，不会留下一个一直等着被点的红按钮。
 */
export function SessionPanel({ stats, title, busy, onClearAll }: SessionPanelProps): React.JSX.Element {
  /** 是否已进入「再点一次确认」。 */
  const [armed, setArmed] = useState(false)
  /** 复原计时器。放 ref：它不参与渲染，且要在重复点击时清掉上一条。 */
  const timer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  /** 组件卸载时清掉计时器，避免它去改一个已经不在的组件的状态。 */
  useEffect(() => {
    return () => {
      if (timer.current !== undefined) globalThis.clearTimeout(timer.current)
    }
  }, [])

  const onClearClick = useCallback((): void => {
    if (!armed) {
      setArmed(true)
      if (timer.current !== undefined) globalThis.clearTimeout(timer.current)
      timer.current = globalThis.setTimeout(() => { setArmed(false) }, 3_000)
      return
    }
    if (timer.current !== undefined) globalThis.clearTimeout(timer.current)
    timer.current = undefined
    setArmed(false)
    onClearAll()
  }, [armed, onClearAll])

  const heading = title.trim() === '' ? '新对话' : title.trim()

  return (
    <div className="sess">
      <div className="sess__head">
        <span className="sess__title" title={heading}>{heading}</span>
        <span className="sess__badge">{stats === undefined ? '未开始' : '进行中'}</span>
      </div>

      {stats === undefined ? (
        /*
         * 空态：还没有会话。
         *
         * 不用「暂无数据」——那句话什么都没说。用户需要知道的是「说一句就有」，
         * 而输入框就在右边。
         */
        <p className="drawer__empty">说一句话，这里就开始记账</p>
      ) : (
        <>
          <dl className="sess__grid">
            <div className="sess__cell">
              <dt className="sess__key">轮数</dt>
              <dd className="sess__value">{grouped(stats.rounds)}</dd>
            </div>
            <div className="sess__cell">
              <dt className="sess__key">总字数</dt>
              <dd className="sess__value">{grouped(stats.totalChars)}</dd>
            </div>
            <div className="sess__cell">
              <dt className="sess__key">开始于</dt>
              <dd className="sess__value sess__value--time">{formatMoment(stats.startedAt)}</dd>
            </div>
            <div className="sess__cell">
              <dt className="sess__key">已归档</dt>
              <dd className="sess__value">{grouped(stats.archivedSegments)} 段</dd>
            </div>
          </dl>

          {/*
           * 工作区：空串表示没有绑定。
           *
           * 不显示一条猜出来的路径——找不到的东西比「未绑定」更让人焦虑。
           */}
          <div className="sess__row">
            <span className="sess__key">工作区</span>
            <span className="sess__path" title={stats.workspace === '' ? undefined : stats.workspace}>
              {stats.workspace === '' ? '未绑定' : stats.workspace}
            </span>
          </div>
        </>
      )}

      <div className="sess__foot">
        <button
          type="button"
          className="sess__clear"
          data-armed={armed ? '' : undefined}
          disabled={busy || stats === undefined}
          onClick={onClearClick}
        >
          {armed ? '再次点击以清空' : '清空全部'}
        </button>
        <span className="sess__hint">
          {busy ? '生成中，请先停止' : '清空后保留归档副本'}
        </span>
      </div>
    </div>
  )
}
