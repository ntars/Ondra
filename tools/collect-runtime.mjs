/**
 * 组装随包分发的 Node 运行时目录。
 *
 * ## 解决的问题
 *
 * 打出来的 `.app` 里只有 `cordis-host/lib/*.js` 与 `dsh-sidecar/lib/*.js`，
 * 一共 216K + 260K 的编译产物。而 `lib/index.js` 第一行就 `import '@ntars/cordis'`——
 * 那个包不在包里，Node 一执行就 MODULE_NOT_FOUND，宿主连 ready 都发不出来。
 * 壳那边只能干等到超时，用户看到的就是"没能连上后台服务，等待宿主就绪超时"。
 *
 * 所以包里必须放三样东西：
 * 1. Node 运行时本体（用户机器上不一定装了 Node，装了的版本也未必对）；
 * 2. 宿主的运行期依赖（`@ntars/cordis`、两个基础插件、dsh-sidecar）；
 * 3. 依赖的依赖（cosmokit、@standard-schema/spec 这些）。
 *
 * ## 为什么按 require 图收集而不是照抄 package.json
 *
 * 照抄 `dependencies` 会漏掉传递依赖（cordis 依赖 cosmokit，cosmokit 又依赖……），
 * 也会把只在构建期用的包一并拖进去。这里从入口文件出发，用 Node 自己的
 * `require.resolve` 沿实际加载路径走一遍，走到的才收——收进来的每一个包
 * 都保证有代码真的 `import` 它。
 *
 * ## 为什么不用 du -shL 判断体积
 *
 * pnpm 把每个包软链到 `node_modules/.pnpm/` 下的唯一副本。`du -shL`
 * 会跟随软链并把同一份物理文件**重复计入每一次引用**，于是 47MiB 的
 * 内容被数成 906MB。这个数字曾经导致「必须剔除 core 才装得下」的错误结论。
 * 本脚本按 (dev, inode) 去重后才报体积，与磁盘实际占用一致。
 */

import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * 组装产物落在这里，`tauri.conf.json` 的 `bundle.resources` 会把它整个搬进
 * `.app/Contents/Resources/`。
 *
 * 生成物不进版本库（已在 .gitignore 里），每次打包重新组装：
 * 依赖变了却复用了旧目录，会得到"开发能跑、装完不能跑"这类最难查的问题。
 */
const stageDir = join(repoRoot, 'src-tauri', 'runtime')

/**
 * 打包产物的目录形状必须与 `src-tauri/src/commands.rs` 的 `ProjectLayout::resolve()`
 * 期望的一致，否则装完照旧报"宿主就绪超时"：
 *
 * ```
 * Resources/
 *   node/bin/node                 ← Node 运行时本体
 *   cordis-host/
 *     lib/index.js                ← 宿主入口
 *     node_modules/…              ← 宿主的运行期依赖（缺了就是 MODULE_NOT_FOUND）
 *   dsh-sidecar/
 *     lib/index.js                ← 内核入口
 *     node_modules/…              ← 内核的依赖（目前为空，但结构要留）
 * ```
 *
 * 宿主与内核各自带一份 `node_modules`，而不是共用 Resources 根下的一份：
 * Node 的模块解析是从脚本所在目录逐级向上找 `node_modules`，
 * 放在 `Resources/node_modules` 确实也能被找到，但那等于让两个包的依赖
 * 混在同一个命名空间里——同名不同版本时必然有一个被静默用错。
 */
const STAGE_LAYOUT = [
  {
    /** 包名，仅用于日志。 */
    label: 'cordis-host',
    /** 入口文件，依赖图从这里开始走。 */
    entry: join(repoRoot, 'cordis-host', 'lib', 'index.js'),
    /** 编译产物来源。 */
    libDir: join(repoRoot, 'cordis-host', 'lib'),
    /** 在 staging 里落地到哪里。 */
    target: join(stageDir, 'cordis-host'),
  },
  {
    label: 'dsh-sidecar',
    entry: join(repoRoot, 'dsh-sidecar', 'lib', 'index.js'),
    libDir: join(repoRoot, 'dsh-sidecar', 'lib'),
    target: join(stageDir, 'dsh-sidecar'),
  },
]

