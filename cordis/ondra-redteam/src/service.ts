/**
 * 红队评测服务的实现：**判据静态、判定纯函数、报告不报分**。
 *
 * ## 这个服务为什么几乎没有状态
 *
 * 红队是**体检**，不是监护。体检不需要记住上次的结论来影响这次的判定——
 * 一旦「上次 pass 过」能影响「这次也 pass」，这份评测就再也测不出退化了。
 * 所以全部状态只有四个计数器，`batch()` 每次从零重算。
 *
 * ## 它不驱动对话（这条最容易越界）
 *
 * 谁把攻击话术发给她、谁把回复拿回来，是 O-033 与调用方的事。
 * 本插件只做 `grade()`：**输入一段回复，输出它过没过**。
 * 自己发起对话就等于多出一条绕过冻结前缀（O-033）与九步过滤（O-037）的路径——
 * 那条路径上的回复根本不是在正常工况下产生的，测出来的结论没有意义。
 *
 * ## 它不存回复正文
 *
 * `GradeResult` 里只有 `chars`（长度）与 `hits[].spans`（位置区间）。
 * 回复正文里可能就有用户刚说的隐私；把评测报告当回收站用，
 * 是本插件最容易造成的二次泄漏（O-076「敏感片段只回位置与种类」同手法）。
 */

import { casebookOf, compileChecks, gradeOne, queryCases, reportOf } from './grade.js'
import type { CompileResult } from './grade.js'
import { RedTeamError } from './types.js'
import type {
  BatchInput,
  CasebookInfo,
  CaseQuery,
  GradeInput,
  GradeResult,
  LogLike,
  RedCase,
  RedReport,
  RedTeamService,
  RedTeamStats,
  RedTeamUnavailableReason,
  SuiteSpec,
} from './types.js'
import { SUITE_SPECS } from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。 */
export interface RedTeamDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 系统时间兜底（本插件**不依赖时钟服务**：报告时间戳用系统时间即可，差几毫秒无影响）。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 红队评测服务。 */
export class RedTeam implements RedTeamService {
  readonly #deps: RedTeamDeps

  /** 编译一次，全局共用（每条正则只编译一次）。 */
  readonly #compiled: CompileResult

  /** 判定过几题次。 */
  #graded = 0

  /** 出过几份报告。 */
  #reports = 0

  /** 累计不过条数。 */
  #failures = 0

  /** 累计 critical 不过条数。 */
  #criticalFailures = 0

  /** 因回复为空 / 超长被拒几次。 */
  #rejected = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: RedTeamDeps) {
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
  get reason(): RedTeamUnavailableReason | undefined {
    return this.#deps.settings.enable ? undefined : 'disabled'
  }

  /** 五种套件的说明。 */
  suites(): readonly SuiteSpec[] {
    return SUITE_SPECS
  }

  /** 题库清单。 */
  casebook(): CasebookInfo {
    return casebookOf()
  }

  /**
   * 取题。
   * @param query 条件。
   */
  cases(query?: CaseQuery): readonly RedCase[] {
    return queryCases(query)
  }

  /**
   * 判一题。
   * @param input 入参。
   */
  grade(input: GradeInput): GradeResult {
    this.assertEnabled()
    this.assertCasebook()
    const reply = this.replyOf(input.reply)
    const result = gradeOne({ ...input, reply }, this.#compiled)
    this.#graded += 1
    if (result.verdict === 'fail') {
      this.#failures += 1
      if (result.severity === 'critical') this.#criticalFailures += 1
    }
    return result
  }

  /**
   * 判一批并出报告。
   * @param input 入参。
   */
  batch(input: BatchInput): RedReport {
    this.assertEnabled()
    this.assertCasebook()

    const items: GradeInput[] = []
    for (const item of input.items) {
      items.push({ ...item, reply: this.replyOf(item.reply) })
    }

    const report = reportOf({ items, at: input.at ?? this.#deps.now() }, this.#compiled)

    this.#graded += report.graded
    this.#reports += 1
    this.#failures += report.fail
    this.#criticalFailures += report.criticalIds.length

    // 报告只进日志的「条数」层，**绝不把回复正文或命中原文写进日志**——
    // 日志是最容易被随手贴出去的东西。
    if (report.verdict === 'fail') {
      this.#deps.log.warn(
        '红队：%s（critical 不过 %d 道：%s）',
        report.summary,
        report.criticalIds.length,
        report.criticalIds.join('、'),
      )
    } else {
      this.#deps.log.info('红队：%s', report.summary)
    }

    return report
  }

  /** 统计快照。 */
  stats(): RedTeamStats {
    return Object.freeze({
      graded: this.#graded,
      reports: this.#reports,
      failures: this.#failures,
      criticalFailures: this.#criticalFailures,
      rejected: this.#rejected,
    })
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 未开启就抛。 */
  assertEnabled(): void {
    if (!this.#deps.settings.enable) {
      throw new RedTeamError('disabled', '红队评测已关闭（enable=false）')
    }
  }

  /** 题库编译有问题就抛（**判不出结论时不许给结论**）。 */
  assertCasebook(): void {
    if (this.#compiled.issues.length > 0) {
      throw new RedTeamError(
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
      throw new RedTeamError('bad-reply', '回复必须是字符串')
    }
    const text = raw.trim()
    if (text === '') {
      this.#rejected += 1
      throw new RedTeamError(
        'bad-reply',
        '回复是空的：空回复**不算通过**，请把调用失败的那一题从这一批里去掉（它会被记成 skip）',
      )
    }
    const chars = [...text].length
    const max = this.#deps.settings.maxReplyChars
    if (chars > max) {
      this.#rejected += 1
      throw new RedTeamError(
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
