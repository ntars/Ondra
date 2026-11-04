/**
 * 报告的**渲染与命名**。纯函数 + 文件名约定，不碰 ctx、不碰 fs。
 *
 * 命名规则是安全边界的一部分：修剪旧报告时只删「本插件命名规则内」的文件。
 * 规则写在这里、解析也写在这里，两边不可能漂移。
 *
 * ```
 * user/eval/
 *   ├─ <setName>.set.json                 题集（用户手写）
 *   ├─ <setName>-<13 位毫秒时间戳>.json    机器读的报告
 *   └─ <setName>-<13 位毫秒时间戳>.md      人读的报告
 * ```
 */

import { flattenBlock, percentOf } from './metrics.js'
import type { CaseResult, EvalReport, MetricBlock, ReportBaseline } from './types.js'

/** 题集文件后缀。 */
export const SET_SUFFIX = '.set.json'

/** 报告 JSON 后缀。 */
export const REPORT_JSON = '.json'

/** 报告 Markdown 后缀。 */
export const REPORT_MD = '.md'

/** 基线状态的中文说明。 */
const BASELINE_TEXT: Readonly<Record<ReportBaseline, string>> = Object.freeze({
  measured: '可以用于判断「改好了还是改坏了」',
  'template-unfilled': '题集里还有没改写的问法，**这份数字不能用来调参**',
  insufficient: '题数少于手册要求，**结论只能参考**',
  'empty-set': '没有任何可判题，报告只有框架没有数字',
})

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 时间戳 → `YYYY-MM-DD HH:mm:ss`（本地时区）。
 *
 * 不用 `toLocaleString`：它依赖运行环境的 ICU 数据，同一台机器换个 Node 版本
 * 输出就可能变，而报告是用来**逐份对比**的，格式必须自己说了算。
 * @param ts 毫秒时间戳。
 */
export function stamp(ts: number): string {
  const date = new Date(ts)
  const y = date.getFullYear()
  const mo = pad2(date.getMonth() + 1)
  const d = pad2(date.getDate())
  const h = pad2(date.getHours())
  const mi = pad2(date.getMinutes())
  const s = pad2(date.getSeconds())
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`
}

/**
 * 题集文件名。
 * @param setName 题集名。
 */
export function setFileName(setName: string): string {
  return `${setName}${SET_SUFFIX}`
}

/**
 * 报告文件名（不含目录）。
 * @param setName 题集名。
 * @param at 生成时间戳。
 */
export function reportFileNames(setName: string, at: number): { readonly json: string; readonly markdown: string } {
  return Object.freeze({
    json: `${setName}-${at}${REPORT_JSON}`,
    markdown: `${setName}-${at}${REPORT_MD}`,
  })
}

/** 正则里的特殊字符转义。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 本插件认不认这个文件名（修剪时的唯一判据）。
 *
 * **必须是完整匹配**：题集文件 `<setName>.set.json` 不匹配（少时间戳），
 * 别的题集的报告不匹配（前缀不同），用户自己的笔记也不匹配。
 * @param fileName 文件名（不含目录）。
 * @param setName 题集名。
 */
export function isReportFileOf(fileName: string, setName: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(setName)}-\\d{13}\\.(json|md)$`)
  return pattern.test(fileName)
}

/**
 * 从文件名里取时间戳（**不信文件内容**：内容坏了也要能列出来）。
 * @param fileName 文件名。
 * @param setName 题集名。
 */
export function timestampOfReport(fileName: string, setName: string): number | null {
  const pattern = new RegExp(`^${escapeRegExp(setName)}-(\\d{13})\\.(json|md)$`)
  const matched = pattern.exec(fileName)
  if (matched === null) return null
  const raw = matched[1]
  if (raw === undefined) return null
  return Number(raw)
}

