/** 配置真源：四个字段。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly allowUnverified: boolean
  readonly keepBackup: boolean
  readonly roots: string[]
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后只读，不安装也不卸载。' },
  { key: 'allowUnverified', note: '允许安装未签名/来源未知的包。' },
  { key: 'keepBackup', note: '卸载前把包复制到备份目录。' },
  { key: 'roots', note: '四个分类目录（core / extensions / dsh-base / custom）。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  enable: true,
  allowUnverified: false,
  keepBackup: true,
  roots: ['ondra-core', 'ondra-extensions', 'dsh-base', 'ondra-custom'],
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  return {
    enable: input.enable ?? true,
    allowUnverified: input.allowUnverified ?? false,
    keepBackup: input.keepBackup ?? true,
    roots: input.roots?.length ? [...input.roots] : [...DEFAULT_CONFIG.roots],
  }
}
