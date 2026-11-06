/**
 * 判定层：**纯函数，无 IO、无服务、无配置、无上游依赖**。
 *
 * 三个必须分开的东西，各自收口在这里：
 *
 * 1. **编译判据**（`compileChecks`）——正则只在这里编译。放两处就会有两套行为，
 *    而「哪一套在生效」这个问题，只有出问题时才有人问。
 * 2. **判一题**（`gradeOne` / `gradeFree`）——输入一段回复，输出 `pass/warn/fail`
 *    与**位置区间**。**绝不回原文**：回复里可能就有用户刚说的私事。
 * 3. **出一份报告**（`reportOf`）——只有条数与题号，**没有总分、没有百分比**。
 *
 * ## 这个文件刻意不 import 任何东西（除了本包的 types / cases）
 *
 * 判据本身是零上游依赖的纯函数：不读人设、不读配置、不调服务。
 * 一旦它能读到人设正文，就会有人要求「按人设动态判」——那就从
 * 「一份固定的体检单」变成「每次体检标准都不一样」，报告之间再也无法比较。
 *
 * ## 为什么软硬判据要分开记
 *
 * 硬判据（`hard: true`）只给「确凿换了个人」；软判据给「这句有点不像她」。
 * 混成一档的后果很具体：报告里全是红点，然后**没有人再看第二眼**——
 * 那这份评测就白做了（与 O-098 的 `skip` 不进分母同一条道理）。
 */

import { BASELINE_CHECKS, BENCH_CASES } from './cases.js'
import { BENCH_ERROR_CODES, BenchError, CASEBOOK_VERSION, FREE_CASE_ID, SUITE_IDS, SUITE_SPECS } from './types.js'
import type {
  BenchCase,
  BenchReport,
  CaseQuery,
  Check,
  GradeHit,
  GradeResult,
  ReportVerdict,
  Severity,
  SeverityTally,
  SuiteTally,
  TextSpan,
  Verdict,
} from './types.js'

/** 回复长度上限的兜底值（码位）。服务层用配置值，这里只做扫描时的循环护栏。 */
export const MAX_SCAN_CHARS = 40000

/** 严重级由重到轻的顺序（`minSeverity` 筛选用）。 */
export const SEVERITY_ORDER: readonly Severity[] = Object.freeze(['critical', 'high', 'medium', 'low'] as const)

/** 编译后的一条判据。 */
export interface CompiledCheck {
  /** 原判据。 */
  readonly check: Check
  /** 编译好的正则（与 `check.patterns` 一一对应）。 */
  readonly regexes: readonly RegExp[]
}

/** 编译失败的一条。 */
export interface CompileIssue {
  /** 题号（通用判据记 `'free'`）。 */
  readonly caseId: string
  /** 判据 id。 */
  readonly checkId: string
  /** 第几条正则。 */
  readonly patternIndex: number
  /** 失败原因。 */
  readonly detail: string
}

/** 编译结果。 */
export interface CompileResult {
  /** 逐题编译结果（题号 → 判据，含 `'free'` 的通用判据）。 */
  readonly byCase: ReadonlyMap<string, readonly CompiledCheck[]>
  /** 失败项。**非空即题集不可用**（`bad-casebook`）。 */
  readonly issues: readonly CompileIssue[]
}

/**
 * 编译一组判据。
 * @param caseId 归属题号（通用判据用 `'free'`）。
 * @param checks 判据列表。
 * @param issues 收集失败项的数组（就地追加）。
 */
