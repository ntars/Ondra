/**
 * Telegram 适配器：**长轮询、判来源、问人格、发回去**。不注册路由、不 listen 端口。
 *
 * ## 一轮长轮询长什么样
 *
 * ```
 * getUpdates(offset, timeout=50) ──→ 一批更新（或空数组，或超时）
 *    ├─ 逐条过闸（机器人自己 / 频道 / 非文本 / 白名单 / 兜底去重）
 *    ├─ admit（O-055）→ 问人格（O-056）→ 切条 → sendMessage
 *    └─ 整批分派完 → 推进 offset → 立刻落盘
 * ```
 *
 * ## 循环为什么是 `setTimeout` 链，不是 `setInterval`
 *
 * 一次长轮询会挂 50 秒。用 `setInterval` 的话，定时器到点就再发一次请求，
 * 而上一轮还在挂着——两轮同时推进同一个 `offset`，必然丢消息。
 * `setTimeout` 链保证「上一轮回来了才开始算下一轮」。
 *
 * ## 停下来的两条保证
 *
 * 1. **立旗 → 中止 → 清定时器**，顺序不能反：先清定时器再立旗，在飞的那一轮
 *    会在卸载之后再发几条消息出去（这是最难解释的一种 bug）。
 * 2. **在飞的那一轮用 `AbortController` 真的掐断**。长轮询要挂 50 秒，
 *    光靠「下一轮不再开始」会让卸载卡住几十秒。
 *
 * ## 为什么 offset 在「分派完」就推进，不等「答完」
 *
 * 回答是异步的（问人格要几秒）。等答完再推进，意味着一个卡住的模型调用
 * 会让整个通道停在那儿。所以语义定成：
 *
 * > **推进 offset = 「这一批已经接住了」**，不是「这一批已经答完了」。
 *
 * 代价是「接住之后崩了」会漏答那几条。与「答两遍」相比，漏答是**可见的**
 * （用户发现她没回，会再问一次），而重复回答是人格层面的破坏。
 * 这个不对称在 O-061 里也用过，两处口径一致。
 *
 * ## 为什么人格调用不复用 HTTP 超时
 *
 * `requestTimeoutOf()` 算出来是 65 秒（50 秒轮询 + 15 秒余量）——那是给长轮询用的。
 * 把它当模型超时，一次卡住的调用会把会话槽占满 65 秒，后面所有消息排队。
 * 所以这里**不传 `timeoutMs`**，让 `ondra-channel-kit` 用自己配置里的超时。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AdapterStats,
  AdapterStatus,
  AdmissionLike,
  CredentialLoad,
  HealthLike,
  InboundMessage,
  KitLike,
  MeResult,
  PollOutcome,
  PollReason,
  RouterLike,
  SendOutcome,
  SendReason,
  TelegramPush,
  TelegramService,
  UpdateView,
} from './types.js'
import { CHANNEL_ID, SPIN_GUARD_MS, UPDATE_LIMIT } from './types.js'
import type { Config as Settings } from './settings.js'
import { redactToken } from './credential.js'
import { advanceTo, markSeen, parseState, prune, seenRecently, toJson } from './cursor.js'
import type { CursorState } from './cursor.js'
import { dedupeKeyOf, fromBotOf, inboundOf } from './wire.js'

/** 日志最小面（cordis logger 的 printf 形态）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 适配器依赖。全部「取的时候才取」，缺一个也不会在构造期炸。 */
export interface AdapterDeps {
  /** 配置。 */
  readonly settings: Settings
  /** 日志（命名空间 `channel.telegram`）。 */
  readonly log: LogLike
  /** 时间源。 */
  now(): number
  /** 状态文件绝对路径（空串表示算不出来）。 */
  readonly stateFile: string
  /** 凭据文件绝对路径（只用于提示「权限已收紧」，**不读它**）。 */
  readonly credentialFile: string
  /** 网络实现（凭据不齐时为 `null`）。 */
  readonly push: TelegramPush | null
  /** 重读凭据（换文件后调 `reload()` 用）。 */
  readCredential(): CredentialLoad
  /** 路由服务（可能后到）。 */
  router(): RouterLike | undefined
  /** 公共段服务（可能后到）。 */
  kit(): KitLike | undefined
  /** 探针服务（可能后到）。 */
  health(): HealthLike | undefined
}

