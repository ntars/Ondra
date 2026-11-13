/**
 * 核对「配置项声明了 → 真的有人读」这条边，防止假开关再长回来。
 *
 * ## 为什么需要这份检查
 *
 * 本仓反复踩同一类失效：**设置页能改、日志照实回报、行为一个字不变**。
 * 它比崩溃更难发现，因为三处（界面、日志、类型）都说「生效了」，只有
 * 「有没有人读这个字段」这一层是空的，而那一层没有界面。
 *
 * 第 18 轮实测：78 个插件里 11 个 `FIELD_SPECS` 键在包内 `src/` 之外
 * **零引用**。逐个核实后分两类：
 *
 * | 类 | 例子 | 该怎么办 |
 * | --- | --- | --- |
 * | 假开关（声明的行为没接线） | `verbose` × 6、`poolEnabled`、`maxLen` | 接线，或从声明里拿掉 |
 * | 误报（引用在 `settings.ts` 内部函数里） | `vision.baseUrl`、`asr.cloudBaseUrl` | 白名单放行 |
 *
 * 第二类必须留下理由，否则下一轮又会当缺陷查一遍（本仓已有两次同型返工）。
 *
 * ## 判据为什么是「包内引用」而不是「运行期生效」
 *
 * 「运行期生效」要为 78 个插件各造一次触发条件，成本高且大多数字段没有
 * 可观测出口。这里收窄到能机械判定的那一层：**字段名在包内至少被读到一次**。
 * 它抓不到「读了但读错」，但能抓住「压根没读」——而后者是本仓的全部实例。
 *
 * ## 反向验证（写这份检查时做过的）
 *
 * - 把 `ondra-filter-chain` 的 `settings.verbose` 判定删掉、恢复成无条件 `log.info`
 *   → A 段红 1 条，位置精确（`ondra-filter-chain / verbose`）。
 * - 把 `WIRED_ELSEWHERE` 里的 `maxLen` 条目删掉 → A 段由「豁免」变「漏网」，红 1 条。
 * - 把 `maxLen` 的理由缩成 8 个字 → B 段红 1 条。
 *
 * 两次都确认过「会红」，这份检查才有意义。
 *
 * 用法：
 *   node tools/check-config-used.mjs
 *
 * 退出码：全部通过为 0，任一断言失败为 1。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PLUGINS = join(ROOT, 'cordis-host', 'plugins')

/**
 * 已知「读了但不在本包 `src/` 里」或「确认是待裁决的假开关」的字段。
 *
 * 每条都必须写清**为什么豁免**与**谁来收尾**，否则这份清单会变成坟场。
 */
const WIRED_ELSEWHERE = new Map([
  // 引用在 settings.ts 自己的 resolveEndpoint()/resolveCloudEndpoint() 里（域内解析，非死配置）。
  ['ondra-vision / baseUrl', 'baseUrl 由 settings.ts 的 resolveEndpoint() 读取（同文件域内函数，非死配置）'],
  ['ondra-asr / cloudBaseUrl', 'cloudBaseUrl 由 settings.ts 的 resolveCloudEndpoint() 读取（同上）'],
  // 待裁决：声明的行为没有实现出口。改成理由 → 影响面 → 谁裁决，见 docs/PLUGIN-HEALTH.md 第 18 轮。
  [
    'ondra-proactive-gate / maxLen',
    '待裁决：手册 §5.3-1 的「超长才扫」在本仓退化成「一律扫」。一律扫更严不会漏，只是每次多花一遍正则；' +
      '补扫描分支要动 gate.ts 的判定顺序，属行为变更，需主人点头',
  ],
  [
    'ondra-proactive-reason / poolEnabled',
    '待裁决：台词池入口存在（collect.ts 读 input.pool），但全仓无调用方传参，台词库本身属手册 §1.9 未迁移资产。' +
      '开关无处生效，删还是接要先定「台词库迁不迁」',
  ],
])

let failed = 0
let index = 0