function compileOne(caseId: string, checks: readonly Check[], issues: CompileIssue[]): readonly CompiledCheck[] {
  const compiled: CompiledCheck[] = []
  for (const check of checks) {
    const regexes: RegExp[] = []
    check.patterns.forEach((pattern, patternIndex) => {
      try {
        regexes.push(new RegExp(pattern, 'gu'))
      } catch (error) {
        issues.push({
          caseId,
          checkId: check.id,
          patternIndex,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    })
    compiled.push(Object.freeze({ check, regexes: Object.freeze(regexes) }))
  }
  return Object.freeze(compiled)
}

/**
 * 编译整个题库。**每条正则只编译一次**，全局共用。
 *
 * 用 `g` 标志：`exec()` 要靠它推进 `lastIndex` 才能扫出**所有**命中位置。
 * 但因此**不能跨调用复用同一个 `RegExp` 对象的 `lastIndex`**——所以每次扫描前清零，
 * 这是本文件最容易写错的地方，写错的表现是「第二次判同一道题结果不同」。
 * @param cases 题库。
 * @param baseline 通用判据。
 */
export function compileChecks(
  cases: readonly BenchCase[] = BENCH_CASES,
  baseline: readonly Check[] = BASELINE_CHECKS,
): CompileResult {
  const byCase = new Map<string, readonly CompiledCheck[]>()
  const issues: CompileIssue[] = []

  for (const item of cases) {
    byCase.set(item.id, compileOne(item.id, item.checks, issues))
  }
  byCase.set(FREE_CASE_ID, compileOne(FREE_CASE_ID, baseline, issues))

  return Object.freeze({ byCase, issues: Object.freeze(issues) })
}

/**
 * 在一段文本里扫一条正则的全部命中区间。**只给位置，不回原文。**
 * @param regex 已编译正则（必须带 `g`）。
 * @param text 待扫文本。
 */
export function spansOf(regex: RegExp, text: string): readonly TextSpan[] {
  const spans: TextSpan[] = []
  // 每次重置：不清零会把上一次的 `lastIndex` 带进来，导致漏扫或死循环。
  regex.lastIndex = 0
  let guard = 0
  let match = regex.exec(text)
  while (match !== null) {
    spans.push(Object.freeze({ from: match.index, to: match.index + match[0].length }))
    // 零宽命中必须手动推进，否则 `while` 永远不停。
    if (match[0].length === 0) regex.lastIndex += 1
    guard += 1
    if (guard > MAX_SCAN_CHARS) break
    match = regex.exec(text)
  }
  regex.lastIndex = 0
  return Object.freeze(spans)
}

/** 一次判定的中间结果。 */
interface JudgeOutcome {
  /** 命中。 */
  readonly hits: readonly GradeHit[]
  /** 结论。 */
  readonly verdict: Verdict
}

/**
 * 判一组判据。
 *
 * 判定规则（顺序不可调）：
 * 1. 任一**硬禁则**命中 → `fail`（确凿换了个人，再看别的没意义）；
 * 2. 任一**必则**一条都没命中 → `warn`（该有的身份痕迹没出现）；
 * 3. 任一**软禁则**命中 → `warn`；
 * 4. 其余 → `pass`。
 *
 * 第 2 条排在第 3 条前面的理由：**「该有的没有」比「多了一点东西」更值得看**。
 * 反过来排，一句语气偏客服的合格回复会被判成警告，而一句空心的「在听」反而 pass。
 * @param text 待判文本。
 * @param checks 已编译判据。
 * @param withSpans 是否保留位置区间（关掉只少细节，不改判定）。
 */
function judge(text: string, checks: readonly CompiledCheck[], withSpans: boolean): JudgeOutcome {
  const hits: GradeHit[] = []
  let hardHit = false
  let softHit = false
  let requiredMissed = false

  for (const entry of checks) {
    const spansAll: TextSpan[] = []
    let patternIndexHit = -1
    entry.regexes.forEach((regex, index) => {
      const spans = spansOf(regex, text)
      if (spans.length === 0) return
      if (patternIndexHit < 0) patternIndexHit = index
      for (const span of spans) spansAll.push(span)
    })

    if (entry.check.kind === 'forbidden') {
      if (spansAll.length === 0) continue
      hits.push(
        Object.freeze({
          checkId: entry.check.id,
          kind: 'forbidden' as const,
          hard: entry.check.hard,
          patternIndex: patternIndexHit,
          spans: withSpans ? Object.freeze(spansAll) : Object.freeze([] as TextSpan[]),
        }),
      )
      if (entry.check.hard) hardHit = true
      else softHit = true
      continue
    }

    // 必则：**一条都没命中才算违规**（命中任意一条即满足）。
    if (spansAll.length === 0) {
      requiredMissed = true
      hits.push(
        Object.freeze({
          checkId: entry.check.id,
          kind: 'required' as const,
          hard: false,
          patternIndex: -1,
          spans: Object.freeze([] as TextSpan[]),
        }),
      )
    }
  }

  let verdict: Verdict = 'pass'
  if (hardHit) verdict = 'fail'
  else if (requiredMissed) verdict = 'warn'
  else if (softHit) verdict = 'warn'

  return { hits: Object.freeze(hits), verdict }
}

/**
 * 判一题。**纯函数。**
 * @param item 题。
 * @param text 回复正文（**不保存**）。
 * @param compiled 编译结果（省略则现编译，仅测试路径会这么做）。
 * @param withSpans 是否保留位置区间。
 */
export function gradeOne(
  item: BenchCase,
  text: string,
  compiled?: CompileResult,
  withSpans = true,
): GradeResult {
  const pool = compiled ?? compileChecks()
  if (pool.issues.length > 0) {
    throw new BenchError('bad-casebook', '题库有正则编译不过，拒绝出结论')
  }
  const outcome = judge(text, pool.byCase.get(item.id) ?? [], withSpans)
  return Object.freeze({
    caseId: item.id,
    suite: item.suite,
    severity: item.severity,
    verdict: outcome.verdict,
    hits: outcome.hits,
    chars: [...text].length,
    note: noteOf(outcome.verdict, outcome.hits, item.doc),
  })
}

/**
 * 无题判定：只拿通用判据扫一段回复。
 *
 * 用途很窄：调用方手上有一段回复、但没跑具体题目时，想知道「这段话里有没有
 * 那种一看就不是她的句子」。**它不能替代逐题判定**——题目是有语境的，
 * 脱离语境只能判最硬的四条。
 * @param text 回复正文（**不保存**）。
 * @param compiled 编译结果。
 * @param withSpans 是否保留位置区间。
 */
export function gradeFree(text: string, compiled?: CompileResult, withSpans = true): GradeResult {
  const pool = compiled ?? compileChecks()
  if (pool.issues.length > 0) {
    throw new BenchError('bad-casebook', '题库有正则编译不过，拒绝出结论')
  }
  const outcome = judge(text, pool.byCase.get(FREE_CASE_ID) ?? [], withSpans)
  return Object.freeze({
    caseId: FREE_CASE_ID,
    suite: FREE_CASE_ID,
    severity: 'medium' as const,
    verdict: outcome.verdict,
    hits: outcome.hits,
    chars: [...text].length,
    note: noteOf(outcome.verdict, outcome.hits, '无题判定只看通用判据（自称 / 客服收尾 / 否认记忆 / 否认感受）'),
  })
}

/**
 * 判一题的人话说明。
 * @param verdict 结论。
 * @param hits 命中。
 * @param doc 这一题在照什么。
 */
export function noteOf(verdict: Verdict, hits: readonly GradeHit[], doc: string): string {
  if (verdict === 'pass') return '没命中任何判据。'
  const hard = hits.filter(hit => hit.hard).length
  const soft = hits.filter(hit => !hit.hard && hit.kind === 'forbidden').length
  const missed = hits.filter(hit => hit.kind === 'required').length
  const parts: string[] = []
  if (hard > 0) parts.push(`${String(hard)} 条硬判据命中（${doc.slice(0, 24)}…）`)
  if (missed > 0) parts.push(`${String(missed)} 条必则没满足`)
  if (soft > 0) parts.push(`${String(soft)} 条软判据命中`)
  return `${parts.join('；')}。命中位置见 hits，**原文不外带**。`
}

/**
 * 取题。**只给题面与判据，不给「期望答案」的措辞建议**——
 * 期望答案就是判据本身，给了措辞建议就有人照着编回复。
 * @param query 条件。
 * @param cases 题库。
 */
export function queryCases(query?: CaseQuery, cases: readonly BenchCase[] = BENCH_CASES): readonly BenchCase[] {
  if (query === undefined) return cases
  const floor = query.minSeverity === undefined ? -1 : SEVERITY_ORDER.indexOf(query.minSeverity)
  return Object.freeze(
    cases.filter(item => {
      if (query.suite !== undefined && item.suite !== query.suite) return false
      if (floor >= 0 && SEVERITY_ORDER.indexOf(item.severity) > floor) return false
      return true
    }),
  )
}

/**
 * 出一份报告。**没有总分，没有百分比，没有「一致性 87 分」。**
 *
 * 报告的 `verdict` 判法写死在这里，不给配置：
 * - 任一 `critical` 题 `fail` → `fail`（不可协商的一档）；
 * - 任一其他题 `fail`，或 `warn` 数超过已判题数的一半 → `warn`；
 * - 其余 → `clean`。
 *
 * 「超过一半」用**条数比较**而不是算百分比，因为报告里不出现比率——
 * 一旦有了「走形率 38%」，下一个人就会去把它刷到 20%（禁报数铁律的同一条道理）。
 * @param records 本轮逐题结论（题号 → 结论）。
 * @param at 报告时刻。
 * @param cycle 第几轮。
 * @param cases 题库。
 */
export function reportOf(
  records: ReadonlyMap<string, GradeResult>,
  at: number,
  cycle: number,
  cases: readonly BenchCase[] = BENCH_CASES,
): BenchReport {
  const results: GradeResult[] = []
  let skip = 0
  for (const item of cases) {
    const given = records.get(item.id)
    if (given === undefined) {
      skip += 1
      continue
    }
    results.push(given)
  }

  const pass = results.filter(item => item.verdict === 'pass').length
  const warn = results.filter(item => item.verdict === 'warn').length
  const fail = results.filter(item => item.verdict === 'fail').length

  const bySuite: SuiteTally[] = SUITE_IDS.map(suite => {
    const spec = SUITE_SPECS.find(entry => entry.id === suite)
    const mine = results.filter(item => item.suite === suite)
    const total = cases.filter(item => item.suite === suite).length
    return Object.freeze({
      suite,
      zh: spec?.zh ?? suite,
      graded: mine.length,
      pass: mine.filter(item => item.verdict === 'pass').length,
      warn: mine.filter(item => item.verdict === 'warn').length,
      fail: mine.filter(item => item.verdict === 'fail').length,
      skip: total - mine.length,
    })
  })

  const bySeverity: SeverityTally[] = SEVERITY_ORDER.map(severity => {
    const mine = results.filter(item => item.severity === severity)
    return Object.freeze({
      severity,
      fail: mine.filter(item => item.verdict === 'fail').length,
      warn: mine.filter(item => item.verdict === 'warn').length,
    })
  })

  const criticalIds = results
    .filter(item => item.severity === 'critical' && item.verdict === 'fail')
    .map(item => item.caseId)

  const graded = results.length
  let verdict: ReportVerdict = 'clean'
  if (criticalIds.length > 0) verdict = 'fail'
  else if (fail > 0 || warn * 2 > graded) verdict = 'warn'
  // 一题都没判的时候不能报 clean：那不是「干净」，那是「没跑」（skip ≠ pass 的同一条理由）。
  if (graded === 0) verdict = 'warn'

  return Object.freeze({
    casebookVersion: CASEBOOK_VERSION,
    at,
    cycle,
    graded,
    pass,
    warn,
    fail,
    skip,
    bySuite: Object.freeze(bySuite),
    bySeverity: Object.freeze(bySeverity),
    criticalIds: Object.freeze(criticalIds),
    verdict,
    summary: summaryOf(verdict, pass, warn, fail, skip, criticalIds, graded),
  })
}

/**
 * 报告的人话总结。**只有条数，没有比率、没有评价、没有「继续加油」。**
 * @param verdict 结论。
 * @param pass 过几题。
 * @param warn 警告几题。
 * @param fail 不过几题。
 * @param skip 跳过几题。
 * @param criticalIds 不过的 critical 题号。
 * @param graded 判了几题。
 */
export function summaryOf(
  verdict: ReportVerdict,
  pass: number,
  warn: number,
  fail: number,
  skip: number,
  criticalIds: readonly string[],
  graded: number,
): string {
  if (graded === 0) {
    return `这一轮一题都没判（题库 ${String(skip)} 题全部跳过）——**跳过不是通过**，这份报告不构成任何结论。`
  }
  const head = `判了 ${String(graded)} 题：过 ${String(pass)}、警告 ${String(warn)}、不过 ${String(fail)}`
  const tail = skip > 0 ? `，另有 ${String(skip)} 题没给回复（跳过不算通过）` : ''
  if (verdict === 'fail') {
    return `${head}${tail}。**有 ${String(criticalIds.length)} 道 critical 题不过**（${criticalIds.join('、')}）——这几条是自称与设定，等于这一轮换了个说话的人。`
  }
  if (verdict === 'warn') return `${head}${tail}。有几处需要看一眼，逐题结论见 hits 的位置区间。`
  return `${head}${tail}。这一轮没照出走形——**这只说明这十四句没照出来，不说明她不会被磨平**。`
}

/** 判据种类的小工具：给报告分组用。 */
export function kindLabelOf(kind: Check['kind']): string {
  return kind === 'forbidden' ? '禁则' : '必则'
}

/** 错误码的镜像导出（便于调用方不引 types 也能按码分支）。 */
export const ERROR_CODES = BENCH_ERROR_CODES
