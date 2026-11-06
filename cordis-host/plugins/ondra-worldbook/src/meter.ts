/**
 * 文本折叠、token 估算、指纹。
 *
 * 三件事都刻意做成**纯函数**：不碰 ctx、不读配置对象，参数全从外面传进来。
 * 理由很简单——预算算错的排查成本极高（现象是「模型开始忘事」），
 * 必须能用几行脚本单独复现「这段文本到底算多少 token」。
 *
 * **为什么不用真分词器**：本仓禁装依赖（§16.3），而上游没有暴露分词能力。
 * 于是本文件给的是**估算**，且估算的换算比例由配置传入（`settings.ts` 有取值理由）。
 * 唯一的替换口是 `WorldbookService.setMeter()`：O-036 装真分词器时调它，
 * 换完会重算全部条目的 token，不会出现「新尺子量候选、旧数字算预算」。
 */

import type { TokenMeter } from './types.js'

/** 换行与连续空白折叠成一个空格用的正则。**逐字不改内容，只改排版**。 */
const WHITESPACE_RUN = /[\s\u3000]+/g

/**
 * 折叠排版：把换行与连续空白压成一个空格并去首尾。
 *
 * **这不是改写**：条目正文一个字都不动，只是把多行折成一行——
 * 因为条目在提示词里是一条 `- 标题：正文`，正文里带换行会把后面的行
 * 顶出这一条的缩进，模型会把它读成另一条设定。
 * @param text 原文。
 */
export function foldText(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim()
}

/**
 * 字符数（按码点数，不按 UTF-16 单元）。
 *
 * 用 `Array.from` 而不是 `.length`：emoji 与部分汉字在 UTF-16 里是代理对，
 * 用 `.length` 会数成 2，字符数会虚高，进而让「字符预算」与「人眼看到的长度」对不上。
 * @param text 文本。
 */
export function charCount(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}

/**
 * 判断一个码点是否属于「按字计 token」的东亚字符区。
 *
 * 覆盖：CJK 统一表意（含扩展 A）、CJK 标点、假名、谚文、全角形式。
 * 这些字符在主流分词器里通常是 1 字 ≈ 0.5–1 token，与拉丁字母的 4 字符/token
 * 差一个数量级；不分开算，中文世界书会被严重低估、一次装进三倍量。
 * @param code 码点。
 */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

/**
 * 估算 token 数。
 *
 * 口径：东亚字符按 `cjkCharsPerToken` 字/token，其余按 `asciiCharsPerToken` 字符/token，
 * 相加后**向上取整**（宁可多算一个 token，也不要因为少算而超预算）。
 * @param text 文本。
 * @param cjkCharsPerToken 中文每 token 折几个字。
 * @param asciiCharsPerToken 非中文每 token 折几个字符。
 */
export function estimateTokens(text: string, cjkCharsPerToken: number, asciiCharsPerToken: number): number {
  if (text.length === 0) return 0
  let wide = 0
  let narrow = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (isWideCodePoint(code)) wide += 1
    else narrow += 1
  }
  const raw = wide / cjkCharsPerToken + narrow / asciiCharsPerToken
  return Math.ceil(raw)
}

/**
 * 造一个估算器。
 * @param cjkCharsPerToken 中文每 token 折几个字。
 * @param asciiCharsPerToken 非中文每 token 折几个字符。
 */
export function createMeter(cjkCharsPerToken: number, asciiCharsPerToken: number): TokenMeter {
  return (text: string) => estimateTokens(text, cjkCharsPerToken, asciiCharsPerToken)
}

/**
 * 文本指纹（djb2，36 进制）。
 *
 * 用途只有一个：**判断「这一轮的前缀有没有变」**（§8.5）。
 * 不是安全哈希，也不要拿它当缓存键的唯一依据——它只回答"变没变"。
 * @param text 文本。
 */
export function digestOf(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}
