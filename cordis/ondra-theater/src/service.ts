/**
 * 多角色剧场服务的实现。
 *
 * ## 一句话
 *
 * 它不写剧本，只当舞台监督：**谁在场上、轮到谁、什么时候必须收场**。
 *
 * ## 三个「不」
 *
 * - **不出台词。** 交给下游的是意图（开场 / 接话 / 过渡 / 收尾）、句数上限与四条禁令。
 *   台词归 O-033 / O-037，本服务连一个字符串入参的入口都没有。
 * - **不装配人格。** 只向 O-021 要一个人设 id 当座位标签，取不到就用调用方给的 id。
 * - **不装定时器。** 冷场判据在 `next()` / `advance()` 被调到时按时刻现算。
 *   一个调度器如果自己挂 `setInterval`，它就变成了常驻后台任务，
 *   而 §17 第 6 条禁的正是「看起来在跑、其实没人管」的东西。
 *
 * ## 读与写的分界
 *
 * `next()` / `snapshot()` **只读**；只有 `advance()` 推进，只有 `close()` 结束。
 * 外壳随便轮询都不会让同一个人被推上去两次——这条比「记得清理状态」可靠得多。
 */

import { ROLE_ID_RE, TheaterError } from './types.js'
import type {
  ClockLike,
  LogLike,
  NextResult,
  PersonaCoreLike,
  RoleInput,
  SceneRequest,
  Seat,
  StagePolicy,
  TheaterService,
  TheaterStats,
  TheaterView,
  CloseReason,
  TheaterErrorCode,
} from './types.js'
import type { Config } from './settings.js'
import { policyOf } from './settings.js'
import {
  advanceStage,
  closeNoteOf,
  closeStage,
  nextTurnOf,
  openStage,
  readRoles,
  stopReasonOf,
  viewOf,
} from './stage.js'
import type { Stage } from './stage.js'

/** 依赖。时钟与人设内核都用取值函数：上游晚装载能自愈，早卸载立刻退回降级。 */
export interface TheaterDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-003 时钟（可选）。 */
  readonly clock: () => ClockLike | undefined
  /** O-021 人设内核（可选，只读人设 id 当座位标签）。 */
  readonly persona: () => PersonaCoreLike | undefined
  /** 系统时间。测试时注入。 */
  readonly now: () => number
}

/** 场次 id 的允许形状（进日志与统计，故与角色 id 同一套字符集）。 */
const SCENE_ID_RE = ROLE_ID_RE

/** 场次标签最长多少个字：只给日志看，长了会把一行日志撑断。 */
const LABEL_MAX = 60

/** 多角色剧场服务。 */
export class Theater implements TheaterService {
  private stage: Stage | null = null
  private readonly policy: StagePolicy
  private opened = 0
  private spoken = 0
  private closes = 0
  private autoCloses = 0
  private refusals = 0
  private lastCloseReason: CloseReason | undefined
  /** 每项降级只报一次：调度每秒可能被轮询，重复的 warn 会把日志刷没。 */
  private readonly warned = new Set<string>()

  /**
   * @param deps 依赖。
   */
  constructor(private readonly deps: TheaterDeps) {
    this.policy = policyOf(deps.settings)
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): TheaterErrorCode | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /**
   * 开场。**已有一场没散时抛 `scene-open`。**
   * @param request 场面。
   * @param at 时刻，省略用时钟服务。
   */
  open(request: SceneRequest, at?: number): TheaterView {
    if (!this.deps.settings.enable) {
      this.refuse('disabled', '多角色剧场已关闭（enable=false）')
    }
    const current = this.stage
    if (current !== null && current.closedReason === null) {
      // 离场必须先收束：中途换人会让剩下的人对着一个空座位说话。
      this.refuse(
        'scene-open',
        `已有一场没散（${current.sceneId}）：换人必须先 close()，不接受中途换人`,
      )
    }
    if (request === null || typeof request !== 'object') {
      this.refuse('bad-request', '开场入参必须是对象')
    }

    const now = this.nowOf(at)
    const raw = request as SceneRequest
    const label = this.labelOf(raw.label)
    const sceneId = this.sceneIdOf(raw.sceneId, now)
    const roles = this.readRolesOrRefuse(raw.roles)

    const seats: Seat[] = roles.map((role, index) => ({
      id: role.id,
      name: this.nameOf(role),
      seat: index,
    }))

    this.stage = openStage({ sceneId, label, seats }, now)
    this.opened += 1
    return this.mustView(now)
  }

  /**
   * 下一句该谁说。**纯读**，不推进、不收场。没有开着的场时抛 `not-open`。
   * @param at 时刻。
   */
  next(at?: number): NextResult {
    if (!this.deps.settings.enable) {
      throw new TheaterError('disabled', '多角色剧场已关闭（enable=false）')
    }
    const stage = this.requireOpen()
    return nextTurnOf(stage, this.policy, this.nowOf(at))
  }

  /**
   * 记「上一位说完了」并推进。**唯一会推进游标的方法。**
   *
   * 迟到的 `advance`（本场其实已经该收了）会**先把场收掉再报错**：
   * 冷场之后再续一句，等于让一场已经散了的戏又开口说话。
   * @param speakerId 说话的角色 id；给了就校验。
   * @param at 时刻。
   */
  advance(speakerId?: string, at?: number): TheaterView {
    if (!this.deps.settings.enable) {
      throw new TheaterError('disabled', '多角色剧场已关闭（enable=false）')
    }
    const stage = this.requireOpen()
    const now = this.nowOf(at)

    const stop = stopReasonOf(stage, this.policy, now)
    if (stop !== null) {
      this.stage = closeStage(stage, stop)
      this.noteClose(stop, true)
      throw new TheaterError(
        'closed',
        `本场已收场（${closeNoteOf(stop)}）：迟到的 advance 不会再记一句`,
      )
    }

    const result = advanceStage(stage, this.policy, speakerId, now)
    this.stage = result.stage
    this.spoken += 1
    if (result.closed !== null) this.noteClose(result.closed, true)
    return this.mustView(now)
  }

