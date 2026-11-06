/**
 * 把官网静态文件收进 .site-dist/。
 *
 * ## 为什么要这一步
 *
 * 官网的 index.html 放在仓库根（好找、好改），但仓库根还有整个工程源码。
 * 直接把根目录当静态输出发布，既会超过平台文件数限制，也会把源码当静态资源暴露。
 *
 * 所以构建时只挑真正要上线的文件放进输出目录，
 * edgeone.json 的 outputDirectory 指向这个目录。
 *
 * ## 加文件怎么办
 *
 * 往 STATIC_FILES 或 STATIC_DIRS 里加一行即可。
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 输出目录，必须与 edgeone.json 的 outputDirectory 一致。 */
const OUT_DIR = '.site-dist'

/** 根目录下的输出目录（相对本脚本所在位置）。 */
const ROOT = join(import.meta.dirname, '..')

/** 需要原样复制的根目录文件。 */
const STATIC_FILES = ['index.html', 'icon.svg', 'favicon.ico']

/** 需要整目录复制的可选目录。目录不存在时跳过，不视为错误。 */
const STATIC_DIRS = ['assets']

/**
 * 复制时跳过的文件名，精确匹配叶名。
 *
 * 这三类是 macOS 自己塞进来的元数据，与站点无关：
 * - `.DS_Store` 记录访达的图标位置与视图偏好；
 * - `._*` 是 AppleDouble 资源叉，跨文件系统复制时产生；
 * - `__MACOSX` 是解压 zip 时的资源叉目录。
 *
 * 只按精确叶名过滤，不做通配删除——`assets` 下如果真有以 `.` 开头的
 * 站点文件（例如 `.well-known`），不该被这条规则误伤。
 */
const SKIP_NAMES = new Set(['.DS_Store', '__MACOSX'])

/** 判断某个文件名是否属于 macOS 元数据。 */
function isMacMetadata(name) {
  return SKIP_NAMES.has(name) || name.startsWith('._')
}

/**
 * 复制目录，但剔除 macOS 元数据。
 *
 * 先复制再删除会留下一个已经写进磁盘的 `.DS_Store`（虽然随即被删），
 * 且删除失败时产物里就真的带上了垃圾。这里改成先读目录、逐个决定，
 * 从源头不复制。
 *
 * 返回值同时带回「复制了几项」和「剔除了几项」，这样调用方不用再为了
 * 打一行日志去重新遍历源目录——那既多一次 IO，也会把剔除逻辑复制一份。
 *
 * @param {string} source 源目录绝对路径。
 * @param {string} target 目标目录绝对路径。
 * @returns {Promise<{ copied: number, skipped: number }>}
 *   复制的条目数与被剔除的元数据条目数（均递归累计）。
 */
async function copyDirFiltered(source, target) {
  const entries = await readdir(source, { withFileTypes: true })
  const kept = entries.filter((entry) => !isMacMetadata(entry.name))
  const result = { copied: 0, skipped: entries.length - kept.length }
  // 全是元数据、或本身为空时，不在产物里留下空目录壳子。
  if (kept.length === 0) return result
  await mkdir(target, { recursive: true })
  for (const entry of kept) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      const sub = await copyDirFiltered(from, to)
      result.copied += sub.copied
      result.skipped += sub.skipped
    } else {
      await cp(from, to)
      result.copied += 1
    }
  }
  return result
}

const outPath = join(ROOT, OUT_DIR)

await rm(outPath, { recursive: true, force: true })
await mkdir(outPath, { recursive: true })

let copied = 0
for (const file of STATIC_FILES) {
  const source = join(ROOT, file)
  if (!existsSync(source)) {
    // 缺失必需文件必须失败：静默跳过会发布出一个没有图标的站点，
    // 而且要等上线后才会发现。
    console.error(`[build-site] 缺少必需文件：${file}`)
    process.exit(1)
  }
  await cp(source, join(outPath, file))
  copied += 1
}

for (const dir of STATIC_DIRS) {
  const source = join(ROOT, dir)
  if (!existsSync(source)) continue
  const { copied: n, skipped } = await copyDirFiltered(source, join(outPath, dir))
  copied += n
  if (skipped > 0) {
    console.log(`[build-site] ${dir}/ 已剔除 ${String(skipped)} 个 macOS 元数据文件`)
  }
}

console.log(`[build-site] 已输出 ${String(copied)} 项到 ${OUT_DIR}/`)
