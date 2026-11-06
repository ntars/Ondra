/**
 * 一致性评测服务的实现：**判据静态、判定纯函数、报告不报分**。
 *
 * ## 这个服务为什么几乎没有状态
 *
 * 一致性评测是**体检**，不是监护。体检不需要记住上次的结论来影响这次的判定——
 * 一旦「上次 pass 过」能影响「这次也 pass」，这份评测就再也测不出退化了。
 * 所以状态只有两样：**本轮逐题结论**（只有结论与位置，**没有回复正文**）
 * 与四个计数器。`report()` 读完即清，下一轮从零开始。
 *
 * ## 它不驱动对话（这条最容易越界）
 *
 * 谁把探测句发给她、谁把回复拿回来，是调用方与 O-033 的事。
 * 本插件只做 `grade()`：**输入一段回复，输出它过没过**。
 * 自己发起对话就等于多出一条绕过冻结前缀（O-033）与九步过滤（O-037）的路径——
 * 那条路径上的回复根本不是在正常工况下产生的，测出来的结论没有意义。
 * 所以这里**没有** `watch()` / `onReply()` / `run()` 之类的「自动接一遍」方法。
 *
 * ## 它不存回复正文
 *
 * `GradeResult` 里只有 `chars`（长度）与 `hits[].spans`（位置区间）。
 * 回复正文里可能就有用户刚说的私事；把评测报告当回收站用，
 * 是本插件最容易造成的二次泄漏（O-076「敏感片段只回位置与种类」同手法）。
 */

