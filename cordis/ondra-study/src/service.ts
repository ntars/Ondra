/**
 * 接线与降级：把纯状态机（`session.ts`）接上时钟、路径与存档。
 *
 * ## 依赖全部用取值函数
 *
 * `path` / `clock` / `now` 都是 `() => ...` 而不是现成的值。理由有两条：
 * 上游晚装载时能自愈（第一次调用才取，不是 `apply` 那一刻取），
 * 上游早卸载时立刻反映（下次调用就变 `undefined`，自动退回降级路径）。
 *
 * ## 三种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-path-layout` | 只在内存，重启丢今日累计 | `stored=false` + 一行日志 |
 * | `ondra-clock` | 本机时区的自然日（口径相同，仅夏令时极端情形差一天） | 一行日志 |
 * | `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行日志 |
 *
 * **降级必须看得见**（§8.2）：静默降级之后，外壳会把 `stored=false` 的那份读数
 * 当成真的「今天已经学了两小时」。
 *
 * ## 写盘节流
 *
 * `tick()` 可能每几秒来一次，每来一次就写一遍盘会变成高频小文件写。
 * 所以 tick 走 60 秒节流；`start` / `stop` / `rest` / `checkpoint` 一律立刻落盘——
 * 这四个是「段落边界」，边界丢了会让重启后的读数自相矛盾。
 */

import type {
  ClockLike,
  LogLike,
  PathLike,
  RestAction,
  StudyCheckpoint,
  StudyErrorCode,
  StudyService,
  StudySnapshot,
  StudyStats,
  StudyTickResult,
} from './types.js'
import { REST_ACTIONS, STATE_FILE_NAME, StudyError } from './types.js'
import type { Config } from './settings.js'
import {
  advance,
  beginFocus,
  endFocus,
  emptyState,
  judgeRest,
  markRest,
  rollTo,
  snapshotOf,
} from './session.js'
import type { StudyState } from './session.js'
import { readState, writeState } from './store.js'

/**
 * 写盘节流：最快每 60 秒落一次。
 *
 * 只在 `tick()` 上生效。节流丢掉的只是最近 60 秒的累计，段落边界必落盘。
 */
const FLUSH_INTERVAL_MS = 60_000

/** 依赖。 */
export interface StudyDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 路径服务（可能缺席）。 */
  readonly path: () => PathLike | undefined
  /** 时钟服务（可能缺席）。 */
  readonly clock: () => ClockLike | undefined
  /** 系统时钟（毫秒）。 */
  readonly now: () => number
}

/** 把时刻参数规整成合法值；非法一律抛 `bad-request`。 */
function atOf(given: number | undefined, now: () => number): number {
  const at = given === undefined ? now() : given
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    throw new StudyError('bad-request', '时刻必须是正的有限数', String(given))
  }
  return Math.trunc(at)
}

