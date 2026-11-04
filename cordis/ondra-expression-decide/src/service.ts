/**
 * 服务层：把纯判定链接到宿主上（读一次六态、记几个计数、吞掉异常）。
 *
 * ## 三条边界
 *
 * 1. **不改任何人的状态。** 不调 O-031 的写入口（它本来也没有），
 *    也不往任何存储里写"当前表情"。表情是**每句话的读数**，不是状态。
 *    器官 ABI 的 C1 在这里等于：只出建议，谁要换脸谁自己换。
 * 2. **错误不外抛（C3）。** 读六态抛错 → 记一条 `lastError`、
 *    `degraded` 标 `no-express`，判定照常按正文线索走。
 *    一次读服务失败不该让整轮回复发不出去。
 * 3. **不缓存六态。** 每次判定现取。缓存会让"她刚才明明还很蔫"这句话
 *    在日志里永远成立——而读数早就变了。
 */

import { dominantOf, markOf } from './decide.js'
import { isExpressionState } from './types.js'
import type { Config } from './settings.js'
import type {
  DecideOptions,
  DegradedCode,
  ExpressionMark,
  ExpressionService,
  ExpressionState,
  ExpressionStats,
  ExpressLike,
  LogLike,
  MarkSource,
  TurnExpression,
} from './types.js'

/** 服务依赖（全部注入，便于脱离宿主逐例核对）。 */
export interface DeciderDeps {
  readonly settings: Config
  readonly log: LogLike
  /** 取当前时刻。 */
  readonly now: () => number
  /** 取 O-031（可能后装载，因此每次现取）。 */
  readonly express: () => ExpressLike | undefined
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读六态的结果。 */
interface StateRead {
  readonly state?: ExpressionState
  readonly degraded?: DegradedCode
}

/** 表情判定服务实现。 */
export class ExpressionDecider implements ExpressionService {
  /** 配置。 */
  private readonly settings: Config
  /** 日志。 */
  private readonly log: LogLike
  /** 时钟。 */
  private readonly now: () => number
  /** 取六态。 */
  private readonly express: () => ExpressLike | undefined

  /** 判过的条数。 */
  private reads = 0
  /** 判过的轮数。 */
  private turns = 0
  /** 线索总条数。 */
  private cues = 0
  /** 按来源分桶。 */
  private readonly bySource: Record<MarkSource, number> = { text: 0, state: 0, default: 0 }
  /** 按态分桶（只计 text 来源）。 */
  private readonly byState: Partial<Record<ExpressionState, number>> = {}
  /** 最近一次的态。 */
  private lastState: ExpressionState | undefined
  /** 最近一次的来源。 */
  private lastSource: MarkSource | undefined
  /** 最近一次错误。 */
  private lastError: string | undefined

  constructor(deps: DeciderDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.now = deps.now
    this.express = deps.express
  }

  /** 是否可用：只看开关。缺六态是降级，不是不可用。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): 'disabled' | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /**
   * 读一次当前六态。**永不抛**。
   * @param at 时刻。
   */
  private readState(at: number): StateRead {
    const express = this.express()
    if (express === undefined) return { degraded: 'no-express' }
    const stateOf = express.stateOf
    if (typeof stateOf !== 'function') return { degraded: 'no-express' }
    try {
      // 用 `call` 保住 `this`：上游的 `stateOf()` 是类方法，脱开实例调用会读到
      // 空的配置对象，而它不会抛错——只会给出一个"读数为默认值"的态。
      const view = stateOf.call(express, at)
      if (view === undefined) return { degraded: 'no-express' }
      if (!isExpressionState(view.state)) {
        // 上游加了第七态。**不映射、不猜**：映射到「平静」会让面板一切正常，
        // 只有她的脸不对，而这条线索在日志里查不到。
        return { degraded: 'unknown-state' }
      }
      return { state: view.state }
    } catch (error) {
      this.lastError = messageOf(error)
      return { degraded: 'no-express' }
    }
  }

