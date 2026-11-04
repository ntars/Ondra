/**
 * 服务实现：把纯判定（`decide.ts`）与四个状态容器接起来。
 *
 * 四个容器，各有各的语义，**没有一个是多余的**：
 *
 * | 容器 | 存什么 | 什么时候清 |
 * |---|---|---|
 * | `busy` | 哪些会话正被她处理 | `release()` / `forget()` |
 * | `queue` | 正忙时积压的消息 | `release()` 一次性交出 / `forget()` |
 * | `seen` | 每个会话最后一条消息 id 与时刻（1 秒去重） | 容量淘汰 / `forget()` |
 * | `channels` | 能力表 | 适配器的 disposer |
 *
 * ## 刻意不装定时器
 *
 * 队列不需要「多久之后自动清空」：它只在 `release()` / `forget()` 时变。
 * 装一个定时器就多一条「插件卸载后还在跑」的路径，而 §3.3-4 要求
 * 卸载即撤销——不装定时器是最省事的满足方式。
 *
 * ## 刻意不回调
 *
 * `release()` 只是**交出**积压，不替调用方处理。若在这里回调适配器，
 * 就会出现「适配器在自己的 release 里被重新叫起来」的重入；
 * 重入加队列，是那种「平时没事、忙起来就乱序」的 bug。
 */

import { ChannelRegistry } from './channels.js'
import { decideRoute } from './decide.js'
import { ConversationQueue, seedOf } from './queue.js'
import type { Config } from './settings.js'
import type {
  Admission,
  ChannelSpec,
  ChannelView,
  LogLike,
  QueueItem,
  RegisterResult,
  RouteAction,
  RouteInput,
  RouteReason,
  RouterService,
  RouterStats,
  RouterUnavailableReason,
  WakeDelivery,
} from './types.js'
import { WAKE_BODY, WAKE_SECTION_NAME } from './types.js'

/** 构造依赖。 */
export interface RouterDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 取当前时刻（毫秒）。 */
  readonly now: () => number
  /** 取一个 [0,1) 的随机数。省略用 `Math.random`（注入是为了让概率可对拍）。 */
  readonly rng?: () => number
}

/** 去重表的一行。 */
interface SeenEntry {
  readonly messageId: string
  readonly at: number
}

/** 唤醒说明段的正文（手册 §5.4 的原话 + 一句身份澄清）。 */
const WAKE_SECTION_TEXT =
  '你收到的那条只写着 `...` 的消息，是你的潜意识在叫你——不是主人在说话，也不是主人在问你。' +
  '三个点本身不携带任何内容，要不要开口、开口说什么，由你自己决定。'

