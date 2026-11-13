/**
 * Date 能表示的最大毫秒数。
 *
 * 就是 `new Date(8.64e15)` 仍然有效、`8.64e15 + 1` 变成 Invalid Date 的那条线。
 * 写成字面量而不是 `new Date(8640000000000000).getTime()`：后者在有些
 * 引擎里会先过一次时区换算，得到的值不稳。
 *
 * 必须声明在 `isUsableStamp` 之前：函数体里引用模块级 `const` 走的是
 * 词法作用域，声明写在后面虽然多数时候能跑（调用发生在模块求值之后），
 * 但一旦有人在模块初始化阶段就调一次，就会撞上暂时性死区。
 */
const MAX_STAMP = 8_640_000_000_000_000

/**
 * 时间戳是否可用。
 *
 * ## 为什么必须是「范围」而不只是「非数」
 *
 * 只判 `Number.isFinite` 会漏掉**能通过有限性检查、但超出 Date 表示范围**
 * 的值。`Date` 只覆盖 ±8.64e15 毫秒（约 ±27 万年），越界时 `new Date(x)`
 * **不抛错**，仍旧给一个 Invalid Date，`getFullYear()` 返回 `NaN`。
 *
 * 这不是假想的输入：纳秒时间戳（`1.7e18`）是宿主侧最常见的量纲错位——
 * 有人按 `Date.now() * 1e6` 存了一次，读回来 `Number.isFinite` 为真、
 * `> 0` 也为真，守卫全过，界面上照样直出 `NaN 年 NaN 月 NaN 日`。
 * 同理，`Infinity` 与「秒当成毫秒乘过头」都走这条缝。
 *
 * 更狠的是 `toISOString()`：它对这个值**会抛 RangeError**。渲染期抛错会
 * 把整棵子树炸掉，比显示一串 NaN 严重得多——白屏与「这条没记时间」
 * 是两种量级的故障。
 *
 * `<= 0` 也算不可用：`0` 是「1970 年 1 月 1 日」，对一条聊天消息而言
 * 与缺失等价，显示出来只是把噪声换了个长相。
 *
 * ## 为什么放在这里
 *
 * 这条判断原本在 `Timeline.tsx` 里是私有函数，`LogDrawer` / `SettingsBackup` /
 * `SessionStats` / `transfer` 各自又手写了一遍 `Number.isFinite(x) && x > 0`。
 * 五份同义判断没有一份带范围检查，于是同一个缺陷要在五个地方各修一次，
 * 且总有一处会被漏掉——`LogDrawer` 的 `dateTime` 就是漏掉的那一处。
 * 单一实现才能一次修全。
 */
export function isUsableStamp(ts: number | undefined | null): ts is number {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && ts <= MAX_STAMP
}

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
 *
 * ## 为什么先挡非数
 *
 * `now - undefined` 是 `NaN`，而 `NaN` 与任何数比大小都为假，于是六档
 * 全部落空，一路走到最后一行，拼出 `NaN 月 NaN 日`。这个值来自宿主，
 * 老数据没有时间字段时就是 `undefined`——类型上写着 `number`，运行时
 * 却不是。给一句「时间未知」比漏一个 `NaN` 诚实。
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  if (!isUsableStamp(ts)) return '时间未知'
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
