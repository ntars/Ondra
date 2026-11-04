/**
 * 链跟踪 —— 把「一次接一次的成功调用」攒成链。
 *
 * ## 链的三条断法
 *
 * 1. **失败**：链断。失败之后的那次成功不是同一条链的延续——中间那一步没过去，
 *    后面走的路就不是原来那条路。
 * 2. **超时**：相邻两步间隔超过 `chain-gap-ms`。隔天再走一遍的相同顺序，
 *    是「又走了一遍」而不是「一直在走」。
 * 3. **到顶**：步数达到 `max-chain-steps`。长链会一直挂着不结算，
 *    既占内存又永远等不到「结束」那一刻；到了上限就结算并重开。
 *
 * ## 为什么按 agent 分桶
 *
 * 两个 agent 的工具调用交错回到同一个事件流里，混成一条链就会得到一条
 * 「谁的调用都不像」的序列。用 `WeakMap` 给 agent 对象分配一个短名，
 * agent 被回收时桶里的条目随之失效——不需要额外的清理逻辑。
 */

import type { ChainSummary } from './types.js'

/** 一条正在走的链。 */
interface ChainState {
  readonly tools: string[]
  readonly startedAt: number
  lastAt: number
}

/**
 * 把状态收成一份快照。
 * @param state 链状态。
 */
function summaryOf(state: ChainState): ChainSummary {
  return { tools: Object.freeze([...state.tools]), startedAt: state.startedAt, lastAt: state.lastAt }
}

/** 链跟踪器。 */
export class ChainTracker {
  private readonly buckets = new Map<string, ChainState>()
  private readonly agentKeys = new WeakMap<object, string>()
  private nextAgent = 0

  /** 当前挂着的链数。 */
  get size(): number {
    return this.buckets.size
  }

  /**
   * 给一个 agent 对象分配短名。不是对象就返回 undefined（调用方计入 `orphanSteps`）。
   * @param agent 上游 `execution.agent`。
   */
  agentKeyOf(agent: unknown): string | undefined {
    if (typeof agent !== 'object' || agent === null) return undefined
    const existing = this.agentKeys.get(agent)
    if (existing !== undefined) return existing
    this.nextAgent += 1
    const key = `agent-${this.nextAgent}`
    this.agentKeys.set(agent, key)
    return key
  }

  /**
   * 记一步成功。
   * @param agent 归属 agent。
   * @param tool 工具名。
   * @param at 时刻。
   * @param gapMs 相邻步最大间隔。
   * @param maxSteps 单链步数上限。
   * @returns 因超时或被上限截断而结算的链（0 到 2 条）。
   */
  step(
    agent: unknown,
    tool: string,
    at: number,
    gapMs: number,
    maxSteps: number,
  ): readonly ChainSummary[] {
    const key = this.agentKeyOf(agent)
    if (key === undefined) return []

    const finished: ChainSummary[] = []
    let state = this.buckets.get(key)
    if (state !== undefined && at - state.lastAt > gapMs) {
      finished.push(summaryOf(state))
      this.buckets.delete(key)
      state = undefined
    }
    if (state === undefined) {
      state = { tools: [], startedAt: at, lastAt: at }
      this.buckets.set(key, state)
    }
    state.tools.push(tool)
    state.lastAt = at

    if (state.tools.length >= maxSteps) {
      finished.push(summaryOf(state))
      this.buckets.delete(key)
    }
    return finished
  }

  /**
   * 记一次失败：该 agent 的链断。
   * @param agent 归属 agent。
   */
  cut(agent: unknown): readonly ChainSummary[] {
    const key = this.agentKeyOf(agent)
    if (key === undefined) return []
    const state = this.buckets.get(key)
    if (state === undefined) return []
    this.buckets.delete(key)
    return [summaryOf(state)]
  }

  /**
   * 交出所有还在走的链（卸载时用）。**不丢弃**：已经走通的步数是事实。
   */
  drain(): readonly ChainSummary[] {
    const out: ChainSummary[] = []
    for (const state of this.buckets.values()) out.push(summaryOf(state))
    this.buckets.clear()
    return out
  }

  /** 清空（账本重置时用）。 */
  clear(): void {
    this.buckets.clear()
  }
}