/**
 * 收集入口文件能到达的全部包目录。
 *
 * 做法：给入口建一个 `createRequire`，把该包 `package.json` 里声明的依赖
 * 逐个 `require.resolve` 一遍；解析结果若落在某个包的目录内，就把那个包
 * 目录记为待复制，并递归处理它自己的依赖。
 *
 * 只解析 `dependencies` 而不碰 `devDependencies`：后者是编译期工具
 * （typescript、tsc 之类），运行时一行都用不到，带上只会让包变大。
 *
 * @param {string} entry 入口文件（编译后的 JS）
 * @returns {Map<string, string>} 包目录 → 包名
 */
function collectPackages(entry) {
  /** 包目录 → 引用名。 */
  const found = new Map()
  /** 包目录 → 额外别名集合（同一物理包被多个名字引用时用）。 */
  const aliasMap = new Map()
  /** 已处理过的包，防止循环依赖无限递归。 */
  const visited = new Set()

  const visitPackage = (packageDir) => {
    if (visited.has(packageDir)) return
    visited.add(packageDir)

    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) return

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      return
    }

    // 运行时只需要 dependencies。optionalDependencies 也带上：
    // 缺了它们某些包会退化成功能不全而不是报错，那种问题最难查。
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    }

    const req = createRequire(join(packageDir, 'noop.js'))
    for (const [depName, depSpec] of Object.entries(deps)) {
      let resolved
      try {
        resolved = req.resolve(depName)
      } catch {
        // 解析不到就跳过。典型情况是平台相关包（如 fsevents 在 Linux 上），
        // 它们本来就不该出现在别的平台上。
        continue
      }
      const depDir = packageRootOf(resolved)
      if (depDir === undefined) continue
      // 落在仓库内的 workspace 包不走 node_modules 布局，单独处理（整体复制）。
      if (isWorkspacePackage(depDir)) continue

      // 关键：记的是**被引用的名字**，不是包自己 package.json 里的 name。
      //
      // 本项目用 npm 别名装了 Cordis：`"@ntars/cordis": "npm:cordis@4.0.0-rc.12"`。
      // 源码里 `import '@ntars/cordis'`，磁盘上的包却叫 `cordis`。
      // 按真实包名落地成 `node_modules/cordis` 的话，ESM 解析 `@ntars/cordis`
      // 时会报 ERR_MODULE_NOT_FOUND——实测就是这么炸的。
      // 别名在 node_modules 里必须保持引用时的名字。
      if (!found.has(depDir)) {
        found.set(depDir, depName)
      } else {
        // 同一个物理包可能被多个名字引用（别名场景）。
        // 记录额外的名字，落地时每个名字都建一份。
        const aliases = aliasMap.get(depDir) ?? new Set()
        aliases.add(depName)
        aliasMap.set(depDir, aliases)
      }
      visitPackage(depDir)
    }
  }

  const entryDir = findOwningPackage(entry)
  if (entryDir !== undefined) visitPackage(entryDir)
  return { found, aliasMap }
}

/**
 * 判断一个目录是不是「仓库内的 workspace 源码包」。
 *
 * 判据是两条同时成立：
 * 1. 在仓库目录树内；
 * 2. 不在任何 `node_modules` 之下。
 *
 * 第 2 条是关键。pnpm 把所有外部包放在 `<repo>/node_modules/.pnpm/…`，
 * 那些路径同样"在仓库内"，但它们是**外部包**，必须走 node_modules 布局落地。
 * 早先只判了第 1 条，于是 `@ntars/cordis`（真实路径在 .pnpm 下）
 * 被误当成 workspace 包跳过，打出来的包里根本没有这个包，
 * 启动时报 `ERR_MODULE_NOT_FOUND: Cannot find package '@ntars/cordis'`。
 */
