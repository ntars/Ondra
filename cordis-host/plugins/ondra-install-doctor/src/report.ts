/**
 * 报告文本渲染 + 结论判定。**纯函数**，不碰磁盘。
 *
 * ## 为什么报告一定要是纯文本
 *
 * 这份报告的第一读者不是界面，是**贴进 issue 的那个人**。所以它必须是等宽排版、
 * 能整段复制、不依赖任何渲染。界面后续要结构化数据，读 `DoctorReport` 的字段即可。
 *
 * ## 结论分级的判定顺序（不可换序）
 *
 * 1. **`unverifiable` 优先**：有本包判不了的东西（YAML 超子集、清单读不出、
 *    没配路径）。判不了就说判不了，**不许降级成 pass**。
 * 2. **`fail`**：有 bundle 被跳过，或有 fatal 级告警。这两件事的共同点是
 *    「某个入口不会挂载」。
 * 3. **`warn`**：装得上，但有问题（第七个字段、重复 id、`group` 的 config 被改）。
 * 4. **`pass`**：以上皆无。
 */

import type {
  BundleLayerView,
  DoctorFinding,
  DoctorReport,
  DoctorVerdict,
  EntryTree,
  PatchProblem,
  SkipReport,
} from './types.js'

/** 判定输入。 */
export interface VerdictInput {
  readonly tree: EntryTree
  readonly skip: SkipReport
  readonly layers: readonly BundleLayerView[]
  readonly unverifiable: boolean
}

/**
 * 判结论。
 * @param input 输入。
 */
export function decideVerdict(input: VerdictInput): DoctorVerdict {
  if (input.unverifiable) return 'unverifiable'
  const skipped = input.layers.filter(layer => layer.skipped).length
  if (skipped > 0 || input.skip.fatal > 0) return 'fail'
  if (input.skip.soft > 0) return 'warn'
  return 'pass'
}

/**
 * 造结论条目（人话 + 指路）。
 * @param verdict 结论。
 * @param input 输入。
 */
export function buildFindings(verdict: DoctorVerdict, input: VerdictInput): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = []
  const { tree, skip, layers } = input
  const skipped = layers.filter(layer => layer.skipped)

  findings.push({
    level: 'info',
    detail: `入口树：${String(tree.total)} 行（${String(tree.groups)} 组 / ${String(tree.leaves)} 叶），最大深度 ${String(tree.maxDepth)}，其中 ${String(tree.disabled)} 条被禁用`,
  })

  if (skipped.length > 0) {
    findings.push({
      level: 'error',
      detail: `${String(skipped.length)} 个 bundle 会被宿主跳过：${skipped.map(layer => layer.packageName).join('、')}`,
      hint: '宿主启动时只会往 stderr 打一行 `skipping profile bundle …`，界面上看不出来——这就是「装了却没反应」的典型形态',
    })
    for (const layer of skipped) {
      findings.push({
        level: 'error',
        detail: `  · ${layer.packageName}（${layer.skipCode ?? 'unknown'}）：${layer.skipReason ?? '未给原因'}`,
        hint: skippedHint(layer.skipCode),
      })
    }
  }

  if (skip.fatal > 0) {
    findings.push({
      level: 'error',
      detail: `${String(skip.fatal)} 条补丁告警是致命的（对应入口不会挂载）`,
      hint: '逐条看下面「补丁告警 · 致命」段；宿主对每一条都只 warn 然后 continue',
    })
  }
  if (skip.soft > 0) {
    findings.push({
      level: 'warn',
      detail: `${String(skip.soft)} 条补丁告警不致命（入口挂上了，但有风险）`,
      hint: '第七个字段 / 重复 id / group 的 config 被改成空数组，这三类宿主都不会报',
    })
  }

  if (verdict === 'pass') {
    findings.push({
      level: 'info',
      detail: '全部通过：宿主会加载这份 profile 里的每一个 bundle，计算出的入口树与补丁一致',
    })
  }
  if (verdict === 'unverifiable') {
    findings.push({
      level: 'warn',
      detail: '有本包判不了的部分，结论只能是「未判定」——不是「通过」',
      hint: '把补丁改成 YAML 子集内的写法（块序列 + 块映射 + 单行标量），或接一个权威组合端口',
    })
  }

  return Object.freeze(findings)
}

/**
 * 给跳过码配一句「怎么修」。
 * @param code 跳过码。
 */
function skippedHint(code: string | undefined): string | undefined {
  switch (code) {
    case 'not-found':
      return '在 profile 目录 `ondra plugin add <包名>` 装上，或检查 profile 的 `node_modules` 有没有链到这个包'
    case 'no-ondra.bundle':
      return '在包的 `package.json` 里加 `"ondra": { "bundle": { "patch": "./cordis.patch.yml" } }`（§8.3-1）'
    case 'bad-patch-declaration':
      return '`ondra.bundle.patch` 只能是一个路径字符串或一组路径字符串'
    case 'patch-unreadable':
      return '确认声明的补丁文件真的存在于包目录内（路径是**包相对**的）'
    case 'patch-unparsable':
      return '补丁文件解析失败：宿主读它时会抛错，整个 bundle 被跳过'
    case 'platform-unsupported':
      return '`ondra.bundle.platforms` 不含当前平台；换机器或去掉这条限制'
    case 'manifest-unreadable':
      return '包目录里没有可解析的 `package.json`：这个目录不是一个包'
    default:
      return undefined
  }
}

