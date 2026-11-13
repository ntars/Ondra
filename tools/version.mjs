/**
 * 版本号递增与发布。
 *
 * ## 内测线的编号规则
 *
 * 内测版一律带 `-alpha` 后缀，格式 `主.次.修订-alpha`。这次从
 * **1.0.1-alpha** 起算，与之前的 2.x 正式线分开——两者不是同一条继承关系，
 * 混在一起会让「哪个更新」变成一道算术题。
 *
 * | 命令 | 结果 | 会发布吗 |
 * | --- | --- | --- |
 * | `pnpm version:alpha` | 修订 +1（1.0.1 → 1.0.2） | 不发布 |
 * | `pnpm version:alpha --minor` | 次 +1、修订归零（1.0.2 → 1.1.0） | **打 tag 并推送**，由 Actions 构建 macOS + Windows 并发布 pre-release |
 * | `node tools/version.mjs --set 1.0.1-alpha` | 直接写入指定版本 | 不发布 |
 *
 * 「次版本 +1 就自动上传」是产品决定：次版本的跨度意味着功能面变了，
 * 需要一个可回滚的发布点；修订版只是修修补补，本地递增即可。
 *
 * ## 为什么改六处
 *
 * 版本号散在六个文件里，且各有各的用途：
 *
 * | 文件 | 谁读它 |
 * | --- | --- |
 * | `package.json` | 仓库根，脚本与 CI 打印 |
 * | `src/package.json` | 前端包 |
 * | `cordis-host/package.json` | 宿主 |
 * | `dsh-sidecar/package.json` | 内核 |
 * | `src-tauri/tauri.conf.json` | **安装包与关于页的版本**，Tauri 打包时读它 |
 * | `src-tauri/Cargo.toml` | Rust 二进制 |
 *
 * 漏掉 `tauri.conf.json` 的后果最隐蔽：界面写着新版本，安装包信息里还是旧的。
 * 所以这里用**同一个正则改同一个字面量**，六处不一致就直接报错退出，
 * 而不是"改了五处、剩下一处留给下次发现"。
 *
 * ## 为什么次版本递增时要求工作区干净
 *
 * 脚本只提交这六个文件。如果工作区里还有别的未提交改动，tag 指向的提交
 * 就不包含那些改动——CI 构建出来的包与用户本机的代码不是同一份。
 * 这种"发出去的包少了一个功能"的事故，事后极难对上账，所以宁可拒绝执行。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/** 需要同步版本号的文件。`kind` 决定替换用的正则。 */
const TARGETS = [
  { path: 'package.json', kind: 'json' },
  { path: 'src/package.json', kind: 'json' },
  { path: 'cordis-host/package.json', kind: 'json' },
  { path: 'dsh-sidecar/package.json', kind: 'json' },
  { path: 'src-tauri/tauri.conf.json', kind: 'json' },
  { path: 'src-tauri/Cargo.toml', kind: 'toml' },
  /*
   * `Cargo.lock` 里也有这个包的版本。
   *
   * 不写它的后果：`cargo build` 会把 lock 改成新版本，于是**仓库里多出
   * 一处未提交的改动**——而下一次 `--minor` 发布会因为「工作区不干净」
   * 被脚本自己挡下来，用户看到的原因却是"有未提交改动"，与真正的原因无关。
   */
  { path: 'src-tauri/Cargo.lock', kind: 'lock' },
]

/** 版本形状：`主.次.修订` + 可选的 `-alpha`。 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-alpha)?$/

/** 读仓库根 `package.json` 的版本。 */
function readVersion() {
  const raw = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  return String(raw.version)
}

/** 把版本写进六个文件，返回改动过的文件清单。 */
function writeVersion(next) {
  const changed = []
  for (const target of TARGETS) {
    const file = join(repoRoot, target.path)
    const before = readFileSync(file, 'utf8')
    let after
    if (target.kind === 'json') {
      after = before.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`)
    } else if (target.kind === 'lock') {
      /* lock 里同名包不止一个版本，必须用包名锚定，不能只认 `version`。 */
      after = before.replace(/(name = "ondra"\nversion = ")[^"]+(")/, `$1${next}$2`)
    } else {
      /*
       * TOML 只在 `[package]` 段里有一行裸 `version = "..."`。
       * 用 `^version` 锚定行首，避免误改依赖里带 version 字段的行。
       */
      after = before.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`)
    }
    if (after === before) {
      throw new Error(`${target.path} 里没找到可替换的版本号，版本同步中止`)
    }
    writeFileSync(file, after, 'utf8')
    changed.push(target.path)
  }
  return changed
}

/** 跑一条 git 命令，输出透传到终端。 */
function git(args) {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'inherit' })
}

/** 工作区是否干净（忽略未跟踪文件：构建产物本来就在 .gitignore 之外）。 */
function isClean() {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return out.trim() === ''
}

/** 解析参数。 */
function parseArgs(argv) {
  const options = { set: undefined, minor: false, dryRun: false, allowDirty: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--set') {
      options.set = argv[index + 1]
      index += 1
    } else if (arg === '--minor') {
      options.minor = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--allow-dirty') {
      options.allowDirty = true
    }
  }
  return options
}

/** 计算下一个版本。 */
function nextVersion(current, minor) {
  const match = VERSION_RE.exec(current)
  if (match === null) throw new Error(`当前版本号认不出来：${current}`)
  const major = Number(match[1])
  const mid = Number(match[2])
  const patch = Number(match[3])
  return minor
    ? `${String(major)}.${String(mid + 1)}.0-alpha`
    : `${String(major)}.${String(mid)}.${String(patch + 1)}-alpha`
}

const options = parseArgs(process.argv.slice(2))
const current = readVersion()
const target = options.set ?? nextVersion(current, options.minor)

if (!VERSION_RE.test(target)) {
  console.error(`版本号形状不对：${target}（应为 主.次.修订 或 主.次.修订-alpha）`)
  process.exit(1)
}

console.log(`版本：${current} → ${target}`)

if (options.dryRun) {
  console.log('（演练模式：未写入任何文件）')
  process.exit(0)
}

const changed = writeVersion(target)
console.log(`已写入 ${String(changed.length)} 个文件：${changed.join('、')}`)

/*
 * 只有「次 +1」才发布。
 *
 * `--set` 是首次内测与手工修正用的，不触发发布；修订递增也不触发。
 */
const publish = options.minor
if (!publish) {
  console.log('修订版不自动发布。要发布次版本，用 `pnpm version:alpha --minor`。')
  process.exit(0)
}

if (!isClean() && !options.allowDirty) {
  console.error('')
  console.error('工作区有未提交的改动，发布会中止。')
  console.error('原因：脚本只提交版本文件，其余改动不会进这次提交，')
  console.error('      于是 tag 指向的代码与 CI 构建出来的包不是同一份。')
  console.error('先提交或暂存这些改动，再重跑；确实要强行发布就加 --allow-dirty。')
  process.exit(1)
}

const tag = `v${target}`
git(['add', ...changed])
git(['commit', '-m', `chore(release): ${tag}`])
git(['tag', '-a', tag, '-m', tag])
git(['push', 'origin', 'HEAD'])
git(['push', 'origin', tag])
console.log(`已推送 ${tag}：Actions 会构建 macOS + Windows 并发布 pre-release。`)
