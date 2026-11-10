/**
 * 十项自检（master-plan §19.1 的九项 + 手册 §8.3 的第十项）。
 *
 * ## 每一项都只做「它能判准」的那部分
 *
 * 这一节最容易被写坏的形态是「为了凑十项而假装判准」。三个例子：
 *
 * - **降级到位**只能看「`const x = ctx.get(...)` 之后 8 行内有没有判空痕迹」。
 *   这是启发式，所以最多出 `warn`，绝不出 `fail`——否则一条正常的
 *   `if (!svc) return` 被包在别处就会误报成致命。
 * - **服务键唯一**需要全仓索引。索引没建起来（`root` 没配）时这一项会如实说
 *   「索引是空的」，而不是「只有一个包，所以唯一」。
 * - **宿主会不会加载我**遇到补丁里有 `!!js` 时标 `unverifiable`，因为本包的
 *   YAML 子集明确不支持它。说「能加载」才是错的。
 *
 * ## 第十项为什么单独回 `hostLoads`
 *
 * 它回答的是元命题，不是「这一项过没过」：`hostLoads === false` 意味着
 * **这份包根本没被加载**，后面九项判得再对也没人看得见（它们跑在插件内部）。
 * 所以它单独一个字段，界面可以直接拿它做红点。
 */

import type {
  BootOracle,
  CheckId,
  CheckReport,
  CheckResult,
  CheckVerdict,
  KeyIndex,
  PackageFacts,
  PatchRow,
  ReportVerdict,
} from './types.js'
import { NAME_RE } from './types.js'
import { collectRows, composeEntries, ENTRY_FIELDS } from './compose.js'
import { scanSources } from './scan.js'
import type { SourceScan } from './scan.js'
import { parseYamlSubset } from './yaml.js'

/** 检查上下文。 */
export interface CheckContext {
  /** 服务键索引（`provided` 为空表示没建索引）。 */
  readonly keys: KeyIndex
  /** 判定时刻。 */
  readonly now: number
}

/** 每一项的中文标题。 */
export const TITLES: Readonly<Record<CheckId, string>> = Object.freeze({
  files: '结构完整',
  manifest: '清单合法',
  tsconfig: '编译配置',
  entry: '入口契约',
  'service-key': '服务键唯一',
  'dep-resolvable': '依赖可解析',
  'no-cross-import': '无越界 import',
  degrade: '降级到位',
  deliverables: '交付物齐全',
  'host-loads': '宿主会加载我',
})

/** 七个必需文件（手册 §3.2；`icon.svg` 可选）。 */
const REQUIRED_FILES: readonly string[] = Object.freeze([
  'package.json',
  'tsconfig.json',
  'cordis.patch.yml',
  'src/index.ts',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
])

/** 明细最多列几条。 */
const MAX_FINDINGS = 12

/**
 * 造一个结果。
 * @param id 项 id。
 * @param verdict 结论。
 * @param detail 一句结论。
 * @param findings 明细。
 * @param hint 指路。
 */
function result(
  id: CheckId,
  verdict: CheckVerdict,
  detail: string,
  findings: readonly string[] = [],
  hint?: string,
): CheckResult {
  const capped =
    findings.length > MAX_FINDINGS
      ? [...findings.slice(0, MAX_FINDINGS), `另有 ${findings.length - MAX_FINDINGS} 条`]
      : findings
  return {
    id,
    title: TITLES[id],
    verdict,
    detail,
    ...(hint !== undefined ? { hint } : {}),
    findings: Object.freeze([...capped]),
  }
}

/**
 * 取嵌套对象。
 * @param value 值。
 * @param key 键。
 */
function sub(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const child = (value as Record<string, unknown>)[key]
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return null
  return child as Record<string, unknown>
}

/**
 * 取嵌套字符串。
 * @param value 值。
 * @param key 键。
 */
function str(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' ? child : null
}

/**
 * 第 1 项：结构完整。
 * @param facts 事实。
 */
