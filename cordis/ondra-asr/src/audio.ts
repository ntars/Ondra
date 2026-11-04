/**
 * 音频读取、种类判定、WAV 头解析。**本包唯一碰源文件的地方**。
 *
 * ## 为什么按魔数判种类
 *
 * 通道适配器落地语音文件时几乎一定改名（`voice_20261103_1`、`media-8891`），
 * 也可能保留一个错的扩展名。按扩展名判的后果不是「报错」，是把一段文本当音频
 * 发出去，然后 provider 回 400，日志写着「转写失败」。
 *
 * ## 为什么还要解析 WAV 头
 *
 * whisper.cpp 的命令行**只吃 16 kHz 单声道 16 位 WAV**（除非它编译时带了
 * FFmpeg 支持，而那是发行版差异，不能假设）。所以本地路径必须先判断
 * 「这个 wav 到底合不合规格」：
 *
 * - 不合规格 → 先用 ffmpeg 转成 16k 单声道，再交给 whisper；
 * - 已经是 WAV 但规格不对（44.1k 立体声，很常见）→ 同样要转。
 *
 * 不判这一下，用户会看到「whisper 说读不了这个文件」，而文件本身完全正常。
 */

import { readFileSync, statSync } from 'node:fs'
import type { AsrReason } from './types.js'

/** 读音频的结果。 */
export type LoadAudio =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mime: string; readonly path: string }
  | { readonly ok: false; readonly reason: AsrReason; readonly detail: string }

/** WAV 的格式信息（只读 `fmt ` 块）。 */
export interface WavInfo {
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerSample: number
}

/** 判定用的最小字节数。 */
const MIN_HEADER = 16

/** 一段字节的字面量比较。 */
function at(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/** 小端 u16。 */
function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256
}

/** 小端 u32。 */
function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 256 +
    (bytes[offset + 2] ?? 0) * 65536 +
    (bytes[offset + 3] ?? 0) * 16777216
  )
}

/**
 * 按魔数判定 MIME。**只认八种**，都是 whisper / 云端转写接口真正吃得下的：
 * WAV / MP3 / OGG / FLAC / M4A(MP4) / WEBM / AIFF / AMR。
 * @param bytes 文件内容。
 */
export function sniffAudio(bytes: Uint8Array): string | undefined {
  if (bytes.length < MIN_HEADER) return undefined
  if (at(bytes, 0, 'RIFF') && at(bytes, 8, 'WAVE')) return 'audio/wav'
  if (at(bytes, 0, 'FORM') && (at(bytes, 8, 'AIFF') || at(bytes, 8, 'AIFC'))) return 'audio/aiff'
  if (at(bytes, 0, 'OggS')) return 'audio/ogg'
  if (at(bytes, 0, 'fLaC')) return 'audio/flac'
  if (at(bytes, 0, '#!AMR')) return 'audio/amr'
  if (at(bytes, 0, 'ID3')) return 'audio/mpeg'
  // MP3 帧头：11 位全 1 的同步字，后面两比特不能是 01（保留值）。
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg'
  // MP4 / M4A：第 4–7 字节是 'ftyp'，品牌在 8–11。
  if (at(bytes, 4, 'ftyp')) return 'audio/mp4'
  // WebM / Matroska：EBML 头 1A 45 DF A3。
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm'
  }
  return undefined
}

/**
 * 读 WAV 的 `fmt ` 块。不是 WAV 或块缺失则 `undefined`。
 *
 * RIFF 的块是「4 字节 id + 4 字节长度 + 数据」，可以有任何顺序，
 * 所以必须走一遍而不是读固定偏移（`fact` / `LIST` 块常排在 `fmt ` 前面）。
 * @param bytes 文件内容。
 */
export function wavInfo(bytes: Uint8Array): WavInfo | undefined {
  if (!at(bytes, 0, 'RIFF') || !at(bytes, 8, 'WAVE')) return undefined
  let index = 12
  while (index + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[index] ?? 0,
      bytes[index + 1] ?? 0,
      bytes[index + 2] ?? 0,
      bytes[index + 3] ?? 0,
    )
    const size = u32le(bytes, index + 4)
    if (id === 'fmt ' && index + 8 + 16 <= bytes.length) {
      return {
        channels: u16le(bytes, index + 10),
        sampleRate: u32le(bytes, index + 12),
        bitsPerSample: u16le(bytes, index + 22),
      }
    }
    // 块长度是奇数时后面还有一个填充字节。
    index += 8 + size + (size % 2)
  }
  return undefined
}

/**
 * whisper.cpp 吃得下的 WAV：16 kHz、单声道、16 位。
 * @param info WAV 头信息。
 */
export function isWhisperWav(info: WavInfo | undefined): boolean {
  if (info === undefined) return false
  return info.sampleRate === 16000 && info.channels === 1 && info.bitsPerSample === 16
}

/**
 * 读一段音频。**永不抛错**。
 * @param path 绝对路径。
 * @param maxBytes 字节上限。
 */
export function loadAudio(path: string, maxBytes: number): LoadAudio {
  if (path.trim() === '') return { ok: false, reason: 'no-file', detail: '没有给音频路径' }

  let size = 0
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { ok: false, reason: 'missing', detail: `不是普通文件：${path}` }
    size = stat.size
  } catch {
    return { ok: false, reason: 'missing', detail: `文件不存在或读不到：${path}` }
  }

  if (size > maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `音频 ${size} 字节，超过上限 ${maxBytes}（本包不切片，切了会截断句子）`,
    }
  }
  if (size < MIN_HEADER) {
    return { ok: false, reason: 'bad-audio', detail: `文件只有 ${size} 字节，不是音频` }
  }

  let bytes: Uint8Array
  try {
    bytes = readFileSync(path)
  } catch (error) {
    return { ok: false, reason: 'missing', detail: `读取失败：${textOf(error)}` }
  }

  const mime = sniffAudio(bytes)
  if (mime === undefined) {
    return {
      ok: false,
      reason: 'bad-audio',
      detail: '魔数不认识（只支持 WAV / MP3 / OGG / FLAC / M4A / WEBM / AIFF / AMR）',
    }
  }
  return { ok: true, bytes, mime, path }
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
