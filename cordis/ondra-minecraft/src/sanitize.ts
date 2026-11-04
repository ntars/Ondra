/**
 * 文本整形：把要发出去的正文收成「协议放得下、对方读得懂」的形状。
 *
 * ## 为什么整形必须在本地做，不能等服务端拒
 *
 * Minecraft 的聊天包对字符串长度有硬限制。超长时服务端**不是报错，是直接断开连接**——
 * 用户看到的是「她突然掉线」，日志里只有一条 `end`，没有任何「消息太长」的痕迹。
 * 所以长度必须在发之前卡住，且卡的方式要**截断**而不是「让它自己失败」。
 *
 * ## 整形做四件事（顺序固定）
 *
 * 1. **去控制字符**：`\u0000`–`\u001F` 与 `\u007F` 全去。协议会把它们当分隔符或直接拒绝。
 * 2. **折叠空白**：连续空白（含全角空格 `\u3000`）折成一个半角空格；首尾去空白。
 *    `§` 颜色码**不在这里处理**——那是她自己的表达，只在下方单独判。
 * 3. **去颜色码**：`§x` 两字符序列。玩家名字与聊天里它会被解析成样式，
 *    留着会让「她说了什么」在别人屏幕上变得不可读。
 * 4. **按码元截断**：到上限为止，且不切断代理对（emoji 被切成半个会变成乱码方块）。
 *
 * 第 4 步用**码元**而不是码点，是因为协议限的是码元（UTF-16）。这与 O-068 踩过的
 * 「Python 按码点、JS 按码元」是同一件事。
 */

import { CHAT_MAX } from './types.js'

/** 控制字符（含 DEL）。 */
const CONTROL_RE = /[\u0000-\u001F\u007F]/g

/** 连续空白（含全角空格、不换行空格）。 */
const SPACE_RE = /[\s\u3000\u00a0]+/g

/** 颜色码：`§` 后跟一个字符。 */
const COLOR_RE = /\u00a7./g

/**
 * 去掉颜色码。
 * @param text 文本。
 */
export function stripColors(text: string): string {
  return text.replace(COLOR_RE, '')
}

/**
 * 整形一段要发出去的正文。
 *
 * **不做**：不做敏感词过滤、不做表情替换、不做语气调整——那些归表达层（O-031/O-040/O-052）。
 * 本层只管「协议放得下」。
 *
 * @param text 原始文本。
 * @param max 上限（字符/码元）。
 */
export function sanitize(text: string, max: number): string {
  const limit = Math.min(CHAT_MAX, Math.max(1, Math.trunc(max)))
  const cleaned = stripColors(text.replace(CONTROL_RE, '').replace(SPACE_RE, ' ').trim())
  if (cleaned.length <= limit) return cleaned
  let cut = cleaned.slice(0, limit)
  // 若截断点落在代理对中间（高位在后、低位被砍掉），退一位。
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/**
 * 整形一条指令。
 *
 * 指令**只去控制字符与空白**，不折大小写、不剥颜色码（有些插件指令名区分大小写，
 * 而颜色码在指令里本来就非法——留着让闸门拒掉，比悄悄改掉更诚实）。
 * @param text 原始指令（可带 `/`）。
 * @param max 上限。
 */
export function sanitizeCommand(text: string, max: number): string {
  const limit = Math.max(1, Math.trunc(max))
  const cleaned = text.replace(CONTROL_RE, '').trim()
  return cleaned.length <= limit ? cleaned : cleaned.slice(0, limit)
}