/** 本机时区的自然日键。**只在 O-003 缺席时使用。** */
function localDayKey(at: number): string {
  const date = new Date(at)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/** 学伴。 */
export class Study implements StudyService {
  private readonly deps: StudyDeps
  private state: StudyState
  private loaded = false
  private writeOk = false
  private lastWriteAt = 0
  private ticks = 0
  private broken = 0
  private completed = 0
  private breaksTaken = 0
  private breaksDeclined = 0
  private rollovers = 0
  private writes = 0
  private writeFailures = 0
  private lastIssue: string | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: StudyDeps) {
    this.deps = deps
    // 只算日键，不读盘：装载期做磁盘 IO 会拖慢启动，且那一刻路径服务可能还没就绪。
    this.state = emptyState(this.dayKey(deps.now()))
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): StudyErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /**
   * 状态是否真的落盘。
   *
   * **口径是「当前读数重启后还回得来吗」，不是「路径算不算得出来」。**
   * 路径在、但一次都没写成功时报 `true`，外壳就会把一份会清零的读数当成可靠数据。
   */
  get stored(): boolean {
    return this.writeOk && this.filePath() !== undefined
  }

  /** 当前时刻的自然日键。 */
  private dayKey(at: number): string {
    const clock = this.deps.clock()
    if (clock !== undefined) {
      try {
        return clock.dayKey(at)
      } catch (error) {
        this.lastIssue = '时钟服务取自然日失败，退回本机时区：' + this.messageOf(error)
      }
    }
    return localDayKey(at)
  }

  /** 存档的绝对路径；缺路径服务时 `undefined`。 */
  private filePath(): string | undefined {
    const path = this.deps.path()
    if (path === undefined) return undefined
    try {
      return path.fileIn('user', STATE_FILE_NAME)
    } catch (error) {
      this.lastIssue = '拼不出存档路径：' + this.messageOf(error)
      return undefined
    }
  }

  /** 取错误消息文本。 */
  private messageOf(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  /** 首次使用时惰性读盘。 */
  private ensureLoaded(at: number): void {
    if (this.loaded) return
    this.loaded = true
    const result = readState(this.filePath(), this.dayKey(at))
    this.state = result.state
    // 只有「真从盘上读到今日状态」才算已落盘；新档 / 坏档 / 跨天都不算。
    this.writeOk = result.fresh === false && result.issue === undefined && this.filePath() !== undefined
    if (result.issue !== undefined) {
      this.lastIssue = result.issue
      this.deps.log.warn('%s（今日累计从零开始，其余读数不受影响）', result.issue)
    }
  }

  /**
   * 落盘。失败只记日志并计数，**永不抛出**——学伴不能因为写不了盘就把对话打断。
   * @param force 是否忽略节流。
   * @param at 当前时刻（节流用）。
   */
  private persist(force: boolean, at: number): void {
    const filePath = this.filePath()
    if (filePath === undefined) {
      this.writeOk = false
      return
    }
    if (!force && at - this.lastWriteAt < FLUSH_INTERVAL_MS) return
    try {
      writeState(filePath, this.state)
      this.writes += 1
      this.writeOk = true
      this.lastWriteAt = at
    } catch (error) {
      this.writeFailures += 1
      this.writeOk = false
      this.lastIssue = '写学习节奏存档失败：' + this.messageOf(error)
      this.deps.log.warn('%s（重启后今日累计会少算这一段）', this.lastIssue)
    }
  }

  /** 总开关关掉时，写方法一律拒绝（读接口照常）。 */
  private guard(): void {
    if (!this.available) {
      throw new StudyError('disabled', '学伴已关闭（enable=false）')
    }
  }

  /** 跨天时累加计数，便于自检看到「清零确实发生过」。 */
  private roll(at: number): string {
    const dayKey = this.dayKey(at)
    if (this.state.dayKey !== dayKey) this.rollovers += 1
    return dayKey
  }

  /**
   * 开始一段专注。已经在学则抛 `bad-request`——静默重开会把上一段无声切断。
   * @param subject 学的是什么。**收下但不落盘、不回传**：存它就等于存学习内容。
   * @param at 时刻，省略用时钟。
   */
  start(subject?: string, at?: number): StudySnapshot {
    this.guard()
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    if (this.state.phase === 'focus') {
      throw new StudyError('bad-request', '已经在一段专注里，不允许静默重开', String(subject ?? ''))
    }
    if (subject !== undefined) {
      // 明确记一笔「收到了但故意不存」，比沉默丢弃更容易在排查时看懂。
      this.deps.log.debug?.('收到科目名，按纪律丢弃、不落盘')
    }
    const dayKey = this.roll(stamp)
    this.state = beginFocus(this.state, stamp, dayKey)
    this.persist(true, stamp)
    this.deps.log.info('开始一段专注（今日已累计 %d 分钟）', Math.floor(this.state.focusMsToday / 60_000))
    return snapshotOf(this.state, stamp, this.deps.settings, this.stored)
  }

  /**
   * 推进一步。**时长只在这里涨**，且只涨「与上次打点之间的那一小段」。
   * @param at 时刻，省略用时钟。
   */
  tick(at?: number): StudyTickResult {
    this.guard()
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    const dayKey = this.roll(stamp)
    const result = advance(this.state, stamp, dayKey, this.deps.settings)
    this.state = result.state
    this.ticks += 1
    if (result.event === 'gap-broken' || result.event === 'clock-back') {
      this.broken += 1
      // 段边界必须立刻落盘：否则重启后「这一段还在」会把断掉的那段续上。
      this.persist(true, stamp)
      this.deps.log.info(
        result.event === 'gap-broken'
          ? '两次打点间隔超过门槛（%d 分钟），这一段记为被打断，一秒都没计入'
          : '时刻倒退，这一段不计入，已重新校准水位',
        this.deps.settings.gapLimitMinutes,
      )
    } else {
      this.persist(false, stamp)
    }
    return Object.freeze({
      event: result.event,
      snapshot: snapshotOf(this.state, stamp, this.deps.settings, this.stored),
      addedMs: result.addedMs,
    })
  }

  /**
   * 结算并落盘，同时回答「此刻该不该提一句休息」。
   * @param at 时刻，省略用时钟。
   */
  checkpoint(at?: number): StudyCheckpoint {
    this.guard()
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    const dayKey = this.roll(stamp)
    const result = advance(this.state, stamp, dayKey, this.deps.settings)
    this.state = result.state
    const rest = judgeRest(this.state, stamp, this.deps.settings)
    if (rest !== null) {
      // 记下「这一刻提过」：冷却锚点是「拒绝有效」的唯一实现，不记就会每次检查都提。
      this.state = Object.freeze({ ...this.state, lastPromptAt: stamp })
    }
    this.persist(true, stamp)
    return Object.freeze({
      snapshot: snapshotOf(this.state, stamp, this.deps.settings, this.stored),
      rest,
    })
  }

  /**
   * 主动收工。**与 `tick()` 用同一套间隔判定**：隔了三小时再点停止，记的是被打断。
   * @param at 时刻，省略用时钟。
   */
  stop(at?: number): StudyTickResult {
    this.guard()
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    if (this.state.phase !== 'focus') {
      throw new StudyError('not-focusing', '当前没有进行中的专注段', this.state.phase)
    }
    const dayKey = this.roll(stamp)
    const result = endFocus(this.state, stamp, dayKey, this.deps.settings)
    this.state = result.state
    if (result.completed) this.completed += 1
    else this.broken += 1
    this.persist(true, stamp)
    if (result.completed) {
      this.deps.log.info('这一段记为完成（今日完成 %d 段）', this.state.segmentsDoneToday)
    } else {
      this.deps.log.info('这一段记为被打断（没有计入时长）')
    }
    return Object.freeze({
      event: result.event,
      snapshot: snapshotOf(this.state, stamp, this.deps.settings, this.stored),
      addedMs: result.addedMs,
    })
  }

  /**
   * 回应休息提示。`taken` 进休息段，`declined` 只记一笔、继续专注。
   * @param action `taken` 或 `declined`。
   * @param at 时刻，省略用时钟。
   */
  rest(action: RestAction, at?: number): StudySnapshot {
    this.guard()
    if (!(REST_ACTIONS as readonly string[]).includes(action)) {
      throw new StudyError('bad-request', '休息动作只能是 taken 或 declined', String(action))
    }
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    if (this.state.phase !== 'focus') {
      throw new StudyError('not-focusing', '当前没有进行中的专注段', this.state.phase)
    }
    const dayKey = this.roll(stamp)
    const result = markRest(this.state, action, stamp, dayKey, this.deps.settings)
    this.state = result.state
    if (action === 'taken') this.breaksTaken += 1
    else this.breaksDeclined += 1
    this.persist(true, stamp)
    return snapshotOf(this.state, stamp, this.deps.settings, this.stored)
  }

  /**
   * 只读快照。**不写盘、不推进。**
   * @param at 时刻，省略用时钟。
   */
  snapshot(at?: number): StudySnapshot {
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    const view = rollTo(this.state, this.dayKey(stamp))
    return snapshotOf(view, stamp, this.deps.settings, this.stored)
  }

  /** 累计统计快照。 */
  stats(): StudyStats {
    const base = {
      ticks: this.ticks,
      broken: this.broken,
      completed: this.completed,
      breaksTaken: this.breaksTaken,
      breaksDeclined: this.breaksDeclined,
      rollovers: this.rollovers,
      writes: this.writes,
      writeFailures: this.writeFailures,
      stored: this.stored,
    }
    return Object.freeze(this.lastIssue === undefined ? base : { ...base, lastIssue: this.lastIssue })
  }
}
