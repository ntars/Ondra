/**
 * 接线与降级：把纯判定层（`health.ts`）接上时钟、路径与存档。
 *
 * ## 依赖全部用取值函数
 *
 * `path` / `clock` / `now` 都是 `() => ...` 而不是现成的值。
 * 理由有两条：上游晚装载时能自愈（第一次调用才取，不是 `apply` 那一刻取），
 * 上游早卸载时立刻反映（下次调用就变 `undefined`，自动退回降级路径）。
 *
 * ## 三种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-path-layout` | 只在内存，重启丢当日累计 | `stored=false` + 一行日志 |
 * | `ondra-clock` | 本机时区的自然日与 `HH:MM` 判定 | 一行日志（口径相同，仅夏令时极端情形差一天） |
 * | `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行日志 |
 *
 * **降级必须看得见**（§8.2）：静默降级之后，外壳会把 `stored=false` 的那份读数
 * 当成真的「今天才用了十分钟」。
 */

import type {
  ClockLike,
  DigitalHealthService,
  HealthAdvice,
  HealthErrorCode,
  HealthLevel,
  HealthSnapshot,
  HealthStats,
  LogLike,
  PathLike,
} from './types.js'
import { DigitalHealthError, HEALTH_LEVELS, LEVEL_ORDER, STATE_FILE_NAME } from './types.js'
import type { Config } from './settings.js'
import { emptyState, judge, maxLevel, noteOf, pulseState, rollTo, snapshotOf } from './health.js'
import type { HealthState } from './health.js'
import { readState, writeState } from './store.js'

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000

/**
 * 写盘节流：最快每 60 秒落一次。
 *
 * 打点可能每句话来一次；每来一次就写一遍盘，会在长时间对话里变成
 * 每秒几次的小文件写。节流丢掉的只是最近 60 秒的计数，`flush()` 与跨天必落盘。
 */
const FLUSH_INTERVAL_MS = 60_000

