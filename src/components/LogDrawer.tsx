/**
 * 日志抽屉：同一段对话的另一种读法。
 *
 * ## 三类分区的边界
 *
 * | 分区 | 是什么 | 数据来源 |
 * | --- | --- | --- |
 * | 会话日志 | 她这几轮做了什么：开始、收到、想了、说完 | `/api/logs/session` + 本轮实时条目 |
 * | 通道日志 | 外部 IM 接入（微信、飞书等）的收发记录 | `/api/logs/channel` |
 * | 系统日志 | 宿主自己的运行记录：插件装载、配置扫描、错误 | `/api/logs/system` |
 *
 * 三者混在一起读不出结论：会话日志是「对话过程」，系统日志是「程序状态」。
 * 分区之后，「没有」也能被读成一句结论，而不是被当成一片空白。
 *
 * ## 会话日志为什么读传进来的那份
 *
 * 本轮正在发生的条目（「开始思考」）只存在于内存里：思考过程不落盘，
 * 服务端派生不出来。所以这一区直接渲染上层聚合好的 `logs`，服务端那条
 * 路由负责的是**首次载入历史**。
 *
 * ## 五个设计判断（这一版新增）
 *
 * 1. **五类徽标**。收发的、模型的、工具的、节奏的、出错的各一种底色。
 *    颜色只是扫描辅助，词才是语义——所以是「收发」不是「收」。
 * 2. **四列网格**。时间 / 徽标 / 角色 / 叙述各占一列。用网格而不是行内流，
 *    是因为读者查「她什么时候开始想的」时沿的是一条直边，不是一条锯齿边。
 * 3. **按轮分组**。组头写「第 N 轮 · 时间 · 几条」。分组只认轮次自己声明的
 *    边界：`round` 为 0 的条目不给组头，硬造一个「第 0 轮」是界面在编。
 * 4. **正文默认折叠**。收到的话、她想的过程、她说的话各一个 `<details>`，
 *    带字数。折叠是为了列表可扫，存在是为了不必切到对话就能看见原文。
 * 5. **跟随尾巴**。在底部时新条目自动滚入视野；一旦往上翻就不抢。
 *    不会跟随的日志，是没人读的日志。
 *
 * ## 时长为什么只在工具行出现
 *
 * 回复与轮次的时长已经写进句子里（「想完了，用了 1.2 秒」），行尾再挂一个
 * 数字就是把同一件事说两遍。工具没有那样的句子，所以独立时长只属于它。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconRefresh } from './icons.ts'
import { getChannelLogs, getSystemLogs, type SystemLogRow } from '../lib/api.ts'
import { groupRounds, projectLog, ACTOR_LABEL, CATEGORY_LABEL, LEVEL_LABEL } from '../lib/logModel.ts'
import { isUsableStamp } from '../lib/time.ts'
import type { LogEntry } from '../lib/types.ts'

/** 只保留最近多少条会话日志。再多也没有人往下翻，而渲染几千行会卡。 */
const SESSION_LIMIT = 200

/**
 * 距底部多少像素之内算「还在跟着」。
 *
 * 48 是两行多一点：轻微上滑看上一行时仍算跟随，真的往上翻了才停。
 */
const STICK_THRESHOLD_PX = 48

/**
 * 时钟写法 `HH:mm:ss`。日志是同一小时内的高频事件，日期在这里是噪声。
 *
 * 时间不可用时返回 `—`（破折号）而不是 `NaN:NaN:NaN`：日志条目的 `at`
 * 来自宿主，老数据可能没有这个字段。用破折号与同一列里其他「无时间」
 * 的行保持同形，用户一眼就知道是「这条没记时间」，而不是软件坏了。
 */
