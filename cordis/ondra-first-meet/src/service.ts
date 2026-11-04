/**
 * 接线与降级：把纯进度层（`progress.ts`）与节拍表（`beats.ts`）接上时钟、路径与存档。
 *
 * ## 为什么读盘是惰性的
 *
 * 装载期做磁盘 IO 会拖慢启动，而且那一刻 O-002 可能还没就绪——早读一次的结果是
 * 「路径算不出来，静默退回内存」，之后再也不重试。故第一次真正用到时才读。
 *
 * ## 三种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-path-layout` | 只在内存，重启后初见从头再来一遍 | `stored=false` + 一行日志 |
 * | `ondra-clock` | 系统时间（`metAt` 只用于展示，差几毫秒无影响） | 无感，不额外报 |
 * | `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行日志 |
 *
 * ## 它不发出任何一句话
 *
 * 全部返回值都是**约束**（该做什么、不许做什么、几句话之内），没有一处拼台词。
 * 谁把话说出去、用什么口吻，归人格（O-020）与表达（O-047）。
 */

import type {
  BeatId,
  ClockLike,
  FirstMeetService,
  LogLike,
  MeetErrorCode,
  MeetScript,
  MeetSnapshot,
  MeetStats,
  PathLike,
  ScriptBeat,
} from './types.js'
import { BEAT_IDS, FirstMeetError, STATE_FILE_NAME } from './types.js'
import type { Config } from './settings.js'
import { allBeats, beatAt, noteOf } from './beats.js'
import {
  advanceState,
  emptyState,
  interruptState,
  skipAllState,
  snapshotOf,
} from './progress.js'
import type { MeetState } from './progress.js'
import { readState, writeState } from './store.js'

/** 依赖。 */
export interface FirstMeetDeps {
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
    throw new FirstMeetError('bad-request', '时刻必须是正的有限数', String(given))
  }
  return Math.trunc(at)
}

/** 初见剧本。 */
export class FirstMeet implements FirstMeetService {
  readonly #deps: FirstMeetDeps

  /** 当前状态。 */
  #state: MeetState = emptyState()

  /** 是否已经读过盘（只读一次）。 */
  #loaded = false

  /** 最近一次写盘是否成功。 */
  #writeOk = false

  /** 写盘次数与失败次数。 */
  #writes = 0
  #writeFailures = 0

  /** 被打断次数与重来次数（内存计数，落盘的是状态里那两个）。 */
  #interrupts = 0

  /** 最近一次失败原因。 */
  #lastIssue: string | undefined

  /** 节拍表（按配置天花板派生一次）。 */
  readonly #beats: readonly ScriptBeat[]

  /**
   * @param deps 依赖。
   */
  constructor(deps: FirstMeetDeps) {
    this.#deps = deps
    this.#beats = allBeats(deps.settings.maxSentencesCap)
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): MeetErrorCode | undefined {
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
      this.#lastIssue = '拼不出初见进度档路径：' + this.#messageOf(error)
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
      this.#deps.log.warn('%s（初见会从头再走一遍）', result.issue)
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
      writeState(filePath, this.#state, this.#state.delivered)
      this.#writes += 1
      this.#writeOk = true
    } catch (error) {
      this.#writeFailures += 1
      this.#writeOk = false
      this.#lastIssue = '写初见进度档失败：' + this.#messageOf(error)
      this.#deps.log.warn('%s（重启后初见会从头再走一遍）', this.#lastIssue)
    }
  }

