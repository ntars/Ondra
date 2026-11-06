/**
 * 图片读取、种类判定、尺寸解析、base64 编码。**本插件唯一碰文件的地方**。
 *
 * ## 为什么按魔数判种类，不按扩展名
 *
 * 通道适配器落地文件名时经常丢掉扩展名（`image_1234`），也可能保留一个错的
 * （微信的语音文件常被存成 `.jpg`）。按扩展名判的后果不是「报错」，是
 * **把一段声波当图片发出去**，然后 provider 回 400，日志写着「视觉失败」。
 * 魔数是内容自己的声明，骗不了。
 *
 * ## 为什么尺寸要自己解析
 *
 * 定位动作要求归一化坐标（0–1）。模型偶尔会回像素值（`x: 420, y: 180`），
 * 那时必须用真实宽高换算。没有图库可用（本轮禁止装依赖），所以这几行
 * 头解析是必要的：PNG 的 IHDR、JPEG 的 SOFn、GIF 的逻辑屏幕、WebP 的三种变体。
 *
 * 解析不出来时**不猜**：`size` 缺省，调用方据此拒收像素坐标，而不是除以一个假尺寸。
 */

import { readFileSync, statSync } from 'node:fs'
import type { ImageSize, VisionReason } from './types.js'

/** 读图的结果。**只有两个出口**：拿到了，或拿到了一个原因码。 */
export type LoadImage =
  | {
    readonly ok: true
    readonly bytes: Uint8Array
    readonly mime: string
    readonly size?: ImageSize
    readonly path: string
  }
  | { readonly ok: false; readonly reason: VisionReason; readonly detail: string }

/** 判定用的最小字节数：连 4 个字节都没有，什么都不是。 */
const MIN_HEADER = 16

/** 大端 u16。 */
function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) * 256 + (bytes[at + 1] ?? 0)
}

/** 大端 u32。 */
function u32be(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) * 16777216 +
    (bytes[at + 1] ?? 0) * 65536 +
    (bytes[at + 2] ?? 0) * 256 +
    (bytes[at + 3] ?? 0)
  )
}

/** 小端 u16。 */
function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) * 256
}

/** 小端 u32。 */
function u32le(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) +
    (bytes[at + 1] ?? 0) * 256 +
    (bytes[at + 2] ?? 0) * 65536 +
    (bytes[at + 3] ?? 0) * 16777216
  )
}

/** 小端 u24。 */
function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) * 256 + (bytes[at + 2] ?? 0) * 65536
}

/** 一段字节的字面量比较。 */
function at(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/** PNG：8 字节签名 + 长度 + 'IHDR'，宽高各 4 字节大端。 */
function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24) return undefined
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * JPEG：从 SOI 之后逐个走段，遇到 SOF0–SOF15（除 C4 / C8 / CC）读宽高。
 *
 * 不能只看固定偏移：SOI 与 SOF 之间可能插着 APPn / COM / DQT 十几种段，
 * 长度各不相同。硬编码偏移在「相机直出图」上碰巧对，在「微信压缩过的图」上必错。
 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  let index = 2
  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1
      continue
    }
    const marker = bytes[index + 1] ?? 0
    // 填充字节：0xFF 后面可以再跟 0xFF。
    if (marker === 0xff) {
      index += 1
      continue
    }
    // 无载荷的标记。
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2
      continue
    }
    const length = u16be(bytes, index + 2)
    if (length < 2) return undefined
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = u16be(bytes, index + 5)
      const width = u16be(bytes, index + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    index += 2 + length
  }
  return undefined
}

