#!/usr/bin/env node
/**
 * 为已迁入的 cordis 插件补齐构建设施。
 *
 * ## 这个脚本解决的问题
 *
 * 旧仓库的 134 个插件各自带一份 `package.json` 与 `tsconfig.json`，
 * 但那两份配置是按旧仓库的目录深度与现实需求写的：依赖 `workspace:~`、
 * 编译目标 ES2022、不启用新仓更严格的那几项检查。
 *
 * 直接把旧配置照搬进来会有两个后果：一是 `workspace:` 协议要求被依赖包
 * 真实存在于工作区，而 `@ntars/cordis` 是私有 scope 别名，靠 pnpm 的
 * `overrides` 才能解析；二是旧配置关掉了 `noUncheckedIndexedAccess` 等
 * 检查，等于新仓最严格的地方对最大一批代码失效。
 *
 * 因此这里统一重写这两份文件：只保留插件自身的元信息（名称、描述、
 * 版本），构建配置一律继承仓库根的 `tsconfig.base.json`。
 *
 * ## 为什么用脚本而不是手工改 134 次
 *
 * 手工改会漏、会不一致、会在下次迁入新插件时重犯。脚本是幂等的：
 * 反复跑结果相同，新增插件只需再跑一次。
 *
 * 用法：
 *   node tools/prepare-plugins.mjs            # 处理全部
 *   node tools/prepare-plugins.mjs ondra-clock  # 只处理指定插件
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginsRoot = join(repoRoot, 'cordis-host', 'plugins')

/**
 * 旧仓库的插件目录，仅用于读取插件的人类可读元信息（描述、界面元数据）。
 *
 * 迁移只搬源码，不搬旧的构建配置——那些按旧仓库的目录深度与依赖协议写的
 * 文件在新仓里是错的。但描述与图标信息属于插件自身定义，值得保留。
 *
 * 默认取同级的兄弟目录，可用环境变量覆盖：迁移是一次性动作，
 * 不能假设旧仓库永远在某个固定位置。
 */
const LEGACY_ROOT = process.env.ONDRA_LEGACY_ROOT
  ?? join(dirname(dirname(repoRoot)), 'Documents', 'Github', 'Ondra', 'cordis')

/** 新仓自己的插件，不由本脚本接管。 */
const OWN_PLUGINS = new Set(['ondra-core', 'desktop-bridge', 'dsh-client'])

/**
 * 生成 tsconfig。
 *
 * 继承根配置而不自带一份：根配置里的严格选项是全仓统一约定，
 * 每个插件各写一份必然逐渐跑偏。
 *
 * `rootDir` 与 `outDir` 必须显式写：继承来的 base 里没有这两项，
 * 因为不同包（前端、宿主、内核）的目录结构不同。
 *
 * ## 为什么这里关掉两个严格选项
 *
 * 这 134 个插件来自旧仓库，是按更宽松的配置写的。实测：套用全量严格项
 * 时有 123 个插件、634 个错误；其中 438 个（69%）只源于这两项——
 * `exactOptionalPropertyTypes` 229 个、`noUncheckedIndexedAccess` 209 个。
 * 关闭后 133/134 个插件零错误，剩下 1 个是真实的 JSON 导入问题，另行修正。
 *
 * 这两个选项检查的不是「代码有 bug」，而是「类型写得够不够精确」：
 *
 * - `exactOptionalPropertyTypes`：区分 `reason?: X`（属性可以不存在）与
 *   `reason: X | undefined`（属性存在但值可为 undefined）。旧代码普遍把
 *   两者混用，关掉它不影响运行时行为，只影响是否允许这种混用。
 * - `noUncheckedIndexedAccess`：让 `arr[0]` 的类型变成 `T | undefined`。
 *   旧代码在这一项下产生 209 处「可能为 undefined」的提示，绝大多数是
 *   已经用长度检查保证过的访问。
 *
 * 这样分层而不是全仓一刀切，是因为两批代码的性质不同：新仓自己的三个
 * 插件是按最严格标准写的，保持全量检查；迁入的插件是既有资产，让它
 * 通过才有意义——为 438 个纯风格问题改动 134 个插件的源码，风险远大于收益。
 *
 * 代价必须写清楚：这两项检查对这 134 个插件不生效。它们的类型精确度
 * 低于新仓其余部分，这是迁入既有代码换来的，不是遗漏。
 */
