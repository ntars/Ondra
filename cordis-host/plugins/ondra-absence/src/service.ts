/**
 * 接线与降级：把纯判定层（`gap.ts`）接上时钟、路径与存档。
 *
 * ## 为什么 `touch()` 与 `mention()` 是两个方法
 *
 * 「她回来了」与「她提过了」是两件事。合成一个，外壳每渲染一次就会推进一次
 * 水位，于是「同一轮只提一次」这条规则永远不成立——最后变成每轮都来一句
 * 「好久不见」。分开之后，只有真正把话说出去的那一方才调 `mention()`。
 *
 * ## 三种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-path-layout` | 只在内存，重启后当成第一次记录 | `stored=false` + 一行日志 |
 * | `ondra-clock` | 系统时间（本插件只用时刻差，不用日历） | 无感，不额外报 |
 * | `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行日志 |
 *
 * ## 它不发出任何一句话
 *
 * 返回值只有档位、粗粒度词、必须做与不许做的清单、句数上限。没有台词。
 */

import type {
  AbsenceErrorCode,
  AbsenceService,
  AbsenceStats,
  AbsenceTier,
  AbsenceView,
  ClockLike,
  CoarseGap,
  LogLike,
  PathLike,
  RegreetPlan,
} from './types.js'
import { ABSENCE_TIERS, AbsenceError, COARSE_OF, STATE_FILE_NAME } from './types.js'
import type { Config } from './settings.js'
import { emptyState, gapOf, minutesOf, planOf, tierOf } from './gap.js'
import type { AbsenceState } from './gap.js'
import { readState, writeState } from './store.js'

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000

/** 依赖。 */
export interface AbsenceDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时钟服务（可能缺席）。 */
  readonly clock: () => ClockLike | undefined
  /** 路径服务（可能缺席）。 */
  readonly path: () => PathLike | undefined
  /** 系统时钟（毫秒）。 */
  readonly now: () => number
}

/** 把时刻参数规整成合法值；非法一律抛 `bad-request`。 */
function atOf(given: number | undefined, now: () => number): number {
  const at = given === undefined ? now() : given
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    throw new AbsenceError('bad-request', '时刻必须是正的有限数', String(given))
  }
  return Math.trunc(at)
}

/** 空窗期礼仪。 */
export class Absence implements AbsenceService {
  readonly #deps: AbsenceDeps

  /** 当前状态。 */
  #state: AbsenceState = emptyState()

  /** 是否已经读过盘。 */
  #loaded = false

  /** 最近一次写盘是否成功。 */
  #writeOk = false

  /** 写盘次数与失败次数。 */
  #writes = 0
  #writeFailures = 0

