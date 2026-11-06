/**
 * `manual` 分支：打包后**逐层手工重签**。
 *
 * ## 什么时候才该用它
 *
 * 只有一种：**必须在打包完成之后才改 bundle 名**（例如给一份已产出的包做定制改名）。
 * 正常发版一律走 `builder`——那条链自带 `afterSign` 校验，手工这条没有。
 *
 * ## 三层「不碰」
 *
 * 上游 `mac.signIgnore` 写着三条正则，对应三棵**预签子树**：
 * `Contents/Resources/runtime/primary-runtime`、`Contents/Resources/app.asar.unpacked/ondra/`、
 * 以及所有 `*.pak`。它们不是「还没签」，而是「已经签过了、由别的流程负责」。
 *
 * `codesign --deep` 会连它们一起重签，把供应商签名换成自己的。后果不是「多签了一次」，
 * 而是**原来的签名被覆盖**，`ondra` 的哈希清单对不上，运行时自检失败，
 * 而错误信息会指向一个跟签名毫无关系的模块。所以这里逐层点名、逐层跳过。
 *
 * ## 顺序为什么是由内向外
 *
 * 外层 bundle 的签名覆盖内层代码的 cdhash。先签外层再改内层，外层立刻失效；
 * 而 `codesign --verify` 只会说「签名无效」，不会说「你顺序反了」。
 * 这一条是平台通识（`通识`），本仓库没有手工重签的先例。
 */

import { LAYERS } from './spec.js'
import type { Config } from './settings.js'
import type { RebrandStep } from './types.js'

/** entitlement 文件（仓库相对路径，与 `mac.entitlements` 同一个）。 */
const ENTITLEMENTS = 'desktop/apps/desktop/scripts/macos-entitlements.plist'

/**
 * 拼一条 codesign 命令。
 *
 * 参数与上游 `signMacOSRuntimeCode` 逐字对齐：`--force --sign --timestamp --options runtime --entitlements`。
 * 少任何一个都会被 `assertMacOSRuntimeSignatureDetails` 判不过。
 * @param target 待签路径。
 * @param identity 证书限定名（不含 `Developer ID Application:` 前缀）。
 */
function signCommand(target: string, identity: string): string {
  const name = identity === '' ? '<证书限定名>' : identity
  return `codesign --force --sign "${name}" --timestamp --options runtime --entitlements ${ENTITLEMENTS} "${target}"`
}

/**
 * 取 `.app` 的父目录。占位符没有父目录时返回 `.`，
 * 否则会拼出 `<App>.app/<产物>.dmg` 这种一眼假、却看着像能跑的命令。
 * @param app `.app` 路径（可能是占位符）。
 */
function parentOf(app: string): string {
  const cut = app.lastIndexOf('/')
  return cut <= 0 ? '.' : app.slice(0, cut)
}

/**
 * 编 `manual` 分支的步骤。
 * @param settings 生效配置。
 */
export function planManual(settings: Config): readonly RebrandStep[] {
  const app = settings.appPath === '' ? '<App>.app' : settings.appPath
  const name = settings.displayName === '' ? '<新显示名>' : settings.displayName
  const steps: Omit<RebrandStep, 'index'>[] = [
    {
      kind: 'verify',
      title: '先确认原包完好',
      detail: '改之前先验一次。原包本来就坏的话，改完分不清是谁弄坏的。',
      command: `codesign --verify --deep --strict --verbose=2 "${app}"`,
      source: '上游源码',
    },
    {
      kind: 'rename',
      title: '改 Info.plist 三处名字',
      detail: `CFBundleName / CFBundleDisplayName / CFBundleExecutable 一起改成「${name}」。**改完 bundle 签名立即失效**——签名覆盖 Info.plist 的哈希，这是必然后果，不是意外。`,
      command: `plutil -replace CFBundleName -string "${name}" "${app}/Contents/Info.plist"`,
      source: '通识',
    },
    {
      kind: 'rename',
      title: '改可执行文件名',
      detail: '`Contents/MacOS/` 里的文件名必须与 `CFBundleExecutable` 一致，否则包双击打不开（Finder 报「应用已损坏」）。',
      command: `mv "${app}/Contents/MacOS/<旧名>" "${app}/Contents/MacOS/${name}"`,
      source: '通识',
    },
    {
      kind: 'rename',
      title: '换图标并改 plist 引用',
      detail: '把 `.icns` 拷进 `Contents/Resources/`，再把 `CFBundleIconFile` 指过去。只换图不改键，Dock 还是旧图。',
      command: `plutil -replace CFBundleIconFile -string "app.icns" "${app}/Contents/Info.plist"`,
      source: '通识',
    },
    {
      kind: 'resign',
      title: '跳过预签子树（不要 --deep）',
      detail: `不要用 \`codesign --deep\`。它会重签 runtime / \`ondra\` 两棵树和所有 \`*.pak\`，把原有签名换掉。下面 ${String(LAYERS.filter(layer => layer.action === 'sign').length)} 步逐层点名，就是要避开它们。`,
      source: '上游源码',
    },
  ]

  for (const layer of LAYERS) {
    if (layer.action !== 'sign') continue
    if (layer.id === 'dmg') {
      steps.push({
        kind: 'resign',
        title: '重做镜像并签',
        detail: '改过 `.app` 之后镜像里的内容已经变了，旧镜像必须作废重做，再做一次镜像签名。',
        layer: layer.id,
        command: `codesign --force --sign "${settings.signingIdentity === '' ? '<证书限定名>' : settings.signingIdentity}" --timestamp "${parentOf(app)}/<产物>.dmg"`,
        source: layer.source,
      })
      continue
    }
    const target = `${app}/${layer.path}`
    steps.push({
      kind: 'resign',
      title: `签 ${layer.id}（第 ${String(layer.order)} 层）`,
      detail: layer.why,
      layer: layer.id,
      command: signCommand(target, settings.signingIdentity),
      source: layer.source,
    })
  }

  steps.push(
    {
      kind: 'verify',
      title: '整包校验',
      detail: '`--verify --deep` 用在这里是对的：校验要看穿嵌套；签名时用 `--deep` 才是错的。',
      command: `codesign --verify --deep --strict --verbose=2 "${app}"`,
      source: '上游源码',
    },
    {
      kind: 'verify',
      title: '判签名身份',
      detail: '把 `codesign --display --verbose=4` 的原文喂给 `judgeSignature()`，逐条看身份、团队、时间戳、hardened runtime。',
      command: `codesign --display --verbose=4 "${app}"`,
      source: '上游源码',
    },
    {
      kind: 'verify',
      title: '重新公证（改过包就必须重做）',
      detail: '公证票据绑定的是 cdhash。改过 Info.plist 之后旧票据必然作废，`stapler validate` 会失败——这是正确行为，不是回归。',
      command: `xcrun stapler validate "${app}" && spctl --assess --type execute --verbose=4 "${app}"`,
      source: '通识',
    },
  )

  return steps.map((step, index) => ({ ...step, index: index + 1 }))
}