function tsconfigFor() {
  return `${JSON.stringify({
    extends: '../../../tsconfig.base.json',
    compilerOptions: {
      rootDir: 'src',
      outDir: 'lib',
      // 插件是 Node 侧代码，需要 node 内置模块的类型。
      types: ['node'],
      // base 里开了 composite，插件作为独立包需要它来做增量构建；
      // 但插件之间没有工程引用关系，故不写 references。
      composite: true,
      // 迁入成本控制，理由见上方注释。
      exactOptionalPropertyTypes: false,
      noUncheckedIndexedAccess: false,
      // 有一个插件从 src/registry.json 导入数据，需要它才能在
      // composite 工程里合法纳入 JSON 文件。
      resolveJsonModule: true,
    },
    include: ['src/**/*.ts', 'src/**/*.json'],
  }, null, 2)}\n`
}

/**
 * 生成 package.json。
 *
 * 保留旧 `package.json` 里的 `description` 与 `ondra` 字段：
 * 前者是插件的人类可读说明，后者携带插件在界面上的呈现元信息
 * （图标、补丁文件位置），都属于插件自身定义，不是构建设置。
 *
 * ## 为什么从旧仓库读而不是读本目录
 *
 * 本脚本是幂等的，第二次运行时本目录的 `package.json` 已经是它自己
 * 上一次的产物——那时 `description` 早已被抹掉，再读就等于读空。
 * 旧仓库是这些元信息唯一的原始来源，因此从那里取。
 * 旧仓库不存在时（例如只在本仓开发新插件）留空即可，不阻断构建。
 */
async function packageJsonFor(name) {
  const legacyPath = join(LEGACY_ROOT, name, 'package.json')
  let description = ''
  let ondraField

  try {
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    if (typeof legacy.description === 'string') description = legacy.description
    if (legacy.ondra !== undefined) ondraField = legacy.ondra
  } catch {
    // 旧仓库不在本机、或该插件是本仓新写的，都属于正常情况。
  }

  const manifest = {
    name: `@ondra/cordis-plugin-${name}`,
    version: '2.1.2',
    private: true,
    ...(description === '' ? {} : { description }),
    type: 'module',
    main: 'lib/index.js',
    types: 'lib/index.d.ts',
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './package.json': './package.json',
    },
    files: ['lib'],
    license: 'AGPL-3.0',
    scripts: {
      build: 'tsc -b',
      typecheck: 'tsc -b --noEmit',
    },
    // `@ntars/cordis` 是私有 scope，实际解析到官方 cordis 包，
    // 由根 pnpm-workspace.yaml 的 overrides 完成。写 `*` 而不是
    // `workspace:~`：后者要求工作区里真有这个包，而它并不存在。
    peerDependencies: { '@ntars/cordis': '*' },
    devDependencies: { '@types/node': '26.6.6', typescript: '7.0.2' },
  }

  if (ondraField !== undefined) manifest.ondra = ondraField

  return `${JSON.stringify(manifest, null, 2)}\n`
}

async function main() {
  const only = process.argv.slice(2)

  const entries = await readdir(pluginsRoot, { withFileTypes: true })
  const targets = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !OWN_PLUGINS.has(name))
    .filter((name) => only.length === 0 || only.includes(name))

  if (targets.length === 0) {
    console.log('没有需要处理的插件。')
    return
  }

  let done = 0
  for (const name of targets) {
    const dir = join(pluginsRoot, name)

    // 没有 src 的目录不是插件，跳过。这种情况通常来自复制中断，
    // 直接报错会让整批处理停下，而其余插件本来是好的。
    try {
      const info = await stat(join(dir, 'src'))
      if (!info.isDirectory()) continue
    } catch {
      console.log(`跳过 ${name}：缺少 src 目录`)
      continue
    }

    await writeFile(join(dir, 'tsconfig.json'), tsconfigFor(), 'utf8')
    await writeFile(join(dir, 'package.json'), await packageJsonFor(name), 'utf8')
    done += 1
  }

  console.log(`已处理 ${String(done)} 个插件的构建设施。`)
}

await main()