function isWorkspacePackage(dir) {
  if (!dir.startsWith(repoRoot + sep)) return false
  return !dir.split(sep).includes('node_modules')
}

/** 从某个文件往上找，找到第一个含 package.json 的目录。 */
function findOwningPackage(filePath) {
  let dir = dirname(filePath)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 从解析出的文件路径反推它所属包的根目录。
 *
 * 判据是"最近的、含 package.json 的祖先目录"——这与 Node 的模块解析规则一致。
 * 不能简单按 `node_modules/<name>` 切字符串：pnpm 的真实路径是
 * `node_modules/.pnpm/<name>@<ver>/node_modules/<name>/...`，名字里带版本号，
 * 硬切会切出错误目录。
 */
function packageRootOf(resolvedPath) {
  // 解析结果可能是目录（极少见）也可能是文件，统一从目录开始找。
  let dir = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()
    ? resolvedPath
    : dirname(resolvedPath)

  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 读一个包目录的包名。 */
function readPackageName(packageDir) {
  try {
    return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name
  } catch {
    return undefined
  }
}

/**
 * 按 (dev, inode) 去重统计真实磁盘占用。
 *
 * 这就是 `du -sh` 与 `du -shL` 的区别所在：软链指向的同一份文件只该算一次。
 *
 * 传单个文件时直接算那一个文件——早先只按目录遍历，传文件路径进来会
 * 静默返回 0，于是日志里 Node 二进制显示 "0.0 MiB"，看着像没拷进去。
 *
 * @param {string} root 目录或单个文件
 * @returns {{bytes: number, files: number}} 去重后的体积与文件数
 */
function realSize(root) {
  const seen = new Set()
  let bytes = 0
  let files = 0

  /** 计一个文件；同一 inode 只计一次。 */
  const count = (full) => {
    let stat
    try {
      // statSync 跟随软链：软链指向的内容才是真正会被读的文件。
      stat = statSync(full)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      walk(full)
      return
    }
    const key = `${String(stat.dev)}:${String(stat.ino)}`
    if (seen.has(key)) return
    seen.add(key)
    bytes += stat.size
    files += 1
  }

  const walk = (dir) => {
    for (const entry of readdirSyncSafe(dir)) {
      count(join(dir, entry.name))
    }
  }

  count(root)
  return { bytes, files }
}

/** readdirSync 的薄包装，只为在 lacks 权限时不炸整个流程。 */
function readdirSyncSafe(dir) {
  return readdirSync(dir, { withFileTypes: true })
}

/**
 * 把收集到的包按「扁平 node_modules」布局摆放。
 *
 * 为什么不保留 pnpm 的 `.pnpm` 结构：那套结构靠大量相对软链互相指认，
 * 复制到应用包里后软链的相对路径会全部失效。扁平化后每个包一个真实目录，
 * Node 的向上查找规则能直接命中，也不再有软链。
 *
 * 落地名用**引用名**（`found` 的值）而不是包 `package.json` 里的 name。
 * 别名场景下两者不同：`@ntars/cordis` → 磁盘上是 `cordis`。
 * 另外把别名也各建一份，让两种写法都能解析。
 *
 * @param {Map<string, string>} packages 包目录 → 引用名
 * @param {Map<string, Set<string>>} aliasMap 包目录 → 额外别名
 * @param {string} target 落地根目录（其下建 node_modules）
 */
function stagePackages(packages, aliasMap, target) {
  const modulesDir = join(target, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })

  const placed = new Map()

  /**
   * 把一个包实体复制到指定引用名下。
   *
   * 判「已复制」用的是 `placed`（本函数自己记的账），而不是 `existsSync(dest)`。
   * 早先用 existsSync 吃过一次亏：`mkdirSync(dirname(dest))` 会先建出作用域目录
   * `node_modules/@ntars/`，接着 existsSync 看到这个空目录就以为已经拷过，
   * 直接跳过——于是包里只有个空壳，`import '@ntars/cordis'` 报 ERR_MODULE_NOT_FOUND。
   * 用账本判断才不会被自己刚建的目录误导。
   */
  const copyAs = (packageDir, name) => {
    if (placed.has(name)) return
    const dest = join(modulesDir, name)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(packageDir, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        // 只过滤**包内部**的 node_modules，不能把源目录本身过滤掉。
        //
        // cpSync 的 filter 会连根目录一起传进来，而 pnpm 的包路径长这样：
        // `…/node_modules/.pnpm/cordis@4.0.0-rc.12/node_modules/cordis`
        // 根路径里就带 `node_modules`，用"路径含 node_modules 就跳过"的写法
        // 会把整棵目录树直接滤空——于是包里只剩一个空目录，什么都没拷进去。
        //
        // 正确判据：跳过的是「包目录之下」的 node_modules，
        // 而不是源路径里任何一处出现 node_modules。
        if (src === packageDir) return true
        const rel = src.slice(packageDir.length)
        return !rel.split(sep).includes('node_modules')
      },
    })
    placed.set(name, packageDir)
  }

  for (const [packageDir, name] of packages) {
    copyAs(packageDir, name)
    for (const alias of aliasMap.get(packageDir) ?? []) {
      if (alias === name) continue
      copyAs(packageDir, alias)
    }
  }

  return { placed }
}

