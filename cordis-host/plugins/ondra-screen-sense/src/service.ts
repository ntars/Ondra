/**
 * 屏幕感知服务的实现。
 *
 * ## 一句话
 *
 * 外壳告诉它「主人在写代码」，它负责节流、吸收抖动、判出「在做一件事 / 散着 /
 * 人不在 / 读不到」，然后给一句**不含数字**的话或者干脆不给。
 *
 * ## 三个「不」
 *
 * - **不截屏。** 没这个权限，也不该有这个权限。
 * - **不自己算时长。** 连续使用分钟数读 O-105 的快照；自己再算一遍就是第二个真源。
 * - **不装定时器。** 采样由外壳驱动。一个护栏插件如果自己挂 `setInterval`，
 *    它就成了常驻后台任务，而 §17 第 6 条禁的正是「看起来在跑、其实没人管」的东西。
 *
 * ## 写盘时机
 *
 * 每次**被接受**的采样写一次（节流已把它压到最多每 30 秒一次，文件两百来字节）。
 * 刻意不做「攒够再写」：攒着写意味着崩溃时丢掉整整一段，而丢掉的那一段
 * 恰好是「她刚刚一直看着你」的那一段。
 */

import { STATE_FILE_NAME, ScreenError } from './types.js'
import type {
  ClockLike,
  HealthLike,
  LogLike,
  PathLike,
  ScreenErrorCode,
  ScreenSenseService,
  ScreenSignal,
  ScreenStats,
  ScreenView,
  SenseHint,
  SensePolicy,
} from './types.js'
import type { Config } from './settings.js'
import { policyOf } from './settings.js'
import { advance, hintOf, readSignal, viewOf } from './classify.js'
import type { ScreenState } from './classify.js'
import { readState, writeState } from './store.js'

/** 依赖。时钟 / 路径 / 健康都用取值函数：上游晚装载能自愈，早卸载立刻退回降级。 */
export interface ScreenSenseDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-003 时钟（可选）。 */
  readonly clock: () => ClockLike | undefined
  /** O-002 路径（可选）。 */
  readonly path: () => PathLike | undefined
  /** O-105 健康护栏（可选，只读它的时长）。 */
  readonly health: () => HealthLike | undefined
  /** 系统时间。测试时注入。 */
  readonly now: () => number
}

/** 屏幕感知服务。 */
export class ScreenSense implements ScreenSenseService {
  private state: ScreenState
  private readonly policy: SensePolicy
  private storedFlag: boolean
  private lastIssue: string | undefined
  private writes = 0
  private writeFailures = 0
  private switches = 0

  /**
   * @param deps 依赖。
   */
  constructor(private readonly deps: ScreenSenseDeps) {
    this.policy = policyOf(deps.settings)
    const path = deps.path()
    const file = path === undefined ? undefined : path.fileIn('user', STATE_FILE_NAME)
    const loaded = readState(file)
    this.state = loaded.state
    // 「有没有路径」不等于「重启后还回得来」：没写过一次就一直不算落盘。
    this.storedFlag = false
    if (loaded.issue !== undefined) {
      this.lastIssue = loaded.issue
      deps.log.warn('在场状态档读取异常：%s', loaded.issue)
    }
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): ScreenErrorCode | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /** 状态是否真的落盘。 */
  get stored(): boolean {
    return this.storedFlag
  }

  /**
   * 记一次采样。**唯一会写盘的方法。**
   * @param signal 类目与时刻。
   * @param at 时刻，省略用系统时间。
   */
  note(signal: ScreenSignal, at?: number): ScreenView {
    if (!this.deps.settings.enable) {
      throw new ScreenError('disabled', '屏幕感知已关闭（enable=false）')
    }
    const now = this.nowOf(at)
    const parsed = readSignal(signal, now)
    if (parsed === null) {
      throw new ScreenError('bad-request', '采样不合法：类目必须在闭集内，时刻必须是有限正数')
    }
    const stamp = parsed.at === undefined ? now : parsed.at
    const before = this.state.category
    const result = advance(this.state, parsed.category, stamp, this.policy)
    this.state = result.state

    // 真切换（不是抖动、不是读不到）单独计数，供 `stats()` 与日志用。
    if (result.reason === 'accepted' && before !== this.state.category) this.switches += 1

    if (result.accepted) this.persist()
    return this.view(stamp)
  }

  /** 只读视图。**不写盘、不推进。** */
  view(at?: number): ScreenView {
    const now = this.nowOf(at)
    return viewOf(this.state, this.policy, now, this.sessionMinutesOf(now), this.storedFlag)
  }

  /** 只读观察。**不写盘、不推进。** */
  hint(at?: number): SenseHint {
    return hintOf(this.view(at))
  }

  /** 重来一遍（换人）。 */
  reset(at?: number): ScreenView {
    this.state = {
      lastAt: null,
      lastMissAt: null,
      segmentStart: null,
      category: 'unknown',
      handovers: [],
      glitches: 0,
      notes: 0,
      dropped: 0,
      misses: 0,
      resets: this.state.resets + 1,
    }
    this.switches = 0
    this.persist()
    return this.view(at)
  }

  /** 累计统计快照。 */
  stats(): ScreenStats {
    return {
      notes: this.state.notes,
      dropped: this.state.dropped,
      glitches: this.state.glitches,
      switches: this.switches,
      misses: this.state.misses,
      restarts: this.state.resets,
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
        // 时钟服务坏了不该让感知停摆，退回系统时间。
      }
    }
    return this.deps.now()
  }

  /**
   * 读 O-105 的连续使用分钟数。**只读，不推进它的水位。**
   *
   * 读不到就是 `null`——不是 `0`。`0` 会被读成「刚坐下」，
   * 于是外壳会显示一句「刚刚开始」，而实际上它只是没接上。
   */
  private sessionMinutesOf(now: number): number | null {
    if (!this.policy.followSession) return null
    const health = this.deps.health()
    if (health === undefined) return null
    try {
      const snapshot = health.snapshot(now)
      const minutes = snapshot.sessionMinutes
      return Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : null
    } catch (error) {
      this.deps.log.warn(
        '读 O-105 时长失败，本次按「读不到」处理：%s',
        error instanceof Error ? error.message : String(error),
      )
      return null
    }
  }

  /** 落盘。失败只记计数，**绝不抛**：感知失败不该打断外壳的采样循环。 */
  private persist(): void {
    const path = this.deps.path()
    if (path === undefined) {
      // 没有路径服务：只在内存。`stored` 保持 false，别谎称落盘。
      this.storedFlag = false
      return
    }
    const file = path.fileIn('user', STATE_FILE_NAME)
    try {
      writeState(file, this.state)
      this.writes += 1
      this.storedFlag = true
      this.lastIssue = undefined
    } catch (error) {
      this.writeFailures += 1
      this.storedFlag = false
      const code = (error as { code?: string }).code
      this.lastIssue = '写入在场状态失败：' + String(code ?? '未知错误')
      this.deps.log.warn('%s（重启后会当成从没读到过）', this.lastIssue)
    }
  }
}
