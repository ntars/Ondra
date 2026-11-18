/**
 * 通道服务：适配器注册 + 一条投递队列。
 *
 * 适配器（QQ / 飞书 / 邮件）只负责「怎么收发」，排队、群聊判定、忙时策略都在这里，
 * 否则同一个群里三个通道会出现三套不同的礼让规则。
 */
export type ChannelId = 'qq' | 'feishu' | 'mail' | (string & {})

export interface InboundMessage {
  channel: ChannelId
  chatId: string
  fromId: string
  text: string
  isGroup: boolean
  at: number
}

export interface ChannelAdapter {
  readonly id: ChannelId
  send(chatId: string, text: string): Promise<void>
}

export class ChannelService {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>()
  private queue: InboundMessage[] = []
  private busy = false

  constructor(
    private readonly allowGroups: boolean,
    private readonly policy: 'queue' | 'steer' | 'drop',
    private readonly maxQueue: number,
  ) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  /** 入站：群聊拦截 → 忙时策略 → 入队。返回 false 表示这条被丢弃。 */
  accept(msg: InboundMessage): boolean {
    if (msg.isGroup && !this.allowGroups) return false
    if (this.busy) {
      if (this.policy === 'drop') return false
      if (this.policy === 'steer') this.queue.unshift(msg)
      else this.queue.push(msg)
    } else {
      this.queue.push(msg)
    }
    if (this.queue.length > this.maxQueue) this.queue.shift()
    return true
  }

  /** 取一条待处理消息（出队）。 */
  next(): InboundMessage | undefined {
    this.busy = this.queue.length > 0
    return this.queue.shift()
  }

  async reply(msg: InboundMessage, text: string): Promise<boolean> {
    const adapter = this.adapters.get(msg.channel)
    if (!adapter) return false
    await adapter.send(msg.chatId, text)
    return true
  }

  get pending(): number { return this.queue.length }
}