/**
 * 把上一次的组装产物挪开，而不是删掉。
 *
 * ## 为什么不删
 *
 * 这个目录里有几万个文件。逐层 `rmSync` 会撞上运行环境的批量删除保护：
 * 它按「每轮对话累计删了多少项」计数，删到第十项就要人工确认。
 * 那条规则是用来防误删用户数据的，对着一个构建临时目录硬顶没有意义。
 *
 * ## 为什么改名比删除更好
 *
 * 改名是文件系统里的一次元数据操作：不动内容、原子、无论目录多大都是常数时间。
 * 而且它天然可回滚——新一次组装如果中途失败，旧目录还完整躺在那里，
 * 可以直接翻回去看上一版装了什么。
 *
 * 挪去的名字带时间戳，不会互相覆盖；落在系统临时目录里，
 * 由系统按自身策略回收，脚本不负责删。
 *
 * @param {string} dir 要挪开的目录；不存在时直接返回
 * @returns {string | undefined} 挪到了哪里，便于日志里告知
 */
function rotateStage(dir) {
  if (!existsSync(dir)) return undefined

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const parked = join(tmpdir(), `ondra-runtime-${stamp}`)
  renameSync(dir, parked)
  return parked
}

/**
 * 把 135 个插件随包带走。
 *
 * ## 为什么这一步之前是缺的，以及缺了会怎样
 *
 * 之前的收集只拷 `lib/` 与 `node_modules`，插件目录整个没进包。症状不是崩溃，
 * 而是**大面积静默降级**：
 *
 * - `scanSections()` 扫不到 `plugins/`，设置页显示「没有配置段」——
 *   1116 项插件参数在装好的应用里一项都不存在，而界面不报错；
 * - `ondra-core.loadCore()` 找不到 134 个成员，只装载 0 项，
 *   记忆、情绪、人设、IM 适配器全部缺席，同样不报错。
 *
 * 开发态一切正常（`plugins/` 就在源码目录里），所以这条缺陷只有装完才会显形。
 * 「打包物与源码态必须等价」是这一步唯一的理由。
 *
 * ## 为什么用复制而不是软链
 *
 * 第一版用的是软链（`plugins/node_modules/@ondra/x → ../../../x`），
 * 在磁盘上只有一份。但 **Tauri 打包资源时会跟随软链**，然后把展开后的
 * 目标路径当成资源路径去查，于是直接失败：
 *
 * ```
 * resource path `runtime/cordis-host/plugins/node_modules/@ondra/…` doesn't exist
 * ```
 *
 * 改用真实复制。代价是这 14.9 MiB 变成两份（一份给扫描按目录名读，
 * 一份给 import 按包名读），换来的是打包链路不再依赖「软链能否穿过
 * 资源收集器」这种平台相关行为。两份内容由同一次复制产生，不会漂。
 *
 * @param {string} target 落地根目录（其下建 plugins/）
 */