function clockOf(at: number): string {
  if (!isUsableStamp(at)) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * `<time datetime>` 的值，或空对象（不渲染该属性）。
 *
 * ## 为什么不能就地写 `new Date(at).toISOString()`
 *
 * 那是我上一版留下的真实缺陷：守卫写的是 `row.at > 0`，而 `1.7e18`
 * （纳秒时间戳）与 `Infinity` 都 `> 0`，于是守卫放行，`toISOString()`
 * **抛 RangeError**。这不是显示一串 NaN，是渲染期抛错——整棵子树会被
 * React 卸掉，用户看到白屏。`> 0` 只挡住负数与 0，挡不住「有限但越界」。
 *
 * 返回空对象而不是空串：`dateTime=""` 在语义上是「时间是空字符串」，
 * 读屏会念出一个空的日期；不渲染这个属性才是「没有机器可读的时间」。
 */
function isoStamp(at: number): { dateTime: string } | Record<string, never> {
  if (!isUsableStamp(at)) return {}
  return { dateTime: new Date(at).toISOString() }
}

/** 正文体积的写法。一个中文字算一个字，与「多少字」的直觉一致。 */
function charsOf(text: string): number {
  return [...text].length
}

export interface LogDrawerProps {
  /** 当前会话 id。空串或 undefined 时会话日志区显示空态。 */
  sessionId: string | undefined
  /** 当前会话日志。含本轮实时写入的条目，按时间升序。 */
  logs: LogEntry[]
}

/**
 * 找一个元素真正在滚的那个祖先。
 *
 * 日志自己不滚：它长在 `.drawer__body` 里，滚动条属于抽屉。跟随尾巴必须
 * 作用在真正的滚动容器上，作用在自己身上等于什么都没做。
 *
 * @param node 起点元素。
 * @returns 最近的滚动祖先；找不到时返回 null（由调用方退回视口语义）。
 */
function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null
  while (current !== null) {
    const { overflowY } = globalThis.getComputedStyle(current)
    if (overflowY === 'auto' || overflowY === 'scroll') return current
    current = current.parentElement
  }
  return null
}

/**
 * 渲染日志抽屉。
 *
 * ## 为什么两个远端分区在挂载时一次拉完
 *
 * 它们都读宿主内存，代价是一次进程内调用。分两次按需加载只会让用户先看到
 * 一个「加载中」再看到内容——而这一屏的内容本来就很短。
 */
