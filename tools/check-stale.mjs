#!/usr/bin/env node
/**
 * `check:stale` —— 产物新鲜度总闸。
 *
 * ## 为什么需要这条检查
 *
 * 巡检脚本、`node tools/ondra.mjs`、甚至「实机验证」读的都是**产物**
 * （`cordis-host/lib/*.js`、各插件 `lib/*.js`、`releases/` 里的打包应用）。
 * 源码改了而不重新构建，症状不是报错，而是**所有检查照旧全绿**：
 *
 * | 现场 | 看到的东西 | 真相 |
 * | --- | --- | --- |
 * | 运行中的宿主 | `phase: ready`、`say` 有回复 | 跑的是几小时前的 `lib` |
 * | `ondra.mjs config` | 64 个配置段 | 新加的 `settings.ts` 一个都没注册 |
 * | `debug.log` | 旧格式日志（`%.2f` 掉行尾） | 修好的代码根本没上机 |
 *
 * 这类「假绿」比红更贵：它让人得出「已经修好了」的结论。
 * 2026-11-12 那几轮就反复踩在这里——每轮都验，验的却不是当轮的代码。
 *
 * ## 判据
 *
 * 逐个包比「`src/**\/*.ts` 最新时间」与「`lib/**\/*.js` 最新时间」，
 * 源码更新即判失效。另外单独比一次打包应用里的宿主入口：
 * 它落后于仓库产物时只警告，因为出包成本高（约 2 分钟），
 * 不该让每小时巡检都因为「没出包」而红。
 *
 * 容差 2 秒：`tsc` 写产物与源文件落盘的先后顺序不固定，留窄窗避免误报。
 *
 * ## 用法
 *
 * ```bash
 * pnpm run check:stale      # 全绿退 0，有旧产物退 1
 * node tools/check-stale.mjs --fix-hint   # 只多打印一行该跑什么
 * ```
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 项目根（tools/ 的上一级）。 */
const ROOT = join(import.meta.dirname, '..')

/** 产物与源码的 mtime 容差（毫秒）。 */
const STALE_TOLERANCE_MS = 2000

/**
 * 递归收集某目录下指定后缀的最新修改时间。
 * @param {string} dir 目录。
 * @param {readonly string[]} exts 后缀（含点）。
 * @returns {number} 最新 mtime（毫秒）；目录不存在或无匹配文件时返回 0。
 */
function newestMtime(dir, exts) {
  if (!existsSync(dir)) return 0
  let newest = 0
  /** @type {string[]} */
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        // `node_modules` 与增量编译缓存不参与比较。
        if (entry.name === 'node_modules') continue
        stack.push(path)
        continue
      }
      if (!exts.some((ext) => entry.name.endsWith(ext))) continue
      try {
        const mtime = statSync(path).mtimeMs
        if (mtime > newest) newest = mtime
      } catch {
        /* 读不到就跳过，不因单个文件失败而中断 */
      }
    }
  }
  return newest
}

/**
 * 列出需要比对的包：宿主本身 + 每个插件 + sidecar + 前端。
 * @returns {readonly {name: string, srcDir: string, srcExts: readonly string[], outDir: string, outExts: readonly string[]}[]}
 */
function buildTargets() {
  const targets = [
    {
      name: 'cordis-host',
      srcDir: join(ROOT, 'cordis-host', 'src'),
      srcExts: ['.ts'],
      // 宿主入口在包根，不在 `src/` 里；漏掉它就会「改了入口不重建也判绿」。
      extraSrc: [join(ROOT, 'cordis-host', 'index.ts')],
      outDir: join(ROOT, 'cordis-host', 'lib'),
      outExts: ['.js'],
    },
    {
      name: 'dsh-sidecar',
      srcDir: join(ROOT, 'dsh-sidecar', 'src'),
      srcExts: ['.ts'],
      outDir: join(ROOT, 'dsh-sidecar', 'lib'),
      outExts: ['.js'],
    },
    {
      name: '@ondra/web',
      srcDir: join(ROOT, 'src'),
      srcExts: ['.ts', '.tsx'],
      outDir: join(ROOT, 'dist'),
      outExts: ['.js'],
    },
  ]

  const pluginsDir = join(ROOT, 'cordis-host', 'plugins')
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      targets.push({
        name: `plugins/${entry.name}`,
        srcDir: join(pluginsDir, entry.name, 'src'),
        srcExts: ['.ts'],
        outDir: join(pluginsDir, entry.name, 'lib'),
        outExts: ['.js'],
      })
    }
  }
  return targets
}

const stale = []
for (const target of buildTargets()) {
  let srcNewest = newestMtime(target.srcDir, target.srcExts)
  for (const file of target.extraSrc ?? []) {
    if (!existsSync(file)) continue
    try {
      srcNewest = Math.max(srcNewest, statSync(file).mtimeMs)
    } catch {
      /* 读不到就跳过 */
    }
  }
  const outNewest = newestMtime(target.outDir, target.outExts)
  if (srcNewest === 0) continue // 没有源码就没有「是否旧」的问题
  if (outNewest === 0) {
    stale.push(`${target.name}：有源码但没有任何产物（${relative(ROOT, target.outDir)} 不存在或为空）`)
    continue
  }
  const behind = srcNewest - outNewest
  if (behind > STALE_TOLERANCE_MS) {
    stale.push(`${target.name}：源码比产物新 ${Math.round(behind / 1000)} 秒`)
  }
}

console.log('=== 产物新鲜度 ===')
if (stale.length === 0) {
  console.log('  ✓ 全部包的产物都不旧于源码')
} else {
  for (const line of stale) console.log(`  ✗ ${line}`)
  console.log('')
  console.log('  这些包的产物与源码不同步：此刻跑的任何检查、任何实机验证，')
  console.log('  读到的都是旧代码，结论不可信。')
  console.log('  修：pnpm run build（只改 TS）· pnpm run build:app（改了 Rust / 前端）')
}

/* ------------------------------------------------------------------ *
 * 打包应用：落后只警告，不判红
 * ------------------------------------------------------------------ */

const APP_HOST_ENTRY = join(
  ROOT,
  'releases',
  'macos',
  '空谷 Ondra.app',
  'Contents',
  'Resources',
  'cordis-host',
  'lib',
  'index.js',
)
const REPO_HOST_ENTRY = join(ROOT, 'cordis-host', 'lib', 'index.js')

if (existsSync(APP_HOST_ENTRY) && existsSync(REPO_HOST_ENTRY)) {
  const behind = statSync(REPO_HOST_ENTRY).mtimeMs - statSync(APP_HOST_ENTRY).mtimeMs
  if (behind > STALE_TOLERANCE_MS) {
    console.log('')
    console.log(
      `  ⚠ 打包应用里的宿主入口比仓库产物旧 ${Math.round(behind / 60000)} 分钟：`,
    )
    console.log('    若用 open releases/macos/空谷 Ondra.app 做「实机验证」，验的是旧代码。')
    console.log('    要让修复上机：CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm run build:app')
  }
}

if (stale.length > 0) process.exit(1)
