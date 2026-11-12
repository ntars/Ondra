/**
 * 离开与归来（§12.9 的后两条）。
 *
 * ## 它回答什么
 *
 * 「刚才这段空白，算不算离开？」
 *
 * ```
 * 窗口失焦 → 记下时刻 → 回来时算差值 → 超过 10 分钟就在时间轴底部插一行灰字
 * ```
 *
 * ## 为什么是「一行灰字」而不是一条系统消息
 *
 * §12.9 原文是「在时间轴当前底部插入一行 11px 灰字」。它不是消息：
 * 不落盘、不进历史、不参与复制、不触发她的回应。它只服务一个瞬间——
 * 用户离开很久后回来，需要知道「刚才这里没有人，别以为漏看了什么」。
 *
 * 若做成消息，重开会话时会看到十几条「你离开了 23 分钟」，
 * 那串记录只说明了用户离开了多少次，与他无关。
 *
 * ## 两个阈值，别混成一个
 *
 * | 阈值 | 用途 |
 * | --- | --- |
 * | 10 分钟 | 够不够长，值不值得说一句 |
 * | 1 分钟 | 太短，连「离开」都不算——切个窗口不该留痕 |
 *
 * 后者不加会出现：点开设置再切回来，时间轴上多一行「你离开了 1 分钟」。
 * 那不是提示，是噪声。所以真正的判据是 `> 10 分钟`，中间那段什么都不做。
 */

/**
 * 离开多久才值当说一句（§12.9 原值）。
 *
 * 10 分钟是一条分界：短于它，用户自己知道刚去干了什么；长于它，
 * 他会真的失去上下文——最后一句是她说的还是自己说的都想不起来了。
 */
export const ABSENCE_HINT_MS = 10 * 60 * 1000

/**
 * 把一段离开时长说成人话。
 *
 * ## 三档的理由
 *
 * | 时长 | 说法 | 为什么 |
 * | --- | --- | --- |
 * | < 1 小时 | `23 分钟` | 分钟是他能对上号的数量级 |
 * | < 1 天 | `2 小时`（不足整时补分钟） | 「140 分钟」没人换算得过来 |
 * | ≥ 1 天 | `3 天` | 跨天之后小时数没有意义 |
 *
 * 取整一律**向下**：说「你离开了 2 小时」时用户可能离开了 2 小时 59 分，
 * 向下取整不会让他觉得这句话在夸张。四舍五入到 3 小时会让他想
 * 「哪有那么久」。
 *
 * @param ms 离开时长（毫秒）。
 */
export function absenceText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.floor(ms / 60_000)
  // 不足一分钟不该走到这里（调用方已按 10 分钟阈值拦过），
  // 但兜一句总比返回「你离开了 0 分钟」好。
  if (minutes < 1) return '离开片刻'
  if (minutes < 60) return `离开 ${String(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0
      ? `离开 ${String(hours)} 小时`
      : `离开 ${String(hours)} 小时 ${String(rest)} 分`
  }
  const days = Math.floor(hours / 24)
  return `离开 ${String(days)} 天`
}

/**
 * 判断一次「离开 → 归来」是否该留一行。
 *
 * @param leftAt 离开时刻。`0` 表示没有记录（首次挂载、刚回来过）。
 * @param now 归来时刻。
 * @returns 该显示的那句话；不该显示时返回 `undefined`。
 */
export function absenceHint(leftAt: number, now: number): string | undefined {
  if (leftAt <= 0) return undefined
  const gap = now - leftAt
  // 时钟回拨（用户手动改系统时间、跨时区飞行）会算出负数。
  // 那时任何结论都不可信，一律不留痕。
  if (gap <= ABSENCE_HINT_MS) return undefined
  return absenceText(gap)
}