  /** 最近一次失败原因。 */
  #lastIssue: string | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: AbsenceDeps) {
    this.#deps = deps
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): AbsenceErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /** 状态是否真的落盘。 */
  get stored(): boolean {
    return this.#filePath() !== undefined && (this.#writeOk || !this.#loaded)
  }

  /** 存档的绝对路径；缺路径服务时 `undefined`。 */
  #filePath(): string | undefined {
    const path = this.#deps.path()
    if (path === undefined) return undefined
    try {
      return path.fileIn('user', STATE_FILE_NAME)
    } catch (error) {
      this.#lastIssue = '拼不出空窗时刻档路径：' + this.#messageOf(error)
      return undefined
    }
  }

  /** 取错误消息文本。 */
  #messageOf(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  /** 首次使用时惰性读盘。 */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true
    const result = readState(this.#filePath())
    this.#state = result.state
    this.#writeOk = this.#filePath() !== undefined
    if (result.issue !== undefined) {
      this.#lastIssue = result.issue
      this.#deps.log.warn('%s（下一次会当成第一次记录）', result.issue)
    }
  }

  /** 落盘。失败只记日志并计数，**永不抛出**。 */
  #persist(): void {
    const filePath = this.#filePath()
    if (filePath === undefined) {
      this.#writeOk = false
      return
    }
    try {
      writeState(filePath, this.#state)
      this.#writes += 1
      this.#writeOk = true
    } catch (error) {
      this.#writeFailures += 1
      this.#writeOk = false
      this.#lastIssue = '写空窗时刻档失败：' + this.#messageOf(error)
      this.#deps.log.warn('%s（重启后会当成第一次记录）', this.#lastIssue)
    }
  }

  /** 总开关关掉时，写方法一律拒绝（读接口照常）。 */
  #guard(): void {
    if (!this.available) {
      throw new AbsenceError('disabled', '空窗期礼仪已关闭（enable=false）')
    }
  }

  /** 当前时刻（优先走 O-003，缺席用系统时间）。 */
  #now(): number {
    const clock = this.#deps.clock()
    if (clock === undefined) return this.#deps.now()
    try {
      // 时钟服务在，但系统时间仍是唯一可信的「现在」：它只提供日历换算，不提供时刻源。
      const stamp = this.#deps.now()
      return Number.isFinite(stamp) && stamp > 0 ? Math.trunc(stamp) : clock.now()
    } catch (error) {
      this.#lastIssue = '时钟服务取值失败，退回系统时间：' + this.#messageOf(error)
      return Date.now()
    }
  }

  /**
   * 组装只读视图。
   * @param at 时刻。
   */
  #viewOf(at: number): AbsenceView {
    const gapMs = gapOf(this.#state, at)
    const tier = tierOf(gapMs, this.#deps.settings)
    const coarse: CoarseGap | null = tier === null ? null : COARSE_OF[tier]
    return Object.freeze({
      firstSeenAt: this.#state.firstSeenAt,
      lastSeenAt: this.#state.lastSeenAt,
      gapMs,
      // 从没记录过时给 0，配 `lastSeenAt === null` 一起看：单看 0 会被读成「刚刚才见过」。
      gapDays: gapMs === null ? 0 : Math.floor(gapMs / DAY_MS),
      tier,
      coarse,
      touches: this.#state.touches,
      mentions: this.#state.mentions,
      stored: this.stored,
    })
  }

  /**
   * 记一次活动。**唯一会写盘的方法之一。**
   * @param at 时刻，省略用系统时间。
   */
  touch(at?: number): AbsenceView {
    this.#guard()
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    this.#state = Object.freeze({
      firstSeenAt: this.#state.firstSeenAt ?? stamp,
      lastSeenAt: stamp,
      // 末次时刻往前推之后，`lastMentionAt >= lastSeenAt` 自然不成立，
      // 于是新一轮空窗的「提过没有」自动归零，不需要单独清一次。
      lastMentionAt: this.#state.lastMentionAt,
      touches: this.#state.touches + 1,
      mentions: this.#state.mentions,
      restarts: this.#state.restarts,
    })
    this.#persist()
    return this.#viewOf(stamp)
  }

  /**
   * 只读视图。
   * @param at 时刻。
   */
  view(at?: number): AbsenceView {
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    return this.#viewOf(stamp)
  }

  /**
   * 只读课表。从没记录过活动时返回 `null`。
   * @param at 时刻。
   */
  greet(at?: number): RegreetPlan | null {
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    const gapMs = gapOf(this.#state, stamp)
    const tier = tierOf(gapMs, this.#deps.settings)
    if (tier === null) return null
    const mentioned =
      this.#state.lastMentionAt !== null &&
      this.#state.lastSeenAt !== null &&
      this.#state.lastMentionAt >= this.#state.lastSeenAt
    return planOf(tier, this.#deps.settings.maxSentencesCap, mentioned)
  }

  /**
   * 记一次「已经真的提了一句」。
   * @param tier 提到的是哪一档。
   * @param at 时刻。
   */
  mention(tier: AbsenceTier, at?: number): AbsenceView {
    this.#guard()
    if (!(ABSENCE_TIERS as readonly string[]).includes(tier)) {
      throw new AbsenceError('bad-request', '档位不在五档闭集里', String(tier))
    }
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    const mentioned =
      this.#state.lastMentionAt !== null &&
      this.#state.lastSeenAt !== null &&
      this.#state.lastMentionAt >= this.#state.lastSeenAt
    if (mentioned) {
      // 同一轮重复记：静默放过，不抛错——外壳重试一次不该让对话中断。
      this.#deps.log.debug?.('这一轮已经记过「提过一句」，忽略重复上报')
      return this.#viewOf(stamp)
    }
    this.#state = Object.freeze({
      firstSeenAt: this.#state.firstSeenAt ?? stamp,
      lastSeenAt: this.#state.lastSeenAt,
      lastMentionAt: stamp,
      touches: this.#state.touches,
      mentions: this.#state.mentions + 1,
      restarts: this.#state.restarts,
    })
    this.#persist()
    return this.#viewOf(stamp)
  }

  /**
   * 重来一遍（换人）。
   * @param at 时刻。
   */
  reset(at?: number): AbsenceView {
    this.#guard()
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    // 重来次数是唯一跨 reset 保留的字段：它是「这已经是第二个人」的唯一线索。
    this.#state = emptyState(this.#state.restarts + 1)
    this.#persist()
    this.#deps.log.info('空窗记录已重置（第 %d 次重来），时刻 %d', this.#state.restarts, stamp)
    return this.#viewOf(stamp)
  }

  /** 累计统计快照。 */
  stats(): AbsenceStats {
    this.#ensureLoaded()
    const base = {
      touches: this.#state.touches,
      mentions: this.#state.mentions,
      restarts: this.#state.restarts,
      writes: this.#writes,
      writeFailures: this.#writeFailures,
      stored: this.stored,
    }
    return Object.freeze(
      this.#lastIssue === undefined ? base : { ...base, lastIssue: this.#lastIssue },
    )
  }
}

/** 供自检与调试用：毫秒换算成分钟（**不许念出来**）。 */
export { minutesOf }