  /** 总开关关掉时，所有写方法一律拒绝（读接口照常）。 */
  #guard(): void {
    if (!this.available) {
      throw new FirstMeetError('disabled', '初见剧本已关闭（enable=false）')
    }
  }

  /**
   * 关闭 `autoStart` 且还没见过时，整段初见不出现。
   *
   * 这不是「假开关」：它决定的是**这条对话里到底有没有初见这一段**，
   * 关掉时 `plan()` 返回空节拍、`advance()` 直接拒绝，而不是返回一份照旧可用的脚本。
   */
  #blockedByAutoStart(): boolean {
    return !this.#deps.settings.autoStart && !this.#state.met
  }

  /** 全部节拍。 */
  beats(): readonly ScriptBeat[] {
    this.#ensureLoaded()
    return this.#blockedByAutoStart() ? Object.freeze([]) : this.#beats
  }

  /** 进度快照。 */
  snapshot(): MeetSnapshot {
    this.#ensureLoaded()
    return snapshotOf(this.#state, this.stored)
  }

  /** 当前脚本。**只读，不推进水位。** */
  plan(): MeetScript {
    this.#ensureLoaded()
    if (this.#blockedByAutoStart()) {
      return Object.freeze({
        snapshot: this.snapshot(),
        beats: Object.freeze([]),
        current: null,
        next: null,
        note: '自动初见已关闭，这条对话里不会出现初见这一段（需要时把 auto-start 打开）',
      })
    }
    const position = this.#state.position
    const current = this.#state.done ? null : (beatAt(this.#beats, position) ?? null)
    return Object.freeze({
      snapshot: this.snapshot(),
      beats: this.#beats,
      current,
      next: beatAt(this.#beats, position + 1) ?? null,
      note: noteOf(position, this.#state.done, this.#deps.settings.autoStart),
    })
  }

  /**
   * 兑现当前这一拍。
   * @param expected 调用方认为当前是哪一拍；省略则不校验。
   */
  advance(expected?: BeatId): MeetScript {
    this.#guard()
    this.#ensureLoaded()
    if (this.#blockedByAutoStart()) {
      throw new FirstMeetError('bad-request', '自动初见已关闭，不能推进', 'auto-start=false')
    }
    if (this.#state.done) {
      throw new FirstMeetError('already-done', '初见已经走完，再推进没有意义')
    }
    if (expected !== undefined) {
      const currentId = BEAT_IDS[this.#state.position]
      if (!(BEAT_IDS as readonly string[]).includes(expected)) {
        throw new FirstMeetError('bad-request', '节拍 id 不在闭集里', String(expected))
      }
      if (expected !== currentId) {
        // 水位不一致说明有第二个调用方也在推进。当场报错，而不是把这一拍悄悄吃掉。
        throw new FirstMeetError(
          'bad-request',
          '水位不一致：调用方以为是这一拍，实际不是',
          '期望 ' + expected + '，实际 ' + String(currentId),
        )
      }
    }
    const stamp = atOf(undefined, this.#deps.now)
    this.#state = advanceState(this.#state, stamp)
    this.#persist()
    return this.plan()
  }

  /** 被打断：水位推到收束拍。 */
  interrupt(): MeetScript {
    this.#guard()
    this.#ensureLoaded()
    if (this.#blockedByAutoStart()) {
      throw new FirstMeetError('bad-request', '自动初见已关闭，不能推进', 'auto-start=false')
    }
    if (this.#state.done) return this.plan()
    this.#interrupts += 1
    this.#state = interruptState(this.#state, atOf(undefined, this.#deps.now))
    this.#persist()
    return this.plan()
  }

  /** 整段跳过。 */
  skipAll(): MeetScript {
    this.#guard()
    this.#ensureLoaded()
    if (this.#blockedByAutoStart()) {
      throw new FirstMeetError('bad-request', '自动初见已关闭，不能跳过', 'auto-start=false')
    }
    this.#state = skipAllState(this.#state, atOf(undefined, this.#deps.now))
    this.#persist()
    return this.plan()
  }

  /**
   * 重来一遍（换人 / 用户要求从头）。
   * @param at 时刻。
   */
  reset(at?: number): MeetSnapshot {
    this.#guard()
    this.#ensureLoaded()
    const stamp = atOf(at, this.#deps.now)
    // 重来次数是唯一跨 reset 保留的字段：它是「这已经是第二个人的初见」的唯一线索。
    this.#state = emptyState(this.#state.restarts + 1)
    this.#persist()
    this.#deps.log.info('初见已重置（第 %d 次重来），时刻 %d', this.#state.restarts, stamp)
    return this.snapshot()
  }

  /** 累计统计快照。 */
  stats(): MeetStats {
    this.#ensureLoaded()
    const base = {
      delivered: this.#state.delivered.length,
      interrupts: this.#interrupts,
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
