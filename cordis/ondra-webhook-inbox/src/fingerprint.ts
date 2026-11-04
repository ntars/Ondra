/**
 * 去重指纹与摘要压缩（纯函数，无 IO、无时钟、无配置读取）。
 *
 * ## 指纹怎么算
 *
 * `sha256(源 + 类型 + 排序后的关键字段)` → 取前 16 位十六进制。
 *
 * - **源与类型转小写**：`GitHub` 与 `github` 是同一个源，同一件事不该因为大小写重播。
 * - **关键字段排序后再拼**：`['A1','main']` 与 `['main','A1']` 必须是同一件事，
 *   否则调用方换个字段顺序就会绕过整个去重。
 * - **关键字段保留大小写**：宁可把两件事当成一件（漏播一次），也不要把一件事
 *   当成两件（半夜说两遍）。这是这条纪律唯一的偏向。
 * - **定长 16 位**：碰撞概率在「一个人一天几十条」这个量级下可以忽略；
 *   而指纹同时是条目 id，太长了日志与界面都难读。
 *
 * ## 为什么可以用哈希做去重
 *
 * 因为**哈希不可逆**。「按指纹去重」这件事因此不可能被拿来还原事件内容，
 * 也就不需要为去重单独存一份原文。这是「只存摘要与指纹」这条纪律能成立的技术前提。
 *
 * ## 摘要只压缩，不脱敏
 *
 * `summarize()` 折空白、截断、加省略号。它**不判断**摘要里有没有密钥、手机号、正文片段——
 * 判断不了，假装判断了反而更危险（会让人以为塞正文进去是安全的）。
 */

import { createHash } from 'node:crypto'

/** 拼哈希时的字段分隔符。用 `\u0000` 是因为它不可能出现在正常文本里，避免拼接歧义。 */
const FIELD_SEP = '\u0000'

/** 指纹长度（十六进制字符数）。 */
export const FINGERPRINT_LENGTH = 16

/**
 * 把空白折成单个空格并去首尾。
 * @param value 原文。
 */
export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 规整「源 / 类型」：折空白 + 转小写。
 * @param value 原文。
 */
export function normalizeToken(value: string): string {
  return collapse(value).toLowerCase()
}

/**
 * 规整一个关键字段值：只折空白，**保留大小写**。
 * @param value 原文。
 */
export function normalizeKeyValue(value: string): string {
  return collapse(value)
}

/**
 * 算指纹。**同一件事永远得到同一个指纹**（只要源、类型、关键字段一致）。
 * @param source 事件源。
 * @param type 事件类型。
 * @param keys 关键字段（顺序无关，空串会被丢掉）。
 * @returns 16 位十六进制指纹。
 */
export function fingerprintOf(source: string, type: string, keys: readonly string[] = []): string {
  const parts = [normalizeToken(source), normalizeToken(type)]
  const cleaned = keys.map(normalizeKeyValue).filter(item => item !== '').sort()
  for (const item of cleaned) parts.push(item)
  return createHash('sha256').update(parts.join(FIELD_SEP), 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH)
}

/**
 * 压缩摘要：折空白、按上限截断、超出加省略号。
 *
 * 截断点包含省略号在内不超过 `maxChars`——否则「上限 140」会变成「最多 141 个字符」，
 * 而那种差一在界面上表现为偶尔溢出半个字。
 * @param raw 原始摘要（可以是 `undefined` 或空串）。
 * @param maxChars 字符上限。
 * @returns 摘要；没有内容时为空串。
 */
export function summarize(raw: string | undefined, maxChars: number): string {
  if (raw === undefined) return ''
  const text = collapse(raw)
  if (text === '') return ''
  if (text.length <= maxChars) return text
  // 上限被夹到 20 以上（见 settings），所以这里不会出现负数下标。
  return text.slice(0, maxChars - 1) + '…'
}

/**
 * 判断一个字符串是不是「能用的事件源 / 类型」。
 * @param value 待判值。
 * @param limit 长度上限。
 */
export function isToken(value: unknown, limit: number): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return text !== '' && text.length <= limit
}

/**
 * 判断一个值是不是「关键字段数组」。
 * @param value 待判值。
 */
export function isKeyList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false
  return value.every(item => typeof item === 'string' && item.length <= 128)
}
