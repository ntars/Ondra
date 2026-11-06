/**
 * 多会话排队：**只存内存、只存入口、不装定时器**。
 *
 * ## 为什么上限满了要「拒绝」而不是「丢掉最旧的」
 *
 * 丢最旧的那条会让用户看到「她跳过了我中间那句话」——而日志里一切正常
 * （确实是在按配置工作）。拒绝会让适配器拿到 `queue-full`，它可以据此
 * 回一句「我有点跟不上了，再说一次好吗」，这是可解释的失败。
 * 「悄悄丢数据比写不进去糟」这条在 O-007 里已经定过，这里是同一条。
 *
 * ## 为什么正文要截断
 *
 * 排队只为「等会儿再处理」，不是归档。平台侧原文还在（适配器在
 * `release()` 之前不该推进游标），所以截断不丢信息，只是不让内存
 * 跟着消息长度长。上限取 2000，对齐手册 §5.3 内容闸的 1800 量级。
 *
 * ## 为什么没有「队列满了自动删会话」
 *
 * 自动淘汰会让「某个群一晚上很热闹」把「另一个私聊在等回复」挤掉，
 * 而两者谁重要不是本插件能判断的。宁可拒绝新会话，也不动已有会话。
 */

import type { ConversationKind, EnqueueOutcome, QueueItem, RouteInput, Trigger } from './types.js'
import { kindOf, triggerOf } from './decide.js'

/** 单条排队正文的最大长度。超了截断（见文件头）。 */
export const QUEUE_TEXT_MAX = 2000

/** 入队用的最小形状。已经判过、确定要处置的那条。 */
export interface QueueSeed {
  readonly channelId: string
  readonly conversationId: string
  readonly kind: ConversationKind
  readonly trigger: Trigger
  readonly text: string
  readonly at: number
  readonly messageId?: string
  readonly senderId?: string
}

/**
 * 把一条入站消息压成队列种子。
 * @param input 入站消息。
 * @param at 判定时刻（毫秒）。
 */
export function seedOf(input: RouteInput, at: number): QueueSeed {
  const text = typeof input.text === 'string' ? input.text : ''
  return {
    channelId: input.channelId,
    conversationId: input.conversationId,
    kind: kindOf(input.kind),
    trigger: triggerOf(input.trigger),
    text: text.length > QUEUE_TEXT_MAX ? text.slice(0, QUEUE_TEXT_MAX) : text,
    at,
    messageId: input.messageId,
    senderId: input.senderId,
  }
}

/** 按会话分组的先进先出队列。**没有定时器、没有回调**。 */
export class ConversationQueue {
  private readonly maxPerConversation: number
  private readonly maxConversations: number
  /** 会话 id → 该会话的积压（队尾在末尾）。 */
  private readonly items = new Map<string, QueueItem[]>()
  /** 全局自增序号：跨会话共享，日志能看出先后。 */
  private seq = 0
  /** 累计因「满了」被拒的条数。 */
  private refusedCount = 0
  /** 累计因「会话被忘掉」而清掉的条数。 */
  private discardedCount = 0

  /**
   * @param maxPerConversation 单会话上限（≥1）。
   * @param maxConversations 会话数上限（≥1）。
   */
  constructor(maxPerConversation: number, maxConversations: number) {
    this.maxPerConversation = Math.max(1, Math.trunc(maxPerConversation))
    this.maxConversations = Math.max(1, Math.trunc(maxConversations))
  }

  /**
   * 入队。
   * @param seed 已判过要处置的一条。
   * @returns 成功给位次，失败给「已满」。
   */
  push(seed: QueueSeed): EnqueueOutcome {
    const existing = this.items.get(seed.conversationId)

    if (existing === undefined) {
      if (this.items.size >= this.maxConversations) {
        this.refusedCount += 1
        return { ok: false, depth: 0, position: 0 }
      }
      const list: QueueItem[] = [this.materialize(seed)]
      this.items.set(seed.conversationId, list)
      return { ok: true, depth: 1, position: 1 }
    }

    if (existing.length >= this.maxPerConversation) {
      this.refusedCount += 1
      return { ok: false, depth: existing.length, position: 0 }
    }

    existing.push(this.materialize(seed))
    return { ok: true, depth: existing.length, position: existing.length }
  }

  /** 造一条队列项（顺手分配序号）。 */
  private materialize(seed: QueueSeed): QueueItem {
    this.seq += 1
    return Object.freeze({
      seq: this.seq,
      channelId: seed.channelId,
      conversationId: seed.conversationId,
      kind: seed.kind,
      trigger: seed.trigger,
      text: seed.text,
      at: seed.at,
      messageId: seed.messageId,
      senderId: seed.senderId,
    })
  }

  /**
   * 取出并清空一个会话的积压。
   * @param conversationId 会话 id。
   */
  take(conversationId: string): readonly QueueItem[] {
    const list = this.items.get(conversationId)
    if (list === undefined) return []
    this.items.delete(conversationId)
    return list
  }

  /**
   * 只读一个会话的积压（不取出）。
   * @param conversationId 会话 id。
   */
  pending(conversationId: string): readonly QueueItem[] {
    return this.items.get(conversationId) ?? []
  }

  /**
   * 一个会话的积压条数。
   * @param conversationId 会话 id。
   */
  depthOf(conversationId: string): number {
    return this.items.get(conversationId)?.length ?? 0
  }

  /** 全部积压，**按全局入队顺序**（跨会话也保持先后）。 */
  all(): readonly QueueItem[] {
    const out: QueueItem[] = []
    for (const list of this.items.values()) out.push(...list)
    return out.sort((a, b) => a.seq - b.seq)
  }

  /** 积压总条数。 */
  size(): number {
    let total = 0
    for (const list of this.items.values()) total += list.length
    return total
  }

  /** 有积压的会话数。 */
  conversations(): number {
    return this.items.size
  }

  /**
   * 忘掉一个会话。**清掉的条数计入「没被处置」**。
   * @param conversationId 会话 id。
   * @returns 清掉的条数。
   */
  forget(conversationId: string): number {
    const list = this.items.get(conversationId)
    if (list === undefined) return 0
    this.items.delete(conversationId)
    this.discardedCount += list.length
    return list.length
  }

  /** 清空（卸载时用）。 */
  clear(): void {
    for (const list of this.items.values()) this.discardedCount += list.length
    this.items.clear()
  }

  /** 累计因满被拒的条数。 */
  get refused(): number {
    return this.refusedCount
  }

  /** 累计被清掉的条数。 */
  get discarded(): number {
    return this.discardedCount
  }
}
