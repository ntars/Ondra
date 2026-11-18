/** 配置真源：五个字段。 */
export interface ConfigShape {
  readonly binary: string
  readonly modelsDir: string
  readonly port: number
  readonly contextSize: number
  readonly gpuLayers: number
}

export const FIELD_SPECS = [
  { key: 'binary', note: 'llama-server 可执行文件；空表示按 PATH 与常见目录查找。' },
  { key: 'modelsDir', note: 'GGUF 存放目录，默认 ~/.ondra/models。' },
  { key: 'port', note: 'llama-server 监听端口，默认 8080（与本地部署预设一致）。' },
  { key: 'contextSize', note: '上下文长度，-c 参数；太大吃内存，默认 8192。' },
  { key: 'gpuLayers', note: '卸载到 GPU 的层数；0 表示纯 CPU，999 表示尽量全放。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  binary: '',
  modelsDir: '',
  port: 8080,
  contextSize: 8192,
  gpuLayers: 999,
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  const clamp = (v: number | undefined, lo: number, hi: number, d: number) =>
    Math.min(hi, Math.max(lo, Math.trunc(v ?? d)))
  return {
    binary: (input.binary ?? '').trim(),
    modelsDir: (input.modelsDir ?? '').trim(),
    port: clamp(input.port, 1024, 65_535, 8080),
    contextSize: clamp(input.contextSize, 512, 1_048_576, 8192),
    gpuLayers: clamp(input.gpuLayers, 0, 999, 999),
  }
}
