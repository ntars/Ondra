/** 配置真源：三个字段。文案与语气不在配置里——那是包的事。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly defaultPack: string
  readonly hotSwitch: boolean
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后不注入人设段，回到通用助手口吻。' },
  { key: 'defaultPack', note: '启动时用哪个包（slug）；空表示取磁盘上第一个。' },
  { key: 'hotSwitch', note: '允许运行期切换；关掉后只能重启生效。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = { enable: true, defaultPack: '', hotSwitch: true }

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  return {
    enable: input.enable ?? DEFAULT_CONFIG.enable,
    defaultPack: (input.defaultPack ?? '').trim(),
    hotSwitch: input.hotSwitch ?? DEFAULT_CONFIG.hotSwitch,
  }
}