  /**
   * 收场。**唯一能让座位上的人离开的方法**（契约里没有 `leave()`）。
   * @param at 时刻。
   */
  close(at?: number): TheaterView {
    if (!this.deps.settings.enable) {
      throw new TheaterError('disabled', '多角色剧场已关闭（enable=false）')
    }
    const stage = this.requireOpen()
    const now = this.nowOf(at)
    this.stage = closeStage(stage, 'manual')
    this.noteClose('manual', false)
    return this.mustView(now)
  }

  /**
   * 场次快照。**纯读**，没有场时为 `null`（关掉总开关也照样能看）。
   * @param at 时刻。
   */
  snapshot(at?: number): TheaterView | null {
    return viewOf(this.stage, this.policy, this.nowOf(at))
  }

  /** 累计统计快照。 */
  stats(): TheaterStats {
    return {
      scenes: this.opened,
      turns: this.spoken,
      closes: this.closes,
      autoCloses: this.autoCloses,
      refusals: this.refusals,
      open: this.stage !== null && this.stage.closedReason === null,
      lastCloseReason: this.lastCloseReason,
    }
  }

  /** 拒绝一次开场。**统一在这里加计数**，免得某个分支忘了记。 */
  private refuse(code: TheaterErrorCode, message: string): never {
    this.refusals += 1
    throw new TheaterError(code, message)
  }

  /**
   * 校验角色，失败也计入 refusals。
   *
   * 人数 / 重复 / 形状的拒绝同属「开场被拒」：不记数的话，一个永远开不起来的场
   * 在 `stats()` 里会显示得跟没人用过一样。
   */
  private readRolesOrRefuse(value: unknown): readonly RoleInput[] {
    try {
      return readRoles(value, this.policy.maxRoles)
    } catch (error) {
      this.refusals += 1
      throw error
    }
  }

  /** 取一场开着的场；没有或已散都抛。 */
  private requireOpen(): Stage {
    const stage = this.stage
    if (stage === null) {
      throw new TheaterError('not-open', '还没有开场：先 open()')
    }
    if (stage.closedReason !== null) {
      throw new TheaterError(
        'closed',
        `本场已收场（${closeNoteOf(stage.closedReason)}）：重新开一场要再调 open()`,
      )
    }
    return stage
  }

  /** 记一次收场（自动 / 手动）。 */
  private noteClose(reason: CloseReason, auto: boolean): void {
    this.closes += 1
    if (auto) this.autoCloses += 1
    this.lastCloseReason = reason
  }

  /** 取时刻：优先用传入值，其次时钟服务，最后系统时间。 */
  private nowOf(at?: number): number {
    if (typeof at === 'number' && Number.isFinite(at) && at >= 0) return at
    const clock = this.deps.clock()
    if (clock !== undefined) {
      try {
        return clock.now()
      } catch (error) {
        // 时钟坏了不该让调度停摆，退回系统时间；但要说一次，不静默。
        this.warnOnce('clock', '读 O-003 时钟失败，本场改用系统时间：%s', messageOf(error))
      }
    }
    return this.deps.now()
  }

  /** 规整场次 id：没给就按开场时刻生成；给了就必须是安全字符。 */
  private sceneIdOf(value: unknown, now: number): string {
    if (value === undefined) return `scene-${now}`
    const id = typeof value === 'string' ? value.trim() : ''
    if (!SCENE_ID_RE.test(id)) {
      this.refuse('bad-request', `场次 id 不合法（要求 ${SCENE_ID_RE.source}）：${String(value)}`)
    }
    return id
  }

  /** 规整场次标签：只是标签，不参与调度。 */
  private labelOf(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const label = value.trim()
    if (label.length === 0) return null
    return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX) : label
  }

  /**
   * 解析座位显示名。三级回退：调用方给的 `name` → O-021 的人设 id → 角色 id。
   *
   * O-021 的 `KernelView` 只有 `personaId`，没有 `displayName`，所以「角色名」
   * 实际上就是人设 id。**不猜名字、不拿槽位正文当名字**——那是第二份人格。
   */
  private nameOf(role: RoleInput): string {
    if (typeof role.name === 'string' && role.name.length > 0) return role.name

    const core = this.deps.persona()
    if (core === undefined) {
      this.warnOnce('persona', '未装载 ondra-persona-core：角色名退回角色 id（不猜名字）')
      return role.id
    }
    try {
      const kernel = core.kernel(role.id)
      const personaId = kernel?.personaId
      if (typeof personaId === 'string' && personaId.length > 0) return personaId
    } catch (error) {
      this.warnOnce('persona-read', '读 O-021 人设 id 失败，角色名退回 id：%s', messageOf(error))
    }
    return role.id
  }

  /** 取快照并断言非空（刚建好或刚推进过的场一定非空）。 */
  private mustView(now: number): TheaterView {
    const view = viewOf(this.stage, this.policy, now)
    if (view === null) {
      throw new TheaterError('not-open', '内部不一致：刚开过的场没有快照')
    }
    return view
  }

  /** 同一项降级只报一次。 */
  private warnOnce(key: string, message: string, ...args: unknown[]): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.log.warn(message, ...args)
  }
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
