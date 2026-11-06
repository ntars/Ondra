/**
 * 帧的产出面 —— 一层薄薄的适配。
 *
 * ## 为什么不直接 `ctx.get('ondra-dialogue-protocol')` 了事
 *
 * 因为那样会有一个很难看的失败：协议插件没装 → 对话链一句话都说不出来。
 * 而 §3.3-3 要求「增强能力挂了，主对话必须还能进行」。协议插件是**增强**
 * （它保证帧合法、帮你防重复），不是对话的前提。
 *
 * 所以这里两层：
 * - 有协议服务 → 用它的 writer（序号、终态、usage 唯一性都由它把关）；
 * - 没有 → 用下面的 `PlainSink`（同形状，**不校验**，只保证 seq 与终态）。
 *
 * ## 为什么 `PlainSink` 只保留两条纪律
 *
 * 序号与终态是**消费者会依赖**的（界面按 seq 去重、按 done 收尾）；
 * 其它三条（空增量、重复 usage、重复 crisis）在没有协议服务时要么不会发生
 * （本插件根本不发 crisis），要么代价极小（多一帧空增量）。少写三条，
 * 就少一处「兜底实现和正式实现不一致」的隐患。
 */

import type { DialogueFrame, DialogueStopReason } from './types.js'

/** 产出面：只暴露本插件真正会发的三种帧。 */
export interface FrameSink {
  /** 写一帧文本增量。空串会被拒（表现为「她卡了一下」）。 */
  delta(text: string): DialogueFrame | undefined
  /** 写一帧用量。 */
  usage(inputTokens: number, outputTokens: number): DialogueFrame | undefined
  /** 写终帧。写出后 sink 关闭。 */
  done(reason: DialogueStopReason): DialogueFrame | undefined
}

/** O-034 协议服务的结构对位（只取本插件要用的四个方法）。 */
export interface ProtocolLike {
  create(): {
    textDelta(text: string): DialogueFrame | undefined
    usage(inputTokens: number, outputTokens: number): DialogueFrame | undefined
    done(reason: DialogueStopReason): DialogueFrame | undefined
  }
  /** 结束原因的**唯一一份**完整映射（见 `types.ts` 的 `DialogueProtocolService`）。 */
  stopReasonOf(kind: string | undefined): DialogueStopReason
}

/**
 * 兜底 sink：协议插件缺席时使用。
 *
 * 与正式实现的两处刻意差异，写在类注释里而不是散落在代码里：
 * 1. 不校验空增量以外的规则（见文件头）；
 * 2. 不统计拒绝次数——没有协议服务就没有人能读那个计数。
 */
class PlainSink implements FrameSink {
  private next = 1
  private finished = false

  delta(text: string): DialogueFrame | undefined {
    if (this.finished) return undefined
    if (typeof text !== 'string' || text.length === 0) return undefined
    const frame: DialogueFrame = { type: 'text-delta', seq: this.next, delta: text }
    this.next += 1
    return frame
  }

  usage(inputTokens: number, outputTokens: number): DialogueFrame | undefined {
    if (this.finished) return undefined
    const frame: DialogueFrame = {
      type: 'usage',
      seq: this.next,
      inputTokens: Math.max(0, Math.trunc(Number.isFinite(inputTokens) ? inputTokens : 0)),
      outputTokens: Math.max(0, Math.trunc(Number.isFinite(outputTokens) ? outputTokens : 0)),
    }
    this.next += 1
    return frame
  }

  done(reason: DialogueStopReason): DialogueFrame | undefined {
    if (this.finished) return undefined
    this.finished = true
    const frame: DialogueFrame = { type: 'done', seq: this.next, stopReason: reason }
    this.next += 1
    return frame
  }
}

/**
 * 造一个 sink：优先用协议服务，缺席则退回 `PlainSink`。
 * @param protocol 协议服务（可能为 `undefined`）。
 */
export function createSink(protocol: ProtocolLike | undefined): FrameSink {
  if (protocol === undefined) return new PlainSink()
  const writer = protocol.create()
  return {
    delta: text => writer.textDelta(text),
    usage: (inputTokens, outputTokens) => writer.usage(inputTokens, outputTokens),
    done: reason => writer.done(reason),
  }
}
