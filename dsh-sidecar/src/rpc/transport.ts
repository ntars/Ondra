/**
 * 按行分帧的 JSON-RPC 传输层。
 *
 * ## 为什么按行分帧而不是 Content-Length
 *
 * JSON-RPC over stdio 有两种常见做法：
 * 1. LSP 风格：`Content-Length: N\r\n\r\n<body>`。
 * 2. NDJSON：一行一条消息，`\n` 结尾。
 *
 * 本项目选 NDJSON，理由是可流式处理且不会因头部写错而整条流卡死。
 * 代价是消息体内不能出现裸换行——JSON 序列化默认就会转义换行，
 * 所以这个代价实际为零。LSP 风格的优势是可以传非文本负载，
 * 而本协议的负载恒为 JSON，用不上那个优势。
 */

import { MAX_MESSAGE_BYTES } from '../protocol.js'

/**
 * 一个可读流（通常是 `process.stdin`）的分帧读取器。
 *
 * 只做一件事：把字节流按 `\n` 切成完整消息，逐条交给上层。
 * 它不解析 JSON，也不理解协议——解析失败属于上层的职责，这样传输层可以独立测试。
 */
export class LineDecoder {
  /**
   * 尚未遇到换行的残留字节。
   *
   * 类型标注为 `Buffer<ArrayBuffer>` 而非裸 `Buffer`：Node 22 起 `Buffer` 是带
   * 泛型的视图类型，`Buffer.concat` 返回 `Buffer<ArrayBuffer>`，
   * 而 `subarray` 可能返回 `Buffer<ArrayBufferLike>`。显式收窄后两者才可互相赋值。
   */
  private buffer: Buffer<ArrayBuffer> = Buffer.alloc(0)

  /** 单条消息上限，用于提前拒绝失控输入。 */
  private readonly maxBytes: number

  constructor(maxBytes: number = MAX_MESSAGE_BYTES) {
    this.maxBytes = maxBytes
  }

  /**
   * 喂入一段字节，返回其中已完整的消息（不含结尾换行）。
   *
   * 为什么不直接按 `\n` fork 字符串：多字节的 UTF-8 字符可能跨 chunk 边界，
   * 先转字符串会把字符切坏成乱码。全程按 Buffer 拼接、切分后再解码才安全。
   *
   * @param chunk 新到达的字节。
   * @returns 已完整的消息字节列表，按到达顺序排列。
   * @throws 单条消息超过 {@link MAX_MESSAGE_BYTES} 时抛出，调用方须断开连接。
   */
  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, chunk])
    const messages: Buffer[] = []
    let newlineAt = this.buffer.indexOf(0x0a)
    while (newlineAt !== -1) {
      const line = Buffer.from(this.buffer.subarray(0, newlineAt))
      this.buffer = Buffer.from(this.buffer.subarray(newlineAt + 1))
      // 空行（心跳或误发的多余换行）直接跳过，不当作空消息上报。
      if (line.length > 0) {
        if (line.length > this.maxBytes) {
          throw new Error(`消息长度 ${String(line.length)} 字节，超过上限 ${String(this.maxBytes)} 字节`)
        }
        messages.push(line)
      }
      newlineAt = this.buffer.indexOf(0x0a)
    }
    // 残留部分也必须有上限，否则一条永不换行的流能无限占内存。
    if (this.buffer.length > this.maxBytes) {
      throw new Error(`未完成消息已累积 ${String(this.buffer.length)} 字节，超过上限 ${String(this.maxBytes)} 字节`)
    }
    return messages
  }
}

/**
 * 把一个 JSON-RPC 消息编码为一行可写入的字节。
 *
 * 末尾补 `\n`，因为分帧靠它。
 *
 * @param message 任意可 JSON 序列化的消息对象。
 * @returns 带换行结尾的 Buffer，可直接写入 stdout。
 */
export function encodeLine(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
}
