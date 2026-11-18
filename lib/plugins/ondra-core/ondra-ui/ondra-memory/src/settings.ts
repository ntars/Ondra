/**
 * 配置的单一真源。
 *
 * 只有六个字段：其余都是形态（怎么切词、怎么排序），形态不进配置——
 * 做成配置项就等于每台机器上「她记得什么」都不一样，而这正是最不该可配的东西。
 */
export interface FieldSpec {
  key: keyof ConfigShape
  /** 手册口径写在这里，改配置的人知道边界在哪。 */
  note: string
}

export interface ConfigShape {
  readonly enable: boolean
  readonly recallLimit: number
  readonly retainDays: number
  readonly capacity: number
  readonly autoSummarize: boolean
  readonly decay: boolean
}

export const FIELD_SPECS: readonly FieldSpec[] = [
  { key: 'enable', note: '总开关；关掉后服务仍在，召回返回空。' },
  { key: 'recallLimit', note: '一次召回最多给几条，默认 6。' },
  { key: 'retainDays', note: '0 表示永久；否则超过天数的记忆不再参与召回。' },
  { key: 'capacity', note: '条数上限，超了按「最久没被引用」淘汰。' },
  { key: 'autoSummarize', note: '每晚把零散对话收成记忆点。' },
  { key: 'decay', note: '按 lastUsedAt 做时间衰减，只影响排序。' },
]

export const DEFAULT_CONFIG: ConfigShape = {
  enable: true,
  recallLimit: 6,
  retainDays: 0,
  capacity: 5000,
  autoSummarize: true,
  decay: true,
}

/** 极端值兜底：配置是用户能改的，改坏了不该让记忆整库失效。 */
export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  const num = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  return {
    enable: input.enable ?? DEFAULT_CONFIG.enable,
    recallLimit: num(input.recallLimit, 1, 20, DEFAULT_CONFIG.recallLimit),
    retainDays: num(input.retainDays, 0, 3650, DEFAULT_CONFIG.retainDays),
    capacity: num(input.capacity, 100, 100_000, DEFAULT_CONFIG.capacity),
    autoSummarize: input.autoSummarize ?? DEFAULT_CONFIG.autoSummarize,
    decay: input.decay ?? DEFAULT_CONFIG.decay,
  }
}