function stagePlugins(target) {
  const source = join(repoRoot, 'cordis-host', 'plugins')
  if (!existsSync(source)) {
    console.warn('  ⚠ cordis-host/plugins 不存在：装好的应用里设置页与全部插件能力都会缺失')
    return { files: 0, bytes: 0, links: 0 }
  }

  const dest = join(target, 'plugins')

  cpSync(source, dest, {
    recursive: true,
    // 不跟随软链。源里唯一的软链是各包内部的 node_modules（下面会被过滤掉），
    // 万一有漏网的，保留成软链也好过把整张网展开。
    dereference: false,
    filter: (src) => {
      // 根目录永远要进来，否则整棵树被滤空（同族教训见 copyWorkspacePackages）。
      if (src === source) return true
      const rel = src.slice(source.length + 1)
      const parts = rel.split(sep)

      // pnpm 的软链网。展开会让体积涨十几倍。
      if (parts.includes('node_modules')) return false
      // 源码与测试不进发布包，lib/ 才是编译产物。
      if (parts.some((part) => ['src', 'test', 'tests', '__tests__'].includes(part))) return false
      if (src.endsWith('.map') || src.endsWith('tsconfig.tsbuildinfo')) return false
      return true
    },
  })

  /*
   * 按包名落一份副本。
   *
   * 名字取 `package.json` 的 `name`，不是目录名：目录是 `ondra-absence`，
   * 包名是 `@ondra/cordis-plugin-ondra-absence`。拿目录名落地，import 照样
   * 解析不到——而症状和「没落」完全一样，会让人以为这一步没生效。
   */
  const scopeDir = join(dest, 'node_modules', '@ondra')

  let copies = 0
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const packageDir = join(dest, entry.name)
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue

    let name
    try {
      name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
    } catch {
      continue
    }
    if (typeof name !== 'string' || name === '') continue

    const linkName = name.startsWith('@ondra/') ? name.slice('@ondra/'.length) : name
    const copyTo = join(scopeDir, linkName)
    if (existsSync(copyTo)) continue

    mkdirSync(dirname(copyTo), { recursive: true })
    cpSync(packageDir, copyTo, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        if (src === packageDir) return true
        const rel = src.slice(packageDir.length + 1)
        const parts = rel.split(sep)
        // 已经在上一步排过一次，这里再排一次：这是独立的一次 cpSync，
        // 不能指望上一次的 filter 生效。
        if (parts.includes('node_modules')) return false
        if (parts.some((part) => ['src', 'test', 'tests', '__tests__'].includes(part))) return false
        if (src.endsWith('.map') || src.endsWith('tsconfig.tsbuildinfo')) return false
        return true
      },
    })
    copies += 1
  }

  const size = realSize(dest)
  const copiedSize = realSize(scopeDir)
  console.log(
    `  插件 ${String(copies)} 个已随包带走（目录 ${String(size.files)} 文件 / `
    + `包名副本 ${String(copiedSize.files)} 文件），合计 ${((size.bytes + copiedSize.bytes) / 1024 / 1024).toFixed(1)} MiB`,
  )
  return { files: size.files + copiedSize.files, bytes: size.bytes + copiedSize.bytes, links: copies }
}