/** 会话前缀。由 `CHANNEL_ID` 拼出来，不手抄。 */
const CONVERSATION_PREFIX = CHANNEL_ID + ':'

/**
 * 会话 id（本项目口径）。群的 `chat.id` 是负数，符号要留着——去掉就会与私聊撞。
 * @param chatId Telegram 会话 id。
 */
export function conversationOf(chatId: number): string {
  return CONVERSATION_PREFIX + String(chatId)
}

/**
 * 从会话 id 反解 `chat.id`。
 * @param conversationId 本项目的会话 id。
 */
export function parseConversation(conversationId: string): number | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const text = conversationId.slice(CONVERSATION_PREFIX.length)
  if (!/^-?\d{1,20}$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) && value !== 0 ? value : null
}

/** Telegram 适配器。 */
export class TelegramAdapter implements TelegramService {
  private readonly deps: AdapterDeps
  private state: CursorState
  private credential: CredentialLoad
  private pushImpl: TelegramPush | null
  private botUsername: string | null = null

  private running = false
  /** 代际：`stop()` 时 +1，在飞的那一轮据此收尾。 */
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null
  private polling = false

  private stateDirty = false
  private lastFlush = 0
  private lastError: string | null = null
  private lastPollAt = 0

  private polls = 0
  private updates = 0
  private answered = 0
  private sent = 0
  private worstAnswerMs = 0
  /** 按原因分桶的忽略计数。用 `Map` 的理由同去重表：`Record` 下标 + `??` 是死代码。 */
  private readonly rejected = new Map<string, number>()
  private readonly inflight = new Set<string>()
  private readonly pending = new Map<string, InboundMessage[]>()

  constructor(deps: AdapterDeps) {
    this.deps = deps
    this.state = this.loadState()
    this.credential = deps.readCredential()
    this.pushImpl = deps.push
    if (this.credential.permissionTightened) {
      deps.log.warn('凭据文件权限过宽，已就地收紧到 0600：%s', deps.credentialFile)
    }
    if (!this.credential.ok) {
      deps.log.warn('凭据未就绪（%s）：%s', this.credential.missing ?? 'unknown', this.credential.detail)
    }
  }

  get available(): boolean {
    return this.deps.settings.enable && this.credential.ok && this.running
  }

