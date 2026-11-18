/**
 * ondra-persona：人设插件（合并版）。
 *
 * 旧版把 loading / vars / assemble / evolve 拆成四个包，新版一个：
 * 它们操作的是同一个对象——当前身份，以及它渲染出的那一段提示词。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { PersonaService, type PersonaPack } from './service.js'

export const name = 'ondra-persona'

class PersonaPluginService extends Service {
  private readonly core = new PersonaService()
  private readonly config: ConfigShape

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'persona')
    this.config = config
    this.core.setEnabled(config.enable)
  }

  /** 由装配方灌入已解析的包（读盘在包加载器里，不在这里）。 */
  install(packs: PersonaPack[]): void {
    this.core.load(packs, this.config.defaultPack)
  }

  switch(id: string): boolean {
    return this.config.hotSwitch ? this.core.switch(id) : false
  }

  active(): PersonaPack | undefined { return this.core.active() }
  list(): PersonaPack[] { return this.core.list() }
  segment(): string { return this.core.segment() }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new PersonaPluginService(ctx, completeConfig(input))
}