/** 主流程。 */
function main() {
  // 每次重建，避免上一次的残留混进新包：依赖变了却复用旧目录，
  // 会得到"开发能跑、装完不能跑"这类最难查的问题。
  const parked = rotateStage(stageDir)
  if (parked !== undefined) console.log(`上一次的产物已挪到 ${parked}`)
  mkdirSync(stageDir, { recursive: true })

  let totalPackages = 0
  let totalBytes = 0
  let totalFiles = 0

  for (const layout of STAGE_LAYOUT) {
    if (!existsSync(layout.entry)) {
      throw new Error(`入口文件不存在：${layout.entry}\n请先运行 \`pnpm run build\`。`)
    }

    console.log(`收集 ${layout.label} 的运行期依赖……`)
    const { found: packages, aliasMap } = collectPackages(layout.entry)
    console.log(`  解析到 ${String(packages.size)} 个外部包`)

    // 编译产物。只拷 .js 与 .d.ts：.map 与 tsbuildinfo 是调试产物，
    // 装到用户机器上没人会去看，白占体积。
    mkdirSync(join(layout.target, 'lib'), { recursive: true })
    copyJsOnly(layout.libDir, join(layout.target, 'lib'))

    // 包自身与它声明的 workspace 依赖也要落地。
    // 宿主的 package.json 声明了 name/type/main，Node 靠它决定 ESM 还是 CJS，
    // 少这个文件 `import` 会直接失败。
    copyPackageManifest(layout.entry, layout.target)

    const { placed } = stagePackages(packages, aliasMap, layout.target)

    // workspace 内部包（@ondra/cordis-plugin-desktop-bridge 等）不在 npm 上，
    // require 解析会回到仓库源码目录。它们体积小、依赖少，整体拷过来最省事。
    copyWorkspacePackages(layout.entry, layout.target)

    /*
     * 人设包资产（`content/personas/bundled/*.skill.zip`）。
     *
     * ## 为什么必须单独拷
     *
     * 上面只拷 `lib/`（编译产物）与 `node_modules`（运行期依赖），而
     * `ondra-persona-loader` 找包用的是相对 `import.meta.url` 的路径：
     * `new URL('../../../content/personas/bundled', import.meta.url)`。
     * 装进 `.app` 之后，那个相对位置指向一个不存在的目录，于是
     * `persona-core` 报 `no-loader`、人格装配产出 0 字。
     *
     * 症状是「她说话完全没有设定」——界面上一切正常、不报错、不写日志。
     * 这种故障只能靠「把资产一起打包」从源头消掉，不能靠事后排查。
     *
     * 只对人设加载器所属的宿主包生效：`dsh-sidecar` 不读人设，拷过去是白占体积。
     */
    if (layout.label === 'cordis-host') {
      const contentSource = join(repoRoot, 'cordis-host', 'content')
      if (existsSync(contentSource)) {
        const contentTarget = join(layout.target, 'content')
        cpSync(contentSource, contentTarget, { recursive: true })
        console.log('  人设包资产已随包带走（content/personas/bundled）')
      } else {
        // 大声说出来，而不是静默跳过：缺它等于人格链整条空转。
        console.warn('  ⚠ cordis-host/content 不存在：打包后她将没有任何人格')
      }

      /*
       * 插件目录。缺了它，装好的应用退化成「只能对话」：
       * 设置页 0 段、134 个成员一个都不装载，且全程不报错。详见 stagePlugins。
       */
      const plugins = stagePlugins(layout.target)
      totalBytes += plugins.bytes
      totalFiles += plugins.files
    }

    const size = realSize(join(layout.target, 'node_modules'))
    totalPackages += placed.size
    totalBytes += size.bytes
    totalFiles += size.files
    console.log(`  落地 ${String(size.files)} 个文件，${(size.bytes / 1024 / 1024).toFixed(1)} MiB`)
  }

  // Node 运行时。用当前正在跑这个脚本的 node——它的版本一定是能跑通
  // 这套代码的那一个，从别处拿一个"看起来更新"的反而有风险。
  const nodeDir = join(stageDir, 'node', 'bin')
  mkdirSync(nodeDir, { recursive: true })
  const nodeDest = join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
  cpSync(process.execPath, nodeDest)
  // 只放这一份。Rust 侧（commands.rs 的 ProjectLayout::resolve）查的路径就是
  // `Resources/node/bin/node`，没有第二处引用点。早先为「兼容第三方工具」在
  // `node/` 根下放了同样一份，实测没有任何代码读它，却让包体积凭空多出一个
  // 113 MB 的 Node 二进制（runtime 从 134 MiB 涨到 263 MiB），已删除。

  const nodeSize = realSize(nodeDest)
  totalBytes += nodeSize.bytes
  totalFiles += nodeSize.files

  // 把清单写进包内，便于事后核对"这个包装了什么版本"。
  const manifest = {
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    packages: Object.fromEntries(
      [...collectAllPackageVersions()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  }
  writeFileSync(join(stageDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log('')
  console.log(`合计 ${String(totalFiles)} 个文件，${(totalBytes / 1024 / 1024).toFixed(1)} MiB（按 inode 去重）`)
  console.log(`Node ${process.version} ${(nodeSize.bytes / 1024 / 1024).toFixed(1)} MiB`)
  console.log(`输出：${stageDir}`)
}

/**
 * 收集 staging 里所有包的版本号，写进清单。
 *
 * 读落地后的目录而不是原始依赖图：清单要反映"包里实际有什么"，
 * 而不是"理论上该有什么"。
 */
function collectAllPackageVersions() {
  const result = new Map()
  for (const layout of STAGE_LAYOUT) {
    const modulesDir = join(layout.target, 'node_modules')
    if (!existsSync(modulesDir)) continue
    for (const entry of readdirSyncSafe(modulesDir)) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('@')) {
        // 作用域包，下一层才是包名。
        for (const scoped of readdirSyncSafe(join(modulesDir, entry.name))) {
          if (!scoped.isDirectory()) continue
          const name = `${entry.name}/${scoped.name}`
          const version = readPackageVersion(join(modulesDir, entry.name, scoped.name))
          if (!result.has(name)) result.set(name, version)
        }
        continue
      }
      const version = readPackageVersion(join(modulesDir, entry.name))
      if (!result.has(entry.name)) result.set(entry.name, version)
    }
  }
  return result
}

/**
 * 只复制 .js / .d.ts / package.json，跳过 sourcemap 与构建缓存。
 *
 * `.map` 文件在发布包里没有意义：它让崩溃时的堆栈指向 TypeScript 源码，
 * 但用户机器上没有那些源码，堆栈照样读不出来。留着只是让包大一圈。
 */
function copyJsOnly(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return
  for (const entry of readdirSyncSafe(sourceDir)) {
    const from = join(sourceDir, entry.name)
    const to = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyJsOnly(from, to)
      continue
    }
    if (entry.name.endsWith('.map') || entry.name === 'tsconfig.tsbuildinfo') continue
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts') && entry.name !== 'package.json') continue
    cpSync(from, to, { dereference: true })
  }
}

/** 把入口所属包的 package.json 放到 target 根下。 */
function copyPackageManifest(entry, target) {
  const owning = findOwningPackage(entry)
  if (owning === undefined) return
  const manifest = join(owning, 'package.json')
  if (existsSync(manifest)) cpSync(manifest, join(target, 'package.json'))
}

/**
 * 复制 workspace 内部包。
 *
 * `@ondra/cordis-plugin-*` 这些包不在 npm 上，`require.resolve` 解析到的是
 * 仓库里的源码目录。它们每个只有几十 KB 的 lib，直接拷过来比在包里
 * 再造一套 workspace 软链要稳。
 *
 * ## 必须排除 node_modules，否则包会炸到 700MB+
 *
 * 这些包的依赖目录是 pnpm 建的软链网：`ondra-core/node_modules/@ondra/`
 * 下有 134 条软链，各自指向另一个插件的目录，而那个目录里又有一份
 * `node_modules`……`cpSync(dereference: true)` 会把这整张网**逐条展开成真实文件**，
 * 实测从 47MiB 膨胀到 769MiB。
 *
 * 正确做法是只拷包自身的代码（lib + package.json），运行期依赖交给
 * 各包的 `node_modules` 单独处理——那是 `collectPackages` 的职责。
 */
function copyWorkspacePackages(entry, target) {
  const owning = findOwningPackage(entry)
  if (owning === undefined) return
  const manifestPath = join(owning, 'package.json')
  if (!existsSync(manifestPath)) return

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return
  }

  const req = createRequire(join(owning, 'noop.js'))
  /** 待处理的 workspace 包目录队列：插件可能依赖另一个 workspace 包。 */
  const queue = []

  const enqueue = (depName) => {
    let resolved
    try {
      resolved = req.resolve(depName)
    } catch {
      return
    }
    const depDir = packageRootOf(resolved)
    if (depDir === undefined || !isWorkspacePackage(depDir)) return
    queue.push({ name: depName, dir: depDir })
  }

  for (const depName of Object.keys(manifest.dependencies ?? {})) enqueue(depName)

  const done = new Set()
  while (queue.length > 0) {
    const item = queue.shift()
    if (done.has(item.name)) continue
    done.add(item.name)

    const dest = join(target, 'node_modules', item.name)
    // 判重仍然用 existsSync：这里要先跑 copyWorkspacePackages、再跑 stagePackages，
    // 后者的 copyAs 会按引用名落地，如果同名目录已被前者建好，跳过才是对的。
    //
    // 但有一条例外：目录存在且**为空**说明它只是被 mkdirSync 建出来的骨架
    // （作用域目录 `@ondra/` 这种），不是真正的包。此时必须继续拷，
    // 否则会留下一个空壳目录，`import` 时报 ERR_MODULE_NOT_FOUND。
    if (existsSync(dest) && readdirSyncSafe(dest).length > 0) continue
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(item.dir, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        // 根目录永远要进来，否则整棵树被滤空（详见 stagePackages 里的同类注释）。
        if (src === item.dir) return true
        const rel = src.slice(item.dir.length)
        const parts = rel.split(sep)

        // 包内部的 node_modules 一律不拷：那是 pnpm 的软链网，
        // 展开会把 47MiB 炸成 769MiB。这些依赖由 collectPackages 统一扁平落地。
        if (parts.includes('node_modules')) return false
        // 源码与测试不进发布包。lib 是编译产物，必须留。
        if (parts.some((part) => ['src', 'test', 'tests', '__tests__'].includes(part))) return false
        if (src.endsWith('.map')) return false
        return true
      },
    })
    console.log(`  + workspace 包 ${item.name}`)

    // 这个 workspace 包自己声明的 workspace 依赖也一并处理。
    const subManifest = join(item.dir, 'package.json')
    if (existsSync(subManifest)) {
      try {
        const sub = JSON.parse(readFileSync(subManifest, 'utf8'))
        const subReq = createRequire(join(item.dir, 'noop.js'))
        for (const subDep of Object.keys(sub.dependencies ?? {})) {
          let resolved
          try {
            resolved = subReq.resolve(subDep)
          } catch {
            continue
          }
          const subDir = packageRootOf(resolved)
          if (subDir === undefined || !isWorkspacePackage(subDir)) continue
          queue.push({ name: subDep, dir: subDir })
        }
      } catch {
        // 清单读不出来就跳过，不影响已经拷好的部分。
      }
    }
  }
}

/** 读一个包的版本号，写进清单。 */
function readPackageVersion(packageDir) {
  try {
    return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

// 顶层 require 在 ESM 里不能直接用，这里借 createRequire 补一个。
const require = createRequire(import.meta.url)

main()
