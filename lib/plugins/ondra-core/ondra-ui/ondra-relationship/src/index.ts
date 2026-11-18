/**
 * ondra-relationship：关系与主动（合并版）。
 *
 * 旧版把 first-meet / identity / worldbook / proactive-gate / proactive-quota /
 * rhythm 拆成多个包。新版一个：主动说话的额度取决于关系阶段，
 * 分开算就会「刚认识却天天找你」。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { RelationshipService } from './service.js'

export const name = 'ondra-relationship'

class RelationshipPluginService extends Service {
  private readonly core: RelationshipService
  private readonly enabled: boolean

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'relationship')
    this.enabled = config.enable
    this.core = new RelationshipService(
      config.proactiveDailyCap,
      config.cooldownMinutes * 60_000,
      config.trustPerTurn,
    )
  }

  touch() { return this.core.touch() }
  stage() { return this.core.stage() }
  mayProactive() {
    if (!this.enabled) return { ok: false, reason: '已关闭' }
    return this.core.mayProactive()
  }
  silence() { return this.core.silence() }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new RelationshipPluginService(ctx, completeConfig(input))
}
