/**
 * 结果裁剪：把浏览器那边吐回来的东西压进上下文预算。
 *
 * 手册 §10.1 那个数字是这一层存在的理由：**Playwright 快照 315KB → 5.4KB（98%）**。
 * 同一节把它列为「工具输出沙箱」这项架构级前置，并点名 `desktop-mcp`/`adb`/`vision` 全走沙箱；
 * 浏览器快照是其中最大的一份。
 *
 * ## 为什么这里是「砍尾巴」而不是 O-070 的「跳过继续试」
 *
 * 两个插件的体裁不同：
 *
 * - O-070 的进程列表、文件命中是**互相独立的条目**，跳过一条不影响其余；
 * - 浏览器的可访问性快照是**一棵树**，中间挖掉几行会让缩进与父子关系错位，
 *   模型会照着错的层级去点元素。所以整棵树只保留头部，并在结尾明说「已裁剪」。
 *
 * 判据不是「哪种算法更好」，而是**数据本身有没有结构**。有结构就不能抽条。
 *
 * ## 为什么必须写出「原有多大」
 *
 * 只给裁剪后的正文，模型会把「我看到 80 行」当成「页面只有 80 行」。
 * 那一句 `已裁剪：原 51234 字符 / 812 行` 是它知道自己没看全的唯一手段，
 * 也是它决定「要不要用更具体的选择器再快照一次」的依据。
 *
 * ## 预算的口径
 *
 * - 字符预算把**尾注本身**也算进去（所以正文实际可用 `budget − 尾注长度`）；
 * - 行预算只数正文行，尾注那一行不计入——否则预算取 1 时会出现「一行正文都留不下、只剩尾注」。
 */

import type { TrimKind, TrimResult } from './types.js'

/**
 * 裁一段文本。
 * @param text 原文。
 * @param kind 体裁（快照按行、普通文本按字符）。
 * @param budgetChars 字符预算。
 * @param budgetLines 行预算。
 */
export function trimText(text: string, kind: TrimKind, budgetChars: number, budgetLines: number): TrimResult {
  const before = text.length
  const lines = text.split('\n')
  const totalLines = lines.length

  if (before <= budgetChars && totalLines <= budgetLines) {
    return Object.freeze({ text, before, after: before, trimmed: false, droppedLines: 0 })
  }

  const footer = `\n…（已裁剪：原 ${before} 字符 / ${totalLines} 行，下面没展开）`
  const room = Math.max(0, budgetChars - footer.length)

  if (kind === 'snapshot') {
    // 树结构：只留头部整行，绝不从中间抽条。
    const kept: string[] = []
    let chars = 0
    for (const line of lines) {
      if (kept.length >= budgetLines) break
      const cost = line.length + 1
      if (chars + cost > room) break
      kept.push(line)
      chars += cost
    }
    const body = kept.join('\n')
    const out = `${body}${footer}`
    return Object.freeze({
      text: out,
      before,
      after: out.length,
      trimmed: true,
      droppedLines: Math.max(0, totalLines - kept.length),
    })
  }

  // 普通文本：按字符切，不关心行边界。
  const body = text.slice(0, room)
  const out = `${body}${footer}`
  const keptLines = body.split('\n').length
  return Object.freeze({
    text: out,
    before,
    after: out.length,
    trimmed: true,
    droppedLines: Math.max(0, totalLines - keptLines),
  })
}
