/**
 * 运行时状态机：idle → starting → ready → failed，失败按退避重来。
 *
 * 只管状态与节奏，不真的 spawn——进程拉起是平台层（ondra-flutter）的事。
 * 分开的理由：状态机可测，spawn 不可测。
 */
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed'

export interface HealthResult {
  ok: boolean
  detail?: string
}

export class RuntimeService {
  private state: RuntimeState = 'idle'
  private restarts = 0

  constructor(
    private readonly maxRestarts: number,
    private readonly backoffMs: number,
  ) {}

  current(): RuntimeState { return this.state }

  begin(): void {
    this.state = this.restarts === 0 ? 'starting' : 'restarting'
  }

  ready(): void {
    this.state = 'ready'
    this.restarts = 0
  }

  /** 失败：算下一次要等多久。超过上限就停在 failed，不再自动重试。 */
  fail(): { delayMs: number | null } {
    this.restarts += 1
    if (this.restarts > this.maxRestarts) {
      this.state = 'failed'
      return { delayMs: null }
    }
    this.state = 'restarting'
    return { delayMs: this.backoffMs * 2 ** (this.restarts - 1) }
  }

  /** 健康检查结果归一：非 2xx、超时、解析失败都算不健康。 */
  check(status: number, elapsedMs: number, timeoutMs: number): HealthResult {
    if (elapsedMs > timeoutMs) return { ok: false, detail: '超时' }
    if (status < 200 || status >= 300) return { ok: false, detail: `HTTP ${status}` }
    return { ok: true }
  }

  get attempts(): number { return this.restarts }
}
