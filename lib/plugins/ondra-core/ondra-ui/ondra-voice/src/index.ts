/**
 * ondra-voice：语音插件（合并版）。
 *
 * 旧版 asr / tts / tts-gate / oral 四个包。新版一个：听与说是一条链路，
 * 识别的断句决定朗读的换气位置，拆开就会各说各的。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { VoiceService } from './service.js'

export const name = 'ondra-voice'

class VoicePluginService extends Service {
  private readonly core: VoiceService
  private readonly enabled: boolean

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'voice')
    this.enabled = config.enable
    this.core = new VoiceService(config.tts, config.timbre, config.rate)
  }

  plan(answer: string) { return this.enabled ? this.core.plan(answer) : [] }
  startListening() { if (this.enabled) this.core.startListening() }
  stopListening() { this.core.stopListening() }
  heard(text: string, elapsedMs: number) { return this.core.heard(text, elapsedMs) }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new VoicePluginService(ctx, completeConfig(input))
}
