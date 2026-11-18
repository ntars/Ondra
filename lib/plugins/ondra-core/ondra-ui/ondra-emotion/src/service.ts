/**
 * 情绪服务：状态 + 表现 + 在场。
 *
 * 三者共用一份状态是刻意的——情绪变了，表情与「正在输入」必须同时变；
 * 拆成三个插件时，两边只能靠事件对时，一慢就是一秒的穿帮。
 */
import type { EmotionLevel, EmotionState, Express, Presence } from './types.js'
import { completeConfig, type ConfigShape } from './settings.js'

export class EmotionService {
  private config: ConfigShape
  private state: EmotionState
  private lastActivity = Date.now()
  private breathUsed = 0
  private breathDay = new Date().toDateString()

  constructor(config: ConfigShape = completeConfig()) {
    this.config = config
    this.state = { level: 0, cause: '', at: Date.now() }
  }

  configure(next: ConfigShape): void {
    this.config = next
  }

  current(): EmotionState {
    return this.state
  }

  /** 记一次波动。level 用整数档，cause 只给日志看，不进模型上下文。 */
  set(level: EmotionLevel, cause = ''): EmotionState {
    this.state = { level, cause, at: Date.now() }
    this.lastActivity = Date.now()
    return this.state
  }

  /** 该不该表现。门槛在配置里：低档不表现，避免每句话都带表情。 */
  express(): Express {
    if (!this.config.enable) return 'none'
    const floor = this.config.expressLevel === 'open' ? 3 : 1
    if (this.state.level < floor) return 'none'
    return this.state.level >= 4 ? 'open' : 'subtle'
  }

  /** 在不在屏幕前：打字阶段亮「正在输入」，走神的长停顿一律熄灭。 */
  presence(phase: 'typing' | 'thinking' | 'idle' = 'idle', now = Date.now()): Presence {
    if (phase === 'typing') {
      this.lastActivity = now
      return 'typing'
    }
    if (phase === 'thinking') return 'thinking'
    return now - this.lastActivity > this.config.awayAfterMs ? 'away' : 'typing'
  }

  /** 呼吸感动作：一天最多两次，同一动作一天最多一次。 */
  breathAction(): string | null {
    if (!this.config.enable || !this.config.breath) return null
    const today = new Date().toDateString()
    if (today !== this.breathDay) {
      this.breathDay = today
      this.breathUsed = 0
    }
    if (this.breathUsed >= 2) return null
    this.breathUsed += 1
    return this.breathUsed === 1 ? '伸了个懒腰' : '把尾巴收回来'
  }
}
