/**
 * 协议门面：把纯判定（`frames.ts`）与跨帧纪律（`writer.ts`）组装成一个服务。
 *
 * 这一层只做四件事，每件都对应一个真实失败：
 *
 * 1. **给每个回合发一个新 writer** —— 复用 writer 会让上一轮的 `seq` 与
 *    `finished` 漏到下一轮，表现是「第二条消息一个字都不出」；
 * 2. **统计拒绝** —— 被拒的写入必须能看见，否则「为什么界面少了一句话」
 *    永远查不到（拒绝是静默的，这是它能被忽略这么久的原因）；
 * 3. **编解码** —— 通道侧要一行一帧（NDJSON），界面侧要对象；
 * 4. **总开关** —— 关掉时返回一个**立刻关闭**的 writer，而不是返回
 *    「一个什么都不做的对象」。后者会让调用方以为自己还在产帧。
 */

import { stopReasonOf as mapStopReason, validateFrame } from './frames.js'
import { FrameWriterImpl } from './writer.js'
import type { Config } from './settings.js'
import type {
  CrisisLabel,
  DialogueFrame,
  DialogueProtocolService,
  FrameType,
  FrameWriter,
  LogLike,
  ProtocolStats,
  StopReason,
  ValidateResult,
  WriterOptions,
} from './types.js'
import { CRISIS_LABELS, FRAME_TYPES, STOP_REASONS } from './types.js'

/**
 * 总开关关闭时用的 writer。
 *
 * 所有写入都返回 `undefined`、`closed` 恒为真——调用方 `if (!frame) break`
 * 会立刻收手，而不会以为「还没开始」。这比返回一个永远吐帧的实现诚实。
 */
class ClosedWriter implements FrameWriter {
  get seq(): number {
    return 1
  }

  get closed(): boolean {
    return true
  }

  get frames(): number {
    return 0
  }

  get rejected(): number {
    return 0
  }

  textDelta(): undefined {
    return undefined
  }

  textReplace(): undefined {
    return undefined
  }

  crisis(): undefined {
    return undefined
  }

  usage(): undefined {
    return undefined
  }

  done(): undefined {
    return undefined
  }
}

/** 协议服务实现。 */
export class DialogueProtocol implements DialogueProtocolService {
  readonly frames: readonly FrameType[] = FRAME_TYPES
  readonly stopReasons: readonly StopReason[] = STOP_REASONS
  readonly crisisLabels: readonly CrisisLabel[] = CRISIS_LABELS

  /** 仍在进行中的 writer（关闭后在 `stats()` 里结算并移除）。 */
  private readonly live = new Set<FrameWriterImpl>()
  /** 已结算的 writer 贡献的帧数。 */
  private settledFrames = 0
  /** 创建过的 writer 总数。 */
  private writers = 0
  /** 累计被拒次数。 */
  private rejected = 0
  /** 最近一次拒绝原因。 */
  private lastReject: string | undefined
  /** 编解码调用次数。 */
  private codecCalls = 0
  /** 生效配置。 */
  private readonly settings: Config
  /** 日志。 */
  private readonly log: LogLike

  constructor(options: { readonly settings: Config; readonly log: LogLike }) {
    this.settings = options.settings
    this.log = options.log
  }

  create(options?: WriterOptions): FrameWriter {
    if (!this.settings.enable) return new ClosedWriter()
    this.writers += 1
    // `allowEmptyDelta` 取「调用方显式开启 或 配置开启」的或——
    // 调用方最清楚这一轮是不是保活心跳；配置是机器级的兜底。
    const merged: WriterOptions = {
      allowEmptyDelta: options?.allowEmptyDelta === true || this.settings.allowEmptyDelta,
    }
    const writer = new FrameWriterImpl(merged, reason => {
      this.rejected += 1
      this.lastReject = reason
      if (this.settings.verbose) this.log.warn('帧写入被拒：%s', reason)
    })
    this.live.add(writer)
    return writer
  }

  stopReasonOf(kind: string | undefined): StopReason {
    return mapStopReason(kind)
  }

  validate(value: unknown): ValidateResult {
    return validateFrame(value)
  }

  /**
   * 序列化成一帧一行。
   *
   * 先校验再序列化：直接把未知对象 `JSON.stringify` 出去，
   * 对端 `decode` 会失败并且不知道为什么——错误就跑到了另一端。
   * @param frame 帧。
   */
  encode(frame: DialogueFrame): string {
    this.codecCalls += 1
    const checked = validateFrame(frame)
    if (!checked.ok) throw new TypeError(`不是合法帧：${checked.detail}`)
    return JSON.stringify(checked.frame)
  }

  /**
   * 从一行 NDJSON 解回帧。**不抛**：通道收到的脏数据不应该打断转发循环。
   * @param line 一行文本。
   */
  decode(line: string): DialogueFrame | undefined {
    this.codecCalls += 1
    if (typeof line !== 'string' || line.trim() === '') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // 解析失败是脏数据，不是故障：记一条并让转发循环继续。
      this.log.warn('协议解码失败：这一行不是合法 JSON（长度 %d）', line.length)
      return undefined
    }
    const checked = validateFrame(parsed)
    if (!checked.ok) {
      this.log.warn('协议解码失败：%s', checked.detail)
      return undefined
    }
    return checked.frame
  }

  stats(): ProtocolStats {
    // 先结算已关闭的 writer：把它们的帧数固化下来再从活动集移除，
    // 否则这个集合会随回合数无限增长（它没有别的清理时机）。
    for (const writer of this.live) {
      if (!writer.closed) continue
      this.settledFrames += writer.frames
      this.live.delete(writer)
    }
    let frames = this.settledFrames
    for (const writer of this.live) frames += writer.frames
    const base = {
      writers: this.writers,
      frames,
      rejected: this.rejected,
      codecCalls: this.codecCalls,
    }
    // `lastReject` 用条件展开而不是写 `lastReject: undefined`：
    // 后者在 `exactOptionalPropertyTypes` 下会报错，且让「没有」与「空串」混在一起。
    return this.lastReject === undefined ? base : { ...base, lastReject: this.lastReject }
  }
}
