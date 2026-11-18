/** 配置真源：四个字段。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly dir: string
  readonly keepSnapshots: number
  readonly compactEvery: number
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后 read/write 直接抛错，避免半截写入。' },
  { key: 'dir', note: '数据目录；空表示用运行时默认目录。' },
  { key: 'keepSnapshots', note: '保留多少份快照，默认 7。' },
  { key: 'compactEvery', note: '每多少次写入做一次整理，0 表示不做。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = { enable: true, dir: '', keepSnapshots: 7, compactEvery: 50 }

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  return {
    enable: input.enable ?? true,
    dir: (input.dir ?? '').trim(),
    keepSnapshots: Math.min(30, Math.max(1, Math.trunc(input.keepSnapshots ?? 7))),
    compactEvery: Math.min(1000, Math.max(0, Math.trunc(input.compactEvery ?? 50))),
  }
}
