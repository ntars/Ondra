#!/usr/bin/env node
/**
 * 运行时资源预取器
 *
 * 背景：打包阶段 prepare-runtime 用 node 的 fetch 下载 python-build-standalone 与 wheel，
 * 在本机代理下会被中断（SocketError: other side closed）。curl 走同样的代理却稳定。
 * 所以这个脚本用 curl 预先把所有资源灌进它自己的缓存目录（文件名 = 期望 sha256），
 * 让 prepare-runtime 直接命中缓存、零下载。
 *
 * 校验：下载后立刻比对 sha256，不匹配就丢弃，绝不把坏文件喂给打包流程。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, readFileSync, unlinkSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const LOCK = join(ROOT, 'scripts/primary-runtime/lock.json')
const CACHE = join(ROOT, 'apps/desktop/.desktop-build/downloads')
const TARGET = 'mac-arm64'

const lock = JSON.parse(readFileSync(LOCK, 'utf8'))
const t = lock.targets[TARGET]

/** 收集本次目标需要的一切远程资源 */
const assets = []
// 1. Node 运行时
assets.push({ label: `node ${lock.nodeVersion}`, url: t.nodeArchive, sha256: t.nodeSha256 })
// 2. Python 运行时（这就是断掉的那个）
const pyFile = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${t.pythonTarget}-install_only_stripped.tar.gz`
assets.push({
  label: `python ${lock.pythonVersion}`,
  url: `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(pyFile)}`,
  sha256: t.pythonSha256,
})
// 3. 所有 wheel（目标级 + 全局）
for (const w of [...(t.wheels ?? []), ...(lock.wheels ?? [])]) {
  assets.push({ label: `wheel ${new URL(w.url).pathname.split('/').pop()}`, url: w.url, sha256: w.sha256 })
}

mkdirSync(CACHE, { recursive: true })
console.log(`缓存目录：${CACHE}`)
console.log(`待处理 ${assets.length} 个资源\n`)

let reused = 0
let fetched = 0
let failed = 0

for (const a of assets) {
  const dest = join(CACHE, a.sha256)
  if (existsSync(dest)) {
    const digest = createHash('sha256').update(readFileSync(dest)).digest('hex')
    if (digest === a.sha256) {
      console.log(`✓ 已缓存 ${a.label}`)
      reused++
      continue
    }
    console.log(`△ 缓存损坏，重下 ${a.label}`)
    unlinkSync(dest)
  }
  const tmp = `${dest}.part`
  // 直连 files.pythonhosted.org 在本机只有 ~20KB/s，清华镜像同文件同 sha256 可达 15MB/s。
  // 镜像只是加速通道，最终仍以 sha256 定真假，下歪了会被丢弃并回退原站重试。
  const candidates = []
  if (a.url.includes('files.pythonhosted.org')) {
    candidates.push(a.url.replace('files.pythonhosted.org', 'pypi.tuna.tsinghua.edu.cn'))
  }
  candidates.push(a.url)
  try {
    let done = false
    let lastError = null
    for (const url of candidates) {
      try {
        execFileSync('curl', ['-sL', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20',
          '--max-time', '900', '-o', tmp, url], { stdio: ['ignore', 'ignore', 'pipe'] })
        const digest = createHash('sha256').update(readFileSync(tmp)).digest('hex')
        if (digest !== a.sha256) throw new Error(`校验失败：期望 ${a.sha256.slice(0, 12)}，实得 ${digest.slice(0, 12)}`)
        done = true
        break
      } catch (error) {
        lastError = error
        try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
      }
    }
    if (!done) throw lastError ?? new Error('所有下载通道均失败')
    renameSync(tmp, dest)
    const mb = (statSync(dest).size / 1048576).toFixed(1)
    console.log(`↓ 已下载 ${a.label} (${mb} MB)`)
    fetched++
  } catch (error) {
    console.log(`✗ 失败 ${a.label}：${error instanceof Error ? error.message : String(error)}`)
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
    failed++
  }
}

console.log(`\n结果：复用 ${reused} / 新下载 ${fetched} / 失败 ${failed}`)
if (failed > 0) process.exitCode = 1
