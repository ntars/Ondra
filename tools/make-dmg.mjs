/**
 * 用系统自带的 `hdiutil` 生成 dmg，替代 Tauri 内置的 `bundle_dmg.sh`。
 *
 * ## 为什么不用 Tauri 自带的那个脚本
 *
 * `bundle_dmg.sh` 是第三方 `create-dmg` 的改写版，里面有这一行：
 *
 * ```sh
 * found_dir=$(hdiutil info | grep -E --color=never "${dev_name}" | ...)
 * ```
 *
 * `${dev_name}` 形如 `/dev/disk15s1`，直接塞进 `grep -E` 会被当成正则：
 * `[` `]` 未闭合 → `grep: bad regex`，于是拿不到挂载点，
 * 最终报 "interstitial disk image was not found"，并把临时映像留在系统里。
 *
 * 新版 macOS（这里测的是 `hdiutil` 已弃用 `create/resize/attach/detach`
 * 一组动词的版本）上这个脚本还有第二重问题：`hdiutil create` 的旧参数
 * 仍然能跑但会刷一整屏弃用警告，把真正的错误埋掉。
 *
 * 与其给第三方脚本打补丁（升级 Tauri 时会覆盖掉），不如自己做一件更简单的事：
 * 建一个空映像 → 挂载 → 拷 `.app` 与 Applications 软链 → 卸载 → 转成压缩格式。
 * 只有 6 步，每一步都能单独验证。
 *
 * ## 产物形状
 *
 * 打开 dmg 看到的是标准的「左边应用、右边 Applications」布局，
 * 用户把图标拖过去就是安装。没有背景图和自定义窗口位置——
 * 那些需要 Finder AppleScript 自动化，在无人值守环境里经常卡死，
 * 收益（好看一点）不值得引入这个不确定性。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const bundleRoot = join(repoRoot, 'src-tauri', 'target', 'release', 'bundle')
const appDir = join(bundleRoot, 'macos', '空谷 Ondra.app')
const outDir = join(bundleRoot, 'dmg')

if (!existsSync(appDir)) {
  console.error(`找不到应用包：${appDir}`)
  console.error('请先运行 `pnpm exec tauri build --bundles app` 生成 .app。')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

/** 从 package.json 读版本，避免和产物文件名对不上。 */
function readVersion() {
  const pkg = JSON.parse(
    execFileSync('node', ['-e', `console.log(JSON.stringify(require('${repoRoot}/package.json').version))`], {
      encoding: 'utf8',
    }),
  )
  return pkg
}

const version = readVersion()
const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
const volumeName = '空谷 Ondra'
const finalDmg = join(outDir, `${volumeName}_${version}_${arch}.dmg`)
// SPARSE 类型会自动补 `.sparseimage` 后缀，后面所有命令都得用带后缀的真实路径。
const baseTemp = join(outDir, `.tmp-${version}-${arch}`)
const tempDmg = `${baseTemp}.sparseimage`

/** 跑一条命令，失败时把它自己和输出一起抛出来。 */
function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
    throw new Error(`${command} ${args.join(' ')} 失败：\n${stderr}`)
  }
}

/**
 * 从 `hdiutil attach` 的输出里取挂载点。
 *
 * 输出是多列制表符分隔的表，最后一列是挂载路径。不能用正则去匹配设备名
 * （这正是原脚本的 bug），按下标取列最稳。
 */
function parseMountPoint(attachOutput) {
  for (const line of attachOutput.split('\n')) {
    if (!line.startsWith('/dev/')) continue
    const columns = line.split('\t')
    const last = columns.at(-1)?.trim()
    if (last?.startsWith('/Volumes/')) return last
  }
  return undefined
}

/** 挂载点是否真的没了；卸载偶尔要等一两秒。 */
function unmount(mountPoint) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!existsSync(mountPoint)) return true
    try {
      run('hdiutil', ['detach', mountPoint, '-force'])
    } catch {
      // 第一两次失败通常是卷还被 Finder 占着，重试即可。
    }
  }
  return !existsSync(mountPoint)
}

/**
 * 估算映像容量。
 *
 * `hdiutil create -size` 给小了会在拷贝阶段报 "No space left on device"，
 * 给大了浪费磁盘（dmg 最终会压缩，所以只影响中间文件）。
 * 应用体积 + 64 MB 余量；Applications 软链本身不占空间。
 */
function estimateSize(appPath) {
  const bytes = Number(run('du', ['-sk', appPath]).split('\t')[0]) * 1024
  return Math.ceil((bytes + 64 * 1024 * 1024) / (1024 * 1024))
}

console.log(`应用包：${appDir}`)
console.log(`版本：${version}（${arch}）`)

// 上一次失败可能留下同名中间文件。
if (existsSync(tempDmg)) unlinkSync(tempDmg)

const sizeMb = estimateSize(appDir)
console.log(`中间映像容量：${String(sizeMb)} MB`)

// `-type SPARSE` 建空白稀疏映像：容量只是上限，实际只按写入量占盘，
// 所以「按应用体积 + 余量」给足空间不会有代价。
//
// 不能用 `-format UDRW` 建空白映像——那个参数只在 `-srcfolder` / `-srcdevice`
// 模式下有意义，单独建空盘时会报 "-format requires -srcfolder or -srcdevice"。
run('hdiutil', [
  'create',
  '-size', `${String(sizeMb)}m`,
  '-type', 'SPARSE',
  '-fs', 'HFS+',
  '-volname', volumeName,
  baseTemp,
])

const attachOutput = run('hdiutil', ['attach', tempDmg, '-nobrowse', '-noautoopen'])
const mountPoint = parseMountPoint(attachOutput)
if (mountPoint === undefined) {
  console.error('无法确定挂载点，hdiutil 输出如下：')
  console.error(attachOutput)
  process.exit(1)
}
console.log(`挂载点：${mountPoint}`)

try {
  // `ditto` 而不是 `cp -R`：前者保留资源叉、扩展属性与代码签名。
  // 用 cp 拷出来的 .app 签名容易失效，用户打开会看到"已损坏"。
  run('ditto', [appDir, join(mountPoint, '空谷 Ondra.app')])
  run('ln', ['-s', '/Applications', join(mountPoint, 'Applications')])
} finally {
  // 无论拷贝是否成功都要卸载，不能把映像留在系统里。
  if (!unmount(mountPoint)) {
    console.error(`警告：${mountPoint} 未能卸载，请手动执行 hdiutil detach "${mountPoint}"`)
    process.exit(1)
  }
}

// 先删旧的最终产物：hdiutil convert 不会覆盖，会直接报"文件已存在"。
if (existsSync(finalDmg)) unlinkSync(finalDmg)

run('hdiutil', ['convert', tempDmg, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', finalDmg])
unlinkSync(tempDmg)

const sizeMbFinal = (statSync(finalDmg).size / 1024 / 1024).toFixed(1)
console.log(`完成：${finalDmg}（${sizeMbFinal} MB）`)

// 卸载后 /Volumes 下会留一个空目录，hdiutil 自己不清。
if (existsSync(mountPoint)) {
  try {
    run('rmdir', [mountPoint])
  } catch {
    // 非空说明有别的进程往里写了东西，留着让人看一眼比强删安全。
  }
}

// 让 bundle-release.mjs 能顺带搬产物，这里只做提示，不改别人的职责。
console.log('下一步：`node tools/bundle-release.mjs` 把产物搬到 releases/')