function check(name, ok, detail) {
  index += 1
  if (ok) {
    console.log(`  ✓ ${name}`)
    return
  }
  failed += 1
  console.log(`  ✗ ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

/** 读一个文件；不存在返回空串。 */
function readOr(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** 取 `FIELD_SPECS = Object.freeze({ ... })` 里的顶层键名。 */
function fieldKeysOf(text) {
  const start = text.search(/FIELD_SPECS[^=]*=\s*Object\.freeze\(\{/)
  if (start < 0) return []
  // 从 `({` 之后开始逐字符配平，避免正则跨不过嵌套对象。
  let i = text.indexOf('({', start) + 2
  let depth = 1
  const begin = i
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    i += 1
  }
  const body = text.slice(begin, i - 1)
  // 只取深度 1 的 `key: {`。
  const keys = []
  let d = 0
  let pending = ''
  for (let j = 0; j < body.length; j += 1) {
    const ch = body[j]
    if (ch === '{') {
      if (d === 0) {
        const m = /([A-Za-z][A-Za-z0-9_]*)\s*:\s*$/.exec(pending)
        if (m) keys.push(m[1])
        pending = ''
      }
      d += 1
    } else if (ch === '}') {
      d -= 1
    } else if (d === 0) {
      pending += ch
    }
  }
  return keys
}

/* ------------------------------------------------------------------ *
 * A 段：每个配置字段在包内至少被读到一次
 * ------------------------------------------------------------------ */

console.log('\n── A 段：配置字段有没有人读 ──')

const plugins = readdirSync(PLUGINS).filter(name => {
  const dir = join(PLUGINS, name, 'src')
  return existsSync(dir) && statSync(dir).isDirectory()
})

const dead = []
let fieldTotal = 0
let pluginWithSettings = 0

for (const pkg of plugins.sort()) {
  const srcDir = join(PLUGINS, pkg, 'src')
  const settingsPath = join(srcDir, 'settings.ts')
  if (!existsSync(settingsPath)) continue
  pluginWithSettings += 1

  const keys = fieldKeysOf(readOr(settingsPath))
  fieldTotal += keys.length
  if (keys.length === 0) continue

  // 包内其余源码拼一份，用来判「有没有人读」。settings.ts 自身不算（那里是声明）。
  const others = readdirSync(srcDir)
    .filter(file => file.endsWith('.ts') && file !== 'settings.ts')
    .map(file => readOr(join(srcDir, file)))
    .join('\n')

  for (const key of keys) {
    if (new RegExp(`\\b${key}\\b`).test(others)) continue
    dead.push(`${pkg} / ${key}`)
  }
}

const excused = dead.filter(id => WIRED_ELSEWHERE.has(id))
const nogrant = dead.filter(id => !WIRED_ELSEWHERE.has(id))

check(
  `扫描到 ${pluginWithSettings} 个有配置段的插件、${fieldTotal} 个字段`,
  pluginWithSettings > 0 && fieldTotal > 0,
  `插件 ${pluginWithSettings} / 字段 ${fieldTotal}`,
)
check(
  '每个字段在包内都被读到（豁免项除外）',
  nogrant.length === 0,
  nogrant.length === 0 ? undefined : `漏网 ${nogrant.length} 个：${nogrant.join('、')}`,
)
check(
  '豁免清单没有过期条目（每条都还真的没被读）',
  excused.length === WIRED_ELSEWHERE.size,
  excused.length === WIRED_ELSEWHERE.size
    ? undefined
    : `清单里 ${WIRED_ELSEWHERE.size} 条，只有 ${excused.length} 条仍成立；过期：${[...WIRED_ELSEWHERE.keys()]
        .filter(id => !dead.includes(id))
        .join('、')}`,
)

/* ------------------------------------------------------------------ *
 * B 段：豁免必须带理由
 * ------------------------------------------------------------------ */

console.log('\n── B 段：豁免必须写清理由 ──')

const thin = [...WIRED_ELSEWHERE.entries()].filter(([, why]) => typeof why !== 'string' || why.trim().length < 30)
check('每条豁免都有像样的理由（≥ 30 字，够写清「为什么」与「谁裁决」）', thin.length === 0, thin.map(([id]) => id).join('、'))

/* ------------------------------------------------------------------ *
 * C 段：`verbose` 这个具体承诺必须真的落到日志上
 * ------------------------------------------------------------------ */

console.log('\n── C 段：verbose 承诺与日志调用对得上 ──')

/*
 * `verbose` 的 doc 一律写「打一行日志」。本段只查一件事：
 * 声明了 `verbose` 的包，**必须**在别处出现 `settings.verbose` 或 `deps.settings.verbose`
 * 这类读取。它抓不到「读了但只影响一行、其余照打」，但能抓住「声明了完全没读」。
 *
 * 第 18 轮实测：6 个包声明了 `verbose` 却零读取。修复后本段应为 0。
 */
const verboseDead = []
for (const pkg of plugins.sort()) {
  const srcDir = join(PLUGINS, pkg, 'src')
  const settingsPath = join(srcDir, 'settings.ts')
  if (!existsSync(settingsPath)) continue
  const decl = readOr(settingsPath)
  const hasVerbose = /^ {2}verbose:\s*\{/m.test(decl) || /\bverbose\?\s*:\s*boolean/.test(decl)
  if (!hasVerbose) continue
  const others = readdirSync(srcDir)
    .filter(file => file.endsWith('.ts') && file !== 'settings.ts')
    .map(file => readOr(join(srcDir, file)))
    .join('\n')
  if (!/\.verbose\b/.test(others)) verboseDead.push(pkg)
}

check(
  '声明 verbose 的包都读了它',
  verboseDead.length === 0,
  verboseDead.length === 0 ? undefined : `只声明没读：${verboseDead.join('、')}`,
)

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

if (failed === 0) {
  console.log(`\n合计：${index}/${index} 通过`)
  process.exit(0)
}
console.log(`\n合计：${index - failed}/${index} 通过，${failed} 条红`)
process.exit(1)
