/**
 * 素材扫描：**目录 → 图 / 模型**，纯函数，不碰 ctx。
 *
 * 三条规则，每一条都对应一类「放了图但不显示」的静默故障：
 *
 * 1. **目录顺序即优先级**：人设目录在前，共享目录在后。同一个表情在两处都有图时，
 *    用先出现的那个（人设是她自己的脸），后出现的记一条 issue——
 *    而不是静默覆盖。用户改了共享目录那张、发现没反应，唯一的线索就是这条 issue。
 *
 * 2. **文件名主干必须是六态之一（或 neutral / default）**。`IMG_2034.png`
 *    放在立绘目录里不是错误，但它永远不会被用到；沉默跳过等于让用户
 *    对着一个"明明放了图"的空立绘发呆。
 *
 * 3. **0 字节跳过**。空文件在 `statSync` 里完全正常，渲染时才发现是坏图;
 *    那种报错发生在浏览器里，宿主的日志里一个字都没有。
 */

import { isAssetKey } from './types.js'
import type {
  AssetFormat,
  AssetKey,
  AvatarAsset,
  AvatarScan,
  FsLike,
  ModelRef,
  ScanDir,
  ScanLabel,
} from './types.js'

/** 一个待扫的目录。 */
export interface ScanTarget {
  /** 绝对路径。 */
  readonly path: string
  /** 角色。 */
  readonly label: ScanLabel
}

/** 扫描入参。 */
export interface ScanInput {
  /** 待扫目录（**顺序即优先级**，人设在前）。 */
  readonly dirs: readonly ScanTarget[]
  /** 文件系统。 */
  readonly fs: FsLike
  /** 扫描时刻。 */
  readonly at: number
}

/** 扩展名 → 格式。`jpeg` 与 `jpg` 是同一个格式的两个写法。 */
const FORMATS: Readonly<Record<string, AssetFormat>> = Object.freeze({
  png: 'png',
  webp: 'webp',
  jpg: 'jpg',
  jpeg: 'jpg',
  gif: 'gif',
  svg: 'svg',
  avif: 'avif',
})

/** Live2D 的两种入口文件名（Cubism 2 与 3/4）。 */
const MODEL_SUFFIXES: readonly string[] = Object.freeze(['.model3.json', '.model.json'])

/**
 * 取扩展名（小写，不含点）。
 * @param name 文件名。
 */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * 取主干（去掉最后一个扩展名）。
 * @param name 文件名。
 */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/**
 * 判一个文件名是不是模型入口，是则给出模型 id。
 * @param name 文件名。
 */
function modelIdOf(name: string): string | undefined {
  for (const suffix of MODEL_SUFFIXES) {
    if (name.length > suffix.length && name.toLowerCase().endsWith(suffix)) {
      return name.slice(0, name.length - suffix.length)
    }
  }
  return undefined
}

/**
 * 判一个文件名是不是图片，是则给出格式。
 * @param name 文件名。
 */
function formatOf(name: string): AssetFormat | undefined {
  return FORMATS[extOf(name)]
}

/** 按文件名稳定排序（同一目录重复扫描结果恒定）。 */
function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * 扫一遍素材目录。
 * @param input 目录、文件系统、时刻。
 */
export function scanAvatar(input: ScanInput): AvatarScan {
  const images: AvatarAsset[] = []
  const models: ModelRef[] = []
  const dirs: ScanDir[] = []
  const issues: string[] = []
  // 去重按**素材键**而不是六态：`neutral` / `default` 同样会跨目录重复，
  // 只按六态去重会让 `assets()` 里出现两张同名兜底图，而文档写着"一个键最多一张"。
  const taken = new Set<AssetKey>()
  const takenModels = new Set<string>()

  for (const target of input.dirs) {
    const listing = input.fs.list(target.path)
    // ENOENT = 还没建；其它错误码 = 存在但读不了（权限、不是目录…）。
    const present = listing.error === undefined || listing.code !== 'ENOENT'
    const entries = [...listing.entries].sort(byName)
    let count = 0

    if (listing.error !== undefined && listing.code !== 'ENOENT') {
      issues.push(`素材目录「${target.path}」读不了：${listing.error}`)
    }

    for (const entry of entries) {
      if (entry.isDir) continue
      if (entry.bytes <= 0) {
        issues.push(`「${entry.name}」是 0 字节，已跳过`)
        continue
      }

      const id = modelIdOf(entry.name)
      if (id !== undefined) {
        if (takenModels.has(id)) {
          issues.push(`模型「${id}」已有人在先，忽略 ${target.path}/${entry.name}`)
          continue
        }
        takenModels.add(id)
        models.push(
          Object.freeze({
            id,
            entry: entry.name,
            path: joinOf(target.path, entry.name),
            kind: 'live2d' as const,
            dir: target.path,
          }),
        )
        count += 1
        continue
      }

      const format = formatOf(entry.name)
      if (format === undefined) continue

      const key = stemOf(entry.name)
      if (!isAssetKey(key)) {
        issues.push(`「${entry.name}」的主干不是六态名（也不是 neutral / default），已跳过`)
        continue
      }
      if (taken.has(key)) {
        issues.push(`「${key}」已有图（人设目录优先），忽略 ${target.path}/${entry.name}`)
        continue
      }
      taken.add(key)

      images.push(
        Object.freeze({
          key,
          file: entry.name,
          path: joinOf(target.path, entry.name),
          format,
          bytes: entry.bytes,
          dir: target.path,
        }),
      )
      count += 1
    }

    dirs.push(
      Object.freeze({
        path: target.path,
        label: target.label,
        present,
        ...(listing.code === undefined ? {} : { code: listing.code }),
        ...(listing.error === undefined ? {} : { error: listing.error }),
        count,
      }),
    )
  }

  return Object.freeze({
    dirs: Object.freeze(dirs),
    images: Object.freeze(images),
    models: Object.freeze(models),
    issues: Object.freeze(issues),
    at: input.at,
  })
}

/**
 * 拼目录与文件名。
 *
 * 刻意不用 `node:path`：这两个值都已经来自 `path-layout` 的绝对路径，
 * 再 `join` 一次只是把同一次拼接写两遍。空目录（`''`）按"只有文件名"处理。
 * @param dir 目录。
 * @param name 文件名。
 */
function joinOf(dir: string, name: string): string {
  if (dir === '') return name
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + '/' + name
}