  /**
   * 判一条。
   * @param text 正文。
   * @param options 入参。
   */
  decide(text: string, options?: DecideOptions): ExpressionMark {
    const at = options?.at ?? this.now()
    // 调用方可能是 JS（拿不到类型检查），因此这里仍做一次运行期兜底。
    const source = typeof text === 'string' ? text : ''

    if (!this.settings.enable) {
      // 关掉时给一个"没有依据"的标记，而不是抛错或返回空：
      // 调用方即使没看 available，也只会拿到一张最不容易出错的脸。
      return this.record(
        markOf({
          text: source,
          index: options?.index ?? 0,
          minScore: Number.POSITIVE_INFINITY,
          fallbackState: this.settings.fallbackState,
        }),
      )
    }

    const explicit = options?.state
    const read: StateRead =
      explicit !== undefined
        ? { state: explicit }
        : this.settings.useStateFallback
          ? this.readState(at)
          : {}

    return this.record(
      markOf({
        text: source,
        index: options?.index ?? 0,
        minScore: this.settings.minScore,
        fallbackState: this.settings.fallbackState,
        ...(read.state === undefined ? {} : { stateFromExpress: read.state }),
      }),
    )
  }

  /**
   * 判一整轮。**推荐入口**：六态只读一次，顺带给出 `dominant`。
   * @param texts 每一句正文。
   * @param options 入参。
   */
  decideTurn(texts: readonly string[], options?: DecideOptions): TurnExpression {
    const at = options?.at ?? this.now()
    const list = Array.isArray(texts) ? texts : []
    const degraded = new Set<DegradedCode>()

    const explicit = options?.state
    let stateFromExpress: ExpressionState | undefined
    if (explicit !== undefined) {
      stateFromExpress = explicit
    } else if (this.settings.enable && this.settings.useStateFallback) {
      const read = this.readState(at)
      if (read.degraded !== undefined) degraded.add(read.degraded)
      stateFromExpress = read.state
    }

    const marks: ExpressionMark[] = []
    for (let i = 0; i < list.length; i += 1) {
      const mark = this.settings.enable
        ? markOf({
            text: list[i] as string,
            index: i,
            minScore: this.settings.minScore,
            fallbackState: this.settings.fallbackState,
            ...(stateFromExpress === undefined ? {} : { stateFromExpress }),
          })
        : markOf({
            text: list[i] as string,
            index: i,
            minScore: Number.POSITIVE_INFINITY,
            fallbackState: this.settings.fallbackState,
          })
      marks.push(this.record(mark))
    }

    // 整轮一条正文线索都没有：让调用方看得见"这次的脸不是从话里读出来的"。
    if (marks.length > 0 && marks.every(mark => mark.source !== 'text')) degraded.add('no-cues')

    this.turns += 1
    const dominant = dominantOf(marks, this.settings.fallbackState)

    if (this.settings.verbose && marks.length > 0) {
      this.log.debug(
        '表情判定：%d 条 · 主态 %s · 来源 %s%s',
        marks.length,
        dominant,
        marks[marks.length - 1]?.source ?? 'default',
        degraded.size === 0 ? '' : ' · 降级 ' + [...degraded].join(','),
      )
    }

    return Object.freeze({
      marks: Object.freeze(marks),
      dominant,
      degraded: Object.freeze([...degraded]),
      at,
    })
  }

  /** 读数。 */
  stats(): ExpressionStats {
    return Object.freeze({
      reads: this.reads,
      turns: this.turns,
      bySource: Object.freeze({ ...this.bySource }),
      cues: this.cues,
      byState: Object.freeze({ ...this.byState }),
      ...(this.lastState === undefined ? {} : { lastState: this.lastState }),
      ...(this.lastSource === undefined ? {} : { lastSource: this.lastSource }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    })
  }

  /**
   * 记一次判定。
   * @param mark 标记。
   */
  private record(mark: ExpressionMark): ExpressionMark {
    this.reads += 1
    this.cues += mark.cues.length
    this.bySource[mark.source] += 1
    this.lastState = mark.state
    this.lastSource = mark.source
    if (mark.source === 'text') {
      this.byState[mark.state] = (this.byState[mark.state] ?? 0) + 1
    }
    return mark
  }
}
