/**
 * 接线与降级：把纯轮次状态机（`rounds.ts`）与四拍约束表（`briefs.ts`）接上时钟与人设。
 *
 * ## 它不发出任何一句话、不生成任何一段内容
 *
 * 全部返回值都是**约束**（这一拍谁开口、该解决什么、必须做到什么、不许做什么），
 * 没有一处拼内容。谁把话说出去、用什么口吻、写成什么样，归对话链（O-033）与人格（O-020）。
 *
 * ## 三种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-persona-core` | 边界条数记 `null`，出稿 / 收束拍换成一条「先核对边界」的禁令 | 一行 `warn` + `mustNot` 里那句措辞不同 |
 * | `ondra-clock` | 系统时间（时刻只用于展示与排序，差几毫秒无影响） | 无感，不额外报 |
 * | `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行 `warn` |
 * | `ondra-identity` | 日志命名空间退回 `ondra.cocreate` | 无感 |
 *
 * ## 为什么边界条数每次立题重取一次
 *
 * 人设（O-021）常比本插件晚装载。装载期取一次就把它钉死成 `null`，之后
 * 整场共创都会带着「边界取不到」的禁令，而那时人设其实早就好了。
 * 重取的时机选在 `open()`：一次会话取一次，不会每拍都去碰上游。
 *
 * ## 为什么状态不落盘
 *
 * 共创是一次对话之内的事。落盘只会得到一种更坏的局面：下一个进程读到「第 3 版」，
 * 却不知道前 3 版做过什么，然后对着一个自己没见过的稿子收束。
 */

import type {
  ClockLike,
  CocreateErrorCode,
  CocreateRound,
  CocreateService,
  CocreateSnapshot,
  CocreateStats,
  LogLike,
  PersonaCoreLike,
} from './types.js'
import { CocreateError } from './types.js'
import type { Config } from './settings.js'
import { GOAL_MAX_CHARS } from './settings.js'
import { briefAt, noteOf } from './briefs.js'
import type { BriefInput } from './briefs.js'
import { closeState, handoffState, idleState, kindOf, snapshotOf, startState } from './rounds.js'
import type { SessionState, StepFail } from './rounds.js'

/** 依赖。 */
export interface CocreateDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时钟服务（可能缺席）。 */
  readonly clock: () => ClockLike | undefined
  /** 人设服务（可能缺席）。 */
  readonly persona: () => PersonaCoreLike | undefined
  /** 系统时钟（毫秒）。 */
  readonly now: () => number
}

/** 失败原因 → 中文说明。文案在这里，错误码在 `types.ts`，两边分开改。 */
const FAIL_MESSAGES: Readonly<Record<StepFail, string>> = Object.freeze({
  'no-session': '还没开始共创：先 open(goal)',
  'already-done': '这次共创已经收束，再推进没有意义',
  'round-cap': '版数已用尽，只能 close() 收束——上限要拦的正是「再改一版就好」',
})

/** 共创流程。 */
export class Cocreate implements CocreateService {
  readonly #deps: CocreateDeps

  /** 当前会话状态。 */
  #state: SessionState = idleState()

  /** 本次会话的人设硬边界条数；`undefined` = 本次会话还没取过。 */
  #boundaryCount: number | null | undefined = undefined

  /** 内存计数（不落盘）。 */
  #sessions = 0
  #handoffs = 0
  #editions = 0
  #closes = 0
  #rejected = 0
  #capHits = 0

