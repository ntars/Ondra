/**
 * O-084 的**知识真源**：改名点位、逐层重签清单、七条不变量、预签子树规则。
 *
 * ## 这一份为什么不是「配置」
 *
 * 点位（哪个文件承载品牌名）与重签顺序（由内向外）是**上游仓库的客观事实**，
 * 不是用户偏好。开放成配置的结果不是「用户能自定义」,而是「任何两个人的改名清单
 * 都不一样，且都没有报错」。所以它们是常量，改这里等于改规格。
 *
 * 可配的只有「改成什么」（见 `settings.ts`）。
 *
 * ## 每一条都标了出处档位
 *
 * - `上游源码`：文件里能逐字找到；
 * - `上游注释`：注释里写明了「为什么」，例如 userData 那条历史事故；
 * - `反推`：从代码结构推出来，手册没写；
 * - `通识`：Apple 平台的通用约束，本仓库无直接证据。
 *
 * 手册里关于本项的原文只有一句「Dev.app 改名换图标并逐层重签」，
 * **没有任何展开**。所以本文件的绝大部分内容来自上游源码与平台通识，
 * 不假装它们出自手册。
 */

import type { RebrandInvariant, RebrandSite, RebrandSpec, ResignLayer } from './types.js'

/**
 * 改名点位地图。
 *
 * 顺序是「先真源、后副本」：先改 `PRODUCT_NAME`，再改那些**抄了一份**的地方。
 * 反过来做，改完真源会让副本显得「也是对的」，漏掉的副本就再也查不出来了。
 */