import { compileChecks, gradeFree, gradeOne, queryCases, reportOf } from './grade.js'
import type { CompileResult } from './grade.js'
import { BENCH_CASES } from './cases.js'
import { BenchError, SUITE_SPECS } from './types.js'
import type {
  BenchCase,
  BenchReport,
  BenchService,
  BenchStats,
  BenchUnavailableReason,
  CaseQuery,
  GradeResult,
  LogLike,
  SuiteSpec,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。 */
export interface BenchDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 系统时间兜底（本插件**不依赖时钟服务**：报告时间戳差几毫秒无影响）。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 人格一致性评测服务。 */
export class ConsistencyBench implements BenchService {
  readonly #deps: BenchDeps

  /** 编译一次，全局共用（每条正则只编译一次）。 */
  readonly #compiled: CompileResult

  /** **本轮**逐题结论：题号 → 结论。只有结论与位置，没有回复正文。 */
  readonly #records = new Map<string, GradeResult>()

  /** 判过几题次（含无题判定）。 */
  #graded = 0

  /** 判过几次无题判定。 */
  #freeGrades = 0

  /** 出过几轮报告。 */
  #cycles = 0

  /** 累计不过条数。 */
  #failures = 0

  /** 累计 critical 不过条数。 */
  #criticalFailures = 0

  /** 因回复为空 / 超长被拒几次。 */
  #rejected = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: BenchDeps) {
    this.#deps = deps
    this.#compiled = compileChecks()
    if (this.#compiled.issues.length > 0) {
      // 题库坏掉是**初始化期就能发现**的问题：把每一条失败逐条报出来，
      // 不许吞成一句「题库加载失败」——那样没人知道该修哪一条正则。
      for (const issue of this.#compiled.issues) {
        deps.log.error(
          '题库正则编译失败：%s / %s / 第 %d 条：%s',
          issue.caseId,
          issue.checkId,
          issue.patternIndex,
          issue.detail,
        )
      }
      deps.log.error('题库有 %d 条正则编译不过，评测结果不可信', this.#compiled.issues.length)
    }
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): BenchUnavailableReason | undefined {
    return this.#deps.settings.enable ? undefined : 'disabled'
  }

  /** 五种分类的说明。 */
  suites(): readonly SuiteSpec[] {
    return SUITE_SPECS
  }

  /**
   * 取题。
   * @param query 条件。
   */
  cases(query?: CaseQuery): readonly BenchCase[] {
    return queryCases(query)
  }

  /**
   * 判一段回复。
   * @param reply 回复正文。
   * @param caseId 题号；省略则按通用判据判（结果不计入报告，因为没有对应题目）。
   */
  grade(reply: string, caseId?: string): GradeResult {
    this.assertEnabled()
    this.assertCasebook()
    const text = this.replyOf(reply)
    const withSpans = this.#deps.settings.listSpans

    if (caseId === undefined) {
      const free = gradeFree(text, this.#compiled, withSpans)
      this.#graded += 1
      this.#freeGrades += 1
      return free
    }

    const item = BENCH_CASES.find(entry => entry.id === caseId)
    if (item === undefined) {
      throw new BenchError('no-such-case', `没有这道题：${caseId}`)
    }

    const result = gradeOne(item, text, this.#compiled, withSpans)
    // 覆盖写：同一题这轮判两次，以最后一次为准。要保住前一次就该分两轮跑——
    // 「同一题判两次都留着」会让报告里的条数超过题库题数，那是没法解释的。
    this.#records.set(result.caseId, result)
    this.#graded += 1
    if (result.verdict === 'fail') {
      this.#failures += 1
      if (result.severity === 'critical') this.#criticalFailures += 1
    }
    return result
  }

  /**
   * 出一轮报告，**读完即清**。
   *
   * 清空是刻意的：不清空的话，两轮之间改过人格参数的结论会混在一份报告里，
   * 而报告本身看不出哪一条来自哪一轮——那比没有报告更糟。
   */
  report(): BenchReport {
    this.assertEnabled()
    this.assertCasebook()

    this.#cycles += 1
    const report = reportOf(this.#records, this.#deps.now(), this.#cycles)
    this.#records.clear()

    // 报告只进日志的「条数」层，**绝不把回复正文或命中原文写进日志**——
    // 日志是最容易被随手贴出去的东西。
    if (report.verdict === 'fail') {
      this.#deps.log.warn(
        '一致性：%s（critical 不过 %d 道：%s）',
        report.summary,
        report.criticalIds.length,
        report.criticalIds.join('、'),
      )
    } else if (report.graded === 0) {
      this.#deps.log.warn('一致性：%s', report.summary)
    } else {
      this.#deps.log.info('一致性：%s', report.summary)
    }

    return report
  }

  /** 统计快照。 */
  stats(): BenchStats {
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      caseCount: BENCH_CASES.length,
      graded: this.#graded,
      freeGrades: this.#freeGrades,
      cycles: this.#cycles,
      failures: this.#failures,
      criticalFailures: this.#criticalFailures,
      rejected: this.#rejected,
      compileIssues: this.#compiled.issues.length,
    })
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 未开启就抛。 */
  assertEnabled(): void {
    if (!this.#deps.settings.enable) {
      throw new BenchError('disabled', '人格一致性评测已关闭（enable=false）')
    }
  }

  /** 题库编译有问题就抛（**判不出结论时不许给结论**）。 */
  assertCasebook(): void {
    if (this.#compiled.issues.length > 0) {
      throw new BenchError(
        'bad-casebook',
        `题库有 ${String(this.#compiled.issues.length)} 条正则编译不过，评测结果不可信，拒绝出结论`,
      )
    }
  }

  /**
   * 校验并规整回复。
   *
   * **空回复一律拒收**，不接受「空回复算通过」：一次没拿到回复的运行，
   * 报成「全过」是最糟的结论——它会让一个根本没跑起来的评测看起来一切正常。
   * @param raw 原始回复。
   */
  replyOf(raw: unknown): string {
    if (typeof raw !== 'string') {
      this.#rejected += 1
      throw new BenchError('bad-reply', '回复必须是字符串')
    }
    const text = raw.trim()
    if (text === '') {
      this.#rejected += 1
      throw new BenchError(
        'bad-reply',
        '回复是空的：空回复**不算通过**，请把调用失败的那一题从这一轮里去掉（它会记成 skip）',
      )
    }
    const chars = [...text].length
    const max = this.#deps.settings.maxReplyChars
    if (chars > max) {
      this.#rejected += 1
      throw new BenchError(
        'bad-reply',
        `回复 ${String(chars)} 字超过上限 ${String(max)}：多半是把整段对话粘进来了，判出来的结论没意义`,
      )
    }
    return text
  }

  /**
   * 打一行降级日志（`verbose` 关掉就不打）。
   * @param message 模板。
   * @param args 参数。
   */
  warn(message: string, ...args: unknown[]): void {
    if (!this.#deps.settings.verbose) return
    try {
      this.#deps.log.warn(message, ...args)
    } catch (error) {
      // 日志坏了不该让判定失败——但这条兜底本身也要能被看见。
      void messageOf(error)
    }
  }
}
