/**
 * O-138 的**取词**：把本轮用户消息里的文字捞出来，喂给规则表。
 *
 * ## 为什么只取 `text` 块
 *
 * 用户消息的 `content` 是块数组（`text` / `image` / `file` / …）。
 * 图片与文件对意图判断不是没用，但**从图片里读意图等于调用视觉模型**，
 * 而本包的立身之本就是「零模型调用、每个决定可解释」。所以：
 * 只读 `text`，其余块一律忽略，且忽略这件事本身会被记下来（`blocks` 计数）。
 *
 * ## 为什么要截断
 *
 * 规则表是子串匹配，正文越长，误命中的概率越高（一篇长文里必然出现「文件」「代码」）。
 * 所以只看**开头 `maxChars` 个字**——用户提要求时，意图通常在头一两句。
 * 截断不改变「没命中就不门控」这条兜底：宁可多花 token。
 */

/** 一次取词的结果。 */
export interface IntentText {
  /** 拼好的正文（已小写前的原文）。 */
  readonly text: string
  /** 原文总码位数（截断前）。 */
  readonly chars: number
  /** 读到的文本块数。 */
  readonly blocks: number
  /** 被忽略的非文本块数（图片、文件…）。 */
  readonly ignoredBlocks: number
  /** 是否被截断。 */
  readonly truncated: boolean
}

/** 单个块的最小形状。 */
interface BlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

/**
 * 从一个消息数组里取文字。
 * @param messages 消息数组（形状未知，逐层判空）。
 * @param maxChars 最多取多少码位。
 */
export function textOfMessages(messages: readonly unknown[], maxChars: number): IntentText {
  const parts: string[] = []
  let blocks = 0
  let ignoredBlocks = 0
  let total = 0

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const content = (message as { readonly content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      if (typeof raw !== 'object' || raw === null) continue
      const block = raw as BlockLike
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text
        blocks += 1
        total += text.length
        if (text !== '') parts.push(text)
      } else {
        ignoredBlocks += 1
      }
    }
  }

  const joined = parts.join('\n')
  if (joined.length <= maxChars) {
    return Object.freeze({ text: joined, chars: total, blocks, ignoredBlocks, truncated: false })
  }
  // 按码位切，不按 UTF-16 单元切：emoji 与生僻字被切成半个会变成乱码。
  const cut = Array.from(joined).slice(0, maxChars).join('')
  return Object.freeze({ text: cut, chars: total, blocks, ignoredBlocks, truncated: true })
}

/**
 * 取一句摘录，只进报告与日志。
 * @param text 正文。
 * @param maxChars 最多多少码位。
 */
export function excerptOf(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  if (chars.length <= maxChars) return flat
  return chars.slice(0, maxChars).join('') + '…'
}
