/**
 * O-139 的实现：把上游 `tools/result` 接成三件事——归因、伤口账、喂器官宿主。
 *
 * ## 为什么本包是「喂食者」
 *
 * O-132 的器官宿主提供了 `toolResult()`，但它**自己不装监听器**（它连定时器都不装，
 * 这是它刻意的「零常驻」）。也就是说：没有本包，`onToolResult` 永远不会被触发，
 * 所有声明了 `tool.result` 能力的器官都是聋的。
 *
 * 所以本包承担一个明确角色：**上游事件与器官 ABI 之间的唯一接线点**。
 * 代价是「唯一」两个字只是约定，不是结构保证——若将来有第二个喂食者，
 * 器官会收到两份同样的结果。所以给了 `feed-host` 开关，并把这条约定写进 README。
 *
 * ## 为什么不做 `tools/post-execute` 的改写
 *
 * 那条路能让我们把处方**塞回模型眼前**（`add context`）。不做，三个理由：
 * 1. 工具结果的形状归各工具自己声明，第三方改写会撞上输出契约（上游有
 *    `finalizeContent` 的「仅限内容」不变式，改写等于跟它抢）；
 * 2. 处方是给**调用方**（重试策略、界面、O-144）的裁决，不是给模型的提示词；
 * 3. 手册把「往提示词里加东西」归 O-036 与 CoT 锚，本包越界就是重复真源。
 *
 * 处方通过服务键交出去，谁需要谁取。
 */

import type {
  Attribution,
  AttribStats,
  AttribUnavailableReason,
  Cause,
  FailureAttribService,
  FailureInput,
  FailureReport,
  HealedWound,
  LogLike,
  OrganHostLike,
  Prescription,
  ToolExecutionLike,
  ToolResultLike,
  Wound,
} from './types.js'
import { classify } from './classify.js'
import { prescriptionOf, shouldRetry } from './prescribe.js'
import { WoundBook } from './wounds.js'
import type { Config } from './settings.js'

/** 服务依赖。全部现取，不在构造时快照。 */
export interface AttribDeps {
  readonly settings: () => Config
  readonly log: LogLike
  readonly now: () => number
  /** O-132 器官宿主；缺席时返回 undefined（软依赖）。 */
  readonly host: () => OrganHostLike | undefined
}

/**
 * 失败归因服务实现。
 *
 * **永不抛错**：归因在工具返回的临界路径上（手册反模式④：
 * 「在 `feedback` 里做超过 50ms 的计算」同理），抛错会污染工具结果。
 */
export class FailureAttrib implements FailureAttribService {
  private readonly deps: AttribDeps
  private readonly book: WoundBook
  private readonly byCause: Record<string, number> = {}

