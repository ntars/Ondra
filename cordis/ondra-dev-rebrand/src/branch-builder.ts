/**
 * `builder` 分支：改名交给 electron-builder 的签名链，本包只出步骤。
 *
 * ## 为什么它是默认
 *
 * 上游 `electron-builder-config.mjs` 已经写全了签名参数：
 * `identity`（未签时是 `-` 即 ad-hoc）、`hardenedRuntime: true`、
 * `entitlements` 与 `entitlementsInherit` 都指向 `macos-entitlements.plist`、
 * `signIgnore` 三条、`dmg.sign`、`notarize`。`afterSign` 里还挂了
 * `verifyMacOSSignatureAfterSign`——**签完立刻验**，验不过打包就失败。
 *
 * 也就是说：这条链上没有任何一步需要插件补。插件在这里的价值是
 * **把「改名之后要按这个顺序做」写清楚**，以及指出哪些文件是名字的第二份。
 *
 * ## 为什么不给「手工 codesign」的步骤
 *
 * 一旦这里也写 `codesign`，就会出现两条都能跑通的路径；跑了手工那条，
 * 产物没走 `afterSign` 的校验，签名坏了也没人知道。§12 的纪律是「能融就融」，
 * 这里融不掉的部分不是「加一条命令」，而是「加一条**不该被执行的**命令」。
 * 所以 `builder` 分支的 `resign` 步骤 `command` 一律为空，只说明由谁签。
 */

import type { Config } from './settings.js'
import type { RebrandStep } from './types.js'

/** 打包命令（`package.json` 里真实存在的脚本）。 */
const PACKAGE_COMMAND = 'pnpm --filter @ntars/ondra-desktop run package:mac:arm64'

/** 签名校验命令（同上，`verify:mac-signature` = `node scripts/verify-macos-signature.mjs`）。 */
const VERIFY_COMMAND = 'pnpm --filter @ntars/ondra-desktop run verify:mac-signature -- <App>.app'

/**
 * 编 `builder` 分支的步骤。
 * @param settings 生效配置。
 */
export function planBuilder(settings: Config): readonly RebrandStep[] {
  const name = settings.displayName === '' ? '<新显示名>' : settings.displayName
  const steps: Omit<RebrandStep, 'index'>[] = [
    {
      kind: 'rename',
      title: '改显示名真源',
      detail: `把 \`PRODUCT_NAME\` 改成「${name}」。\`productName\`、协议名、冒烟脚本的产物路径都从这里取，改这一处即可。`,
      file: 'desktop/apps/desktop/scripts/product-name.mjs',
      source: '上游源码',
    },
    {
      kind: 'rename',
      title: '同步关于面板',
      detail: `\`app.setAboutPanelOptions({ applicationName })\` 是硬编码的第二份名字，改成「${name}」。漏了它的表现是「Dock 新名、关于面板旧名」。`,
      file: 'desktop/apps/desktop/src/main.ts',
      source: '上游源码',
    },
    {
      kind: 'rename',
      title: '同步八种语言的品牌词',
      detail: '`aboutProduct` / `welcomeBrand` / `welcomeTitle` / `updateTitle` / 菜单项文案逐语言替换。按词替换，不要整文件替换——文件里还有别的英文句子。',
      file: 'desktop/apps/desktop/src/locale.ts',
      source: '上游源码',
    },
    {
      kind: 'rename',
      title: '换图标（换内容不换文件名）',
      detail: '替换 `resources/icon-macos.png`、`icon-windows.png`、`tray-windows.ico`。`mac.icon` / `win.icon` / `extraResources` 都按这三个文件名引用，改名反而要同步三处配置。',
      file: 'desktop/apps/desktop/resources/',
      source: '上游源码',
    },
    {
      kind: 'rename',
      title: '改麦克风授权文案',
      detail: '`NSMicrophoneUsageDescription` 的句子里写着产品名。不改它，系统授权弹窗还叫旧名。',
      file: 'desktop/apps/desktop/scripts/electron-builder-config.mjs',
      source: '上游源码',
    },
    {
      kind: 'rename',
      title: '改开发包（Harness Dev → 新名）',
      detail: `三处 plist 值（CFBundleName / CFBundleDisplayName / CFBundleExecutable）、\`Contents/MacOS/\` 里的可执行文件名、以及 \`Harness Dev.app\` 目录名一起改成「${name}」。改完删旧目录，否则 Launch Services 里会同时挂着新旧两个包。`,
      file: 'desktop/apps/desktop/scripts/development-app.ts',
      source: '上游源码',
    },
    {
      kind: 'rename',
      title: '给开发包补图标',
      detail: '开发包是从 `Electron.app` 拷的，没有 `CFBundleIconFile`，Dock 上是电子图标。拷 `.icns` 进 `Contents/Resources/` 并 `plutil -replace CFBundleIconFile`。',
      file: 'desktop/apps/desktop/scripts/development-app.ts',
      source: '上游源码',
    },
    {
      kind: 'resign',
      title: '打包（签名由 electron-builder 完成）',
      detail: '不手工 `codesign`。`mac.identity` / `hardenedRuntime` / `entitlements` / `signIgnore` / `dmg.sign` 都在配置里，`afterSign` 会立刻验一次签名，验不过打包就失败。',
      command: PACKAGE_COMMAND,
      source: '上游源码',
    },
    {
      kind: 'verify',
      title: '验签名',
      detail: '`codesign --verify --deep --strict` 加身份断言（`Authority=` / `TeamIdentifier=`）。这是上游 `afterSign` 同一个函数，单独跑一遍用于人工确认。',
      command: VERIFY_COMMAND,
      source: '上游源码',
    },
    {
      kind: 'verify',
      title: '验公证与 Gatekeeper',
      detail: '开了 `notarize` 才有这一步：`xcrun stapler validate` 加 `spctl --assess`。两者都过，别人下载才不会被拦。',
      command: 'xcrun stapler validate <App>.app && spctl --assess --type execute --verbose=4 <App>.app',
      source: '上游源码',
    },
    {
      kind: 'verify',
      title: '核对预签子树没被重签',
      detail: `两棵预签子树（runtime / \`ondra\`）加全部 \`*.pak\`，把签名时间戳与改动前比一次；变了说明有人用了 \`--deep\`。`,
      source: '上游源码',
    },
  ]

  return steps.map((step, index) => ({ ...step, index: index + 1 }))
}
