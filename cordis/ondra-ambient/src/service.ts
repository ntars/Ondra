/**
 * 键鼠反应服务的实现。
 *
 * ## 一句话
 *
 * 外壳告诉它「刚有人敲了一下 / 刚有人动了一下鼠标 / 已经十分钟没人动了」，
 * 它负责节流、算密度、判出 `quiet` / `near` / `ready`，然后回一句
 * **不含任何数字**的裁决，或者干脆什么都不建议。
 *
 * ## 三个「不」
 *
 * - **不监听硬件。** 真实键鼠监听要辅助功能授权，属应用外壳；插件只接事件。
 * - **不装定时器。** 时间推进由外壳的 `tick` 或下一次事件驱动。一个护栏插件
 *   如果自己挂 `setInterval`，它就成了常驻后台任务，而 §17 第 6 条禁的正是
 *   「看起来在跑、其实没人管」的东西。
 * - **不产生台词、不发送。** `nudge()` 只回答「要不要冒个泡」。
 *
 * ## 写盘时机
 *
 * 每次**被接受**的事件写一次（节流已把它压到最多每 250 毫秒一次，文件两百来字节）。
 * 刻意不做「攒够再写」：攒着写意味着崩溃时丢掉整整一段，而丢掉的那一段
 * 恰好是「她刚刚一直陪着你」的那一段。
 */

import { STATE_FILE_NAME, AmbientError } from './types.js'
import type {
  AmbientEvent,
  AmbientPolicy,
  AmbientService,
  AmbientStats,
  ClockLike,
  LogLike,
  Nudge,
  PathLike,
  Reaction,
  Snapshot,
} from './types.js'
import type { Config } from './settings.js'
import { policyOf } from './settings.js'
import {
  MUST_NOT,
  acceptEvent,
  decideOf,
  emptyMemory,
  nudgeOf,
  reactionOf,
  readEvent,
  snapshotOf,
} from './react.js'
import type { AmbientMemory, AmbientRecord, Decision } from './react.js'
import { readRecord, writeRecord } from './store.js'

/** 依赖。时钟 / 路径都用取值函数：上游晚装载能自愈，早卸载立刻退回降级。 */
export interface AmbientDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-003 时钟（可选）。 */
  readonly clock: () => ClockLike | undefined
  /** O-002 路径（可选）。 */
  readonly path: () => PathLike | undefined
  /** 系统时间。测试时注入。 */
  readonly now: () => number
}

/** 键鼠反应服务。 */
export class Ambient implements AmbientService {
  private record: AmbientRecord
  private memory: AmbientMemory
  private readonly policy: AmbientPolicy
  private storedFlag = false
  private lastIssue: string | undefined
  private writes = 0
  private writeFailures = 0
  private nods = 0
  private lastNudgeAt: number | null = null
  private nudgeDayKey: string | null = null
  private nudgedToday = 0
  private dayKeyMissing = false
  private clockMissing = false
  private pathMissing = false

  /**
   * @param deps 依赖。
   */
  constructor(private readonly deps: AmbientDeps) {
    this.policy = policyOf(deps.settings)
    this.memory = emptyMemory()
    const path = deps.path()
    const file = path === undefined ? undefined : path.fileIn('user', STATE_FILE_NAME)
    const loaded = readRecord(file)
    this.record = loaded.record
    // 「有没有路径」不等于「重启后还回得来」：没写过一次就一直不算落盘。
    this.storedFlag = false
    if (loaded.issue !== undefined) {
      this.lastIssue = loaded.issue
      deps.log.warn('键鼠反应档读取异常：%s', loaded.issue)
    }
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): 'disabled' | 'bad-request' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /** 状态是否真的落盘。 */
  get stored(): boolean {
    return this.storedFlag
  }

  /**
   * 记一次事件。**唯一会写盘的方法。**
   * @param event 事件类型与时刻。
   * @param at 时刻，省略用系统时间。
   */
  observe(event: AmbientEvent, at?: number): Snapshot {
    if (!this.deps.settings.enable) {
      throw new AmbientError('disabled', '键鼠反应已关闭（enable=false）')
    }
    const now = this.nowOf(at)
    const parsed = readEvent(event, now)
    if (parsed === null) {
      throw new AmbientError(
        'bad-request',
        '事件不合法：类型必须是 key / mouse / idle 之一，时刻必须是有限正数',
      )
    }
    const stamp = parsed.at ?? now
    const result = acceptEvent(this.record, this.memory, parsed.type, stamp, this.policy)
    this.record = result.record
    this.memory = result.memory

    if (result.accepted) this.persist()

    const decision = this.settle(stamp)
    return snapshotOf(decision, this.memory, stamp, this.storedFlag)
  }

  /** 只读裁决。**不写盘、不推进判定输入。** */
  decide(at?: number): Reaction {
    const now = this.nowOf(at)
    if (!this.deps.settings.enable) {
      return {
        state: 'quiet',
        stateZh: '别打扰',
        confidence: 'none',
        maySpeak: false,
        reason: '键鼠反应已关闭，什么都不判断，也就什么都不建议。',
        mustNot: MUST_NOT,
      }
    }
    return reactionOf(this.snapshot(now))
  }

