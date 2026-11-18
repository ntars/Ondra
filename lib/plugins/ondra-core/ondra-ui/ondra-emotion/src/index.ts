/**
 * ondra-emotion：情绪插件（合并版）。
 *
 * 旧版拆成 emotion-core / diffuse / express / project / stage / breath / absence
 * 等近十个包。新版合并：**它们共用一份状态**，拆开之后「表情变了但正在输入还亮着」
 * 这种穿帮就得靠事件对时去补。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { EmotionService } from './service.js'
import { EMOTION_SERVICE, type EmotionLevel } from './types.js'

export const name = 'ondra-emotion'

export interface Config extends Partial<ConfigShape> {}

class EmotionPluginService extends Service {
  private readonly core: EmotionService

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, EMOTION_SERVICE)
    this.core = new EmotionService(completeConfig(config))
    ctx.effect(() => () => { /* 无常驻资源 */ }, 'emotion:dispose')
  }

  state() { return this.core.current() }
  set(level: EmotionLevel, cause?: string) { return this.core.set(level, cause) }
  express() { return this.core.express() }
  presence(phase?: 'typing' | 'thinking' | 'idle') { return this.core.presence(phase) }
  breath() { return this.core.breathAction() }
}

export function apply(ctx: Context, config: Config = {}): void {
  new EmotionPluginService(ctx, config)
}
