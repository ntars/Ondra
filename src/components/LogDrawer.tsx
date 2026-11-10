/**
 * 日志抽屉：三类分区。
 *
 * ## 三类的边界
 *
 * | 分区 | 是什么 | 数据来源 |
 * | --- | --- | --- |
 * | 会话日志 | 她这几轮做了什么：开始、收到、想了、说完 | `/api/logs/session` + 本轮实时条目 |
 * | 通道日志 | 外部 IM 接入（微信、飞书等）的收发记录 | `/api/logs/channel` |
 * | 系统日志 | 宿主自己的运行记录：插件装载、配置扫描、错误 | `/api/logs/system` |
 *
 * 三者混在一起读不出结论：会话日志是「对话过程」，系统日志是「程序状态」，
 * 而通道日志在本版本恒为空（八个适配器已随插件精简删除）。分区之后，
 * 「没有」也能被读成一句结论，而不是被当成一片空白。
 *
 * ## 会话日志为什么用传进来的，而不是自己拉
 *
 * 本轮正在发生的条目（「开始思考」「想完了 1.2 秒」）只存在于内存里：
 * 思考过程不落盘，服务端派生不出来。所以这一区直接渲染上层已经聚合好的
 * `logs`，服务端那条路由负责的是**首次载入历史**（见 `useAppState`）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconChevronRight, IconRefresh } from './icons.ts'
import { getChannelLogs, getSystemLogs, type SystemLogRow } from '../lib/api.ts'
import type { LogEntry } from '../lib/types.ts'

/** 只保留最近多少条会话日志。再多也没有人往下翻，而渲染几千行会卡。 */
const SESSION_LIMIT = 200

/** 时钟写法 `HH:mm:ss`。日志是同一小时内的高频事件，日期在这里是噪声。 */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 时长写法。与 `useAppState.formatSeconds` 同口径，避免两处数字说法不同。 */
function durationOf(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  if (seconds < 60) return `${String(Math.round(seconds))} 秒`
  return `${(seconds / 60).toFixed(1)} 分钟`
}

/** 会话日志里一条的徽标文字。 */
const BADGES: Record<LogEntry['channel'], string> = {
  rhythm: '轮',
  channel: '收',
  model: '她',
  tool: '具',
  error: '错',
}

export interface LogDrawerProps {
  /** 当前会话 id。空串或 undefined 时会话日志区显示空态。 */
  sessionId: string | undefined
  /** 当前会话日志。含本轮实时写入的条目，按时间升序。 */
  logs: LogEntry[]
}

/**
 * 渲染日志抽屉。
 *
 * ## 为什么两个远端分区在挂载时一次拉完
 *
 * 它们都要读宿主内存，代价是一次进程内调用。分两次按需加载只会让
 * 用户先看到一个「加载中」再看到内容——而这一屏的内容本来就很短。
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
      // 通道日志区只看 `note`：本版本没有通道，`items` 恒为空。
      setChannelNote(channel.note)
      setSystem(systemLog)
      setFault(undefined)
    } catch (caught) {
      // 与「没有日志」分开报：读不到时给一个明确原因，而不是让三个区都空着。
      setFault(caught instanceof Error ? caught.message : '读不到系统日志')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 会话日志只要最近 N 条，倒序显示——最新的一条就在最上面。 */
  const recent = logs.slice(-SESSION_LIMIT).reverse()

  return (
    <div className="logp">
      {/* --- 会话日志 --------------------------------------------- */}
      <section className="logp__section">
        <header className="logp__head">
          <h3 className="logp__title">会话日志</h3>
          <span className="logp__count">{String(logs.length)}</span>
        </header>
        {sessionId === undefined || sessionId === '' ? (
          <p className="logp__empty">还没有会话</p>
        ) : recent.length === 0 ? (
          <p className="logp__empty">这一轮还没留下记录</p>
        ) : (
          <ul className="logp__list">
            {recent.map((entry) => (
              <li key={entry.id} className="logp__item">
                <span className="logp__badge" data-channel={entry.channel}>{BADGES[entry.channel]}</span>
                <div className="logp__main">
                  <div className="logp__line">
                    <span className="logp__summary">{entry.summary}</span>
                    <span className="logp__time">{clockOf(entry.at)}</span>
                  </div>
                  {/*
                    字数与耗时并排放在第二行：它们是同一类读数（这次做了多少、
                    用了多久），放主行会把摘要挤掉。
                  */}
                  {entry.chars !== undefined || entry.ms !== undefined ? (
                    <div className="logp__meta">
                      {entry.chars !== undefined ? <span>{String(entry.chars)} 字</span> : null}
                      {entry.ms !== undefined ? <span>{durationOf(entry.ms)}</span> : null}
                    </div>
                  ) : null}
                  {entry.detail !== undefined && entry.detail !== '' ? (
                    /*
                     * 用原生 `details`：它自带键盘与读屏语义，比手写折叠少一处状态。
                     * 默认收起——日志正文可能很长，全展开会把后面几轮挤到屏外。
                     */
                    <details className="logp__detail">
                      <summary className="logp__more">
                        <Icon icon={IconChevronRight} size={16} />
                        看原文
                      </summary>
                      <p className="logp__text">{entry.detail}</p>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
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
          <p className="logp__empty">正在读</p>
        ) : system.length === 0 ? (
          <p className="logp__empty">这次启动还没有记录</p>
        ) : (
          <ul className="logp__list">
            {/* 系统日志按时间升序给，这里倒序：最近发生的事在最上面。 */}
            {[...system].reverse().map((row) => (
              <li key={row.id} className="logp__item logp__item--system">
                <span className="logp__dot" data-level={row.level} aria-hidden="true" />
                <div className="logp__main">
                  <div className="logp__line">
                    <span className="logp__summary">{row.text}</span>
                    <span className="logp__time">{clockOf(row.at)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
