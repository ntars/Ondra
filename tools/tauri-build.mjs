/**
 * 调 `tauri build`，但只出 `.app`（macOS）或 `.exe`（Windows）。
 *
 * ## 为什么需要一个包装脚本
 *
 * 两件事 `tauri build` 自己做不了，或者做不对：
 *
 * **1. cargo 不在 PATH 里。**
 * `rustup` 默认把 cargo 装到 `~/.cargo/bin`，但只在交互式 shell 的 rc 文件里
 * 加这一行。构建脚本从非交互 shell 启动时拿不到它，`tauri build` 会直接报
 * `failed to run cargo metadata ... No such file or directory`。
 * 这里显式把 `~/.cargo/bin` 补进 PATH，而不是要求用户去改 shell 配置。
 *
 * **2. dmg 打包在较新的 macOS 上必失败。**
 * Tauri 内置的 `bundle_dmg.sh` 用 `grep -E "/dev/disk15s1"` 找挂载点，
 * 正则里的 `[` `]` 未闭合，`grep` 直接报 `bad regex`，于是找不到临时映像，
 * 报错退出——还会把临时映像留在系统里不卸载。
 * 因此这里用 `--bundles app` 明确跳过 dmg，dmg 交给 `tools/make-dmg.mjs`。
 *
 * ## 为什么不直接用 `tauri.conf.json` 的 `bundle.targets` 控制
 *
 * `targets` 是一份静态清单，两个平台共用。用命令行参数控制更准确：
 * 在 macOS 上要 app 不要 dmg，在 Windows 上要 nsis 不要别的，
 * 这类"按平台分支"的逻辑写在 JS 里比写在 JSON 里清楚。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * 组装 PATH：把 cargo 目录前置。
 *
 * `~/.cargo/bin` 是 rustup 在两个平台上的默认安装位置。
 * 若用户用系统包管理器装的 rust（比如 Homebrew），cargo 本来就在 PATH 里，
 * 这里补一次也不会出错——前置于已存在的目录只是让查找顺序更确定。
 */
function withCargoOnPath() {
  const cargoBin = join(homedir(), '.cargo', 'bin')
  const current = process.env.PATH ?? ''
  if (current.split(delimiter).includes(cargoBin)) return current
  return `${cargoBin}${delimiter}${current}`
}

// 先确认 cargo 真的能找到，否则给出人能看懂的提示，
// 而不是让 tauri 抛一句 "failed to run cargo metadata"。
const env = { ...process.env, PATH: withCargoOnPath() }
try {
  const version = execFileSync('cargo', ['--version'], { encoding: 'utf8', env }).trim()
  console.log(`cargo：${version}`)
} catch {
  console.error('找不到 cargo。请先安装 Rust 工具链：https://rustup.rs')
  process.exit(1)
}

// 按平台决定出什么包。macOS 只要 .app（dmg 自己另做），Windows 只要 nsis 安装包。
const bundles = process.platform === 'win32' ? 'nsis' : 'app'
console.log(`打包目标：${bundles}`)

try {
  execFileSync(
    'pnpm',
    ['exec', 'tauri', 'build', '--bundles', bundles, '--config', '{"build":{"beforeBuildCommand":""}}'],
    { cwd: repoRoot, env, stdio: 'inherit' },
  )
} catch {
  console.error('tauri build 失败，见上方输出。')
  process.exit(1)
}

/**
 * 校验产物真的落地了。
 *
 * `tauri build` 返回 0 但什么都没产出是可能发生的（比如 `--bundles` 写了
 * 当前平台不支持的值，它只打一行警告）。这一步让失败在打包阶段暴露，
 * 而不是等到用户双击安装包才发现。
 */
const expected = process.platform === 'win32'
  ? join(repoRoot, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
  : join(repoRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos')

if (!existsSync(expected)) {
  console.error(`打包报告成功，但没找到产物目录：${expected}`)
  process.exit(1)
}

console.log(`产物目录：${expected}`)
