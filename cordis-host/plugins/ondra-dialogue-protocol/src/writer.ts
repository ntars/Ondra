/**
 * 帧写入器：**跨帧纪律**的唯一实现处。
 *
 * ## 为什么跨帧纪律必须集中在一个对象里
 *
 * 单帧校验（`frames.ts`）看不出「写了两帧 done」「usage 报了两次」，
 * 因为那需要记忆。如果把这条记忆塞进调用方，那么每个生产帧的地方
 * （对话链、通道、界面）都要各写一遍「是否已终态」的判断——
 * 三份判断必然有一份漏，而漏掉的表现是**用户看到半句话**或**账单翻倍**，
 * 两者都不是崩溃，所以永远不会有人报 bug。
 *
 * ## 拒绝而不是抛错
 *
 * 所有方法在非法写入时返回 `undefined`。理由写在 `types.ts` 的 `DoneFrame` 上：
 * 流式路径上抛错会让用户看到半句话然后插件崩掉。代价是调用方必须判空——
 * 这个代价是值得的，因为「判空」在类型上强制，而「记得 catch」不会。
 */

import { clampCount, isCrisisLabel, isStopReason } from './frames.js'
import type {
  CrisisFrame,
  CrisisLabel,
  DoneFrame,
  FrameWriter,
  StopReason,
  TextDeltaFrame,
  TextReplaceFrame,
  UsageFrame,
  WriterOptions,
} from './types.js'

/** 写入被拒时把原因送到外面（只用于统计与日志，不参与控制流）。 */
export type RejectSink = (reason: string) => void

/**
 * 一个回合的帧写入器。
 *
 * 内部状态刻意用**可变私有字段 + 只读 getter**，而不是把接口字段声明成
 * `readonly` 再在类里 `+=`：后者会触发 TS2540（只读字段不可赋值），
 * 而静态文本检查完全看不出来。这条坑在本仓已经踩过一次（O-129 / O-130）。
 */
export class FrameWriterImpl implements FrameWriter {
  /** 下一个可用序号。被拒的写入**不占号**——跳过一帧会让对端误判丢包。 */
  private next = 1
  /** 已成功写出的帧数。 */
  private count = 0
  /** 被拒绝的写入次数。 */
  private rejects = 0
  /** 是否已写出终帧。 */
  private finished = false
  /** 本轮是否已发过危机标记。 */
  private crisisSent = false
  /** 本轮是否已发过用量。 */
  private usageSent = false
  /** 是否放行空文本增量。 */
  private readonly allowEmpty: boolean
  /** 拒绝回调。 */
  private readonly onReject: RejectSink | undefined

  constructor(options?: WriterOptions, onReject?: RejectSink) {
    this.allowEmpty = options?.allowEmptyDelta === true
    this.onReject = onReject
  }

  /** 下一个可用序号。 */
  get seq(): number {
    return this.next
  }

  /** 是否已关闭。 */
  get closed(): boolean {
    return this.finished
  }

  /** 已写出的帧数。 */
  get frames(): number {
    return this.count
  }

  /** 被拒次数。 */
  get rejected(): number {
    return this.rejects
  }

  /**
   * 把一个写入者推到「拒绝」状态。
   * @param reason 一句中文原因。
   */
  private refuse(reason: string): undefined {
    this.rejects += 1
    this.onReject?.(reason)
    return undefined
  }

  /**
   * 终态闸：任何写入前都要过。
   *
   * 单独提成一个方法而不是每处写 `if (this.finished)`：五处各写一遍，
   * 将来加第六种帧时一定会漏一处。
   * @param what 帧类型名（用于日志）。
   */
  private gate(what: string): boolean {
    if (!this.finished) return true
    this.refuse(`writer 已关闭，拒绝写入 ${what}`)
    return false
  }

  textDelta(text: string): TextDeltaFrame | undefined {
    if (!this.gate('text-delta')) return undefined
    if (typeof text !== 'string') return this.refuse('text-delta 的 delta 不是字符串')
    if (text.length === 0 && !this.allowEmpty) return this.refuse('text-delta 的 delta 为空串')
    const frame: TextDeltaFrame = { type: 'text-delta', seq: this.next, delta: text }
    this.next += 1
    this.count += 1
    return frame
  }

  textReplace(text: string): TextReplaceFrame | undefined {
    if (!this.gate('text-replace')) return undefined
    if (typeof text !== 'string') return this.refuse('text-replace 的 text 不是字符串')
    // 替换成空串是合法语义：整段撤回、这句不说了。
    const frame: TextReplaceFrame = { type: 'text-replace', seq: this.next, text }
    this.next += 1
    this.count += 1
    return frame
  }

  crisis(label: CrisisLabel): CrisisFrame | undefined {
    if (!this.gate('crisis')) return undefined
    if (!isCrisisLabel(label)) return this.refuse('crisis 的 kindLabel 不是三个已知值之一')
    if (this.crisisSent) return this.refuse('本轮已发过 crisis（重复提示会让用户以为出了两件事）')
    this.crisisSent = true
    const frame: CrisisFrame = { type: 'crisis', seq: this.next, kindLabel: label }
    this.next += 1
    this.count += 1
    return frame
  }

  usage(inputTokens: number, outputTokens: number): UsageFrame | undefined {
    if (!this.gate('usage')) return undefined
    if (this.usageSent) return this.refuse('本轮已发过 usage（重复上报会让下游重复累加）')
    this.usageSent = true
    const frame: UsageFrame = {
      type: 'usage',
      seq: this.next,
      inputTokens: clampCount(inputTokens),
      outputTokens: clampCount(outputTokens),
    }
    this.next += 1
    this.count += 1
    return frame
  }

  done(stopReason: StopReason): DoneFrame | undefined {
    if (!this.gate('done')) return undefined
    if (!isStopReason(stopReason)) return this.refuse('done 的 stopReason 不是四个已知值之一')
    this.finished = true
    const frame: DoneFrame = { type: 'done', seq: this.next, stopReason }
    this.next += 1
    this.count += 1
    return frame
  }
}