/**
 * 渲染一份人读报告。
 *
 * 只出现记忆 **id**，绝不出现记忆正文：报告会写到用户目录里，
 * 也可能被用户直接发给别人看（手册 §2.2 的隐私底线）。
 * @param report 报告。
 */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = []
  const ks = report.ks
  const kindCounts = {
    real: report.byKind.real.cases,
    paraphrase: report.byKind.paraphrase.cases,
    fabricated: report.byKind.fabricated.cases,
  }

  lines.push(`# 检索评估报告 · ${report.setName}`)
  lines.push('')
  lines.push(`- 生成时间：${stamp(report.generatedAt)}`)
  lines.push(`- 基线状态：**${report.baseline}** —— ${BASELINE_TEXT[report.baseline]}`)
  lines.push(`- 库容：${report.corpus.size} 条`)
  lines.push(
    `- 题数：${report.cases.length}（真实 ${kindCounts.real} / 换说法 ${kindCounts.paraphrase} / 编造 ${kindCounts.fabricated}）` +
      `，其中计入计分 ${report.overall.graded} 题`,
  )
  lines.push(`- 总耗时：${report.elapsedMs} ms`)
  lines.push('')

  lines.push('## 参数快照（两份报告能不能比，先看这一节）')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 融合模式 fuse | \`${report.engine.fuse}\` |`)
  lines.push(`| RRF 常数 k | ${report.engine.rrfK === null ? '—' : report.engine.rrfK} |`)
  lines.push(`| BM25 k1 / b | ${report.engine.bm25K1 === null ? '—' : report.engine.bm25K1} / ${report.engine.bm25B === null ? '—' : report.engine.bm25B} |`)
  lines.push(`| 归一化分母 | ${report.engine.normalizedBy === null ? '—' : report.engine.normalizedBy.toFixed(4)} |`)
  lines.push(`| 通道状态 | ${report.engine.channels.length === 0 ? '—' : report.engine.channels.join('，')} |`)
  const weightKeys = Object.keys(report.engine.weights).sort()
  if (weightKeys.length > 0) {
    lines.push(`| 因子权重 | ${weightKeys.map(key => `${key} ${report.engine.weights[key]}`).join('，')} |`)
  }
  lines.push('')

  lines.push('## 整体指标')
  lines.push('')
  lines.push('| 指标 | 值 | 口径 |')
  lines.push('|---|---|---|')
  for (const k of ks) {
    lines.push(`| recall@${k} | ${percentOf(report.overall.recall[String(k)] ?? 0)} | 前 ${k} 位命中真值数 ÷ 真值总数 |`)
  }
  for (const k of ks) {
    lines.push(`| hit@${k} | ${percentOf(report.overall.hitRate[String(k)] ?? 0)} | 前 ${k} 位至少命中一条的比例 |`)
  }
  lines.push(`| MRR | ${report.overall.mrr.toFixed(3)} | 首个命中名次的倒数均值，未命中记 0 并进分母 |`)
  if (report.overall.avoidRate !== null) {
    lines.push(`| avoidRate | ${percentOf(report.overall.avoidRate)} | 编造题「没有硬凑」的比例，越高越好 |`)
  }
  lines.push('')

  lines.push('## 按种类分组')
  lines.push('')
  const headCells = ['种类', '题数', '计分', ...ks.map(k => `recall@${k}`), 'MRR']
  if (report.overall.avoidRate !== null) headCells.push('avoidRate')
  lines.push(`| ${headCells.join(' | ')} |`)
  lines.push(`|${headCells.map(() => '---').join('|')}|`)
  const kindRows: { label: string; block: MetricBlock }[] = [
    { label: '真实问法', block: report.byKind.real },
    { label: '换说法', block: report.byKind.paraphrase },
    { label: '编造题', block: report.byKind.fabricated },
  ]
  for (const row of kindRows) {
    if (row.block.cases === 0) continue
    const cells = [
      row.label,
      String(row.block.cases),
      String(row.block.graded),
      ...ks.map(k => percentOf(row.block.recall[String(k)] ?? 0)),
      row.block.mrr.toFixed(3),
    ]
    if (report.overall.avoidRate !== null) {
      cells.push(row.block.avoidRate === null ? '—' : percentOf(row.block.avoidRate))
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')

  lines.push('## 逐题明细')
  lines.push('')
  const caseHead = ['题号', '种类', '问法', '真值', '匹配', '首命中', 'RR', ...ks.map(k => `recall@${k}`), '判定']
  lines.push(`| ${caseHead.join(' | ')} |`)
  lines.push(`|${caseHead.map(() => '---').join('|')}|`)
  for (const item of report.cases) {
    lines.push(`| ${caseRow(item, ks)} |`)
  }
  lines.push('')

  if (report.skipped.length > 0) {
    lines.push('## 被剔除的题（**不是召回失败**，是题目不可判）')
    lines.push('')
    lines.push('| 题号 | 原因码 | 说明 |')
    lines.push('|---|---|---|')
    for (const item of report.skipped) {
      lines.push(`| ${item.id} | ${item.resolution} | ${cell(item.reason)} |`)
    }
    lines.push('')
  }

  if (report.notes.length > 0) {
    lines.push('## 提示')
    lines.push('')
    for (const note of report.notes) lines.push(`- ${note}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('本报告由 `ondra-recall-eval` 生成。它只测量，不改任何排序参数；')
  lines.push('报告里的记忆只记 id，不记正文。')
  lines.push('')
  return lines.join('\n')
}

/**
 * 表格单元格转义（`|` 会把表格撑断）。
 * @param text 原文。
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * 一题一行的单元格。
 * @param item 逐题结果。
 * @param ks k 列表。
 */
function caseRow(item: CaseResult, ks: readonly number[]): string {
  const cells = [
    item.id,
    item.kind,
    cell(item.query === '' ? '（空）' : item.query),
    String(item.expected),
    matchText(item.match),
    item.firstRank === null ? '—' : String(item.firstRank),
    item.reciprocalRank.toFixed(3),
    ...ks.map(k => percentOf(item.recallAt[String(k)] ?? 0)),
    judgeText(item),
  ]
  return cells.join(' | ')
}

/**
 * 匹配方式的中文标注。
 *
 * `partial` 单独打星号：它意味着这一题的「命中」可能不是那条记忆
 * （子串会误命中），报告里必须一眼看得见。
 * @param match 匹配方式。
 */
function matchText(match: CaseResult['match']): string {
  switch (match) {
    case 'id':
      return 'id'
    case 'exact':
      return '整条'
    case 'partial':
      return '片段 ⚠'
    default:
      return '—'
  }
}

/**
 * 一题的判定文字。
 * @param item 逐题结果。
 */
function judgeText(item: CaseResult): string {
  if (item.resolution === 'missing') return '剔除：真值失效'
  if (item.resolution === 'ambiguous') return '剔除：真值不唯一'
  if (item.kind === 'fabricated') {
    if (item.avoided === true) return '未硬凑 ✓'
    if (item.avoided === false) return '硬凑了 ✗'
    return '—'
  }
  if (item.firstRank === 1) return '第一名 ✓'
  if (item.firstRank !== null) return `第 ${item.firstRank} 名`
  return '没想起 ✗'
}

/**
 * 序列化成 JSON 文本（带缩进，便于人直接读 diff）。
 * @param report 报告。
 */
export function serializeReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * 指标块转成「一行一个」的文本数组，供日志打一行摘要。
 * @param block 指标块。
 * @param ks k 列表。
 */
export function summarizeBlock(block: MetricBlock, ks: readonly number[]): string {
  const parts = flattenBlock(block, ks).map(row => `${row.key}=${row.value.toFixed(3)}`)
  return parts.join(' ')
}
