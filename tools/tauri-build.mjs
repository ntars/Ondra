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
import { existsSync, readdirSync, statSync } from 'node:fs'
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

/**
 * tauri CLI 的 JS 入口。用 `node <entry>` 起它，而不是 `pnpm exec tauri`。
 *
 * ## 为什么绕开 pnpm
 *
 * Windows 上有两道叠加的坑：
 *
 * 1. `pnpm` 实际是 `pnpm.CMD`，`execFileSync` 不经过 shell，找不到；
 * 2. 就算写成 `pnpm.cmd`，Node ≥ 18.20 出于安全考虑**拒绝**在不开 shell 的
 *    情况下启动 `.cmd` / `.bat`，抛的是 `EINVAL`——而不是「找不到文件」。
 *
 * 第二条正是 1.0.1-alpha 第三次云端构建的报错（`spawnSync pnpm.cmd EINVAL`）。
 * 开 `shell: true` 能绕过去，但 `--config '{"build":…}'` 这个参数带引号与
 * 花括号，交给 shell 拼字符串就会在 Windows 上被拆坏。
 *
 * 于是换一条没有 shell 的路：`node node_modules/@tauri-apps/cli/tauri.js`。
 * 三个平台同一个写法，参数按数组传，不存在引号问题。
 */
const tauriCli = join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

/**
 * pnpm 的可执行名，按平台分。
 *
 * 只在「前端产物落后、需要补一次 build:web」时用到。那条命令的参数不含
 * 引号与空格，开 shell 是安全的，所以 Windows 上直接开 shell。
 */
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

/**
 * 源码是否比前端产物新。
 *
 * ## 为什么需要这一道
 *
 * 下面 `--config` 清空了 `beforeBuildCommand`——`pnpm run build:app` 链里
 * 已经跑过一次 `build:web`，再跑一遍是重复工作。代价是**单独运行本脚本时
 * 没有人为前端产物负责**：改了 `src/` 却直接打包，打进包的是上一次的 dist。
 *
 * 那种故障比构建失败难查得多：构建失败会停下来，这个不会——日志全绿、
 * 应用正常启动，只有"改动没生效"。实测踩过一次：改完前端直接打包，
 * 装上去看见的还是旧界面，回头去查 CSS 查了很久。
 *
 * @returns {boolean} 需要先构建前端
 */
function frontendIsStale() {
  const newestIn = (dir, skip) => {
    let newest = 0
    const walk = (current) => {
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (skip.includes(entry.name)) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        try {
          const time = statSync(full).mtimeMs
          if (time > newest) newest = time
        } catch {
          // 单个文件读不到不影响整体判断。
        }
      }
    }
    walk(dir)
    return newest
  }

  const dist = join(repoRoot, 'dist', 'assets')
  if (!existsSync(dist)) return true

  const sourceTime = newestIn(join(repoRoot, 'src'), ['node_modules', 'assets'])
  const bundleTime = newestIn(dist, [])
  return sourceTime > bundleTime
}

if (frontendIsStale()) {
  console.log('前端产物落后于源码，先构建……')
  try {
    execFileSync(pnpm, ['run', 'build:web'], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      // Windows 上 pnpm 是 .cmd，Node 不允许无 shell 启动它。这里的参数不含引号，开 shell 安全。
      shell: process.platform === 'win32',
    })
  } catch (error) {
    console.error('前端构建失败，见上方输出。', error instanceof Error ? error.message : '')
    process.exit(1)
  }
}

if (!existsSync(tauriCli)) {
  console.error(`找不到 tauri CLI：${tauriCli}。请先在仓库根执行 pnpm install。`)
  process.exit(1)
}

try {
  /*
   * 用 node 直接跑 CLI 的 JS 入口，见文件上方 `tauriCli` 的注释。
   * `--config` 里清空 `beforeBuildCommand`：前端已由 root build 或上一步负责。
   */
  execFileSync(
    process.execPath,
    [tauriCli, 'build', '--bundles', bundles, '--config', '{"build":{"beforeBuildCommand":""}}'],
    { cwd: repoRoot, env, stdio: 'inherit' },
  )
} catch (error) {
  /*
   * 连错误信息一起打。
   *
   * `stdio: 'inherit'` 只转交**子进程**的输出；子进程根本没起来时（ENOENT、
   * 权限、解释器缺失），上方会一片空白，只剩这一行「失败」——上一版就是
   * 这样把「pnpm 不存在」读成了「tauri 崩了」。
   */
  console.error('tauri build 失败，见上方输出。', error instanceof Error ? error.message : '')
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