function checkFiles(facts: PackageFacts): CheckResult {
  const missing = REQUIRED_FILES.filter(path => !facts.files.includes(path))
  if (missing.length > 0) {
    return result('files', 'fail', `缺 ${missing.length} 个必需文件`, missing, '补齐后再交付（手册 §3.2）')
  }
  const icon = facts.files.includes('icon.svg') ? '' : '（无 icon.svg，可选）'
  return result('files', 'pass', `7 个必需文件齐${icon}`)
}

/**
 * 第 2 项：清单合法。
 * @param facts 事实。
 */
function checkManifest(facts: PackageFacts): CheckResult {
  if (facts.manifest === null) {
    return result(
      'manifest',
      'fail',
      '`package.json` 解析失败',
      [facts.manifestError ?? '未知原因'],
      '先修 JSON 语法：解析不了的清单等于没有清单',
    )
  }
  const manifest = facts.manifest
  const findings: string[] = []

  const name = str(manifest, 'name')
  if (name !== facts.name) findings.push(`name 是「${name ?? '（缺失）'}」，目录名是「${facts.name}」`)
  if (str(manifest, 'type') !== 'module') findings.push('type 不是 "module"')
  for (const key of ['main', 'types', 'exports', 'files'] as const) {
    if (manifest[key] === undefined) findings.push(`缺 \`${key}\``)
  }
  const peers = sub(manifest, 'peerDependencies')
  const devs = sub(manifest, 'devDependencies')
  if (peers === null || peers['@ntars/cordis'] === undefined) {
    findings.push('`peerDependencies` 里没有 `@ntars/cordis`')
  }
  if (devs === null || devs['@ntars/cordis'] === undefined) {
    findings.push('`devDependencies` 里没有 `@ntars/cordis`')
  }

  if (findings.length > 0) {
    return result('manifest', 'fail', `${findings.length} 处不合规`, findings, '按 master-plan §3.2 的模板修')
  }
  return result('manifest', 'pass', '清单字段齐（name / type / main / types / exports / files / cordis 两侧）')
}

/**
 * 第 3 项：编译配置。
 * @param facts 事实。
 */
function checkTsconfig(facts: PackageFacts): CheckResult {
  if (facts.tsconfig === null) {
    return result(
      'tsconfig',
      'fail',
      '`tsconfig.json` 解析失败',
      [facts.tsconfigError ?? '未知原因'],
      '先修 JSON 语法',
    )
  }
  const options = sub(facts.tsconfig, 'compilerOptions')
  if (options === null) {
    return result('tsconfig', 'fail', '没有 `compilerOptions`', [], '补上 compilerOptions')
  }
  const findings: string[] = []
  const expect = (key: string, want: string | boolean): void => {
    const got = options[key]
    if (got !== want) findings.push(`${key} 是 ${JSON.stringify(got ?? null)}，应为 ${JSON.stringify(want)}`)
  }
  expect('module', 'NodeNext')
  expect('moduleResolution', 'NodeNext')
  expect('strict', true)
  expect('rootDir', 'src')
  expect('outDir', 'lib')
  expect('declaration', true)

  if (findings.length > 0) {
    return result('tsconfig', 'fail', `${findings.length} 处不符`, findings, '按 master-plan §19.1 第 3 项修')
  }
  return result('tsconfig', 'pass', 'NodeNext / strict / rootDir src / outDir lib / declaration')
}

/**
 * 第 4 项：入口契约。
 * @param facts 事实。
 * @param scan 扫描结果。
 */
