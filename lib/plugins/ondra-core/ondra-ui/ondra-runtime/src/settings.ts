/** 配置真源：五个字段。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly port: number
  readonly maxRestarts: number
  readonly backoffMs: number
  readonly healthTimeoutMs: number
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后不自动拉起进程。' },
  { key: 'port', note: '监听端口，默认 9060 的下一跳 3080。' },
  { key: 'maxRestarts', note: '连续失败重启上限，超过就停在失败态。' },
  { key: 'backoffMs', note: '重启退避基数，按次数翻倍。' },
  { key: 'healthTimeoutMs', note: '健康检查超时。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  enable: true, port: 3080, maxRestarts: 5, backoffMs: 1_000, healthTimeoutMs: 5_000,
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  const clamp = (v: number | undefined, lo: number, hi: number, d: number) =>
    Math.min(hi, Math.max(lo, Math.trunc(v ?? d)))
  return {
    enable: input.enable ?? true,
    port: clamp(input.port, 1024, 65_535, 3080),
    maxRestarts: clamp(input.maxRestarts, 0, 20, 5),
    backoffMs: clamp(input.backoffMs, 100, 60_000, 1_000),
    healthTimeoutMs: clamp(input.healthTimeoutMs, 500, 60_000, 5_000),
  }
}
