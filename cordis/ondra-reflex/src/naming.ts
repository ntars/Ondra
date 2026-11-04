/**
 * 命名 —— **纯函数**。这里处理的是本包唯一一个「规范自相矛盾」的地方。
 *
 * ## `R-auto-…` 过不了 §8.4，两个都得留
 *
 * 手册 §8.6 逐字要求反射叫 `R-auto-<cause>-<tool>`；
 * 手册 §8.4 又要求键名匹配 `^[a-z][a-z0-9_-]{1,63}$`。
 * 大写开头这两条直接冲突，没有第三种解法：只能两个名字并存，各归其位。
 *
 * - `id`（展示用）保留手册原样，大小写与连字符都不动；
 * - `key`（当键用）小写 + 归一化，长度封顶 63。
 *
 * ## 下划线要留着，别一起归一成连字符
 *
 * 八类归因码本身带下划线（`arg_error` / `tool_missing` / `not_found`）。
 * 若把下划线也归一成连字符，`r-auto-arg_error-read` 就会变成
 * `r-auto-arg-error-read-xxxx`——**每条反射都会长出一个指纹尾巴**，
 * 于是「归一化有没有动过字符」这个信号永远为真，也就等于没有信号。
 * `§8.4` 的字符类本来就是 `[a-z0-9_-]`，下划线合法，所以留着。
 *
 * ## 归一化仍会撞号，撞了就加指纹
 *
 * `mcp__fs.read` 与 `mcp__fs-read` 归一化后都是 `mcp__fs-read`（点号换成连字符），
 * 两个不同工具就共用一个 key 了。所以只要**归一化真的改了字符**，就在尾巴上补 4 位指纹。
 * 没改的（绝大多数工具名）保持干净，不加噪音。
 *
 * 长度封顶也是一样：截断会让 `terminal_run_read` 与 `terminal_run_write` 撞在同一个前缀上，
 * 所以截断同样触发指纹后缀——宁可名字丑，不可两条规则互相覆盖。
 */

import { createHash } from 'node:crypto'
import { KEY_RE, REFLEX_KEY_PREFIX, REFLEX_PREFIX } from './types.js'

/** key 的总长度上限（手册 §8.4）。 */
const KEY_MAX = 63

/**
 * 取一段十六进制指纹。
 * @param text 原文。
 * @param length 取几位。
 */
export function hashOf(text: string, length: number): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, length)
}

/**
 * 归一化成 `[a-z0-9_-]`：字母、数字、下划线原样留；其余字符（点、空格、标点、中文）
 * 折成一条连字符；连续连字符合成一条，首尾不留连字符。
 *
 * 三条取舍：
 * - **下划线不折**（见文件头：八类归因码带下划线，折了就让每条键都长尾巴）；
 * - **连字符不叠**：`a---b` 与 `a-b` 归一后必须一样，否则同一条规则能长出两个键；
 * - **非 ASCII 一律弃**（中文工具名归一后为空），由调用方回退成 `tool` / `unknown`。
 * @param text 原文。
 * @param max 长度上限。
 */
export function slugOf(text: string, max: number): string {
  let out = ''
  for (const raw of text.toLowerCase()) {
    const code = raw.codePointAt(0) ?? 0
    const isAlpha = code >= 97 && code <= 122
    const isDigit = code >= 48 && code <= 57
    if (isAlpha || isDigit || code === 95) {
      out += raw
      continue
    }
    if (out.length > 0 && !out.endsWith('-')) out += '-'
  }
  if (out.length > max) out = out.slice(0, max)
  while (out.endsWith('-')) out = out.slice(0, -1)
  return out
}

/**
 * 手册逐字的展示 id：`R-auto-<cause>-<tool>`。
 * @param cause 归因（来自 O-139）。
 * @param tool 工具名（原样）。
 */
export function reflexIdOf(cause: string, tool: string): string {
  return `${REFLEX_PREFIX}${cause}-${tool}`
}

/**
 * 当键用的名字：小写、归一化、封顶 63、必要时补指纹。
 * @param cause 归因。
 * @param tool 工具名。
 */
export function reflexKeyOf(cause: string, tool: string): string {
  const causeSlug = slugOf(cause, 16) || 'unknown'
  let toolSlug = slugOf(tool, 40) || 'tool'
  const causeChanged = causeSlug !== cause.toLowerCase()
  const toolChanged = toolSlug !== tool.toLowerCase()

  // 空名也补指纹：它会被回退成 `tool` / `unknown`，而真的叫 `tool` 的工具是另一条规则，
  // 两者不能同键。代价只是一个用不到的名字多四位，收益是「回退名」不会吃掉真名。
  const suffix = `${toolChanged ? `-${hashOf(tool, 4)}` : ''}${causeChanged ? `-${hashOf(cause, 4)}` : ''}`
  const budget = KEY_MAX - REFLEX_KEY_PREFIX.length - causeSlug.length - 1 - suffix.length
  if (toolSlug.length > budget) {
    toolSlug = slugOf(toolSlug, Math.max(1, budget))
    // 截断也会造成撞号：换了长度就意味着可能有两段前缀相同，补指纹。
    return `${REFLEX_KEY_PREFIX}${causeSlug}-${toolSlug}-${hashOf(tool, 4)}`.slice(0, KEY_MAX)
  }
  return `${REFLEX_KEY_PREFIX}${causeSlug}-${toolSlug}${suffix}`
}

/**
 * key 是否合法（`^[a-z][a-z0-9_-]{1,63}$`）。
 * @param key 待验键名。
 */
export function keyOfSafe(key: string): boolean {
  return KEY_RE.test(key)
}

/**
 * key 是否与 id 只差大小写。`false` 说明归一化动过字符，已经补了指纹后缀。
 * @param id 展示 id。
 * @param key 键名。
 */
export function keyIsPlain(id: string, key: string): boolean {
  return key === id.toLowerCase()
}

/**
 * 链签名：工具名按顺序用 `>` 连起来，只取前 `max` 步。
 *
 * 取前 N 步而不是全部，是因为长链的尾巴特别容易漂（多调一次 grep 就变一条新链），
 * 而「前五步怎么走」才是这条链的身份。
 * @param tools 工具序列。
 * @param max 最多取几步。
 */
export function signatureOf(tools: readonly string[], max: number): string {
  return tools.slice(0, max).join('>')
}

/**
 * 候选名：`chain-<8 位指纹>`。过 §8.4，且与序列一一对应。
 * @param signature 链签名。
 */
export function candidateSlugOf(signature: string): string {
  return `chain-${hashOf(signature, 8)}`
}
