/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { PRODUCT_NAME } from './product-name.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const artifacts = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] }).directory
const application = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', `${PRODUCT_NAME}.app`, 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
// Windows 的可执行文件名跟着 productName 走（electron-builder 用中文名原样落盘），
// 不能再写字面量 'Ondra.exe'——那是改名前的旧名，会让冒烟脚本 ENOENT 而卡住上传。
const executable = windows ? join(application, `${PRODUCT_NAME}.exe`) : join(application, 'MacOS', PRODUCT_NAME)
const descriptor = await verifyDesktopRuntime(paths.ondra, readDesktopRuntime(paths.ondra).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'ondra'), executable, join(resources, 'runtime'), descriptor)
