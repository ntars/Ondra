/**
 * ondra-plugins：插件管理（导入 / 安装 / 卸载 / 导出）。
 *
 * 插件目录分布在四个分类下（ondra-core / ondra-extensions / dsh-base / ondra-custom），
 * 所以每条记录都带分类；只管文件与清单，不管插件跑起来之后做什么。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import {
  PluginsService, type InstalledPlugin, type PluginPackage, type PluginRoot,
} from './service.js'

export const name = 'ondra-plugins'

class PluginsPluginService extends Service {
  private readonly core: PluginsService
  private readonly enabled: boolean

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'plugins')
    this.enabled = config.enable
    this.core = new PluginsService(config.allowUnverified)
  }

  list(): InstalledPlugin[] { return this.core.list() }
  counts() { return this.core.counts() }

  inspect(pkg: PluginPackage, target: PluginRoot) { return this.core.inspect(pkg, target) }

  install(pkg: PluginPackage, target: PluginRoot): InstalledPlugin | { error: string } {
    if (!this.enabled) return { error: '插件管理已关闭' }
    const err = this.core.inspect(pkg, target)
    return err ? { error: err } : this.core.install(pkg, target)
  }

  uninstall(id: string) {
    if (!this.enabled) return { ok: false, reason: '插件管理已关闭' }
    return this.core.uninstall(id)
  }

  export(id: string) { return this.core.export(id) }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new PluginsPluginService(ctx, completeConfig(input))
}