/** 依赖。 */
export interface DigitalHealthDeps {
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
    throw new DigitalHealthError('bad-request', '时刻必须是正的有限数', String(given))
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

/** 本机时区的第几分钟。**只在 O-003 缺席时使用。** */
function localMinuteOfDay(at: number): number {
  const date = new Date(at)
  return date.getHours() * 60 + date.getMinutes()
}

/** 把 `HH:MM` 解析成分钟数；形状不合法返回 `undefined`。 */
function hhmmMinutes(text: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (match === null) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * 本机时区的窗口判定。**语义与 O-003 逐条对齐**：左闭右开、支持跨零点、
 * `start === end` 是**空窗**而不是整天。
 */
function localWithinWindow(start: string, end: string, at: number): boolean {
  const from = hhmmMinutes(start)
  const to = hhmmMinutes(end)
  if (from === undefined || to === undefined) return false
  if (from === to) return false
  const minute = localMinuteOfDay(at)
  return from < to ? minute >= from && minute < to : minute >= from || minute < to
}

/** 数字健康护栏。 */
export class DigitalHealth implements DigitalHealthService {
  private readonly deps: DigitalHealthDeps
  private state: HealthState
  private loaded = false
  private writeOk = false
  private lastWriteAt = 0
  private rollovers = 0
  private writes = 0
  private writeFailures = 0
  private lastIssue: string | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: DigitalHealthDeps) {
    this.deps = deps
    this.state = emptyState(this.dayKey(deps.now()))
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): HealthErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /**
   * 状态是否真的落盘。
   *
   * **口径是「当前读数重启后还回得来吗」，不是「路径算不算得出来」。**
   * 早先写成「路径在就算能落盘」是乐观推断：路径在、但一次都没写成功时，
   * 外壳会读到 `stored=true`，于是把一份会清零的读数当成可靠数据。
   * 诚实比好看要紧——`false` 只是让外壳标一句「重启会清零」。
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

  /**
   * 首次使用时惰性读盘。
   *
   * **不在 `apply` 里读**：装载期做磁盘 IO 会拖慢启动，而且那一刻
   * O-002 可能还没就绪——早读一次的结果是「路径算不出来，静默退回内存」，
   * 之后再也不重试。
   */
  private ensureLoaded(at: number): void {
    if (this.loaded) return
    this.loaded = true
    const dayKey = this.dayKey(at)
    const result = readState(this.filePath(), dayKey)
    this.state = result.state
    // 只有「真从盘上读到今日状态」才算已落盘；新档 / 坏档 / 跨天都不算。
    this.writeOk = result.fresh === false && result.issue === undefined && this.filePath() !== undefined
    if (result.issue !== undefined) {
      this.lastIssue = result.issue
      this.deps.log.warn('%s（当日累计从零开始，其余读数不受影响）', result.issue)
    }
  }

  /**
   * 落盘。失败只记日志并计数，**永不抛出**——护栏不能因为写不了盘就把对话打断。
   * @param force 是否忽略节流。
   */
  private persist(force: boolean): void {
    const filePath = this.filePath()
    if (filePath === undefined) {
      this.writeOk = false
      return
    }
    const now = this.deps.now()
    if (!force && now - this.lastWriteAt < FLUSH_INTERVAL_MS) return
    try {
      writeState(filePath, this.state)
      this.writes += 1
      this.writeOk = true
      this.lastWriteAt = now
    } catch (error) {
      this.writeFailures += 1
      this.writeOk = false
      this.lastIssue = '写数字健康存档失败：' + this.messageOf(error)
      this.deps.log.warn('%s（重启后当日累计会少算这一段）', this.lastIssue)
    }
  }

  /** 此刻是否落在深夜窗内。 */
  private lateNight(at: number): boolean {
    const { lateNightStart, lateNightEnd } = this.deps.settings
    const clock = this.deps.clock()
    if (clock !== undefined) {
      try {
        return clock.withinWindow(lateNightStart, lateNightEnd, at)
      } catch (error) {
        this.lastIssue = '时钟服务判深夜窗失败，退回本机时区：' + this.messageOf(error)
      }
    }
    return localWithinWindow(lateNightStart, lateNightEnd, at)
  }

  /**
   * 取「今天视角」的状态。
   *
   * `advise()` / `snapshot()` 是只读的，不能为了跨天去改盘，所以这里派生一份
   * 只读视图：跨天清当日计数，但**保留「曾经打过点」**——那个标记用来区分
   * 「一次都没打点」与「昨天用过、今天还没开始」，两者后果不同：
   * 前者该说「护栏没在工作」，后者只是一天还没开始。
   */
  private viewState(dayKey: string): HealthState {
    return rollTo(this.state, dayKey)
  }

  /**
   * 记一次活动打点。
   * @param at 时刻，省略用系统时间。
   */
  pulse(at?: number): HealthSnapshot {
    if (!this.available) {
      throw new DigitalHealthError('disabled', '数字健康护栏已关闭（enable=false）')
    }
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    const dayKey = this.dayKey(stamp)
    const rolled = this.state.dayKey !== dayKey
    if (rolled) this.rollovers += 1
    this.state = pulseState(this.state, stamp, dayKey, this.deps.settings.breakMinutes)
    this.persist(rolled)
    return snapshotOf(this.state, stamp, this.deps.settings, this.stored)
  }

  /**
   * 只读快照。
   * @param at 时刻。
   */
  snapshot(at?: number): HealthSnapshot {
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    return snapshotOf(this.viewState(this.dayKey(stamp)), stamp, this.deps.settings, this.stored)
  }

  /**
   * 只读判定。
   * @param at 时刻。
   */
  advise(at?: number): HealthAdvice {
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    const view = this.viewState(this.dayKey(stamp))
    const judged = judge({
      state: view,
      at: stamp,
      settings: this.deps.settings,
      lateNight: this.lateNight(stamp),
    })
    const cooldownMs = this.deps.settings.nudgeCooldownMinutes * MINUTE_MS
    const cooled = view.lastNudgeAt === null || stamp - view.lastNudgeAt >= cooldownMs
    const above = LEVEL_ORDER[judged.level] > LEVEL_ORDER[view.acknowledged]
    const nudgeDue = judged.level !== 'ok' && above && cooled
    return Object.freeze({
      level: judged.level,
      state: judged.state,
      at: stamp,
      reasons: judged.reasons,
      sessionStart: judged.sessionMinutes > 0 ? view.sessionStart : null,
      sessionMinutes: judged.sessionMinutes,
      dayMinutes: judged.dayMinutes,
      nudgeDue,
      suggestQuiet: judged.level === 'firm' || judged.level === 'stop',
      note: noteOf(judged.level, judged.state),
    })
  }

  /**
   * 记一次「已经提醒过了」。
   * @param level 提醒到的档位。
   * @param at 时刻。
   */
  ack(level: HealthLevel, at?: number): HealthSnapshot {
    if (!this.available) {
      throw new DigitalHealthError('disabled', '数字健康护栏已关闭（enable=false）')
    }
    if (!HEALTH_LEVELS.includes(level)) {
      throw new DigitalHealthError('bad-request', '档位不在闭集里', String(level))
    }
    if (level === 'ok') {
      // 报「我提醒了一句『没事』」= 调用方把轮询当成提醒了。
      throw new DigitalHealthError('bad-request', 'ok 档不是提醒，不允许 ack')
    }
    const stamp = atOf(at, this.deps.now)
    this.ensureLoaded(stamp)
    const dayKey = this.dayKey(stamp)
    const view = this.viewState(dayKey)
    this.state = Object.freeze({
      ...view,
      acknowledged: maxLevel(view.acknowledged, level),
      nudges: view.nudges + 1,
      lastNudgeAt: stamp,
    })
    this.persist(true)
    return snapshotOf(this.state, stamp, this.deps.settings, this.stored)
  }

  /**
   * 强制落盘。卸载前由 `index.ts` 调一次。
   * @returns 是否成功。
   */
  flush(): boolean {
    this.persist(true)
    return this.writeOk
  }

  /** 累计统计快照。 */
  stats(): HealthStats {
    const base = {
      pulses: this.state.pulses,
      nudges: this.state.nudges,
      rollovers: this.rollovers,
      writes: this.writes,
      writeFailures: this.writeFailures,
      stored: this.stored,
    }
    return Object.freeze(
      this.lastIssue === undefined ? base : { ...base, lastIssue: this.lastIssue },
    )
  }
}