export function LogDrawer({ sessionId, logs }: LogDrawerProps): React.JSX.Element {
  const [channelNote, setChannelNote] = useState<string | undefined>(undefined)
  const [system, setSystem] = useState<SystemLogRow[]>([])
  const [fault, setFault] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [channel, systemLog] = await Promise.all([getChannelLogs(), getSystemLogs(SESSION_LIMIT)])
      /* 通道日志区只看 `note`：本版本没有通道，`items` 恒为空。 */
      setChannelNote(channel.note)
      setSystem(systemLog)
      setFault(undefined)
    } catch (caught) {
      /* 与「没有日志」分开报：读不到时给一个明确原因，而不是让三个区都空着。 */
      setFault(caught instanceof Error ? caught.message : '读不到系统日志')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 最近 N 条，保持时间升序：日志是从上往下读的，最新的在最后。 */
  const recent = useMemo(() => logs.slice(-SESSION_LIMIT), [logs])
  const rows = useMemo(() => projectLog(recent), [recent])
  const groups = useMemo(() => groupRounds(rows), [rows])

  const tail = useRef<HTMLDivElement | null>(null)
  /** 是否还在跟着尾巴。往上翻之后置 false，翻回底部再置 true。 */
  const following = useRef(true)

  /*
   * 记录「用户往上翻了」。
   *
   * 监听挂在真正的滚动祖先上，而不是这个组件的根节点：日志自己不滚。
   * 挂错地方的表现是「不管翻到哪都会自动跳回底部」，比不跟随更烦人。
   */
  useEffect(() => {
    const scroller = scrollParentOf(tail.current)
    /* v8 ignore next -- 抽屉结构固定存在滚动祖先；这里只是防挂载顺序变化。 */
    if (scroller === null) return
    const onScroll = (): void => {
      following.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD_PX
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => { scroller.removeEventListener('scroll', onScroll) }
  }, [])

  /*
   * 新条目落下时滚到底。
   *
   * 用 `scrollIntoView` 而不是估算 `scrollTop`：滚动容器可能是抽屉，也可能是
   * 将来某个把日志放进主列的形态，交给浏览器逐层处理才不用在这里写死一层。
   */
  useEffect(() => {
    if (!following.current) return
    tail.current?.scrollIntoView({ block: 'end', inline: 'nearest' })
  }, [groups.length])

  const empty = sessionId === undefined || sessionId === ''

  return (
    <div className="logp">
      {/* --- 会话日志 --------------------------------------------- */}
      <section className="logp__section">
        <header className="logp__head">
          <h3 className="logp__title">会话日志</h3>
          <span className="logp__count">{String(logs.length)}</span>
        </header>

        {empty ? (
          <p className="logp__empty">暂无会话</p>
        ) : groups.length === 0 ? (
          <p className="logp__empty">本轮暂无记录</p>
        ) : (
          <div className="logp__rows">
            {groups.map((group) => (
              <section key={group.key} className="logp__group">
                {group.round === 0 ? null : (
                  <h4 className="logp__group-head">
                    <span className="logp__group-label">第 {group.round} 轮</span>
                    <span className="logp__group-time">{clockOf(group.at)}</span>
                    <span className="logp__group-count">{group.rows.length} 条</span>
                  </h4>
                )}
                {group.rows.map((row) => (
                  <div key={row.id} className="logp__row" data-category={row.category} data-actor={row.actor}>
                    <time
                      className="logp__time"
                      {...isoStamp(row.at)}
                    >
                      {row.at > 0 ? clockOf(row.at) : '—'}
                    </time>
                    <span className="logp__badge" data-category={row.category}>
                      {CATEGORY_LABEL[row.category]}
                    </span>
                    <span className="logp__actor" data-actor={row.actor}>{ACTOR_LABEL[row.actor]}</span>
                    <span className="logp__text">
                      {row.text}
                      {row.duration === null ? null : <span className="logp__duration">{row.duration}</span>}
                    </span>
                    {row.body === null ? null : (
                      <details className="logp__detail">
                        <summary className="logp__more">
                          {row.bodyLabel ?? '看原文'}
                          <span className="logp__body-size">{charsOf(row.body)} 字</span>
                        </summary>
                        <p className="logp__body">{row.body}</p>
                      </details>
                    )}
                  </div>
                ))}
              </section>
            ))}
            {/* 跟随锚点：放在最后，高度 0，不参与视觉。 */}
            <div ref={tail} className="logp__tail" aria-hidden="true" />
          </div>
        )}
      </section>

      {/* --- 通道日志 --------------------------------------------- */}
      <section className="logp__section">
        <header className="logp__head">
          <h3 className="logp__title">通道日志</h3>
          <span className="logp__count">0</span>
        </header>
        {/*
          空态必须说清「没有通道接入」，而不是「暂无记录」。
          后者会被读成「通道在，只是最近没消息」，而实际上这一整条链路
          在本版本不存在（八个适配器已删除）。
        */}
        <p className="logp__empty">{channelNote ?? '无通道接入'}</p>
      </section>

      {/* --- 系统日志 --------------------------------------------- */}
      <section className="logp__section">
        <header className="logp__head">
          <h3 className="logp__title">系统日志</h3>
          <button
            type="button"
            className="logp__refresh"
            aria-label="刷新系统日志"
            disabled={loading}
            onClick={() => { void load() }}
          >
            <Icon icon={IconRefresh} size={16} />
          </button>
        </header>
        {fault !== undefined ? (
          <p className="logp__empty">{fault}</p>
        ) : loading ? (
          <p className="logp__empty">正在读取</p>
        ) : system.length === 0 ? (
          <p className="logp__empty">本次启动暂无记录</p>
        ) : (
          <div className="logp__rows">
            {/* 系统日志按时间升序给，这里倒序：最近发生的事在最上面。 */}
            {[...system].reverse().map((row) => (
              <div key={row.id} className="logp__row logp__row--system" data-level={row.level}>
                <time className="logp__time" {...isoStamp(row.at)}>
                  {row.at > 0 ? clockOf(row.at) : '—'}
                </time>
                <span className="logp__dot" data-level={row.level} aria-hidden="true" />
                {LEVEL_LABEL[row.level] === '' ? null : (
                  <span className="logp__level" data-level={row.level}>{LEVEL_LABEL[row.level]}</span>
                )}
                <span className="logp__text">{row.text}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