export const SITES: readonly RebrandSite[] = Object.freeze([
  {
    id: 'display-name',
    file: 'desktop/apps/desktop/scripts/product-name.mjs',
    symbol: "PRODUCT_NAME = '空谷 Ondra'",
    current: '空谷 Ondra',
    singleSource: true,
    action: '改这一行。`productName`、协议名、冒烟脚本的产物路径都从这里取。',
    source: '上游源码',
  },
  {
    id: 'bundle-id',
    file: 'desktop/apps/desktop/scripts/desktop-release-environment.mjs',
    symbol: 'ONDRA_DESKTOP_APP_ID（resolveDesktopAppId）',
    current: '环境变量，仓库内无值',
    singleSource: true,
    action: '**不要改**（见不变量 `keep-bundle-id`）。它只校验 reverse-DNS 形状，值来自打包环境。',
    source: '上游源码',
  },
  {
    id: 'about-panel',
    file: 'desktop/apps/desktop/src/main.ts',
    symbol: "app.setAboutPanelOptions({ applicationName: '空谷 Ondra' })",
    current: '空谷 Ondra（硬编码）',
    singleSource: false,
    action: '改成新名。这里是**第二份**名字，与 `product-name.mjs` 互不相认。',
    source: '上游源码',
  },
  {
    id: 'locale-brand',
    file: 'desktop/apps/desktop/src/locale.ts',
    symbol: 'aboutProduct / welcomeBrand / welcomeTitle / updateTitle …',
    current: '8 种语言各一份（`Ondra` / `关于 Ondra` / `退出 Ondra` …）',
    singleSource: false,
    action: '逐语言替换品牌词。全文件 `Ondra` 出现 103 次，**按词替换而不是按文件替换**。',
    source: '上游源码',
  },
  {
    id: 'dev-bundle',
    file: 'desktop/apps/desktop/scripts/development-app.ts',
    symbol: 'CFBundleName / CFBundleDisplayName / CFBundleExecutable',
    current: "Harness Dev / Harness Dev / HarnessDev",
    singleSource: false,
    action: '三处一起改，且 `Contents/MacOS/<CFBundleExecutable>` 的文件名要跟着改（启动器脚本 exec 的就是它）。',
    source: '上游源码',
  },
  {
    id: 'dev-bundle-path',
    file: 'desktop/apps/desktop/scripts/development-app.ts',
    symbol: "join(options.directory, 'Harness Dev.app')",
    current: 'Harness Dev.app',
    singleSource: false,
    action: '目录名跟显示名走。改完旧目录要删，否则 Launch Services 里会同时注册新旧两个包。',
    source: '上游源码',
  },
  {
    id: 'dev-icon',
    file: 'desktop/apps/desktop/scripts/development-app.ts',
    symbol: 'CFBundleIconFile（**当前不存在**）',
    current: '沿用 Electron.app 的默认图标',
    singleSource: true,
    action: '拷 `.icns` 进 `Contents/Resources/` 并 `plutil -replace CFBundleIconFile`。只换 png 不改 plist，Dock 还是电子图标。',
    source: '上游源码',
  },
  {
    id: 'scheme',
    file: 'desktop/apps/desktop/scripts/electron-builder-config.mjs',
    symbol: "protocols: [{ name: PRODUCT_NAME, schemes: ['ondra'] }]",
    current: 'ondra',
    singleSource: false,
    action: '**不要改**（见不变量 `keep-scheme`）。`development-app.ts` 里另有一份同样的 `CFBundleURLSchemes`。',
    source: '上游源码',
  },
  {
    id: 'artifact-prefix',
    file: 'desktop/apps/desktop/scripts/electron-builder-config.mjs',
    symbol: "artifactName: 'ondra-${version}-${os}-${arch}…'",
    current: 'ondra-',
    singleSource: true,
    action: '产物文件名前缀。改不改都不影响运行，但发布记录与下载链接会跟着变。',
    source: '上游源码',
  },
  {
    id: 'microphone-usage',
    file: 'desktop/apps/desktop/scripts/electron-builder-config.mjs',
    symbol: 'mac.extendInfo.NSMicrophoneUsageDescription',
    current: 'Ondra uses your microphone to transcribe speech into message drafts.',
    singleSource: true,
    action: '授权弹窗里给用户看的原文。名字写在句子里，改名不改它 = 系统弹窗还叫旧名。',
    source: '上游源码',
  },
  {
    id: 'icon-assets',
    file: 'desktop/apps/desktop/resources/',
    symbol: 'icon-macos.png / icon-windows.png / tray-windows.ico（+ 同名 svg 源）',
    current: '现行品牌图',
    singleSource: true,
    action: '换图。`mac.icon` / `win.icon` / `extraResources` 都指向这三个文件名，**换内容不换名**。',
    source: '上游源码',
  },
  {
    id: 'userdata',
    file: 'desktop/apps/desktop/src/paths.ts',
    symbol: 'resolveDesktopUserData() = join($ONDRA_HOME, "electron")',
    current: '$ONDRA_HOME/electron',
    singleSource: true,
    action: '**不要改**（见不变量 `keep-userdata`）。它已经与名字解耦了。',
    source: '上游注释',
  },
])

/**
 * 逐层重签清单，由内向外。
 *
 * 顺序依据：内层代码的签名必须在外层 bundle 封签**之前**完成，否则外层封的是旧 cdhash，
 * 内层一改，外层签名立刻失效。这条是平台通识（`通识`），本仓库没有手工重签的先例可抄。
 *
 * `skip` 三层来自上游 `mac.signIgnore` 的三条正则，是**硬证据**：
 * 那三棵子树在打包前就已签好（或由别的流程签），再签一遍等于把供应商签名换掉。
 */
