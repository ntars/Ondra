/**
 * ondra-channel：通道插件（合并版）。
 *
 * 旧版有 dsh-client / desktop-bridge 两个包，加上后来的各类机器人适配。
 * 新版一个：**一条通道一种适配，投递策略只有一套**。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { ChannelService, type ChannelAdapter, type InboundMessage } from './service.js'

export const name = 'ondra-channel'

class ChannelPluginService extends Service {
  private readonly core: ChannelService
  private readonly enabled: boolean

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'channel')
    this.enabled = config.enable
    this.core = new ChannelService(config.allowGroups, config.busyPolicy, config.maxQueue)
  }

  register(adapter: ChannelAdapter) { this.core.register(adapter) }
  accept(msg: InboundMessage) { return this.enabled && this.core.accept(msg) }
  next() { return this.core.next() }
  reply(msg: InboundMessage, text: string) { return this.core.reply(msg, text) }
  pending() { return this.core.pending }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  new ChannelPluginService(ctx, completeConfig(input))
}
