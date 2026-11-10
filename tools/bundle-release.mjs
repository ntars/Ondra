/**
 * 把 Tauri 的打包产物搬运到仓库根的 `releases/`。
 *
 * ## 为什么不直接让 Tauri 输出到 releases
 *
 * Tauri 的 bundle 永远落在 `src-tauri/target/release/bundle/`，
 * 这个位置由 Cargo 的 target 目录决定，配置里改不了。
 * 因此用一步拷贝把 dmg / app / exe 集中到仓库根的 `releases/`，
 * 既满足"产物放仓库根"的要求，又不影响 Tauri 自己的构建流程。
 *
 * ## 跨平台
 *
 * 纯 Node `fs` 实现，不依赖 `cp`/`robocopy`，在 macOS 与 Windows 上一致。
 * `releases/` 已在 .gitignore 中，不会进库。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const bundleDir = join(repoRoot, 'src-tauri', 'target', 'release', 'bundle')
const outDir = join(repoRoot, 'releases')

if (!existsSync(bundleDir)) {
  console.error(`找不到打包产物目录：${bundleDir}`)
  console.error('请先运行 `pnpm run build:app`（即 tauri build）生成安装包。')
  process.exit(1)
}

// 每次搬运前清空旧产物，避免残留上一版的过期安装包。
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/**
 * 只搬运真正要交付的东西。
 *
 * `bundle/` 里混着 Tauri 自己用的中间文件：`dmg/bundle_dmg.sh`、
 * `dmg/icon.icns`、`share/create-dmg/`——它们是构建脚本和素材，
 * 不是用户会打开的东西。以前整目录照搬，`releases/` 里 2987 个文件
 * 有 2983 个是这些无用的中间产物，真正要给人只有 1 个 dmg + 1 个 app。
 *
 * 判据按扩展名，不按路径：路径会随 Tauri 版本变，而"用户要装的东西"
 * 就那么几种形态。
 */
const KEEP_EXTENSIONS = ['.dmg', '.exe', '.msi', '.AppImage', '.deb', '.rpm', '.pkg']
const KEEP_DIRECTORIES = ['.app'] // macOS 应用包是目录，整体保留

/** 是否值得搬。 */
function worthKeeping(source, entryName) {
  if (KEEP_DIRECTORIES.some((ext) => entryName.endsWith(ext))) return true
  return KEEP_EXTENSIONS.some((ext) => entryName.endsWith(ext))
}

// 逐层遍历 bundle/，只把产物按原相对路径落到 releases/。
let count = 0
const copyFiltered = (sourceDir, targetDir) => {
  mkdirSync(targetDir, { recursive: true })
  for (const item of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, item.name)
    const target = join(targetDir, item.name)
    if (item.isDirectory()) {
      // `.app` 是产物（目录形态），整体拷；其它目录继续往下找。
      if (item.name.endsWith('.app')) {
        cpSync(source, target, { recursive: true, dereference: true })
        continue
      }
      copyFiltered(source, target)
      // 空的中间目录不留在 releases 里。
      if (readdirSync(target).length === 0) rmSync(target, { recursive: true, force: true })
      continue
    }
    if (worthKeeping(source, item.name)) {
      cpSync(source, target, { dereference: true })
      count++
    }
  }
}

copyFiltered(bundleDir, outDir)

// 统计目录形态的产物（.app 内部的每个文件都算）。
if (count === 0) {
  console.error('没有找到可交付的产物，检查一下 tauri build 是否成功。')
  process.exit(1)
}
for (const platformDir of readdirSync(outDir, { withFileTypes: true })) {
  if (!platformDir.isDirectory()) continue
  const collectDir = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isDirectory()) collectDir(full)
      else count++
    }
  }
  collectDir(join(outDir, platformDir.name))
}

console.log(`已搬运 ${count} 个产物到 releases/`)
console.log(`  ${outDir}`)