  /** 只读快照。**不写盘、不推进判定输入。** */
  snapshot(at?: number): Snapshot {
    const now = this.nowOf(at)
    if (!this.deps.settings.enable) {
      const decision: Decision = { state: 'quiet', source: 'none', measured: false }
      return snapshotOf(decision, this.memory, now, this.storedFlag)
    }
    return snapshotOf(this.settle(now), this.memory, now, this.storedFlag)
  }

  /**
   * 要不要冒个泡。**不写盘、不产生台词、不发送。**
   *
   * 判为「值得」时即视为**建议已发出**，立刻进入冷却——这样外壳重复轮询
   * 也不会在同一段可接话窗口里连拿好几次 `true`。刻意不加「确认已说」的端口：
   * 多一个端口就多一个能自己开口的理由。
   * @param at 时刻，省略用系统时间。
   */
  nudge(at?: number): Nudge {
    const now = this.nowOf(at)
    const snapshot = this.snapshot(now)
    this.rollDay(now)
    const result = nudgeOf(
      snapshot,
      {
        lastNudgeAt: this.lastNudgeAt,
        nudgedToday: this.nudgedToday,
        cap: this.deps.settings.dailyNudgeCap,
        cooldownMs: this.deps.settings.cooldownMin * 60_000,
      },
      now,
    )
    if (result.worth) {
      this.nods += 1
      this.lastNudgeAt = now
      this.nudgedToday += 1
    }
    return result
  }

  /** 累计统计（诊断用，禁止进台词）。 */
  stats(): AmbientStats {
    return {
      beats: this.record.beats,
      bursts: this.record.bursts,
      ignored: this.record.ignored,
      nudges: this.nods,
      writes: this.writes,
      writeFailures: this.writeFailures,
      stored: this.storedFlag,
      lastIssue: this.lastIssue,
    }
  }

  /** 取时刻：优先用传入值，其次时钟服务，最后系统时间。 */
  private nowOf(at?: number): number {
    if (typeof at === 'number' && Number.isFinite(at) && at >= 0) return at
    const clock = this.deps.clock()
    if (clock !== undefined) {
      try {
        return clock.now()
      } catch {
        // 时钟服务坏了不该让反应停摆，退回系统时间。
      }
    }
    // 不静默：降级说一句，只说一次（每 250 毫秒一条日志比降级本身更糟）。
    if (!this.clockMissing) {
      this.clockMissing = true
      this.deps.log.warn('缺 ondra-clock，时刻退回系统时间（夏令时与日界可能不准）')
    }
    return this.deps.now()
  }

  /**
   * 算一次裁决，并更新内存里的「上一次状态」缓存。
   *
   * 这一步**不写盘**：它只记「刚刚翻过档」，用来让 `settled` 在临界点上
   * 先压一小会儿，免得外壳在临界点两边各收到一次真的。
   */
  private settle(now: number): Decision {
    const decision = decideOf(this.record, this.memory, this.policy, now)
    // 第一次算也要记一个起点，否则「一直忙」的状态下 settled 永远是 false，
    // 外壳会以为这一刻一直在临界点上。
    if (decision.state !== this.memory.lastState || this.memory.changedAt === null) {
      this.memory = { ...this.memory, lastState: decision.state, changedAt: now }
    }
    return decision
  }

  /**
   * 归日：日界用 O-003 的 `dayKey`，**不自己算日历**。
   *
   * 没有时钟服务时日上限退化为「进程内累计」，日志里会说一句——
   * 静默退化会让「今天已经冒了三次」变成「这次进程已经冒了三次」，
   * 两者差得不多，但说清楚才不会被当成 bug 查半天。
   */
  private rollDay(now: number): void {
    const clock = this.deps.clock()
    let key: string | null = null
    if (clock !== undefined) {
      try {
        key = clock.dayKey(now)
      } catch {
        key = null
      }
    }
    if (key === null) {
      if (!this.dayKeyMissing) {
        this.dayKeyMissing = true
        this.deps.log.warn('取不到日界（ondra-clock 缺席），日上限改为按进程内累计')
      }
      this.nudgeDayKey = null
      return
    }
    if (this.nudgeDayKey !== key) {
      this.nudgeDayKey = key
      this.nudgedToday = 0
    }
  }

  /** 落盘。失败只记计数，**绝不抛**：反应失败不该打断外壳的事件循环。 */
  private persist(): void {
    const path = this.deps.path()
    if (path === undefined) {
      // 没有路径服务：只在内存。`stored` 保持 false，别谎称落盘。
      this.storedFlag = false
      // 不静默：说一句，只说一次。
      if (!this.pathMissing) {
        this.pathMissing = true
        this.deps.log.warn('缺 ondra-path-layout，键鼠反应档只在内存（重启后当成从没观测过）')
      }
      return
    }
    const file = path.fileIn('user', STATE_FILE_NAME)
    try {
      writeRecord(file, this.record)
      this.writes += 1
      this.storedFlag = true
      this.lastIssue = undefined
    } catch (error) {
      this.writeFailures += 1
      this.storedFlag = false
      const code = (error as { code?: string }).code
      this.lastIssue = '写入键鼠反应档失败：' + String(code ?? '未知错误')
      this.deps.log.warn('%s（重启后会当成从没观测过）', this.lastIssue)
    }
  }
}
