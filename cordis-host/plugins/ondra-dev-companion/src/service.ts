/**
 * 开发者陪伴服务的实现。
 *
 * ## 一句话
 *
 * 外壳说「编译挂了」「测试绿了」「任务跑完了」，它决定**该不该出声**，
 * 以及在允许出声时给一句**不含数字**的话。
 *
 * ## 三个「不」
 *
 * - **不读代码。** 本文件没有 `readFileSync`，只有写台账的那一处 `fs`。
 *   这不是疏漏，是边界：代码是雇主的资产，搬进插件就是另一类问题。
 * - **不装定时器。** 「失败后的安静期」靠时刻比较，不靠 `setTimeout`。
 *   一个陪伴插件如果自己挂 `setInterval`，它就成了常驻后台任务。
 * - **不直接发消息。** `cue()` 只产出文本，发不发归 O-042 的六道闸。
 *
 * ## 读 O-109 的纪律
 *
 * 只读一次 `view()`，只用两个字段（`state` / `category`），**按契约消费、不 import 源码**。
 * 上游抛错一律吞掉并记一行日志——感知坏了不该让陪伴也停摆（器官 ABI C3 的同一条精神）。
 */

import { DEV_TONES, DevError, STATE_FILE_NAME } from './types.js'
import type {
  ClockLike,
  DevCompanionService,
  DevCue,
  DevErrorCode,
  DevEvent,
  DevPolicy,
  DevStats,
  DevTone,
  DevView,
  LogLike,
  PathLike,
  ScreenPresenceLike,
  ScreenSenseLike,
} from './types.js'
import type { Config } from './settings.js'
import { policyOf } from './settings.js'
import { applyAck, applyEvent, decide, emptyMemory, readEvent, viewOf } from './rules.js'
import type { DevLedger, DevMemory } from './rules.js'
import { readLedger, writeLedger } from './store.js'

/** 依赖。时钟 / 路径 / 在场都用取值函数：上游晚装载能自愈，早卸载立刻退回降级。 */
export interface DevCompanionDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-003 时钟（可选）。 */
  readonly clock: () => ClockLike | undefined
  /** O-002 路径（可选）。 */
  readonly path: () => PathLike | undefined
  /** O-109 屏幕感知（可选，只读在场）。 */
  readonly screen: () => ScreenSenseLike | undefined
  /** 系统时间。测试时注入。 */
  readonly now: () => number
}

/** 开发者陪伴服务。 */
export class DevCompanion implements DevCompanionService {
  private memory: DevMemory
  private ledger: DevLedger
  private readonly policy: DevPolicy
  private storedFlag: boolean
  private lastIssue: string | undefined
  private acceptedEvents = 0
  private rejectedEvents = 0
  private writes = 0
  private writeFailures = 0

  /**
   * @param deps 依赖。
   */
  constructor(private readonly deps: DevCompanionDeps) {
    this.policy = policyOf(deps.settings)
    this.memory = emptyMemory()
    const path = deps.path()
    const file = path === undefined ? undefined : path.fileIn('user', STATE_FILE_NAME)
    const loaded = readLedger(file)
    this.ledger = loaded.ledger
    // 「有没有路径」不等于「重启后还回得来」：没写过一次就一直不算落盘。
    this.storedFlag = false
    if (loaded.issue !== undefined) {
      this.lastIssue = loaded.issue
      deps.log.warn('陪伴台账读取异常：%s', loaded.issue)
    }
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): DevErrorCode | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /** 台账是否真的落盘。 */
  get stored(): boolean {
    return this.storedFlag
  }

  /**
   * 记一个事件。
   * @param event 事件。
   * @param at 时刻，省略用系统时间。
   */
  note(event: DevEvent, at?: number): DevView {
    if (!this.deps.settings.enable) {
      throw new DevError('disabled', '开发者陪伴已关闭（enable=false）')
    }
    const now = this.nowOf(at)
    const parsed = readEvent(event, now)
    if (parsed === null) {
      this.rejectedEvents += 1
      throw new DevError('bad-request', '事件不合法：类型必须在闭集内，时刻必须是有限正数')
    }
    const stamp = parsed.at === undefined ? now : parsed.at
    this.memory = applyEvent(this.memory, parsed, stamp)
    this.acceptedEvents += 1
    return this.view(stamp)
  }