export const LAYERS: readonly ResignLayer[] = Object.freeze([
  {
    id: 'pak',
    path: 'Contents/Resources/**/*.pak',
    order: 10,
    action: 'sealed',
    why: 'PAK 资源不单独签，由外层 bundle 的签名封住（`signIgnore` 里有 `\\.pak$`）。',
    source: '上游源码',
  },
  {
    id: 'runtime',
    path: 'Contents/Resources/runtime/primary-runtime',
    order: 20,
    action: 'skip',
    why: '预签子树：`signIgnore` 明确忽略它，里面的二进制在打包前已签好。重签会换掉原有签名。',
    source: '上游源码',
  },
  {
    id: 'ondra',
    path: 'Contents/Resources/app.asar.unpacked/ondra/',
    order: 30,
    action: 'skip',
    why: '同上：`signIgnore` 忽略 `ondra` 运行时自带签名与哈希清单。',
    source: '上游源码',
  },
  {
    id: 'helpers',
    path: 'Contents/Frameworks/*.app',
    order: 40,
    action: 'sign',
    why: 'Electron Helper 是独立的嵌套 app，必须各自先签，再签外层。',
    source: '通识',
  },
  {
    id: 'frameworks',
    path: 'Contents/Frameworks/*.framework',
    order: 50,
    action: 'sign',
    why: 'Framework 是嵌套 bundle，同上由内向外。',
    source: '通识',
  },
  {
    id: 'dylibs',
    path: 'Contents/Frameworks/**/*.dylib',
    order: 60,
    action: 'sign',
    why: '独立的 Mach-O 动态库，逐个签（不能靠 `--deep` 顺手带）。',
    source: '通识',
  },
  {
    id: 'executable',
    path: 'Contents/MacOS/<CFBundleExecutable>',
    order: 70,
    action: 'sign',
    why: '主可执行文件。改名后文件名变了，旧的签名记录对不上新路径。',
    source: '上游源码',
  },
  {
    id: 'bundle',
    path: '<App>.app',
    order: 80,
    action: 'sign',
    why: '外层 bundle 最后签。**改过 Info.plist 就必须重签**——bundle 签名覆盖 Info.plist 的哈希。',
    source: '通识',
  },
  {
    id: 'dmg',
    path: 'ondra-<version>-<os>-<arch>.dmg',
    order: 90,
    action: 'sign',
    why: '镜像单独签（上游 `dmg.sign: !unsigned`）。改包后镜像必须重做再签。',
    source: '上游源码',
  },
])

/**
 * 不变量：改名时**不许动**的东西。
 *
 * 每一条都对应一个「看起来顺手、实际会出事」的改动。
 */
export const INVARIANTS: readonly RebrandInvariant[] = Object.freeze([
  {
    id: 'keep-bundle-id',
    rule: '不改 `CFBundleIdentifier`。',
    why: '更新通道、麦克风等 TCC 授权、单实例锁都按 bundle id 认。改了等于换了一个 App：老用户收不到更新，已授的权限要重新点一遍。',
  },
  {
    id: 'keep-scheme',
    rule: '不改 `CFBundleURLSchemes`（`ondra`）。',
    why: '深链一旦发出去就收不回来。改名顺手把 scheme 改成新品牌名，等于让所有已发布的链接 404，而且报错在别人的浏览器里。',
  },
  {
    id: 'keep-userdata',
    rule: '不改 userData 路径（`$ONDRA_HOME/electron`）。',
    why: '上游注释写明这条历史事故：userData 原本跟着应用名走，于是**每次改名都生成一个新的 `Application Support/<name>`，把上一个配置孤立掉**。现在它已经与名字解耦，别为了「干净」把它改回按名字拼。',
  },
  {
    id: 'never-deep-sign-release',
    rule: '发布包不用 `codesign --deep` 签。',
    why: '`--deep` 会连 `signIgnore` 那三棵预签子树一起重签，供应商签名被换成自己的，`--verify --deep --strict` 反而过不了。上游的发布链是逐项签 + `--verify --deep` 校验，**deep 只出现在校验侧**。',
  },
  {
    id: 'always-entitlements',
    rule: '重签必须带 `--entitlements macos-entitlements.plist`。',
    why: '那三个 entitlement（allow-jit、allow-unsigned-executable-memory、disable-library-validation）加麦克风权限。丢了 JIT，渲染进程起不来，而报错会指向别处，看起来像业务代码的 bug。',
  },
  {
    id: 'timestamp-and-runtime',
    rule: '重签必须给 `--timestamp --options runtime`。',
    why: '上游 `assertMacOSRuntimeSignatureDetails` 逐字检查 `Timestamp=` 与 `flags=0x…(runtime)`。少一个，校验脚本直接抛错。',
  },
  {
    id: 'icon-is-not-cosmetic',
    rule: '换图标 = 换图 **+** 改 `CFBundleIconFile`。',
    why: 'macOS 按 plist 里的文件名找图标。只把 png 换掉、plist 还指着旧名（或压根没有这个键，如开发包），Dock 上仍是旧图，且没有任何报错。',
  },
])

