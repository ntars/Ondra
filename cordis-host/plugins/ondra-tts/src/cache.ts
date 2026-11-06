/**
 * 音频缓存：内容寻址 + 按数量淘汰。
 *
 * ## 为什么用内容寻址而不是递增序号
 *
 * 同一句「我在呢」一天可能合成几十次（六态、语速、音色都一样）。
 * 文件名取 `sha256(通道|音色|语速|音量|文本)` 的前 16 位，第二次就是命中，
 * 不必再起一个进程念一遍。递增序号做不到这件事：它只能回答「第几次」，
 * 回答不了「这一句是不是已经念过」。
 *
 * ## 为什么先写 `.part` 再改名
 *
 * `say` 与 `edge-tts` 都是「边合成边写」。进程中途被杀（超时、卸载）时，
 * 目标文件里会留下一个能播放但只念了一半的音频。下一次同文命中它，
 * 用户听到的就是「她说到一半就没声了」，而缓存逻辑一切正常。
 * 写临时名、成功后再 `rename`，是原子替换里最省事的一种。
 *
 * ## 为什么落 `cache/` 而不是 `user/`
 *
 * 音频是可再生的（再合一次就有）。按 O-002 的区域划分，可再生的东西进缓存区，
 * 随时可清；`user/` 只放不可再生的数据。这也是「用户点一下清缓存」时
 * 不必担心删掉什么要紧东西的原因。
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogLike, PathLayoutLike } from './types.js'

/** 缓存子目录名（在 `cache/` 之下）。 */
export const CACHE_SUBDIR = 'tts'

/** 文件名里哈希的长度。16 位十六进制 = 64 bit，够用且不至于让文件名长得难看。 */
export const HASH_LEN = 16

/** 一份缓存文件的信息。 */
export interface CacheEntry {
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
}

/**
 * 解析缓存目录。
 *
 * 有 O-002 就用它的 `ensure('cache', 'tts')`（会顺手把权限收到 0700）；
 * 没有就退到系统临时目录。**音频不是敏感数据**，退到临时目录是可接受的降级，
 * 但要在日志里说一句，否则「重启后缓存没了」会被当成 bug。
 * @param layout 路径服务（可缺席）。
 * @param log 日志。
 */
export function ensureCacheDir(layout: PathLayoutLike | undefined, log: LogLike): string {
  if (layout !== undefined) {
    try {
      return layout.ensure('cache', CACHE_SUBDIR)
    } catch (error) {
      log.warn('缓存目录创建失败，退到系统临时目录：%s', error instanceof Error ? error.message : String(error))
    }
  } else {
    log.info('路径服务未装载：音频缓存放在系统临时目录（重启后会消失）')
  }
  const fallback = join(tmpdir(), 'ondra-tts')
  // 同步建目录：`available` 与 `stats()` 都是同步读数，缓存目录必须「取到就存在」，
  // 否则第一次 `speak()` 之前的一切读数都会遇到「目录还没有」这个分支。
  try {
    mkdirSync(fallback, { recursive: true })
  } catch {
    // 建不出来也不抛：合成时会再失败一次，那时才有原因码可报。
  }
  return fallback
}

/**
 * 算缓存键。
 * @param parts 参与判等的全部维度（顺序固定）。
 */
export function cacheKey(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, HASH_LEN)
}

/**
 * 拼缓存文件路径。
 * @param dir 目录。
 * @param key 键。
 * @param ext 后缀。
 */
export function cachePath(dir: string, key: string, ext: 'wav' | 'mp3'): string {
  return join(dir, key + '.' + ext)
}

/** 临时文件路径（同一目录下，保证 `rename` 是同盘原子操作）。 */
export function partPath(path: string): string {
  return path + '.part'
}

/**
 * 把一个临时文件转正。
 * @param from 临时文件。
 * @param to 目标文件。
 */
export async function promote(from: string, to: string): Promise<void> {
  await rename(from, to)
}

/**
 * 写一份二进制（GPT-SoVITS 走这条路：音频直接从 HTTP 回来）。
 * @param path 目标文件。
 * @param bytes 内容。
 */
export async function writeBinary(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes)
}

/**
 * 删一个文件（不存在不算错）。
 * @param path 文件。
 */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // 缓存文件删不掉不影响任何事：下一次淘汰会再试。
  }
}

/**
 * 读一份缓存条目（不存在返回 `undefined`）。
 * @param path 文件。
 */
export async function readEntry(path: string): Promise<CacheEntry | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) return undefined
    return { path, bytes: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

/** 列出目录里的全部缓存文件（读不到就返回空）。 */
export async function listEntries(dir: string): Promise<readonly CacheEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const entries: CacheEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.wav') && !name.endsWith('.mp3')) continue
    const entry = await readEntry(join(dir, name))
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/**
 * 按数量淘汰：超出 `maxFiles` 时删最旧的。
 *
 * **不按时间淘汰**：一周没用过的一句话，下一次被说起时还能命中；
 * 而「最多留 200 个」有明确上限，不会把磁盘吃满。
 * @param dir 目录。
 * @param maxFiles 上限。
 * @returns 删掉的文件数。
 */
export async function prune(dir: string, maxFiles: number): Promise<number> {
  const entries = await listEntries(dir)
  const overflow = entries.length - maxFiles
  if (overflow <= 0) return 0
  const oldest = [...entries].sort((left, right) => left.mtimeMs - right.mtimeMs).slice(0, overflow)
  for (const entry of oldest) await removeFile(entry.path)
  return oldest.length
}

/**
 * 清空缓存目录里的音频（不动目录本身）。
 * @param dir 目录。
 * @returns 删掉的文件数。
 */
export async function clearCache(dir: string): Promise<number> {
  const entries = await listEntries(dir)
  for (const entry of entries) await removeFile(entry.path)
  return entries.length
}