  get reason(): PollReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (!this.credential.ok) return 'no-credentials'
    if (this.pushImpl === null) return 'no-transport'
    return undefined
  }

  /** 读状态文件。坏文件按空状态处理，但一定留一句日志。 */
  private loadState(): CursorState {
    const file = this.deps.stateFile
    if (!this.deps.settings.persist || file === '') {
      // 不落盘时从 offset=0 开始：Telegram 会把积压的更新全推一遍。
      // 这不是「安静地从头来」，所以必须说出来。
      this.deps.log.warn('状态不落盘：本次从 offset=0 开始，平台会把积压的更新重新推一遍')
      return { offset: 0, seen: new Map() }
    }
    try {
      if (!existsSync(file)) return { offset: 0, seen: new Map() }
      return parseState(JSON.parse(readFileSync(file, 'utf8')) as unknown)
    } catch {
      this.deps.log.warn('状态文件读不出来，已按空状态启动（平台会把积压的更新重推一遍）：%s', file)
      return { offset: 0, seen: new Map() }
    }
  }

  /**
   * 换网络实现（注入测试桩或企业内网关时用）。
   * @param push 实现。
   */
  setPush(push: TelegramPush | null): void {
    this.pushImpl = push
  }

  /** 重读凭据（改完文件后调用）。**会先停一次循环**，由调用方决定要不要再 `start()`。 */
  reload(): CredentialLoad {
    this.stop()
    this.credential = this.deps.readCredential()
    return this.credential
  }

  /** 开始长轮询。重复调用无副作用。 */
  start(): void {
    if (this.running) return
    if (!this.deps.settings.enable) return
    this.running = true
    this.generation += 1
    // 立刻拉一轮：等一个退避周期才第一次拉，会让「刚打开」看起来像「没反应」。
    this.schedule(0)
  }

  /** 停止长轮询（中止在飞的那一轮，不留定时器）。 */
  stop(): void {
    // 顺序：立旗 → 代际 +1 → 中止 → 清定时器。
    this.running = false
    this.generation += 1
    const controller = this.controller
    this.controller = null
    if (controller !== null) {
      try {
        controller.abort()
      } catch {
        // 已经结束的请求，abort 会静默。
      }
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
  }

  /**
   * 排下一轮。
   * @param delayMs 延迟（毫秒）。
   */
  private schedule(delayMs: number): void {
    if (!this.running) return
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.round()
    }, delayMs)
    const maybe = this.timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()
  }

  /** 一轮：拉一次，再决定下次什么时候拉。 */
  private async round(): Promise<void> {
    if (!this.running) return
    const generation = this.generation
    const outcome = await this.pollOnce()
    if (!this.running || generation !== this.generation) return

    if (!outcome.ok) {
      this.schedule(this.deps.settings.backoffMs)
      return
    }
    if (outcome.fetched === 0 && outcome.elapsedMs < SPIN_GUARD_MS) {
      // 服务端没遵守 timeout（或中间有代理提前收尾）：立刻再发就是空转。
      this.schedule(SPIN_GUARD_MS)
      return
    }
    this.schedule(0)
  }

  /**
   * 拉一轮。
   * @param at 时刻（毫秒，回放/测试时可显式传入）。
   */
  async pollOnce(at?: number): Promise<PollOutcome> {
    const settings = this.deps.settings
    const startedAt = at ?? this.deps.now()

    if (!settings.enable) return this.outcome(false, 'disabled', 0, 0, 0, '通道开关关着')
    if (this.polling) {
      // 上一轮还没回来。**不回退成「再开一轮」**：两轮同时推进同一个 offset 必然丢消息。
      return this.outcome(false, 'busy', 0, 0, this.state.offset, '上一轮还没回来')
    }
    const push = this.pushImpl
    if (push === null) {
      const reason: PollReason = this.credential.ok ? 'no-transport' : 'no-credentials'
      return this.outcome(false, reason, 0, 0, this.state.offset, '没有网络实现')
    }

    this.polling = true
    this.polls += 1
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller

    let fetched = 0
    let answered = 0

    try {
      const batch = await push.getUpdates({
        offset: this.state.offset,
        timeoutSec: settings.pollTimeoutSec,
        limit: UPDATE_LIMIT,
        signal: controller.signal,
      })

      if (!batch.ok) {
        // 卸载时的 abort 会被传输层报成 timeout，这里翻回 aborted（唯一一处判断）。
        const aborted = batch.reason === 'timeout' && !this.running
        const reason: PollReason = aborted ? 'aborted' : this.pollReasonOf(batch.reason)
        const detail = redactToken(batch.errmsg ?? '')
        if (!aborted) {
          this.lastError = '拉取失败（' + reason + '）：' + detail
          this.report('error', reason)
        }
        return this.outcome(false, reason, 0, 0, this.state.offset, detail, this.deps.now() - startedAt)
      }

      fetched = batch.updates.length
      this.updates += fetched
      if (fetched > 0) this.report('inbound')

      let maxId = 0
      for (const update of batch.updates) {
        if (update.updateId > maxId) maxId = update.updateId
        answered += this.handle(update, startedAt)
        // 卸载中就别再往下分派了：分派出去的每一轮都会真的发消息。
        if (!this.running || generation !== this.generation) break
      }

      // **整批分派完才推进**（见文件头：接住 ≠ 答完）。offset 只增不减。
      if (maxId > 0 && advanceTo(this.state, maxId)) {
        this.stateDirty = true
        this.flush()
      }
      this.lastPollAt = this.deps.now()
      if (settings.verbose) {
        this.deps.log.info('拉取完成：%d 条，答了 %d 条，offset=%d', fetched, answered, this.state.offset)
      }
      return this.outcome(true, 'ok', fetched, answered, this.state.offset, undefined, this.deps.now() - startedAt)
    } catch (error) {
      const detail = redactToken(errorOf(error))
      this.lastError = '拉取过程抛错：' + detail
      this.deps.log.warn('拉取过程抛错：%s', detail)
      return this.outcome(false, 'http', fetched, answered, this.state.offset, detail, this.deps.now() - startedAt)
    } finally {
      this.polling = false
      if (this.controller === controller) this.controller = null
    }
  }

  /**
   * 分派一条更新。返回是否真的交给了回答流程（0/1）。
   *
   * **同步**：它只做判定与分派，回答在后台跑。这让「整批」的推进时机确定。
   * @param update 一条更新。
   * @param at 收到时刻。
   */
  private handle(update: UpdateView, at: number): number {
    // 机器人自己（或别的 bot）发的：不回答。少了这一条，两个 bot 会互相刷。
    if (fromBotOf(update)) return 0

    const message = inboundOf(update, this.botUsername === null ? '' : this.botUsername)
    if (message === null) return 0

    if (message.text.trim() === '') {
      this.bucket('ignore.unsupported')
      return 0
    }

    const blocked = this.deps.settings.blockSenderIds
    if (blocked.includes(message.senderId)) {
      this.bucket('ignore.not-allowed')
      return 0
    }
    const allow = this.deps.settings.allowSenderIds
    if (allow.length > 0 && !allow.includes(message.senderId)) {
      this.bucket('ignore.not-allowed')
      return 0
    }

    const key = dedupeKeyOf(message)
    if (seenRecently(this.state, key, at)) {
      this.bucket('ignore.duplicate')
      return 0
    }
    // **先记再答**：宁可漏答一次（用户会追问），也不要同一条答两遍。
    markSeen(this.state, key, at)
    this.stateDirty = true

    const conversationId = conversationOf(message.chatId)
    if (this.inflight.has(conversationId) || this.inflight.size >= this.deps.settings.maxConcurrent) {
      this.enqueue(conversationId, message)
      this.bucket('ignore.busy')
      return 0
    }

    const admission = this.admit(message, conversationId, at)
    if (admission.action === 'ignore') {
      this.bucket('ignore.' + admission.reason)
      return 0
    }
    if (admission.action === 'deny') {
      this.bucket('ignore.' + admission.reason)
      return 0
    }
    if (admission.action === 'queue') {
      this.enqueue(conversationId, message)
      this.bucket('ignore.queued')
      return 0
    }

    this.inflight.add(conversationId)
    this.answered += 1
    void this.answer(message, conversationId, admission.reserved)
    return 1
  }

  /**
   * 问路由「该不该回」。
   * @param message 来信。
   * @param conversationId 会话 id。
   * @param at 时刻。
   */
  private admit(message: InboundMessage, conversationId: string, at: number): AdmissionLike {
    const router = this.deps.router()
    if (router === undefined) {
      return { action: 'reply', reason: 'no-router', reserved: false, queueDepth: 0, position: 0 }
    }
    try {
      return router.admit({
        channelId: CHANNEL_ID,
        conversationId,
        kind: message.kind,
        // 群里只有 @ 她或打命令才会收到（隐私模式下的平台行为），所以按提到的走。
        trigger: message.kind === 'group' ? (message.mentioned ? 'mention' : 'message') : 'message',
        text: message.text,
        messageId: String(message.messageId),
        senderId: message.senderId,
        at,
      })
    } catch (error) {
      this.note('路由判定抛错（按「直接回」处理）：%s', errorOf(error))
      return { action: 'reply', reason: 'router-error', reserved: false, queueDepth: 0, position: 0 }
    }
  }

  /**
   * 后台完成一轮并发出。
   * @param message 来信。
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话（必须 release）。
   */
  private async answer(message: InboundMessage, conversationId: string, reserved: boolean): Promise<void> {
    const startedAt = this.deps.now()
    try {
      const kit = this.deps.kit()
      if (kit === undefined) {
        this.note('没有 ondra-channel-kit：这条不回答（缺的是「问人格」的能力，不是通道本身）')
        return
      }
      // 刻意不传 `timeoutMs`：HTTP 超时（轮询 + 余量）不是模型超时，见文件头。
      const result = await kit.callPersona({
        conversationId,
        text: message.text,
        maxChars: this.deps.settings.chunkMax,
      })
      if (!result.ok) {
        this.note('本轮没有可用回复（%s），不发', result.failure ?? 'unknown')
        return
      }
      const pieces = result.pieces.length > 0 ? result.pieces : [result.text]
      await this.sendPieces(message.chatId, this.fitPieces(pieces))
    } catch (error) {
      this.note('回答时抛错：%s', errorOf(error))
    } finally {
      this.observeAnswer(startedAt)
      this.releaseAndDrain(conversationId, reserved)
    }
  }

  /**
   * 释放会话，再把排队中能起的回合起起来。
   *
   * ## 路由交出的正文为什么**不**发出去
   *
   * `router.release()` 交出的 `QueueItem.text` 是**用户说的那句话**，不是她的回答。
   * 发出去等于把用户的话原样复读一遍：用户看得见，而日志每行都写成功。
   *
   * 本地 `pending` 里存着同一批消息的完整来信，由 `pump()` 按正常路径（问人格 → 切条 → 发）
   * 回答。所以这里只把返回值当「占位已归还」的信号。
   *
   * （已知：O-060 / O-063 / O-064 三个已 done 的包直接把 `item.text` 发了出去，
   *   见台账「契约冲突」登记。本轮不改别人的包，只保证本包不复读。）
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话。
   */
  private releaseAndDrain(conversationId: string, reserved: boolean): void {
    const router = this.deps.router()
    if (router !== undefined && reserved) {
      try {
        const released = router.release(conversationId)
        if (released.length > 0 && this.deps.settings.verbose) {
          this.deps.log.info('路由归还了 %d 条积压，按本地队列继续（不原样复读）', released.length)
        }
      } catch (error) {
        this.note('释放会话抛错：%s', errorOf(error))
      }
    }

    // 只补自己这条队列是不够的：被全局并发挤掉的往往是另一个会话。
    this.pump()
  }

  /**
   * 在并发额度内尽量把排队的回合起起来。
   */
  private pump(): void {
    const limit = this.deps.settings.maxConcurrent
    for (const [conversationId, queue] of this.pending) {
      if (this.inflight.size >= limit) return
      if (this.inflight.has(conversationId)) continue
      const next = queue.shift()
      if (queue.length === 0) this.pending.delete(conversationId)
      if (next === undefined) continue
      this.inflight.add(conversationId)
      this.answered += 1
      void this.answer(next, conversationId, false)
    }
  }

  /**
   * 入队。
   * @param conversationId 会话 id。
   * @param message 来信。
   */
  private enqueue(conversationId: string, message: InboundMessage): void {
    const queue = this.pending.get(conversationId) ?? []
    queue.push(message)
    this.pending.set(conversationId, queue)
  }

  /**
   * 发若干段。**空串一律跳过**：一个空串会变成一条空气泡，用户看得见、日志全绿。
   * @param chatId 会话 id。
   * @param pieces 段。
   */
  private async sendPieces(chatId: number, pieces: readonly string[]): Promise<void> {
    if (pieces.length === 0) return
    const push = this.pushImpl
    if (push === null) {
      this.note('没有网络实现（凭据或 fetch 缺失），这几段发不出去：%d 段', pieces.length)
      return
    }

    let done = 0
    for (const piece of pieces) {
      const result = await push.sendMessage({ chatId, text: piece })
      if (!result.ok) {
        this.note(
          '消息发送失败（%s / %s）：本轮已发 %d/%d 段',
          result.reason ?? 'http',
          String(result.errcode ?? ''),
          done,
          pieces.length,
        )
        return
      }
      done += 1
      this.sent += 1
      this.report('outbound')
      if (this.deps.settings.verbose) this.deps.log.info('消息已发一段（%d/%d）', done, pieces.length)
    }
  }

  /**
   * 让每一段都不超上限，并丢掉空段。
   * @param pieces 上游给的段。
   */
  private fitPieces(pieces: readonly string[]): readonly string[] {
    const max = this.deps.settings.chunkMax
    const out: string[] = []
    for (const piece of pieces) {
      const text = piece.trim()
      if (text === '') continue
      if (text.length <= max) {
        out.push(text)
        continue
      }
      const kit = this.deps.kit()
      if (kit === undefined) {
        this.note('有一段超过 %d 字且没有 ondra-channel-kit：不自己写第二套切法，这一段不发', max)
        continue
      }
      try {
        for (const chunk of kit.chunk(text, max).pieces) {
          const trimmed = chunk.trim()
          if (trimmed !== '') out.push(trimmed)
        }
      } catch (error) {
        this.note('切条抛错，这一段不发：%s', errorOf(error))
      }
    }
    return out
  }

  /**
   * 主动发一条（Telegram 没有窗口限制，随时可发）。
   * @param conversationId 会话 id。
   * @param text 正文。
   */
  async reply(conversationId: string, text: string): Promise<SendOutcome> {
    const chatId = parseConversation(conversationId)
    if (chatId === null) return sendOutcome(false, 'empty', 0, 0)
    if (!this.deps.settings.enable) return sendOutcome(false, 'disabled', 0, 0)
    if (!this.credential.ok) return sendOutcome(false, 'no-credentials', 0, 0)

    const trimmed = text.trim()
    if (trimmed === '') return sendOutcome(false, 'empty', 0, 0)

    const ready = this.fitPieces([trimmed])
    if (ready.length === 0) return sendOutcome(false, 'no-kit', 0, 0)

    const push = this.pushImpl
    if (push === null) return sendOutcome(false, 'no-transport', 0, 0)

    let done = 0
    for (const piece of ready) {
      const result = await push.sendMessage({ chatId, text: piece })
      if (!result.ok) {
        return sendOutcome(false, result.reason ?? 'http', ready.length, done, result.errcode, result.errmsg)
      }
      done += 1
      this.sent += 1
      this.report('outbound')
    }
    return sendOutcome(true, 'ok', ready.length, done)
  }

  /** 确认 token。**只读**：不改 offset、不改 `botUsername` 以外的任何状态。 */
  async probe(): Promise<MeResult> {
    const push = this.pushImpl
    if (push === null) {
      const reason: SendReason = this.credential.ok ? 'no-transport' : 'no-credentials'
      return { ok: false, reason, errmsg: '没有网络实现' }
    }
    const result = await push.getMe()
    if (result.ok) {
      this.botUsername = result.username === undefined || result.username === '' ? null : result.username
      this.report('connected')
    } else {
      this.lastError = '确认 token 失败（' + (result.reason ?? 'http') + '）：' + (result.errmsg ?? '')
      this.report('error', result.reason ?? 'http')
    }
    return result
  }

  /** 心跳：清过期兜底记录 + 按节流落盘 + 报一次心跳。 */
  tick(at?: number): void {
    const now = at ?? this.deps.now()
    prune(this.state, now)
    this.report('heartbeat')
    if (!this.deps.settings.persist) return
    if (now - this.lastFlush < this.deps.settings.persistMs) return
    this.flush()
  }

  /** 落盘（只在脏的时候写）。offset 有变化时由 `pollOnce` 立刻调一次。 */
  flush(): void {
    this.lastFlush = this.deps.now()
    if (!this.deps.settings.persist || !this.stateDirty) return
    const file = this.deps.stateFile
    if (file === '') {
      this.deps.log.warn('算不出状态文件路径，offset 只在内存里（重启会从 0 重拉并重推一遍积压）')
      return
    }
    try {
      writeTextAtomic(file, toJson(this.state))
      this.stateDirty = false
    } catch (error) {
      this.deps.log.warn('状态落盘失败（下次再试）：%s', errorOf(error))
    }
  }

  /** 通道现状。 */
  status(): AdapterStatus {
    let queued = 0
    for (const queue of this.pending.values()) queued += queue.length
    return {
      running: this.running,
      channelId: CHANNEL_ID,
      credential: this.credential.ok ? { ok: true } : { ok: false, missing: this.credential.missing ?? 'shape' },
      botUsername: this.botUsername,
      offset: this.state.offset,
      allowlist: this.deps.settings.allowSenderIds.length,
      inflight: this.inflight.size,
      queued,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
    }
  }

  /** 计数。 */
  stats(): AdapterStats {
    return {
      polls: this.polls,
      updates: this.updates,
      answered: this.answered,
      sent: this.sent,
      rejected: Object.fromEntries(this.rejected),
      worstAnswerMs: this.worstAnswerMs,
    }
  }

  /**
   * 记一次「从收到到回答完成」的耗时。
   * @param startedAt 开始时刻。
   */
  private observeAnswer(startedAt: number): void {
    const spent = this.deps.now() - startedAt
    if (spent < 0) return
    if (spent > this.worstAnswerMs) this.worstAnswerMs = spent
  }

  /**
   * 拼一轮的结果。
   * @param ok 是否成功。
   * @param reason 原因。
   * @param fetched 拿到几条。
   * @param answered 答了几条。
   * @param offset 推进后的 offset。
   * @param detail 说明（**已脱敏**）。
   * @param elapsedMs 耗时。
   */
  private outcome(
    ok: boolean,
    reason: PollReason,
    fetched: number,
    answered: number,
    offset: number,
    detail: string | undefined,
    elapsedMs = 0,
  ): PollOutcome {
    const base: PollOutcome = { ok, reason, fetched, answered, offset, elapsedMs }
    return detail === undefined ? base : { ...base, detail }
  }

  /**
   * 把传输层的原因翻成拉取层的原因。
   * @param reason 传输层原因。
   */
  private pollReasonOf(reason: SendReason | undefined): PollReason {
    switch (reason) {
      case 'unauthorized':
        return 'unauthorized'
      case 'conflict':
        return 'conflict'
      case 'timeout':
        return 'timeout'
      case 'forbidden':
        // 403 在拉取语境里只有一种解释：这个 bot 被踢了/被拉黑了。
        return 'unauthorized'
      default:
        return 'http'
    }
  }

  /**
   * 记一个忽略桶。
   * @param key 桶名。
   */
  private bucket(key: string): void {
    this.rejected.set(key, (this.rejected.get(key) ?? 0) + 1)
  }

  /**
   * 向探针上报。探针缺席时静默。
   * @param kind 事件类型。
   * @param code 原因码（只在出错时有意义）。
   */
  private report(kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error', code?: string): void {
    const health = this.deps.health()
    if (health === undefined) return
    try {
      const event: {
        readonly channelId: string
        readonly kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error'
        readonly at: number
        readonly code?: string
      } = { channelId: CHANNEL_ID, kind, at: this.deps.now() }
      health.report(code === undefined ? event : { ...event, code })
    } catch {
      // 探针自己出错与通道无关。
    }
  }

  /** 记一条中文日志（不含正文与 token）。 */
  private note(text: string, ...args: unknown[]): void {
    this.lastError = text
    this.deps.log.warn(text, ...args)
    this.report('error')
  }
}

/**
 * 拼一个发送结果。
 * @param ok 是否成功。
 * @param reason 原因。
 * @param pieces 段数。
 * @param sent 已发段数。
 * @param errcode 平台错误码。
 * @param errmsg 平台错误说明。
 */
function sendOutcome(
  ok: boolean,
  reason: SendReason,
  pieces: number,
  sent: number,
  errcode?: number,
  errmsg?: string,
): SendOutcome {
  const base = { ok, reason, pieces, sent }
  if (errcode === undefined) return base
  return { ...base, errcode, errmsg }
}

/**
 * 取错误文本（**已脱敏**）。
 *
 * 全包只有这一处把异常折成字符串：`fetch` 在 URL 非法时抛的错会带整条 URL，
 * 而那条 URL 里就是 token。两处各写一份「取错误消息」迟早有一处忘了脱敏。
 * @param value 任意异常。
 */
export function errorOf(value: unknown): string {
  return redactToken(value instanceof Error ? value.message : String(value))
}

/**
 * 原子写（临时文件 + rename），权限 0600。
 * @param file 目标路径。
 * @param text 内容。
 */
function writeTextAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.tmp'
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, file)
  chmodSync(file, 0o600)
}
