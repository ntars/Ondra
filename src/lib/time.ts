/**
 * 相对时间的唯一实现。
 *
 * §12.6 定了六档：刚刚 / N 分钟前 / 昨天 / N 天前 / 上个月 / 绝对日期。
 * 这里只服务列表类界面（会话、记忆），超过一周直接给日期——
 * 「3 周前」这种说法用户还得自己换算，不如给日期。
 *
 * 早先这段逻辑写在 `Drawer.tsx` 里，只给会话列表用；记忆面板接上真数据后
 * 也需要同一套措辞，便提到这里。两份实现会慢慢分叉，而「时间说法不一致」
 * 是两个列表并排出现时最先被看出来的毛病。
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
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
