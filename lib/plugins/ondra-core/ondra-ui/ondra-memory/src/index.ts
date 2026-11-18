/**
 * ondra-memory：记忆插件（合并版）。
 *
 * 旧版把记忆拆成了抽取、去重、衰减、图谱、做梦、修复等十余个包。
 * 新版合并成一个：**它们读写的是同一份数据**，拆开的唯一后果是顺序靠猜。
 * 内部仍分文件（types / settings / service），但不拆包。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'
import { MemoryStore } from './service.js'
import { MEMORY_SERVICE } from './types.js'

export const name = 'ondra-memory'

export interface Config extends Partial<ConfigShape> {}

class MemoryService extends Service {
  private readonly store: MemoryStore

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, MEMORY_SERVICE)
    this.store = new MemoryStore(completeConfig(config))
    ctx.effect(() => () => { /* 没有常驻资源，写盘由外部快照负责 */ }, 'memory:dispose')
  }

  remember(text: string, kind: 'fact' | 'preference' | 'event' | 'self' = 'fact') {
    return this.store.remember(text, kind)
  }

  link(a: string, b: string): boolean {
    return this.store.link(a, b)
  }

  recall(query: string) {
    const hits = this.store.recall(query)
    this.store.touch(hits.map(h => h.point.id))
    return hits
  }

  all() {
    return this.store.snapshot()
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new MemoryService(ctx, config)
}
