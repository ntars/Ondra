/**
 * ondra-llama：本地部署。
 *
 * 只做三件事：**模型文件在哪、服务有没有在跑、怎么停**。
 * 下载与进程拉起由 Dart 侧的平台层执行（`ui/llama_client.dart`），
 * 这里保留同一套状态与约束，供运行时接通后接管。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'

export const name = 'ondra-llama'

export interface LocalModel {
  /** 文件名，作为 id。 */
  id: string
  /** 完整路径。 */
  path: string
  /** 字节数。 */
  size: number
}

export interface ServerState {
  running: boolean
  pid?: number
  port: number
  model?: string
  /** 最后一行日志，失败时给界面看。 */
  lastLine?: string
}

class LlamaService extends Service {
  private config: ConfigShape
  private state: ServerState

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'llama')
    this.config = config
    this.state = { running: false, port: config.port }
  }

  /** llama-server 的启动参数。集中在这里，避免界面自己拼命令行。 */
  args(model: LocalModel): string[] {
    return [
      '-m', model.path,
      '--host', '127.0.0.1',
      '--port', String(this.config.port),
      '-c', String(this.config.contextSize),
      '-ngl', String(this.config.gpuLayers),
    ]
  }

  /** OpenAI 兼容地址：交给模型基座的「本地部署」预设。 */
  endpoint(): string {
    return `http://127.0.0.1:${this.config.port}/v1`
  }

  status(code: number, elapsedMs: number): { running: boolean; detail: string } {
    if (elapsedMs > 3000) return { running: false, detail: '超时' }
    if (code >= 200 && code < 300) return { running: true, detail: 'ok' }
    return { running: false, detail: `HTTP ${code}` }
  }

  snapshot(): ServerState {
    return { ...this.state }
  }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  void new LlamaService(ctx, completeConfig(input))
}