/** 服务实现。 */
export class Router implements RouterService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  private readonly rng: () => number

  private readonly channels = new ChannelRegistry()
  private readonly queue: ConversationQueue
  private readonly busy = new Set<string>()
  private readonly seen = new Map<string, SeenEntry>()

  private admitted = 0
  private woken = 0
  private replied = 0
  private ignored = 0
  private skipped = 0
  private denied = 0
  private queuedTotal = 0
  private released = 0
  private lastReason: RouterStats['lastReason']

  constructor(deps: RouterDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.now = deps.now
    this.rng = deps.rng ?? Math.random
    this.queue = new ConversationQueue(deps.settings.maxQueue, deps.settings.maxConversations)
  }

  /** 是否启用（只看配置开关）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): RouterUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /**
   * 造一份受理结果。
   *
   * 单独抽出来不是为了复用，是为了**让类型落在变量上**：直接
   * `return Object.freeze({ action: 'ignore', … })` 会让 `action`
   * 被推断成 `string`，与 `Admission.action` 的闭集对不上。
   * 写成显式标注的局部变量，闭集就由上下文定住了。
   */
  private admissionOf(
    action: RouteAction,
    reason: RouteReason,
    reserved: boolean,
    queueDepth: number,
    position: number,
    at: number,
  ): Admission {
    const admission: Admission = { action, reason, reserved, queueDepth, position, at }
    return Object.freeze(admission)
  }

  /** 受理一条入站消息。**永不抛出。** */
  admit(input: RouteInput): Admission {
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : this.now()
    const verdict = decideRoute(input, this.settings)
    const conversationId = input.conversationId

    // 不该处置的，直接记账返回。
    if (verdict.action === 'ignore' || verdict.action === 'deny') {
      this.admitted += 1
      if (verdict.action === 'deny') this.denied += 1
      else this.ignored += 1
      this.lastReason = verdict.reason
      this.trace(at, conversationId, verdict.action, verdict.reason)
      return this.admissionOf(
        verdict.action,
        verdict.reason,
        false,
        this.queue.depthOf(conversationId),
        0,
        at,
      )
    }

    // 1 秒去重（手册 §5.4 四重锁第一重）。只在平台给了消息 id 时才有意义——
    // 没有标识就无法区分「重复投递」与「用户真的连发两遍」。
    if (this.isDuplicate(input, at)) {
      this.admitted += 1
      this.ignored += 1
      this.lastReason = 'duplicate'
      this.trace(at, conversationId, 'ignore', 'duplicate')
      return this.admissionOf('ignore', 'duplicate', false, this.queue.depthOf(conversationId), 0, at)
    }

    // 记下这一条。**放在概率与占用之前**：同一条消息第二次投递要被认出来，
    // 否则「按概率没叫她」与「正忙排队」两条路径都会让重复投递溜过去。
    this.markSeen(input, at)

    // 概率唤醒（手册 §14.3 三口径的合一，见 `settings.ts` 文件头）。
    // **只作用于私聊的 `wake`**：群里被点名还掷骰子就是失礼。
    if (verdict.action === 'wake' && this.settings.wakeProbability < 1) {
      if (this.rng() >= this.settings.wakeProbability) {
        this.admitted += 1
        this.ignored += 1
        this.skipped += 1
        this.lastReason = 'wake-skipped'
        this.trace(at, conversationId, 'ignore', 'wake-skipped')
        return this.admissionOf(
          'ignore',
          'wake-skipped',
          false,
          this.queue.depthOf(conversationId),
          0,
          at,
        )
      }
    }

    // 正忙 → 排队。排队不是「处置」，所以不占位、也不需要 release。
    if (this.busy.has(conversationId)) {
      const outcome = this.queue.push(seedOf(input, at))
      this.admitted += 1

      if (!outcome.ok) {
        this.denied += 1
        this.lastReason = 'queue-full'
        this.trace(at, conversationId, 'deny', 'queue-full')
        return this.admissionOf('deny', 'queue-full', false, outcome.depth, 0, at)
      }

      this.queuedTotal += 1
      this.lastReason = 'busy-queued'
      this.trace(at, conversationId, 'queue', 'busy-queued')
      return this.admissionOf('queue', 'busy-queued', false, outcome.depth, outcome.position, at)
    }

    // 占位并交出去。**调用方必须 release。**
    this.busy.add(conversationId)
    this.admitted += 1
    if (verdict.action === 'wake') this.woken += 1
    else this.replied += 1
    this.lastReason = verdict.reason
    this.trace(at, conversationId, verdict.action, verdict.reason)

    return this.admissionOf(
      verdict.action,
      verdict.reason,
      true,
      this.queue.depthOf(conversationId),
      0,
      at,
    )
  }

  /** 释放占用并交出积压。 */
  release(conversationId: string): readonly QueueItem[] {
    if (this.busy.delete(conversationId)) this.released += 1
    const items = this.queue.take(conversationId)
    if (items.length > 0) {
      this.log.info(
        '会话 %s 的占用已释放，积压 %d 条一并交出（这些条目已离开队列，请按序处置）',
        conversationId,
        items.length,
      )
    }
    return items
  }

  /** 只读积压。 */
  pending(conversationId: string): readonly QueueItem[] {
    return this.queue.pending(conversationId)
  }

  /** 全部积压（按全局入队顺序）。 */
  queued(): readonly QueueItem[] {
    return this.queue.all()
  }

  /** 忘掉一个会话。 */
  forget(conversationId: string): number {
    this.busy.delete(conversationId)
    this.seen.delete(conversationId)
    const removed = this.queue.forget(conversationId)
    if (removed > 0) {
      this.log.warn('会话 %s 被忘掉，队列里 %d 条没被处置（通道关闭或会话销毁）', conversationId, removed)
    }
    return removed
  }

  /** 注册通道能力。 */
  registerChannel(spec: ChannelSpec): RegisterResult {
    const result = this.channels.register(spec, this.now())
    if (!result.ok) {
      this.log.warn(
        '通道 %s 的能力注册被拒（%s）：路由不会因此拒绝它的消息，只是查不到它能不能发图/发语音',
        typeof spec === 'object' && spec !== null ? spec.id : '（无名）',
        result.reason,
      )
      return result
    }
    this.log.info('通道能力已登记：%s（单条上限 %d 字）', spec.id, spec.caps.maxChars)
    return result
  }

  /** 查通道能力。 */
  capabilities(channelId: string): ChannelView | undefined {
    return this.channels.get(channelId)
  }

  /** 已注册通道 id。 */
  channelIds(): readonly string[] {
    return this.channels.ids()
  }

  /** 唤醒投递该长什么样。 */
  wakeDelivery(): WakeDelivery {
    return Object.freeze({
      body: WAKE_BODY,
      section: Object.freeze({
        name: WAKE_SECTION_NAME,
        order: 100,
        text: WAKE_SECTION_TEXT,
        chars: WAKE_SECTION_TEXT.length,
      }),
      why: '主动叫醒只在私聊；正文只有三个点，内容走说明段（手册 §5.4）',
    })
  }

  /** 统计快照。 */
  stats(): RouterStats {
    const snapshot: RouterStats = {
      available: this.settings.enable,
      channels: this.channels.size,
      busy: this.busy.size,
      queued: this.queue.size(),
      admitted: this.admitted,
      woken: this.woken,
      replied: this.replied,
      ignored: this.ignored,
      skipped: this.skipped,
      denied: this.denied,
      queuedTotal: this.queuedTotal,
      released: this.released,
      dropped: this.queue.refused + this.queue.discarded,
      lastReason: this.lastReason,
    }
    return Object.freeze(snapshot)
  }

  /** 卸载时清空（由 `ctx.effect` 的 disposer 调）。 */
  dispose(): void {
    this.queue.clear()
    this.busy.clear()
    this.seen.clear()
    this.channels.clear()
  }

  /**
   * 同一条消息是不是 1 秒内的重复投递。
   * @param input 入站消息。
   * @param at 判定时刻。
   */
  private isDuplicate(input: RouteInput, at: number): boolean {
    if (this.settings.dedupeMs <= 0) return false
    const messageId = input.messageId
    if (typeof messageId !== 'string' || messageId === '') return false

    const prev = this.seen.get(input.conversationId)
    if (prev === undefined || prev.messageId !== messageId) return false
    // 用绝对值：时钟回拨时 `at < prev.at`，仍应判为重复。
    return Math.abs(at - prev.at) <= this.settings.dedupeMs
  }

  /**
   * 记一条去重记录，并按 `maxConversations` 淘汰最早的。
   * @param input 入站消息。
   * @param at 判定时刻。
   */
  private markSeen(input: RouteInput, at: number): void {
    const messageId = input.messageId
    if (typeof messageId !== 'string' || messageId === '') return
    this.seen.set(input.conversationId, { messageId, at })
    while (this.seen.size > this.settings.maxConversations) {
      const oldest = this.seen.keys().next()
      if (oldest.done === true) break
      this.seen.delete(oldest.value)
    }
  }

  /**
   * 打一行受理日志。忽略类只进 debug，免得群里 200 条闲聊把日志刷满。
   * @param at 判定时刻。
   * @param conversationId 会话 id。
   * @param action 动作。
   * @param reason 原因码。
   */
  private trace(at: number, conversationId: string, action: string, reason: string): void {
    if (!this.settings.verbose) return
    if (action === 'ignore') {
      this.log.debug?.('受理 %s → %s（%s）', conversationId, action, reason)
      return
    }
    this.log.info('受理 %s @%d → %s（%s）', conversationId, at, action, reason)
  }
}