  private results = 0
  private failures = 0
  private successes = 0
  private unnamed = 0
  private feeds = 0
  private feedErrors = 0
  private disposed = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: AttribDeps) {
    this.deps = deps
    this.book = new WoundBook(
      () => deps.settings().maxOpenWounds,
      () => deps.settings().maxHealedHistory,
    )
  }

  get available(): boolean {
    return !this.disposed && this.deps.settings().enable
  }

  get reason(): AttribUnavailableReason | undefined {
    return this.available ? undefined : 'disabled'
  }

  classify(input: FailureInput): Attribution {
    return classify(input)
  }

  prescription(cause: Cause): Prescription {
    return prescriptionOf(cause)
  }

  shouldRetry(cause: Cause, attempts?: number): boolean {
    return shouldRetry(cause, attempts === undefined ? 0 : attempts, this.deps.settings().maxRetries)
  }

  noteFailure(input: FailureInput): Attribution {
    const attribution = classify(input)
    this.failures += 1
    this.byCause[attribution.cause] = (this.byCause[attribution.cause] ?? 0) + 1
    const wound = this.book.open(input.tool, attribution.cause, this.deps.now())
    if (wound === undefined) {
      // 账本满：新伤口被拒。必须说出来——否则「这个工具坏了」这件事会凭空消失。
      this.deps.log.warn(
        '伤口账本已满（%d），工具「%s」的新伤口被拒（归因 %s）',
        this.deps.settings().maxOpenWounds,
        input.tool,
        attribution.cause,
      )
    }
    if (this.deps.settings().verbose) {
      this.deps.log.info(
        '归因：工具 %s → %s（%s）%s',
        input.tool,
        attribution.cause,
        attribution.matched,
        wound === undefined ? '（伤口被拒）' : '（第 ' + wound.failures + ' 次）',
      )
    }
    return attribution
  }

  noteSuccess(tool: string): Wound | undefined {
    this.successes += 1
    const closed = this.book.close(tool, this.deps.now())
    if (closed !== undefined && this.deps.settings().verbose) {
      this.deps.log.info(
        '伤口闭合：工具 %s（归因 %s，失败 %d 次%s）',
        tool,
        closed.cause,
        closed.failures,
        closed.chronic ? '，曾是 chronic' : '',
      )
    }
    return closed
  }

  /**
   * 上游 `tools/result` 的入口：判定成败、记账、喂宿主。**永不抛错。**
   * @param exec 上游 `ToolExecution`（只读）。
   * @param result 上游 `ToolExecutionResult`（已冻结）。
   * @returns 失败时的归因；成功或无法归因时 undefined。
   */
  handle(exec: unknown, result: unknown): Attribution | undefined {
    if (this.disposed) return undefined
    const settings = this.deps.settings()
    if (!settings.enable) return undefined
    this.results += 1
    // 顺手做一次超时检查：本包不装定时器，chronic 的标记必须搭在「有事件发生」上。
    // 一个从不产生工具结果的进程，伤口本来也不会增长。
    this.sweep()

    const tool = toolNameOf(exec)
    if (tool === undefined) {
      // 没有工具名就归不了因。计数而不是猜一个名字：猜错会污染整本账。
      this.unnamed += 1
      return undefined
    }

    const outcome = resultOf(result)
    if (outcome === undefined) {
      // 结果形状不可识别：既不记成功也不记失败。记成成功是撒谎（它会闭合伤口），
      // 记成失败也是撒谎（它会开一个没发生的伤口）。
      this.unnamed += 1
      return undefined
    }
    const text = textOfContent(outcome)

    if (outcome.isError !== true) {
      this.noteSuccess(tool)
      this.feed(tool, true, undefined, text)
      return undefined
    }

    const info = outcome.error === undefined ? undefined : outcome.error.info
    const message =
      outcome.error === undefined
        ? undefined
        : outcome.error.message ?? (info === undefined ? undefined : info.reason)
    const attribution = this.noteFailure({ tool, code: info === undefined ? undefined : info.code, message })
    this.feed(tool, false, info === undefined ? undefined : info.code, text)
    return attribution
  }

  wounds(): readonly Wound[] {
    return this.book.list()
  }

  woundOf(tool: string): Wound | undefined {
    return this.book.of(tool)
  }

  sweep(at?: number): readonly Wound[] {
    const moment = at === undefined ? this.deps.now() : at
    const fresh = this.book.sweep(moment, this.deps.settings().chronicAfterMs)
    if (fresh.length > 0) {
      this.deps.log.warn(
        '%d 个伤口超过 %dms 未闭合，已标 chronic（停止空转，等人）：%s',
        fresh.length,
        this.deps.settings().chronicAfterMs,
        fresh.map(wound => wound.tool).join(', '),
      )
    }
    return fresh
  }

  healed(limit?: number): readonly HealedWound[] {
    const cap = limit === undefined ? this.deps.settings().maxHealedHistory : limit
    return this.book.healed(cap)
  }

  report(): FailureReport {
    const wounds = this.book.stats()
    const denominator = wounds.healed + wounds.open
    return Object.freeze({
      at: this.deps.now(),
      wounds,
      byCause: Object.freeze({ ...this.byCause }),
      healRate: denominator === 0 ? 0 : wounds.healed / denominator,
    })
  }

  stats(): AttribStats {
    return Object.freeze({
      at: this.deps.now(),
      results: this.results,
      failures: this.failures,
      successes: this.successes,
      unnamed: this.unnamed,
      feeds: this.feeds,
      feedErrors: this.feedErrors,
      wounds: this.book.stats(),
      byCause: Object.freeze({ ...this.byCause }),
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.book.clear()
  }

  /**
   * 把一次工具结果喂给器官宿主。
   * @param tool 工具名。
   * @param ok 成功与否。
   * @param errorCode 协议码。
   * @param text 正文（已截断）。
   */
  private feed(tool: string, ok: boolean, errorCode: string | undefined, text: string | undefined): void {
    const settings = this.deps.settings()
    if (!settings.feedHost) return
    const host = this.deps.host()
    if (host === undefined || !host.available) return
    try {
      host.toolResult({
        at: this.deps.now(),
        tool,
        ok,
        errorCode,
        text: truncate(text, settings.maxTextChars),
      })
      this.feeds += 1
    } catch (error) {
      // 宿主挂了不能影响工具结果本身：C3 的同一句话，换个方向也成立。
      this.feedErrors += 1
      this.deps.log.warn('喂器官宿主失败（工具 %s）：%s', tool, textOf(error))
    }
  }
}

/**
 * 从上游 exec 里取工具名。
 * @param exec 上游 `ToolExecution`。
 */
function toolNameOf(exec: unknown): string | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const name = (exec as ToolExecutionLike).name
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 把上游结果收窄成本包声明的形状。
 * @param result 上游结果。
 */
function resultOf(result: unknown): ToolResultLike | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  return result as ToolResultLike
}

/**
 * 从结果正文里取文字块。
 * @param result 上游结果。
 */
function textOfContent(result: ToolResultLike | undefined): string | undefined {
  if (result === undefined || !Array.isArray(result.content)) return undefined
  const parts: string[] = []
  for (const raw of result.content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { readonly type?: unknown; readonly text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * 截断。
 * @param text 正文。
 * @param maxChars 上限（0 = 不要正文）。
 */
function truncate(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) return undefined
  if (maxChars <= 0) return undefined
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, maxChars).join('')
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