/**
 * 渲染纯文本报告。
 * @param input 渲染输入。
 */
export function renderReport(input: {
  readonly profileDir: string
  readonly profileName: string
  readonly layers: readonly BundleLayerView[]
  readonly tree: EntryTree
  readonly skip: SkipReport
  readonly verdict: DoctorVerdict
  readonly findings: readonly DoctorFinding[]
  readonly at: number
}): string {
  const lines: string[] = []
  lines.push('空谷 Ondra · 安装自检（O-133 ondra-install-doctor）')
  lines.push('='.repeat(64))
  lines.push('结论：' + verdictLabel(input.verdict))
  lines.push('profile：' + input.profileName)
  lines.push('目录：' + input.profileDir)
  lines.push('')

  lines.push('一、bundle 层（' + String(input.layers.length) + ' 个）')
  lines.push('-'.repeat(64))
  if (input.layers.length === 0) {
    lines.push('  （profile 里没登记任何 bundle）')
  }
  for (const layer of input.layers) {
    const mark = layer.skipped ? '跳过' : '装载'
    const patchCount = layer.patches.length
    lines.push(
      '  [' + mark + '] ' + layer.packageName +
      '  补丁文件 ' + String(patchCount) + ' 个，新增入口 ' + String(layer.entries) + ' 行',
    )
    if (layer.skipped) {
      lines.push('         原因（' + (layer.skipCode ?? 'unknown') + '）：' + (layer.skipReason ?? '未给原因'))
    }
    for (const patch of layer.patches) {
      const state = !patch.read ? '读不到' : !patch.parsed ? '解析失败' : 'ok'
      lines.push('         · ' + patch.declared + '  [' + state + ']  行 ' + String(patch.rows))
      if (patch.problem !== undefined) lines.push('           ' + patch.problem)
      if (patch.unsupported) {
        lines.push('           ↑ 超出本包 YAML 子集：判定降级为 unverifiable（第 ' + String(patch.unsupportedLine ?? 0) + ' 行）')
      }
    }
  }
  lines.push('')

  lines.push('二、宿主会看到的入口树（' + String(input.tree.total) + ' 行）')
  lines.push('-'.repeat(64))
  if (input.tree.rows.length === 0) {
    lines.push('  （空：这份 profile 算出来一条入口都没有——要么补丁全是 insert 到一个不存在的 group，要么一个 bundle 都没装上）')
  }
  for (const row of input.tree.rows) {
    const indent = '  '.repeat(row.depth + 1)
    const kind = row.group ? '[组]' : '[叶]'
    const off = row.disabled ? '（已禁用）' : ''
    lines.push(indent + kind + ' ' + row.id + '  ← ' + row.layer + off)
  }
  lines.push('')

  const fatal = input.skip.warnings.filter(item => item.fatal)
  const soft = input.skip.warnings.filter(item => !item.fatal)
  lines.push('三、补丁告警（致命 ' + String(fatal.length) + ' / 非致命 ' + String(soft.length) + '）')
  lines.push('-'.repeat(64))
  if (input.skip.warnings.length === 0) {
    lines.push('  （0 条：补丁全部按预期应用）')
  }
  for (const item of fatal) lines.push('  [致命] ' + problemLine(item))
  for (const item of soft) lines.push('  [提醒] ' + problemLine(item))
  lines.push('')

  lines.push('四、结论明细')
  lines.push('-'.repeat(64))
  for (const finding of input.findings) {
    const mark = finding.level === 'error' ? '✗' : finding.level === 'warn' ? '!' : '·'
    lines.push('  ' + mark + ' ' + finding.detail)
    if (finding.hint !== undefined) lines.push('      → ' + finding.hint)
  }
  lines.push('')
  lines.push('生成时刻：' + new Date(input.at).toISOString())
  return lines.join('\n')
}

/**
 * 一行补丁告警。
 * @param item 告警。
 */
function problemLine(item: PatchProblem): string {
  const where = item.row === undefined ? '' : '第 ' + String(item.row) + ' 行 '
  const layer = item.layer === undefined ? '' : '（' + item.layer + '）'
  return where + layer + item.message
}

/**
 * 结论的中文标签。
 * @param verdict 结论。
 */
export function verdictLabel(verdict: DoctorVerdict): string {
  switch (verdict) {
    case 'pass':
      return '通过（每个 bundle 都会加载，入口树与补丁一致）'
    case 'warn':
      return '通过但有告警（装得上，有三类宿主不报的隐患）'
    case 'fail':
      return '不通过（有 bundle 会被跳过，或某条入口不会挂载）'
    case 'unverifiable':
      return '未判定（有本包判不了的部分，不等于通过）'
    default:
      return '未判定'
  }
}

/**
 * 把报告折成一行摘要（给日志）。
 * @param report 报告。
 */
export function summarize(report: Pick<DoctorReport, 'verdict' | 'bundles' | 'layers' | 'tree' | 'skip'>): string {
  const skipped = report.layers.filter(layer => layer.skipped).length
  return (
    verdictLabel(report.verdict) +
    '：bundle ' + String(report.bundles) + ' 个（跳过 ' + String(skipped) + '），入口 ' +
    String(report.tree.total) + ' 行，告警 致命 ' + String(report.skip.fatal) +
    ' / 非致命 ' + String(report.skip.soft)
  )
}
