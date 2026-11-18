/**
 * ondra-model：模型网关（运行时侧）。
 *
 * 与界面侧的 `ondra-models`（设置页）共用同一套字段，但职责不同：
 * 界面负责编辑，这里负责解析与校验——两边各写一遍，迟早会走形。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { ModelService, type Provider } from './service.js'

export const name = 'ondra-model'

class ModelPluginService extends Service {
  private readonly core = new ModelService()
  private readonly config: ConfigShape

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'modelBase')
    this.config = config
  }

  setProviders(list: Provider[]) { this.core.setProviders(list) }
  providers() { return this.core.providers_() }
  check(p: Provider, m: Provider) { return this.core.checkModel(p, m.models[0]) }
  resolve() {
    if (!this.config.enable) return undefined
    return this.core.resolve(this.config.defaultModel)
  }
  timeout() { return this.config.providerTimeoutMs }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new ModelPluginService(ctx, completeConfig(input))
}
