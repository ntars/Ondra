/**
 * O-004 的文本格式化：时间戳、级别、printf 参数拍平。
 *
 * 这一层不碰文件系统、不碰 ctx，出错只影响「这一行长什么样」，
 * 不影响「日志能不能写下去」——所以所有可能抛错的地方都在这里收口。
 */

import type { LogLevel } from './types.js'

/** 级别数值：越小越严重，用于「低于此级别不写」。 */
export const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

/** 补零到两位。 */
function pad2(value: number): string {
  return value < 10 ? '0' + String(value) : String(value)
}

/**
 * 进程本地时区的时间戳文本 `YYYY-MM-DD HH:mm:ss`。
 *
 * 只作为 `ondra-clock` 缺席时的兜底；正常情况下由调用方注入
 * `clock.format()`，保证日志时间与产品时区一致。
 * @param epoch 毫秒时间戳。
 */
export function localStamp(epoch: number): string {
  const d = new Date(epoch)
  return (
    String(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  )
}

/** 安全字符串化：循环引用、BigInt、函数都不抛错。 */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return String(value) + 'n'
  if (typeof value === 'function') return '[函数]'
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return '[无法序列化]'
  }
}

/**
 * 把插件的结构化日志参数拍平成一行文本。
 *
 * Cordis 的 `Message.args` 是 printf 风格的原参数组。这里做**保守**格式化：
 * 支持 `%s` / `%d` / `%i` / `%f` / `%o` / `%O` / `%%`；`%c` / `%C` 是颜色占位，
 * 落盘时直接去掉。刻意不追求还原 `Logger.format()` 的着色与换行——
 * 代码层的价值在「能搜到」，不在「好看」。
 * @param args 原始参数。
 */
export function flattenArgs(args: readonly unknown[]): string {
  if (args.length === 0) return ''
  const head = args[0]
  if (head instanceof Error) {
    const tail = args.slice(1).map(safeStringify).join(' ')
    const text = head.stack ?? head.message
    return tail === '' ? text : text + ' ' + tail
  }
  if (typeof head !== 'string') {
    return args.map(safeStringify).join(' ')
  }
  let cursor = 1
  const text = head.replace(/%([sdifOocC%])/g, (match, flag: string) => {
    if (match === '%%') return '%'
    if (flag === 'c' || flag === 'C') return ''
    if (cursor >= args.length) return match
    const value = args[cursor]
    cursor += 1
    if (flag === 'o' || flag === 'O') return safeStringify(value)
    if (flag === 'd' || flag === 'i') return String(Math.trunc(Number(value)))
    if (flag === 'f') return String(Number(value))
    return String(value)
  })
  const rest = args.slice(cursor).map(safeStringify)
  return rest.length > 0 ? text + ' ' + rest.join(' ') : text
}

/**
 * 把消息模板压成去重键用的短串：折叠空白、截断。
 *
 * 不取整条消息：带上时间戳与请求 id 的整条消息永不重复，保护就失效了。
 * @param text 原始消息。
 */
export function dedupeKeyOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}
