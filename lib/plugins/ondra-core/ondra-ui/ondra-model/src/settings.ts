/** 配置真源：三个字段；提供商与模型目录是数据，不是配置。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly defaultModel: string
  readonly providerTimeoutMs: number
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后 resolve() 返回 undefined。' },
  { key: 'defaultModel', note: '默认模型 id；空表示取第一个可用。' },
  { key: 'providerTimeoutMs', note: '单次请求超时，默认 60 秒。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = { enable: true, defaultModel: '', providerTimeoutMs: 60_000 }

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  return {
    enable: input.enable ?? true,
    defaultModel: (input.defaultModel ?? '').trim(),
    providerTimeoutMs: Math.min(300_000, Math.max(5_000, Math.trunc(input.providerTimeoutMs ?? 60_000))),
  }
}