/** GIF：'GIF8' 之后第 6、8 字节是小端宽高。 */
function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined
  const width = u16le(bytes, 6)
  const height = u16le(bytes, 8)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** WebP 的三种变体：VP8X（扩展）/ VP8（有损）/ VP8L（无损）。 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) return undefined
  if (at(bytes, 12, 'VP8X')) {
    const width = u24le(bytes, 24) + 1
    const height = u24le(bytes, 27) + 1
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (at(bytes, 12, 'VP8 ')) {
    // 关键帧头：3 字节起始码 9D 01 2A，随后 2 字节宽、2 字节高（低 14 位有效）。
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    const width = u16le(bytes, 26) & 0x3fff
    const height = u16le(bytes, 28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (at(bytes, 12, 'VP8L')) {
    // 无损：签名 0x2F 之后 14 位宽 + 14 位高，均减一。
    if (bytes[20] !== 0x2f) return undefined
    const bits = (bytes[21] ?? 0) + ((bytes[22] ?? 0) << 8) + ((bytes[23] ?? 0) << 16) + ((bytes[24] ?? 0) << 24)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  return undefined
}

/**
 * 按魔数判定 MIME 与尺寸。**只认五种**：PNG / JPEG / GIF / WebP / BMP。
 *
 * 少一种比多一种好：不认识的格式直接 `bad-image`，而不是硬塞给 provider
 * 换一个 400——那时用户看到的是「视觉坏了」，实际是「这个格式本来就不支持」。
 * @param bytes 文件内容（至少前 32 字节）。
 */
export function sniff(bytes: Uint8Array): { mime: string; size?: ImageSize } | undefined {
  if (bytes.length < MIN_HEADER) return undefined
  if (bytes[0] === 0x89 && at(bytes, 1, 'PNG')) {
    return { mime: 'image/png', size: pngSize(bytes) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', size: jpegSize(bytes) }
  }
  if (at(bytes, 0, 'GIF8')) {
    return { mime: 'image/gif', size: gifSize(bytes) }
  }
  if (at(bytes, 0, 'RIFF') && at(bytes, 8, 'WEBP')) {
    return { mime: 'image/webp', size: webpSize(bytes) }
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    // BMP：'BM' + 文件长度 + 保留 + 数据偏移，宽高在固定偏移 18 / 22。
    // **BMP 是小端格式**（曾误用大端，会把 800×600 读成天文数字）。
    // 高可能为负（自上而下扫描），取绝对值。
    if (bytes.length < 26) return { mime: 'image/bmp' }
    const width = Math.abs(u32le(bytes, 18) | 0)
    const height = Math.abs(u32le(bytes, 22) | 0)
    return { mime: 'image/bmp', size: width > 0 && height > 0 ? { width, height } : undefined }
  }
  return undefined
}

/**
 * 读一张图。**永不抛错**：路径、权限、大小、格式四种坏法各有原因码。
 * @param path 绝对路径。
 * @param maxBytes 字节上限。
 */
export function loadImage(path: string, maxBytes: number): LoadImage {
  if (path.trim() === '') return { ok: false, reason: 'no-file', detail: '没有给图片路径' }

  let size = 0
  try {
    const stat = statSync(path)
    if (!stat.isFile()) {
      return { ok: false, reason: 'missing', detail: `不是普通文件：${path}` }
    }
    size = stat.size
  } catch {
    return { ok: false, reason: 'missing', detail: `文件不存在或读不到：${path}` }
  }

  if (size > maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `图片 ${size} 字节，超过上限 ${maxBytes}（本包不压缩，压了会改内容）`,
    }
  }
  if (size < MIN_HEADER) {
    return { ok: false, reason: 'bad-image', detail: `文件只有 ${size} 字节，不是图片` }
  }

  let bytes: Uint8Array
  try {
    bytes = readFileSync(path)
  } catch (error) {
    return { ok: false, reason: 'missing', detail: `读取失败：${textOf(error)}` }
  }

  const kind = sniff(bytes)
  if (kind === undefined) {
    return { ok: false, reason: 'bad-image', detail: '魔数不认识（只支持 PNG / JPEG / GIF / WebP / BMP）' }
  }
  return { ok: true, bytes, mime: kind.mime, size: kind.size, path }
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 字节 → base64。用 Buffer 而不是手写查表：手写的版本在大文件上会慢一个数量级。 */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** 字节 → `data:` URL（OpenAI 兼容端点要求）。 */
export function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${toBase64(bytes)}`
}