function checkEntry(facts: PackageFacts, scan: SourceScan): CheckResult {
  const listed = facts.files.includes('src/index.ts')
  const readable = facts.sources.some(file => file.path === 'src/index.ts')
  if (!listed) return result('entry', 'fail', '没有 `src/index.ts`', [], '入口必须在 `src/index.ts`')
  if (!readable) {
    // 文件在、但读不到（太大 / 读失败）：不能报「没有」，也不能报「通过」。
    return result('entry', 'unverifiable', '`src/index.ts` 存在但读不出来', [], '检查单文件大小上限')
  }

  const findings: string[] = []
  if (scan.exportName === null) {
    findings.push('没有 `export const name = \'…\'`')
  } else if (scan.exportName !== facts.name) {
    findings.push(`\`name\` 是「${scan.exportName}」，包名是「${facts.name}」`)
  }
  if (!scan.hasApply) findings.push('没有 `export function apply(`')

  if (findings.length > 0) {
    return result('entry', 'fail', '入口契约不完整', findings, '手册 §3.2：`name` / `inject` / `apply(ctx)` / `Config`')
  }

  const warnings: string[] = []
  if (scan.hasInject) {
    warnings.push('声明了插件级 `inject`：任一上游缺席会让整插件停在 PENDING（§8.3 的静默失败之一）')
  }
  if (scan.hasConfig && !scan.configStandard) {
    warnings.push('有 `Config` 但没有 `~standard`：可能不是标准 schema 形状')
  }
  if (warnings.length > 0) return result('entry', 'warn', '入口可用，但有一处要注意', warnings)
  return result('entry', 'pass', `name = ${facts.name}，apply 存在，无插件级 inject`)
}

/**
 * 第 5 项：服务键唯一。
 * @param facts 事实。
 * @param scan 扫描结果。
 * @param keys 索引。
 */
function checkServiceKey(facts: PackageFacts, scan: SourceScan, keys: KeyIndex): CheckResult {
  if (scan.provideKeys.length === 0) {
    return result('service-key', 'warn', '本包没有 `ctx.provide()`', [], '若它只是消费者，可忽略；否则补上服务键')
  }
  const findings: string[] = []
  for (const key of scan.provideKeys) {
    if (!NAME_RE.test(key)) {
      findings.push(`「${key}」不匹配 ^[a-z][a-z0-9_-]{1,63}$（带冒号会被模型侧直接拒绝）`)
      continue
    }
    const owners = keys.provided.get(key)
    if (owners === undefined) continue
    const others = owners.filter(owner => owner !== facts.name)
    if (others.length > 0) findings.push(`「${key}」已被 ${others.join(' / ')} 占用`)
  }
  if (findings.length > 0) {
    return result('service-key', 'fail', '服务键不合规或冲突', findings, '一个服务键只能有一个 provide 方（§15.4）')
  }
  if (keys.provided.size === 0) {
    return result(
      'service-key',
      'warn',
      '索引是空的：只验了键名形状，没验唯一',
      scan.provideKeys.map(key => `形状合规：${key}`),
      '配 `root` 之后重建索引（`refresh()`）才判得了唯一性',
    )
  }
  return result('service-key', 'pass', `${scan.provideKeys.length} 个服务键全合规且唯一`)
}

/**
 * 第 6 项：依赖可解析。
 * @param facts 事实。
 * @param scan 扫描结果。
 * @param keys 索引。
 */
function checkDeps(facts: PackageFacts, scan: SourceScan, keys: KeyIndex): CheckResult {
  if (scan.consumeKeys.length === 0) {
    return result('dep-resolvable', 'pass', '不消费任何服务键')
  }
  if (keys.provided.size === 0) {
    return result(
      'dep-resolvable',
      'unverifiable',
      `消费了 ${scan.consumeKeys.length} 个键，但没有索引可比`,
      scan.consumeKeys.map(key => `待核：${key}`),
      '配 `root` 之后重建索引才判得了',
    )
  }
  const dangling: string[] = []
  const selfOnly: string[] = []
  for (const key of scan.consumeKeys) {
    const owners = keys.provided.get(key)
    if (owners === undefined) {
      if (keys.hostKeys.includes(key)) continue
      dangling.push(key)
      continue
    }
    if (owners.length === 1 && owners[0] === facts.name) selfOnly.push(key)
  }
  if (dangling.length > 0) {
    return result(
      'dep-resolvable',
      'fail',
      `${dangling.length} 个键在索引里找不到提供方`,
      dangling.map(key => `悬空：${key}`),
      '若它其实是宿主键（不在本仓），把它加进 `hostKeys` 配置；否则等提供方落地',
    )
  }
  if (selfOnly.length > 0) {
    return result(
      'dep-resolvable',
      'warn',
      '有一处消费的是自己提供的键',
      selfOnly.map(key => `自依赖：${key}`),
    )
  }
  return result(
    'dep-resolvable',
    'pass',
    `${scan.consumeKeys.length} 个消费键全部有主（含宿主键 ${keys.hostKeys.length} 个）`,
  )
}

