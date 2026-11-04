/**
 * 目录扫描：**一次列目录 → 一堆带标签的条目**。没有清单文件。
 *
 * 两条边界：
 *
 * 1. **坏文件不拖垮整包。** 扩展名不认识、0 字节、读不到 stat，
 *    都只记进 `skipped`，不影响同目录里的其他图。一张坏图不该让
 *    「另外 40 张好图」也放不出来。
 * 2. **空目录照报。** 目录存在但一张图都没有，也要出现在 `packs()` 里——
 *    面板要能显示「目录建好了，把图放进去」，而不是「没有贴纸」。
 *    这两句话对用户意味着完全不同的事。
 */

import { formatOf } from './tags.js'
import type { FsLike, PackKind, StickerEntry, StickerPackView } from './types.js'

/** 扫描依赖（全部注入，便于脱离文件系统核对）。 */
export interface ScanDeps {
  /** 文件系统。 */
  readonly fs: FsLike
  /** 派生标签（已过同义表）。 */
  readonly tagOf: (file: string) => string
  /** 派生序号。 */
  readonly orderOf: (file: string) => number
  /** 拼路径。 */
  readonly join: (...parts: string[]) => string
}

/** 一个已扫描的包：概况 + 条目。 */
export interface ScannedPack {
  readonly view: StickerPackView
  readonly entries: readonly StickerEntry[]
}

/** 把一批文件名变成条目（磁盘包与注册包共用这一条路径）。 */
function entriesOf(
  packId: string,
  dir: string,
  files: readonly string[],
  deps: ScanDeps,
  byteOf: (file: string) => number,
): { entries: StickerEntry[]; skipped: number } {
  const entries: StickerEntry[] = []
  let skipped = 0

  for (const file of files) {
    const format = formatOf(file)
    if (format === undefined) {
      skipped += 1
      continue
    }
    const bytes = byteOf(file)
    // 0 字节的图**一定是坏的**（上传中断、复制到一半）。发出去是灰色方块，
    // 而日志里一切正常——不如当场跳过并计数。
    if (bytes === 0) {
      skipped += 1
      continue
    }
    const tag = deps.tagOf(file)
    if (tag === '') {
      skipped += 1
      continue
    }
    entries.push(
      Object.freeze({
        id: packId + '/' + file,
        tag,
        packId,
        path: deps.join(dir, file),
        file,
        bytes,
        format,
        order: deps.orderOf(file),
      }),
    )
  }

  // 同标签内按序号、再按文件名——顺序必须是确定的，
  // 否则「轮转」在两次进程里走出两种顺序，用户会觉得图在乱跳。
  entries.sort((a, b) => a.tag.localeCompare(b.tag, 'zh') || a.order - b.order || a.file.localeCompare(b.file, 'zh'))
  return { entries, skipped }
}

/** 把条目做成概况。 */
function viewOf(
  id: string,
  kind: PackKind,
  dir: string,
  present: boolean,
  entries: readonly StickerEntry[],
  skipped: number,
  error?: string,
): StickerPackView {
  const tags = new Set<string>()
  for (const entry of entries) tags.add(entry.tag)
  return Object.freeze({
    id,
    kind,
    dir,
    present,
    files: entries.length,
    tags: tags.size,
    skipped,
    ...(error === undefined ? {} : { error }),
  })
}

/**
 * 扫一个目录。
 * @param id 包 id。
 * @param kind 包来源。
 * @param dir 目录绝对路径；空串表示拼不出路径（此时不扫）。
 * @param deps 依赖。
 */
export function scanDir(id: string, kind: PackKind, dir: string, deps: ScanDeps): ScannedPack {
  if (dir === '') {
    return { view: viewOf(id, kind, '', false, [], 0), entries: [] }
  }
  const listing = deps.fs.list(dir)
  if (listing.error !== undefined) {
    // 不存在 → present:false，不算故障（第一次启动就是这样，面板该说"把图放进去"）。
    // 其他错误（权限、路径是文件）→ 带上原因，面板该说"读不了"。
    const missing = listing.code === 'ENOENT' || listing.code === 'ENOTDIR'
    return {
      view: viewOf(id, kind, dir, false, [], 0, missing ? undefined : listing.error),
      entries: [],
    }
  }
  const files = listing.entries.filter(entry => !entry.isDir).map(entry => entry.name)
  const size = new Map<string, number>()
  for (const entry of listing.entries) if (!entry.isDir) size.set(entry.name, entry.bytes)

  const { entries, skipped } = entriesOf(id, dir, files, deps, file => size.get(file) ?? 0)
  return { view: viewOf(id, kind, dir, true, entries, skipped), entries }
}

/**
 * 从一批绝对路径建包（`registerPack()` 用，不碰文件系统）。
 *
 * `bytes` 记成 -1（未知）：注册包来自宿主，本插件没有它的 stat 权限，
 * 而"未知"与"0 字节"必须能分开——后者会被当成坏图跳过。
 * @param id 包 id。
 * @param kind 包来源。
 * @param files 绝对路径列表。
 * @param deps 依赖（只需要 `tagOf` / `orderOf`）。
 */
export function packFromFiles(
  id: string,
  kind: PackKind,
  files: readonly string[],
  deps: Pick<ScanDeps, 'tagOf' | 'orderOf'>,
): ScannedPack {
  const { entries, skipped } = entriesOf(
    id,
    '',
    files,
    // 注册包给的是**绝对路径**，不再拼目录：取最后一段即是原样路径。
    { ...deps, fs: { list: () => ({ entries: [] }) }, join: (...parts: string[]) => parts[parts.length - 1] ?? '' },
    () => -1,
  )
  return { view: viewOf(id, kind, '', true, entries, skipped), entries }
}