  /** 最近一次失败原因。 */
  #lastIssue: string | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: CocreateDeps) {
    this.#deps = deps
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): CocreateErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /** 取错误消息文本。 */
  #messageOf(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  /** 现在几点。时钟缺席就退回系统时间。 */
  #now(): number {
    const clock = this.#deps.clock()
    if (clock === undefined) return Math.trunc(this.#deps.now())
    try {
      const at = clock.now()
      if (typeof at === 'number' && Number.isFinite(at) && at > 0) return Math.trunc(at)
    } catch (error) {
      this.#deps.log.warn('读时钟失败，本次退回系统时间：%s', this.#messageOf(error))
    }
    return Math.trunc(this.#deps.now())
  }

  /** 总开关关掉时，所有写方法一律拒绝（读接口照常）。 */
  #guard(): void {
    if (!this.available) {
      this.#rejected += 1
      throw new CocreateError('disabled', '共创流程已关闭（enable=false）')
    }
  }

  /** 记一次拒绝并抛错。被拒次数是「硬上限真的在拦人」的唯一证据。 */
  #reject(code: CocreateErrorCode, message: string, detail?: string): never {
    this.#rejected += 1
    this.#lastIssue = message
    throw new CocreateError(code, message, detail)
  }

  /**
   * 本次会话的人设硬边界条数。取不到就 `null`，**不拿 0 顶替**——
   * 0 会被读成「人设没有任何边界」，那是最危险的一种误读。
   */
  #boundaries(): number | null {
    if (this.#boundaryCount !== undefined) return this.#boundaryCount
    let count: number | null = null
    const persona = this.#deps.persona()
    if (persona === undefined || !persona.available) {
      this.#deps.log.warn('人设服务不可用：边界条数按「取不到」处理（不按 0 处理）')
    } else {
      try {
        const items = persona.boundaries()
        // 空数组是真的「没有边界条目」，与「取不到」不是一回事，仍按 0 条算。
        count = Array.isArray(items) ? items.length : null
      } catch (error) {
        this.#deps.log.warn(
          '读人设边界失败，边界条数按「取不到」处理：%s',
          this.#messageOf(error),
        )
        count = null
      }
    }
    this.#boundaryCount = count
    return count
  }

  /** 当前上下文（拍 id 由阶段推出，调用方无法自选）。 */
  #input(): BriefInput | null {
    const kind = kindOf(this.#state.phase)
    if (kind === null) return null
    return {
      kind,
      edition: this.#state.edition,
      maxEditions: this.#deps.settings.maxEditions,
      closing: this.#state.phase === 'closing' || this.#state.edition >= this.#deps.settings.maxEditions,
      boundaryCount: this.#boundaries(),
    }
  }

  /** 空拍的视图（还没开 / 已收束）。 */
  #emptyView(note: string): CocreateRound {
    return Object.freeze({
      snapshot: this.snapshot(),
      kind: null,
      owner: null,
      intent: '',
      mustDo: Object.freeze([]) as readonly string[],
      mustNot: Object.freeze([]) as readonly string[],
      askFinal: false,
      note,
    })
  }

  /** 组装一拍视图。 */
  #view(): CocreateRound {
    if (this.#state.phase === 'idle') {
      return this.#emptyView('还没开始：先 open(goal) 把「要一起做出什么」说清楚')
    }
    if (this.#state.phase === 'closed') {
      return this.#emptyView('这次共创已经收束：定稿与否由人回答，本插件不记答案')
    }
    const input = this.#input()
    if (input === null) {
      return this.#emptyView('当前阶段没有可执行的一拍')
    }
    const brief = briefAt(input)
    return Object.freeze({
      snapshot: this.snapshot(),
      kind: brief.kind,
      owner: brief.owner,
      intent: brief.intent,
      mustDo: brief.mustDo,
      mustNot: brief.mustNot,
      askFinal: brief.kind === 'close',
      note: noteOf(input),
    })
  }

  /**
   * 收束视图。**刻意不复用 `#view()`**：收束之后阶段就是 `closed`，
   * 而 `#view()` 对 `closed` 只回一个空拍。那一拍恰恰是最该说的那一句，
   * 复用会让调用方拿到「已经结束了」而永远问不出「这版算定稿吗」。
   */
  #closeView(): CocreateRound {
    const input: BriefInput = {
      kind: 'close',
      edition: this.#state.edition,
      maxEditions: this.#deps.settings.maxEditions,
      closing: this.#state.edition >= this.#deps.settings.maxEditions,
      boundaryCount: this.#boundaries(),
    }
    const brief = briefAt(input)
    return Object.freeze({
      snapshot: this.snapshot(),
      kind: 'close' as const,
      owner: brief.owner,
      intent: brief.intent,
      mustDo: brief.mustDo,
      mustNot: brief.mustNot,
      askFinal: true,
      note: noteOf(input),
    })
  }

  /**
   * 开一次共创：立题。重复调用等于换题，版数与账目一律清零。
   * @param goal 要做出的东西（一句话）。
   */
  open(goal: string): CocreateRound {
    this.#guard()
    if (typeof goal !== 'string') {
      this.#reject('bad-request', '立题必须是一句话（字符串）', typeof goal)
    }
    const text = goal.trim()
    if (text === '') {
      this.#reject('bad-request', '立题不能为空：说不出要做出什么，就没有可验收的标准')
    }
    if (text.length > GOAL_MAX_CHARS) {
      this.#reject(
        'bad-request',
        '立题超过 ' + String(GOAL_MAX_CHARS) + ' 字：立题要一句话，长到这种程度说明还没想清',
        String(text.length),
      )
    }
    this.#sessions += 1
    this.#state = startState(this.#now(), text.length)
    // 换题就重取边界：人设可能比本插件晚装载。
    this.#boundaryCount = undefined
    this.#deps.log.info('共创开始：%d 字目标，版数上限 %d', text.length, this.#deps.settings.maxEditions)
    return this.#view()
  }

  /** 当前这一拍。**只读，不推进水位。** */
  next(): CocreateRound {
    return this.#view()
  }

  /**
   * 兑现当前这一拍。
   * @param note 交接备注（一句）。空的一律拒绝——什么都没说就想交下一版，就是拖。
   * @param expectedEdition 调用方认为当前是第几版。
   */
  handoff(note: string, expectedEdition: number): CocreateRound {
    this.#guard()
    if (typeof note !== 'string') {
      this.#reject('bad-request', '交接备注必须是字符串', typeof note)
    }
    const text = note.trim()
    if (text === '') {
      this.#reject('bad-request', '交接备注不能为空：不说清改了什么，就等于没交接')
    }
    if (text.length > this.#deps.settings.noteMaxChars) {
      this.#reject(
        'bad-request',
        '交接备注超过 ' + String(this.#deps.settings.noteMaxChars) + ' 字：备注是一句话，不是总结',
        String(text.length),
      )
    }
    if (
      typeof expectedEdition !== 'number' ||
      !Number.isFinite(expectedEdition) ||
      expectedEdition < 0 ||
      !Number.isInteger(expectedEdition)
    ) {
      this.#reject('bad-request', '版号必须是非负整数', String(expectedEdition))
    }
    if (this.#state.phase === 'idle') {
      this.#reject('no-session', FAIL_MESSAGES['no-session'])
    }
    if (expectedEdition !== this.#state.edition) {
      // 版号不一致说明有第二个调用方也在改。当场拒绝，而不是把对方的改动悄悄盖掉。
      this.#reject(
        'stale-version',
        '版号不一致：调用方以为的版号与真实版号不同',
        '调用方 ' + String(expectedEdition) + '，实际 ' + String(this.#state.edition),
      )
    }
    const step = handoffState(this.#state, this.#now(), this.#deps.settings.maxEditions)
    if (!step.ok) {
      if (step.fail === 'round-cap') this.#capHits += 1
      this.#reject(step.fail, FAIL_MESSAGES[step.fail])
    } else {
      this.#state = step.state
      this.#handoffs += 1
      if (step.fulfilled === 'make') this.#editions += 1
    }
    return this.#view()
  }

  /** 收束：把定稿的决定权交回去。**幂等**。 */
  close(): CocreateRound {
    this.#guard()
    const result = closeState(this.#state, this.#now())
    if (!result.ok) {
      this.#reject('no-session', FAIL_MESSAGES['no-session'])
    } else {
      this.#state = result.state
      if (result.changed) {
        this.#closes += 1
        this.#deps.log.info(
          '共创收束：共 %d 版、%d 次交接（定稿与否由人回答，本插件不记答案）',
          this.#state.edition,
          this.#state.rounds,
        )
      }
    }
    return this.#closeView()
  }

  /** 进度快照。 */
  snapshot(): CocreateSnapshot {
    return snapshotOf(this.#state, this.#deps.settings.maxEditions)
  }

  /** 累计统计快照。 */
  stats(): CocreateStats {
    const base = {
      sessions: this.#sessions,
      handoffs: this.#handoffs,
      editions: this.#editions,
      closes: this.#closes,
      rejected: this.#rejected,
      capHits: this.#capHits,
    }
    return Object.freeze(
      this.#lastIssue === undefined ? base : { ...base, lastIssue: this.#lastIssue },
    )
  }
}