/**
 * 第 7 项：无越界 import。
 * @param scan 扫描结果。
 */
function checkImports(scan: SourceScan): CheckResult {
  if (scan.crossImports.length === 0) {
    return result('no-cross-import', 'pass', '没有 `from \'ondra-…\'`')
  }
  return result(
    'no-cross-import',
    'fail',
    `${scan.crossImports.length} 处越界 import`,
    scan.crossImports.map(hit => `${hit.path}:${hit.no} ${hit.text}`),
    '改为 `ctx.get(\'ondra-x\')` 经服务键调用（§15.5）',
  )
}

/**
 * 第 8 项：降级到位（**启发式，最多 warn**）。
 * @param scan 扫描结果。
 */
function checkDegrade(scan: SourceScan): CheckResult {
  if (scan.consumeKeys.length === 0) {
    return result('degrade', 'pass', '不消费任何服务键，无需降级')
  }
  if (scan.degradeChecked === 0) {
    return result(
      'degrade',
      'unverifiable',
      `消费了 ${scan.consumeKeys.length} 个键，但没有 \`const x = ctx.get(…)\` 形状，判不了`,
      [],
      '把取值写成先赋值再判空，这一项才看得见',
    )
  }
  if (scan.degradeMisses.length > 0) {
    return result(
      'degrade',
      'warn',
      `${scan.degradeChecked} 处取值里有 ${scan.degradeMisses.length} 处没看到判空`,
      scan.degradeMisses.map(hit => `${hit.path}:${hit.no} ${hit.text}`),
      '这是启发式（只看 8 行内）：若判空在别处，可忽略；否则补 `if (!svc) return`',
    )
  }
  return result('degrade', 'pass', `${scan.degradeChecked} 处取值都紧跟判空`)
}

/**
 * 第 9 项：交付物齐全。
 * @param facts 事实。
 */
function checkDeliverables(facts: PackageFacts): CheckResult {
  if (facts.readme === null) {
    return result('deliverables', 'fail', '没有 `README.md`', [], 'README 是交付物的一部分')
  }
  const readme = facts.readme
  const findings: string[] = []
  if (!readme.includes('技术来源')) findings.push('README 缺「技术来源」表（§12.2：不填不许算完成）')
  if (!readme.includes('隔离') || !(readme.includes('五问') || readme.includes('关掉我'))) {
    findings.push('README 缺「隔离自检五问」（§16.4）')
  }
  if (findings.length > 0) {
    return result('deliverables', 'fail', `${findings.length} 处缺失`, findings, '按 master-plan §19.1 第 9 项补')
  }

  const warnings: string[] = []
  if (!readme.includes('多方案')) warnings.push('README 没有「多方案」章节（若涉及 §14.3 的项必须写）')
  if (!readme.includes('已知限制')) warnings.push('README 没有「已知限制」章节')

  const localeFindings: string[] = []
  const locales: readonly (readonly [string, Record<string, unknown> | null])[] = [
    ['locale/zh.json', facts.localeZh],
    ['locale/en.json', facts.localeEn],
  ]
  for (const [label, locale] of locales) {
    const meta = sub(locale, 'meta')
    if (meta === null) {
      localeFindings.push(`${label} 缺 \`meta\``)
      continue
    }
    const title = str(meta, 'title')
    if (title === null || title.trim() === '') localeFindings.push(`${label} 缺 \`meta.title\``)
    const description = str(meta, 'description')
    if (description === null || description.trim() === '') {
      localeFindings.push(`${label} 缺 \`meta.description\``)
    }
  }
  if (localeFindings.length > 0) {
    return result('deliverables', 'fail', 'locale 不完整', localeFindings, '两个 locale 都要有 meta.title 与 meta.description')
  }

  if (warnings.length > 0) return result('deliverables', 'warn', 'README 主体齐，有两处可补', warnings)
  return result('deliverables', 'pass', 'README（技术来源 / 隔离五问 / 多方案 / 已知限制）与两个 locale 齐')
}

