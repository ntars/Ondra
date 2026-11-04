/**
 * 工具输出沙箱：**进上下文之前先压一遍**。
 *
 * 手册第九部分 §3-1 逐字点名：「工具输出沙箱化 —— 315KB→5.4KB，
 * Ondra 的 `desktop-mcp`/`adb`/`vision` 全部走沙箱」。
 * 所以这不是「顺手加个截断」，而是本包的**架构级职责**：原始读数不进上下文。
 *
 * ## 为什么是「跳过继续试」而不是「截到第 N 条」
 *
 * 与 O-036 的装箱制同口径：一行太长装不下就跳过它、继续试下一行。
 * 「截到第 N 条」在一条超长行上会直接把后面所有短行一起丢掉，
 * 用户看到的是「只有一条」，而真相是「第 2 条太长」。
 *
 * ## 为什么必须报 `omitted`
 *
 * 只给裁剪后的正文、不说裁了多少，模型会把「我看到 12 条」当成「一共 12 条」。
 * 段尾那句「另有 N 条未展开」是让它知道自己**没看全**的唯一手段。
 */

import { RENDER_CHARS_MAX, RENDER_LINES_MAX } from './types.js'

/** 渲染结果。 */
export interface RenderResult {
  /** 模型可见正文。 */
  readonly text: string
  /** 被裁掉的条数。 */
  readonly omitted: number
  /** 是否发生过裁剪。 */
  readonly degraded: boolean
}

/**
 * 把若干行压进预算。
 * @param lines 原始行（顺序即重要度，重要的放前面）。
 */
export function renderLines(lines: readonly string[]): RenderResult {
  const kept: string[] = []
  let chars = 0
  let omitted = 0

  for (const line of lines) {
    if (kept.length >= RENDER_LINES_MAX) {
      omitted += 1
      continue
    }
    // +1 是换行符的预算；不把它算进去，最后一行会刚好超一个字符。
    const cost = line.length + 1
    if (chars + cost > RENDER_CHARS_MAX) {
      omitted += 1
      continue
    }
    kept.push(line)
    chars += cost
  }

  const body = kept.join('\n')
  const text = omitted > 0 ? `${body}\n（另有 ${omitted} 条未展开）` : body
  return Object.freeze({ text, omitted, degraded: omitted > 0 })
}
