/**
 * ondra-chat：右栏与内核之间的接线。
 *
 * 一轮对话 = `ctx.agents` 取/建 agent → `handle.send()` 推一条用户消息 →
 * agent-loop 自己跑完「模型 → 工具 → 模型」，增量从事件流里出来。
 * 这里只管三件事：取 agent、转发增量、停止。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'ondra-chat'
export const inject = ['agents']

export interface SendRequest {
  /** 会话 id；不传表示开新会话。 */
  sessionId?: string
  text: string
}

export interface ChatChunk {
  type: 'text' | 'tool' | 'done' | 'error'
  text?: string
  name?: string
  message?: string
}

/**
 * 内核的 agent 注册表。类型来自 dsh-agent 的 module augmentation；
 * 这里只声明我们真正用到的三个方法，避免把整个内核类型拖进本插件。
 */
interface AgentLike {
  send(text: string): AsyncIterable<{ type: string; text?: string; name?: string }>
  stop(): void
  history(): unknown[]
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
  create(options: Record<string, unknown>): Promise<AgentLike>
}

class ChatService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ondraChat')
  }

  private get agents(): AgentsLike {
    return (this.ctx as unknown as { agents: AgentsLike }).agents
  }

  async *send(req: SendRequest): AsyncGenerator<ChatChunk> {
    const agent = req.sessionId
      ? this.agents.get(req.sessionId)
      : await this.agents.create({})
    if (!agent) {
      yield { type: 'error', message: `会话不存在：${req.sessionId}` }
      return
    }
    for await (const event of agent.send(req.text)) {
      if (event.type === 'text') yield { type: 'text', text: event.text }
      else if (event.type === 'tool') yield { type: 'tool', name: event.name }
    }
    yield { type: 'done' }
  }

  stop(sessionId: string): void {
    this.agents.get(sessionId)?.stop()
  }

  history(sessionId: string) {
    return this.agents.get(sessionId)?.history() ?? []
  }
}

export function apply(ctx: Context): void {
  // 只暴露三个方法；右栏不再需要知道内核里的任何其他概念。
  void new ChatService(ctx)
}
