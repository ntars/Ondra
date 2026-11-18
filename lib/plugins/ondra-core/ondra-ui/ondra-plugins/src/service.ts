/**
 * 插件管理：只做四件事——导入、安装、卸载、导出。
 *
 * 有意不碰「插件跑起来之后的行为」：那些属于各插件自己。
 * 目录分布在四个分类下，所以每条记录都带 `root`，否则卸载时就不知道该删哪一份。
 */
export type PluginRoot = 'ondra-core' | 'ondra-extensions' | 'dsh-base' | 'ondra-custom'

export interface InstalledPlugin {
  id: string
  version: string
  root: PluginRoot
  /** 是否可关闭；core 与 dsh-base 不可关闭。 */
  closable: boolean
  /** 导入来源，便于审计。 */
  source?: string
}

export interface PluginPackage {
  id: string
  version: string
  /** 包文件名，用于记录与回滚。 */
  file: string
  verified: boolean
}

const CLOSABLE: Record<PluginRoot, boolean> = {
  'ondra-core': false,
  'ondra-extensions': true,
  'dsh-base': false,
  'ondra-custom': true,
}

export class PluginsService {
  private installed: InstalledPlugin[] = []

  constructor(private readonly allowUnverified: boolean) {}

  list(): InstalledPlugin[] { return [...this.installed] }

  /** 导入：先校验 id 与来源，再决定落到哪个分类。 */
  inspect(pkg: PluginPackage, target: PluginRoot): string | null {
    if (!/^[a-z][a-z0-9-]*$/.test(pkg.id)) return '插件 id 需小写字母开头，可含数字与短横线'
    if (!pkg.verified && !this.allowUnverified) return '包未校验：请确认来源，或在设置里允许未校验的包'
    if (this.installed.some(p => p.id === pkg.id && p.root === target)) return '该分类下已存在同 id 插件'
    return null
  }

  install(pkg: PluginPackage, target: PluginRoot): InstalledPlugin {
    const record: InstalledPlugin = {
      id: pkg.id, version: pkg.version, root: target,
      closable: CLOSABLE[target], source: pkg.file,
    }
    this.installed.push(record)
    return record
  }

  /** 卸载：不可关闭的插件拒绝卸载（只能禁用，且禁用也要走运行时）。 */
  uninstall(id: string): { ok: boolean; reason?: string } {
    const hit = this.installed.find(p => p.id === id)
    if (!hit) return { ok: false, reason: '未安装' }
    if (!hit.closable) return { ok: false, reason: '核心插件不可卸载' }
    this.installed = this.installed.filter(p => p !== hit)
    return { ok: true }
  }

  /** 导出：只打包一个插件，不导出它的运行数据。 */
  export(id: string): { id: string; version: string } | null {
    const hit = this.installed.find(p => p.id === id)
    return hit ? { id: hit.id, version: hit.version } : null
  }

  /** 按分类统计，插件页的标题行用。 */
  counts(): Record<PluginRoot, number> {
    const out: Record<PluginRoot, number> = {
      'ondra-core': 0, 'ondra-extensions': 0, 'dsh-base': 0, 'ondra-custom': 0,
    }
    for (const p of this.installed) out[p.root] += 1
    return out
  }
}
