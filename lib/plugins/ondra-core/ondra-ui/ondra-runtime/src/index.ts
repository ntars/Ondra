/**
 * ondra-runtime：运行时守护（合并版）。
 *
 * 旧版 process-host / sandbox / port-picker / startup-check / install-doctor / installer
 * 六个包。新版一个：这些判断必须一起看，否则「端口被占 → 重启 → 再被占」会无限循环。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { RuntimeService } from './service.js'

export const name = 'ondra-runtime'

class RuntimePluginService extends Service {
  private readonly core: RuntimeService
  private readonly config: ConfigShape

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'runtime')
    this.config = config
    this.core = new RuntimeService(config.maxRestarts, config.backoffMs)
  }

  state() { return this.core.current() }
  begin() { if (this.config.enable) this.core.begin() }
  ready() { this.core.ready() }
  fail() { return this.core.fail() }
  check(status: number, elapsedMs: number) {
    return this.core.check(status, elapsedMs, this.config.healthTimeoutMs)
  }
  port() { return this.config.port }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new RuntimePluginService(ctx, completeConfig(input))
}
