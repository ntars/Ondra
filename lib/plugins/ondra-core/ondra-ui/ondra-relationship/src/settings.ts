/** 配置真源：四个字段。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly proactiveDailyCap: number
  readonly cooldownMinutes: number
  readonly trustPerTurn: number
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后既不记关系也不主动。' },
  { key: 'proactiveDailyCap', note: '单日主动开口上限，默认 1，上限锁 3。' },
  { key: 'cooldownMinutes', note: '两次主动之间的最小间隔，默认 180 分钟。' },
  { key: 'trustPerTurn', note: '每轮有效对话增加的信任，默认 1。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  enable: true, proactiveDailyCap: 1, cooldownMinutes: 180, trustPerTurn: 1,
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  const cap = typeof input.proactiveDailyCap === 'number' ? input.proactiveDailyCap : 1
  return {
    enable: input.enable ?? true,
    proactiveDailyCap: Math.min(3, Math.max(0, Math.trunc(cap))),
    cooldownMinutes: Math.min(1440, Math.max(0, Math.trunc(input.cooldownMinutes ?? 180))),
    trustPerTurn: Math.min(5, Math.max(0, Math.trunc(input.trustPerTurn ?? 1))),
  }
}