  /** 只读判定。**不写盘、不推进。** */
  cue(at?: number): DevCue {
    const now = this.nowOf(at)
    return decide(
      this.memory,
      this.ledger,
      this.policy,
      now,
      this.presenceOf(now),
      this.deps.settings.enable,
    )
  }

  /** 记一次「已经真的说出去了」。 */
  ack(tone: DevTone, at?: number): DevView {
    if (!this.deps.settings.enable) {
      throw new DevError('disabled', '开发者陪伴已关闭（enable=false）')
    }
    if (!DEV_TONES.includes(tone)) {
      throw new DevError('bad-request', '调门不在闭集内')
    }
    const now = this.nowOf(at)
    const tones = {
      quiet: this.ledger.tones.quiet,
      companion: this.ledger.tones.companion,
      release: this.ledger.tones.release,
      celebrate: this.ledger.tones.celebrate,
    }
    tones[tone] = tones[tone] + 1

    // 关掉只该生效一次的标记（「绿了」与「先放下」各一条），否则同一次事件会被说两遍。
    this.memory = applyAck(this.memory, tone, now)

    this.ledger = {
      lastCueAt: tone === 'quiet' ? this.ledger.lastCueAt : now,
      lastCelebrateAt: tone === 'celebrate' ? now : this.ledger.lastCelebrateAt,
      tones,
      resets: this.ledger.resets,
    }
    this.persist()
    return this.view(now)
  }

  /** 只读视图。**不写盘、不推进。** */
  view(at?: number): DevView {
    const now = this.nowOf(at)
    return viewOf(this.memory, this.ledger, this.policy, now, this.presenceOf(now), this.storedFlag)
  }

  /** 重来一遍（换人）。 */
  reset(at?: number): DevView {
    this.memory = emptyMemory()
    this.ledger = {
      lastCueAt: null,
      lastCelebrateAt: null,
      tones: { quiet: 0, companion: 0, release: 0, celebrate: 0 },
      resets: this.ledger.resets + 1,
    }
    this.persist()
    return this.view(at)
  }

  /** 累计统计快照。 */
  stats(): DevStats {
    return {
      events: this.acceptedEvents,
      rejected: this.rejectedEvents,
      tones: this.ledger.tones,
      restarts: this.ledger.resets,
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
        // 时钟坏了不该让陪伴停摆，退回系统时间。
      }
    }
    return this.deps.now()
  }

  /**
   * 读 O-109 的在场视图。**只读两个字段。**
   *
   * 上游缺席、抛错、返回值畸形，一律当 `null`（不作门）。
   * 单装本插件时必须能说话，否则「没装感知插件」就等于「永远闭嘴」。
   */
  private presenceOf(now: number): ScreenPresenceLike | null {
    if (!this.policy.respectPresence) return null
    const screen = this.deps.screen()
    if (screen === undefined) return null
    try {
      const view = screen.view(now)
      if (view === null || typeof view !== 'object') return null
      const state = view.state
      if (
        state !== 'unknown' &&
        state !== 'idle' &&
        state !== 'scattered' &&
        state !== 'focused' &&
        state !== 'wandering'
      ) {
        // 闭集外的状态：当作读不到，而不是当作「可以说话」。
        return { state: 'unknown', category: 'unknown' }
      }
      return {
        state,
        category: typeof view.category === 'string' ? view.category : 'unknown',
      }
    } catch (error) {
      this.deps.log.warn(
        '读 O-109 在场视图失败，本次不作门：%s',
        error instanceof Error ? error.message : String(error),
      )
      return null
    }
  }

  /** 落盘。失败只记计数，**绝不抛**。 */
  private persist(): void {
    const path = this.deps.path()
    if (path === undefined) {
      this.storedFlag = false
      return
    }
    const file = path.fileIn('user', STATE_FILE_NAME)
    try {
      writeLedger(file, this.ledger)
      this.writes += 1
      this.storedFlag = true
      this.lastIssue = undefined
    } catch (error) {
      this.writeFailures += 1
      this.storedFlag = false
      const code = (error as { code?: string }).code
      this.lastIssue = '写入陪伴台账失败：' + String(code ?? '未知错误')
      this.deps.log.warn('%s（重启后可能重复说同一句）', this.lastIssue)
    }
  }
}
