/** 配置真源：四个字段。形态（阈值、文案）不进配置，否则每台机器的「她」都不一样。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly expressLevel: ExpressFloor
  readonly breath: boolean
  readonly awayAfterMs: number
}

/** 表达门槛：低于这个强度就不表现——她不需要把每次波动都说出来。 */
export type ExpressFloor = 'subtle' | 'open'

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后状态仍记录，但不表现。' },
  { key: 'expressLevel', note: '表达门槛：subtle 起就表现，open 只在强情绪时表现。' },
  { key: 'breath', note: '呼吸感动作（一天最多两次）。' },
  { key: 'awayAfterMs', note: '多久没动静算「不在屏幕前」，默认 90 秒。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  enable: true,
  expressLevel: 'subtle',
  breath: true,
  awayAfterMs: 90_000,
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  const away =
    typeof input.awayAfterMs === 'number' && Number.isFinite(input.awayAfterMs)
      ? Math.min(600_000, Math.max(15_000, Math.trunc(input.awayAfterMs)))
      : DEFAULT_CONFIG.awayAfterMs
  return {
    enable: input.enable ?? DEFAULT_CONFIG.enable,
    expressLevel: input.expressLevel === 'open' ? 'open' : 'subtle',
    breath: input.breath ?? DEFAULT_CONFIG.breath,
    awayAfterMs: away,
  }
}
