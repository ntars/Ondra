/** 关系服务：一条信任曲线 + 一个主动额度。 */
export type Stage = 'stranger' | 'familiar' | 'close'

export interface RelationState {
  stage: Stage
  trust: number
  lastSpokeAt: number
  proactiveUsed: number
  proactiveDay: string
}

const DAY = 86_400_000

export class RelationshipService {
  private state: RelationState = {
    stage: 'stranger', trust: 0, lastSpokeAt: 0, proactiveUsed: 0,
    proactiveDay: new Date().toISOString().slice(0, 10),
  }

  constructor(
    private readonly cap: number,
    private readonly cooldownMs: number,
    private readonly trustPerTurn: number,
  ) {}

  /** 一轮有效对话：加信任、抬阶段、记时间。 */
  touch(now = Date.now()): RelationState {
    this.state.trust = Math.min(100, this.state.trust + this.trustPerTurn)
    this.state.lastSpokeAt = now
    this.state.stage = this.state.trust >= 60 ? 'close' : this.state.trust >= 20 ? 'familiar' : 'stranger'
    return { ...this.state }
  }

  stage(): Stage { return this.state.stage }

  /**
   * 能不能主动开口：阶段、冷却、单日额度三道闸，全过才允许。
   * 只回答「能不能」，说什么由 expression 那一层决定。
   */
  mayProactive(now = Date.now()): { ok: boolean; reason: string } {
    if (this.state.stage === 'stranger') return { ok: false, reason: '还不熟' }
    if (now - this.state.lastSpokeAt < this.cooldownMs) return { ok: false, reason: '冷却中' }
    const today = new Date(now).toISOString().slice(0, 10)
    if (today !== this.state.proactiveDay) {
      this.state.proactiveDay = today
      this.state.proactiveUsed = 0
    }
    if (this.state.proactiveUsed >= this.cap) return { ok: false, reason: '今日额度用完' }
    this.state.proactiveUsed += 1
    this.state.lastSpokeAt = now
    return { ok: true, reason: 'ok' }
  }

  /** 隔了多久没说话，界面上「上次聊天」用。 */
  silence(now = Date.now()): number {
    return this.state.lastSpokeAt === 0 ? Infinity : now - this.state.lastSpokeAt
  }
}

export const _DAY_MS = DAY
