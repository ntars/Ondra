/**
 * ondra-store：存储插件（合并版）。
 *
 * 旧版 store-json / store-sqlite / snapshot / data-migrate / path-layout 五个包。
 * 新版一个：**一份状态只能有一个写入者**，否则断电之后没人说得清哪份是真的。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { completeConfig, type ConfigShape } from './settings.js'
import { StoreService } from './service.js'

export const name = 'ondra-store'

class StorePluginService extends Service {
  private readonly core: StoreService

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'store')
    const dir = config.dir || join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ondra')
    this.core = new StoreService(dir, config.enable)
  }

  write(key: string, value: unknown) { return this.core.write(key, value) }
  read<T>(key: string, fallback: T) { return this.core.read<T>(key, fallback) }
  snapshot(key: string, keep: number) { return this.core.snapshot(key, keep) }
  writes() { return this.core.writeCount }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new StorePluginService(ctx, completeConfig(input))
}
