/**
 * 核对「每个配置字段的默认值都能通过它自己的 pattern」。
 *
 * ## 这条为什么要单独一份检查
 *
 * `ondra-config-schema` 在 `register()` 时**拿 pattern 校验 default 本身**
 * （见 `plugins/ondra-config-schema/src/layers.ts` 的 `checkSpec`）。默认值不合法
 * 的代价不是启动失败，而是这样一行 warn：
 *
 * ```
 * warn ondra.vision 向 ondra-config-schema 注册配置段失败（退回插件实例配置）：
 *      字段「credential-ref」的默认值不合法：必须匹配 ^[A-Za-z_][A-Za-z0-9_]*$
 * ```
 *
 * 然后整段就此缺席 schema 层。影响范围要说准：宿主装载前会把用户层配置
 * 作为成员配置注入（`buildMemberConfigs`），所以**值仍然生效**；真正失效的
 * 是这一段的 schema 级校验与逐字段回退——非法值不再被挡回默认值——外加
 * 每次启动一行读起来像故障的 warn。
 *
 * 这类缺陷唯一的现场证据就是那行 warn，很容易被当成噪音刷过去；而它的
 * 后果是「校验悄悄没了」，属于最难靠肉眼发现的一类。
 *
 * 首次采集时全仓命中 2 处，都是同一个形状：**默认值是空串，而 pattern
 * 不收空串**。两处代码里其实都写着「留空即自动 / 留空用默认」，也就是
 * 空串本来就是合法且默认的取值——错的是 pattern 太严。
 *
 * ## 判据
 *
 * 逐个 import `plugins/<包>/lib/settings.js`，取出 `FIELD_SPECS`：
 * 凡同时有 `pattern`（字符串）与 `default`（字符串）的字段，`default`
 * 必须能被 `new RegExp(pattern)` 命中。数字 / 布尔 / 枚举字段不在此列
 * （它们的校验走 `kind` 分支，schema 自己会管）。
 *
 * 判据取 `lib/` 产物而不是 `src/` 源码：这一条要验的正是「注册时 schema
 * 会看到的那份 spec」，而 schema 读的就是产物。代价是改完源码必须先 build
 * ——这也是对的，没 build 的改动本来就没进运行中的宿主。
 *
 * ## 反向验证
 *
 * 把 `ondra-asr/src/settings.ts` 的 `pattern: LANGUAGE_PATTERN` 改回
 * `LANGUAGE_RE.source` 并 build → 立刻红 1 条。两处都改回 → 红 2 条。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGINS_ROOT = 'cordis-host/plugins'

/** 逐字段挑出「默认值过不了自己的 pattern」的违规项。 */
async function collect() {
  const bad = []
  const scanned = []
  for (const name of readdirSync(PLUGINS_ROOT).sort()) {
    const file = join(PLUGINS_ROOT, name, 'lib', 'settings.js')
    if (!existsSync(file)) continue
    let mod
    try {
      mod = await import(pathToFileURL(join(process.cwd(), file)).href)
    } catch {
      // 产物坏了由 typecheck / build 去报，这里只关心 spec 的语义。
      continue
    }
    const specs = mod.FIELD_SPECS
    if (specs === undefined || specs === null) continue
    scanned.push(name)
    for (const [key, spec] of Object.entries(specs)) {
      if (typeof spec?.pattern !== 'string' || spec.pattern === '') continue
      if (typeof spec?.default !== 'string') continue
      let re
      try {
        re = new RegExp(spec.pattern)
      } catch {
        bad.push({ name, key, reason: 'pattern 不是合法正则', detail: spec.pattern })
        continue
      }
      if (!re.test(spec.default)) {
        bad.push({
          name,
          key,
          reason: '默认值不匹配 pattern',
          detail: `default=${JSON.stringify(spec.default)} pattern=${spec.pattern}`,
        })
      }
    }
  }
  return { bad, scanned }
}

const { bad, scanned } = await collect()

console.log('=== 配置默认值与 pattern 的一致性 ===')
for (const item of bad) {
  console.log(`  ✗ ${item.name} :: ${item.key} —— ${item.reason}（${item.detail}）`)
}

if (bad.length > 0) {
  console.log('')
  console.log(`扫描 ${String(scanned.length)} 个包的 settings 产物，命中 ${String(bad.length)} 处。`)
  console.log('原因：schema 注册时会拿 pattern 校验 default 本身，默认值不合法 → 整段注册抛错')
  console.log('      → 该段的 schema 级校验与逐字段回退失效，且每次启动留一行假故障 warn。')
  console.log('修法：要么让 pattern 收下这个默认值（空串是「用默认」的合法写法时），')
  console.log('      要么把默认值改成 pattern 认的形状。两者选一，别改 schema 的校验口径。')
  console.log('')
  console.log(`合计：${String(bad.length)} 项未通过`)
  process.exit(1)
}

console.log(`  ✓ ${String(scanned.length)} 个包、全部带 pattern 的字段，默认值均自洽`)
console.log('')
console.log('合计：全部通过')
