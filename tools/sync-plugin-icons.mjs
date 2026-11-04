#!/usr/bin/env node
/**
 * 插件图标同步：把根目录 icon.svg 复制成每个插件的 icon.svg。
 *
 * 为什么不直接让插件引用根目录那一个文件：
 * 宿主读取插件图标时会做一次 realpath（见 desktop/packages/boot/app-boot/src/package-meta.ts），
 * 凡是解析后跑到包目录之外的，一律判「icon must remain inside its manifest directory」并丢弃图标。
 * 所以软链接指向公共图标的做法在运行时会被拒；这里改用「单一真源 + 生成副本」：
 * 根 icon.svg 是唯一真源，插件里的 icon.svg 都是它的副本，由本脚本负责写。
 *
 * 用法：
 *   node tools/sync-plugin-icons.mjs          # 写入，把有漂移的插件图标刷成真源内容
 *   node tools/sync-plugin-icons.mjs --check  # 只检查，有漂移就列出来并以退出码 1 结束
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'icon.svg')
const PLUGIN_DIR = join(ROOT, 'cordis')

/** 读出真源内容，同时挡住「真源被误删」这种一改就全空的情况。 */
function readSource() {
  let bytes
  try {
    bytes = readFileSync(SOURCE)
  } catch {
    throw new Error(`找不到图标真源：${SOURCE}`)
  }
  if (bytes.length === 0) throw new Error(`图标真源是空文件：${SOURCE}`)
  return bytes
}

/** 列出 cordis 下所有真插件目录（必须有 package.json，纯数据目录不算插件）。 */
function listPluginDirs() {
  return readdirSync(PLUGIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('ondra-'))
    .map((entry) => join(PLUGIN_DIR, entry.name))
    .filter((dir) => {
      try {
        return statSync(join(dir, 'package.json')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

const source = readSource()
const checkOnly = process.argv.includes('--check')
const dirs = listPluginDirs()
const drifted = []

for (const dir of dirs) {
  const target = join(dir, 'icon.svg')
  let current
  try {
    current = readFileSync(target)
  } catch {
    current = undefined
  }
  if (current !== undefined && current.equals(source)) continue
  drifted.push(dir)
  if (!checkOnly) writeFileSync(target, source)
}

const action = checkOnly ? '漂移' : '已同步'
if (drifted.length === 0) {
  console.log(`插件图标 ${dirs.length} 个，全部与真源一致。`)
} else {
  console.log(`插件图标 ${dirs.length} 个，${action} ${drifted.length} 个：`)
  for (const dir of drifted) console.log(`  - ${dir.replace(`${ROOT}/`, '')}`)
  if (checkOnly) process.exitCode = 1
}