/**
 * 第 10 项：宿主会不会真的加载我。
 * @param facts 事实。
 * @param oracle 权威组合端口（`null` = 用本包的移植版）。
 */
export function checkHostLoads(facts: PackageFacts, oracle: BootOracle | null): CheckResult {
  if (facts.manifest === null) {
    return result('host-loads', 'unverifiable', '清单读不出来，判不了会不会被加载', [], '先让第 2 项过')
  }

  // ① `ondra.bundle.patch` 声明 —— 手册 §8.3-1 的「最隐蔽的失败」。
  const ondra = sub(facts.manifest, 'ondra')
  const bundle = ondra === null ? null : sub(ondra, 'bundle')
  const declared = bundle === null ? undefined : bundle['patch']
  if (declared === undefined) {
    return result(
      'host-loads',
      'fail',
      '`package.json` 没有 `ondra.bundle.patch`',
      ['宿主只会往 stderr 打一行 `declares no ondra.bundle`，然后**永不加载**这个包'],
      '加 `"ondra": { "bundle": { "patch": "./cordis.patch.yml" } }`（§8.3-1）',
    )
  }
  const paths =
    typeof declared === 'string'
      ? [declared]
      : Array.isArray(declared) && declared.every(item => typeof item === 'string')
        ? (declared as string[])
        : null
  if (paths === null || paths.length === 0) {
    return result(
      'host-loads',
      'fail',
      '`ondra.bundle.patch` 既不是字符串也不是字符串数组',
      [],
      '写一个路径或一组路径（宿主 `bundlePatchFiles()` 只认这两种）',
    )
  }

  // ② 补丁文件读得到。
  if (facts.patches.length === 0) {
    return result('host-loads', 'fail', '声明了补丁但一个都没读到', paths, '确认文件真的存在且路径相对包目录')
  }
  const unreadable = facts.patches.filter(patch => patch.text === null)
  if (unreadable.length > 0) {
    return result(
      'host-loads',
      'fail',
      `${unreadable.length} 个补丁文件读不出来`,
      unreadable.map(patch => `${patch.path}：${patch.problem ?? '不存在'}`),
      '宿主读不到补丁就等于没有补丁',
    )
  }

  // ③ 解析。
  const rows: PatchRow[] = []
  for (const patch of facts.patches) {
    const parsed = parseYamlSubset(patch.text ?? '')
    if (!parsed.ok) {
      if (parsed.unsupported) {
        return result(
          'host-loads',
          'unverifiable',
          `补丁里有本包 YAML 子集不支持的语法（第 ${parsed.line} 行：${parsed.reason}）`,
          [],
          '接一个 `BootOracle` 端口让宿主自己算，或把补丁改成子集内的写法',
        )
      }
      return result(
        'host-loads',
        'fail',
        `补丁解析失败（第 ${parsed.line} 行）`,
        [parsed.reason],
        '宿主会在读文件时抛错，整个 bundle 被跳过',
      )
    }
    if (!Array.isArray(parsed.value)) {
      return result(
        'host-loads',
        'fail',
        '补丁顶层不是数组',
        [`解析出来是 ${parsed.value === null ? 'null' : typeof parsed.value}`],
        '宿主原文：`config file must be a top-level array of entries`',
      )
    }
    for (const row of parsed.value) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        return result('host-loads', 'fail', '补丁数组里有不是对象的条目', [], '每条补丁必须是一个映射')
      }
      rows.push(row as PatchRow)
    }
  }

  // ④ 组合（宿主若给了权威端口就用它）。
  const authoritative =
    oracle === null ? null : oracle.compose(facts.patches.map(patch => patch.text ?? '').join('\n'))
  const composed = authoritative ?? composeEntries(rows)

  // ⑤ 入口树里有没有我。
  const allRows = collectRows(composed.entries)
  const ours = allRows.filter(entry => entry['name'] === facts.name || entry['id'] === facts.name)
  if (ours.length === 0) {
    return result(
      'host-loads',
      'fail',
      '算出来的入口树里没有本包',
      composed.warnings.map(warning => `补丁第 ${warning.row} 行：${warning.message}`),
      '补丁的 `insert` 必须真的插进根列表（或插进一个存在的 group）',
    )
  }

  const findings: string[] = []
  let verdict: CheckVerdict = 'pass'
  for (const entry of ours) {
    const id = entry['id']
    if (typeof id !== 'string' || !NAME_RE.test(id)) findings.push(`入口 id「${String(id)}」不合规`)
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.includes(key)) {
        findings.push(`入口有第七个字段「${key}」（只许 id/name/config/group/disabled/inject）`)
      }
    }
  }
  if (findings.length > 0) verdict = 'fail'

  if (composed.warnings.length > 0) {
    for (const warning of composed.warnings) {
      findings.push(`补丁第 ${warning.row} 行：${warning.message}`)
    }
    if (verdict === 'pass') verdict = 'warn'
  }

  const detail =
    verdict === 'pass'
      ? `入口树里能找到 ${ours.length} 行本包入口，字段合规，0 条告警`
      : verdict === 'warn'
        ? '能找到本包，但有补丁行被宿主跳过'
        : '入口字段不合规'
  return result(
    'host-loads',
    verdict,
    detail,
    findings,
    verdict === 'pass' ? undefined : '逐条改掉上面这些，宿主才会真的挂载它',
  )
}