/**
 * 预签子树规则：**碰了就是错**。
 *
 * 三条直接对应上游 `mac.signIgnore` 的三条正则，逐字对位：
 * `'/Contents/Resources/app\\.asar\\.unpacked/ondra/(?:/|$)'`、
 * `'/Contents/Resources/runtime/primary-runtime(?:/|$)'`、`'\\.pak$'`。
 *
 * 用前缀/后缀而不是正则：这里只需要判「这个路径在不在预签子树里」，
 * 搬一份正则过来只会多一处需要同步的地方。
 */
export const PRESIGNED_RULES: readonly {
  readonly id: string
  readonly kind: 'prefix' | 'suffix'
  readonly pattern: string
  readonly why: string
}[] = Object.freeze([
  {
    id: 'runtime',
    kind: 'prefix',
    pattern: 'Contents/Resources/runtime/primary-runtime',
    why: '预签的运行时树，重签会换掉原有签名',
  },
  {
    id: 'ondra',
    kind: 'prefix',
    pattern: 'Contents/Resources/app.asar.unpacked/ondra/',
    why: '预签的 `ondra` 树，重签会破坏哈希清单',
  },
  { id: 'pak', kind: 'suffix', pattern: '.pak', why: '由外层 bundle 封签，不单独签' },
])

/**
 * 判一个路径里有没有某段「整段路径」。
 *
 * **必须按段边界比，不能用 `startsWith`**：`…/unpacked/ondra/` 与 `…/unpacked/ondra`
 * 前 3 个字符一样，`startsWith` 会把后者也判成预签子树。
 * 后果是审计对着一个**没被碰过的目录**喊「你重签了预签子树」——假警报比漏报更快让人关掉审计。
 * 上游 `signIgnore` 的正则写的是 `(?:/|$)`，就是这条边界。
 * @param path 已归一化的路径。
 * @param pattern 整段路径。
 */
function hasSegment(path: string, pattern: string): boolean {
  let from = 0
  for (;;) {
    const at = path.indexOf(pattern, from)
    if (at === -1) return false
    const end = at + pattern.length
    const before = at === 0 ? '/' : path[at - 1]
    const after = end === path.length ? '/' : path[end]
    if (before === '/' && after === '/') return true
    from = at + 1
  }
}

/**
 * 判一个路径是否落在预签子树里。
 *
 * 允许三种写法：`.app` 内相对路径、带 `./` 的、以及绝对路径（`/Applications/X.app/Contents/…`）。
 * 绝对路径也要认——调用方报「哪些路径被重签过」时，手上拿到的往往是绝对路径，
 * 而只按前缀匹配会让它**恰好漏判**，漏判的后果是「审计说没碰预签子树」。
 * @param path 路径（相对或绝对）。
 * @returns 命中的规则 id；不在预签子树里返回 `null`。
 */
export function presignedRuleOf(path: string): string | null {
  const normalized = path.replace(/^\.\//u, '').replace(/^\/+/u, '')
  for (const rule of PRESIGNED_RULES) {
    if (rule.kind === 'suffix') {
      if (normalized.endsWith(rule.pattern)) return rule.id
      continue
    }
    if (hasSegment(normalized, rule.pattern)) return rule.id
  }
  return null
}

/**
 * 取规格全图。
 * @returns 点位、层、不变量的只读快照。
 */
export function rebrandSpec(): RebrandSpec {
  return { sites: SITES, layers: LAYERS, invariants: INVARIANTS }
}
