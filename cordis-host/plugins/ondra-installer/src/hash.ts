/**
 * sha256：算文件、算字节、算文本，以及「这串是不是 sha256」。
 *
 * ## 为什么文件要走流
 *
 * 运行时压缩包在 100 MB 量级。`readFileSync` 一次读进内存，峰值就是「文件大小 × 2」
 * （Buffer + 复制），在低配机器上等于一次可避免的 OOM。`createReadStream` + `for await`
 * 的峰值只有 chunk 大小，代价是接口变成异步——这层异步在 `verify` 步骤里天然存在，
 * 不额外传染。
 *
 * ## 为什么不再加一层「缓存哈希」
 *
 * 有人会想「同一个文件第二次算就别算了」。缓存键必须包含 `mtime + size`，
 * 而安装器改的正是这些文件；一次误命中就意味着**把一个坏文件认成好的**。
 * 安装器宁可慢一点，也不做这种缓存。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** 合法的 sha256 文本：64 位小写十六进制。 */
const SHA256_RE = /^[a-f0-9]{64}$/u

/**
 * 是不是 sha256 文本。
 *
 * 刻意只认**小写**：清单里大小写混写会让「看着一样、比较不等」，
 * 而那种不等最后表现成「明明写对了却说哈希不对」。
 * @param value 待判值。
 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value)
}

/**
 * 算一段字节的 sha256。
 * @param bytes 内容。
 */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 算一段文本的 sha256（UTF-8）。
 * @param text 文本。
 */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 算一个文件的 sha256（流式）。
 * @param path 绝对路径。
 * @returns 64 位小写十六进制；读不到时抛（由调用方折成失败步骤）。
 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}
