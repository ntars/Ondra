/**
 * 把官网静态文件收进 dist/。
 *
 * ## 为什么要这一步
 *
 * 官网的 `index.html` 放在仓库根目录（好找、好改），但仓库根还有 24,000 多个
 * 文件——`desktop/` 一个目录就 9 GB。直接把根目录当静态输出发布，既会超过
 * 平台限制，也会把整个 Electron 工程的源码当成静态资源暴露出去。
 *
 * 所以构建时只挑真正要上线的这几个文件放进 `dist/`，
 * `edgeone.json` 的 `outputDirectory` 指向 `./dist`。
 *
 * ## 加文件怎么办
 *
 * 往 `STATIC_FILES` 里加一行即可；`assets/` 目录存在就会整目录复制。
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/** 输出目录，必须与 edgeone.json 的 outputDirectory 一致。 */
const OUT_DIR = 'dist'

/** 需要原样复制的根目录文件。 */
const STATIC_FILES = ['index.html', 'icon.svg', 'favicon.ico']

/** 需要整目录复制的可选目录。 */
const STATIC_DIRS = ['assets']

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

for (const file of STATIC_FILES) {
  if (!existsSync(file)) {
    console.error(`[build-site] 缺少文件：${file}`)
    process.exit(1)
  }
  await cp(file, `${OUT_DIR}/${file}`)
  console.log(`[build-site] ${file}`)
}

for (const dir of STATIC_DIRS) {
  if (!existsSync(dir)) continue
  await cp(dir, `${OUT_DIR}/${dir}`, { recursive: true })
  console.log(`[build-site] ${dir}/`)
}

console.log(`[build-site] 完成 → ${OUT_DIR}/`)