/**
 * 跑十项。
 * @param facts 事实。
 * @param context 上下文。
 * @param oracle 权威组合端口。
 * @returns 报告。
 */
export function runChecks(
  facts: PackageFacts,
  context: CheckContext,
  oracle: BootOracle | null = null,
): CheckReport {
  const scan = scanSources(facts.sources)
  const results: CheckResult[] = [
    checkFiles(facts),
    checkManifest(facts),
    checkTsconfig(facts),
    checkEntry(facts, scan),
    checkServiceKey(facts, scan, context.keys),
    checkDeps(facts, scan, context.keys),
    checkImports(scan),
    checkDegrade(scan),
    checkDeliverables(facts),
    checkHostLoads(facts, oracle),
  ]

  const passed: CheckId[] = []
  const failed: CheckId[] = []
  const warned: CheckId[] = []
  const unverifiable: CheckId[] = []
  for (const item of results) {
    if (item.verdict === 'pass') passed.push(item.id)
    else if (item.verdict === 'fail') failed.push(item.id)
    else if (item.verdict === 'warn') warned.push(item.id)
    else unverifiable.push(item.id)
  }

  // 按 id 取，不靠「它一定是最后一项」——顺序一旦被调整，靠位置取会静默取错项。
  const hostItem = results.find(item => item.id === 'host-loads')
  const hostLoads =
    hostItem === undefined ? null : hostItem.verdict === 'unverifiable' ? null : hostItem.verdict !== 'fail'

  // 整份结论按 §19.4 的三档：有 fail = 致命；否则有 warn/unverifiable = 部分过。
  let verdict: ReportVerdict = 'pass'
  if (failed.length > 0) verdict = 'fatal'
  else if (warned.length > 0 || unverifiable.length > 0) verdict = 'partial'

  return {
    package: facts.name,
    at: context.now,
    verdict,
    results: Object.freeze(results),
    passed: Object.freeze(passed),
    failed: Object.freeze(failed),
    warned: Object.freeze(warned),
    unverifiable: Object.freeze(unverifiable),
    hostLoads,
  }
}
