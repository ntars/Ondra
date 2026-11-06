/**
 * 中栏的第二种读法：运行日志。
 *
 * ## 定位
 *
 * 「对话」显示她说了什么；这里显示她**为了说出那些话做了什么**。
 * 每一行都是一句白话：收到一条消息、开始思考、动手改一个文件、
 * 说完了、这一轮结束。读者不需要知道什么是 API、什么是 token。
 *
 * ## 为什么不用左栏那个日志组件
 *
 * 左栏宽度只有 205px，放不下"时间 / 类别 / 谁 / 内容"这四列；
 * 那里用的是竖向时间轴的紧凑写法。中栏有 400px 以上，四列能一次读完，
 * 扫视效率高得多。两处读的是同一份 `logs`，只是排版不同。
 *
 * ## 和其他视图的关系
 *
 * 侧栏的「对话 / 日志」分段控件与这里的标签是同一份状态的两处入口。
 * 谁点都一样，因为它们写的是同一个 `view`。
 */

import type { LogChannel, LogEntry } from './Sidebar.tsx'

/** 组件的属性。 */
export interface LogViewProps {
  logs: LogEntry[]
}

/** 五类日志的中文名。键与 `LogChannel` 一一对应。 */
const CHANNEL_LABEL: Record<LogChannel, string> = {
  rhythm: '节律',
  channel: '通道',
  model: '模型',
  tool: '工具',
  error: '异常',
}

/** 三种角色的中文名。 */
const ACTOR_LABEL: Record<LogEntry['actor'], string> = {
  system: '系统',
  user: '你',
  assistant: '她',
}

/**
 * 把时间戳格成 `HH:MM:SS`。
 *
 * 不用 `toLocaleTimeString`：它可能给出 `02:46:51` 也可能给出 `2:46:51`，
 * 宽度一变整列时间就参差。手拼能保证恒定 8 个字符宽。
 */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 把毫秒压成人读的时长。
 *
 * 只处理秒量级：日志里的耗时是让人感觉快慢的，精确到毫秒反而干扰阅读。
 * 不足一秒保留一位小数，让人能分清"0.3 秒"和"0.9 秒"这两种体感。
 */
function durationOf(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  if (seconds < 60) return `${String(Math.round(seconds))} 秒`
  const minutes = seconds / 60
  if (minutes < 10) return `${minutes.toFixed(1)} 分钟`
  return `${String(Math.round(minutes))} 分钟`
}

/**
 * 把日志按轮次分组。
 *
 * 组内按时间正序（先发生的在上），组间按轮次倒序（最新一轮在最上）。
 * 打开日志的人想看的永远是刚才那一轮。
 */
function groupByRound(
  logs: LogEntry[],
): Array<{ round: number; at: number; entries: LogEntry[] }> {
  const buckets = new Map<number, LogEntry[]>()
  for (const entry of logs) {
    const bucket = buckets.get(entry.round)
    if (bucket === undefined) buckets.set(entry.round, [entry])
    else bucket.push(entry)
  }
  return [...buckets.entries()]
    .map(([round, entries]) => ({
      round,
      // 组头时刻取组内最早的一条：那才是这一轮真正开始的时间。
      at: entries.reduce(
        (min, entry) => (entry.at < min ? entry.at : min),
        entries[0]?.at ?? Date.now(),
      ),
      entries,
    }))
    .sort((left, right) => right.round - left.round)
}

/** 渲染运行日志。 */
export function LogView({ logs }: LogViewProps): React.JSX.Element {
  const groups = groupByRound(logs)

  return (
    <div className="log">
      <div className="log__rows" role="log" aria-label="运行日志">
        {groups.length === 0 ? (
          // 空状态的两句文案取自旧版：第一句说"没有记录"，
          // 第二句说"怎么才会有"。只给第一句会让人以为日志坏了。
          <div className="log__empty">
            <p className="log__emptyTitle">还没有动静</p>
            <p className="log__emptyHint">等她收到第一条消息，这里会记下她做了什么。</p>
          </div>
        ) : (
          groups.map((group, index) => (
            <section key={group.round} className="log__group">
              <h3 className="log__groupHead">
                <span className="log__groupLabel">第 {group.round} 轮</span>
                <span className="log__groupTime">{clockOf(group.at)}</span>
                <span className="log__groupCount">{group.entries.length} 条</span>
              </h3>

              {group.entries.map((entry) => (
                <div key={entry.id} className="log__row">
                  <time className="log__time" dateTime={new Date(entry.at).toISOString()}>
                    {clockOf(entry.at)}
                  </time>

                  <span className={`log__badge log__badge--${entry.channel}`}>
                    {CHANNEL_LABEL[entry.channel]}
                  </span>

                  <span className={`log__sender log__sender--${entry.actor}`}>
                    {ACTOR_LABEL[entry.actor]}
                  </span>

                  <span className="log__text">
                    {entry.summary}
                    {entry.ms === undefined ? null : (
                      <span className="log__duration">{durationOf(entry.ms)}</span>
                    )}
                  </span>

                  {/* 有完整内容时才给展开区。用原生 details，
                      展开状态与键盘可达性都由浏览器负责，不必自己补 ARIA。 */}
                  {entry.detail === undefined ? null : (
                    <details className="log__body">
                      <summary className="log__bodySummary">
                        完整内容
                        <span className="log__bodySize">{entry.detail.length} 字</span>
                      </summary>
                      <p className="log__bodyText selectable">{entry.detail}</p>
                    </details>
                  )}
                </div>
              ))}

              {/* 最后一组后面不画线：它下面是列表底部，再加一条线会像页码。 */}
              {index === groups.length - 1 ? null : (
                <div className="log__divider" aria-hidden />
              )}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
