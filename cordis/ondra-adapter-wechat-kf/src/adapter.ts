/**
 * 微信客服适配器：**拉取、判定、问人格、发回去**。不注册路由、不自己 listen。
 *
 * ## 一轮拉取长什么样
 *
 * ```
 * sync_msg(cursor) ──→ 一批消息
 *    ├─ 逐条过闸（来源 / 白名单 / 只认文本 / 去重）
 *    ├─ admit（O-055）→ 问人格（O-056）→ 切条 → send_msg
 *    └─ release（把排队的那几条也答掉，最多 8 条）
 * 整批处理完 → 推进游标 → persist
 * ```
 *
 * ## 三个刻意的取舍
 *
 * 1. **排队不等于丢弃。** 拉取式的消息**没有第二次机会**：游标一旦推进，
 *    平台不会再给你这一条。所以 router 说「排队」时，本适配器把消息留在手里
 *    自己答（先 `release` 让占位归零，再答），而不是把它交给一个没有消费者的队列。
 *    这与 O-060 的处理不同——那边排队意味着「等一下还能走客服消息」，这边没有那条后路。
 * 2. **先记指纹再答。** 宁可漏答一次（日志留 `send-failed`，用户会追问），
 *    也不要同一条答三遍（用户会认为她在刷屏）。两者的代价不对称。
 * 3. **人格调用必须有预算。** 一轮拉取卡住会一直占着 `polling`，
 *    后续每 5 秒都只得到 `busy`——看起来像「通道死了」，其实是「第一轮还没回来」。
 *    所以既 `abort`（主手段），也留一个 race 兜底（实现方忽略 signal 时不让链路僵死）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from './settings.js'
import {
  dedupeKey,
  emptyState,
  hasSeen,
  markSeen,
  markTouched,
  parseState,
  prune,
  withinWindow,
} from './cursor.js'
import type { CursorState } from './cursor.js'
import { checkSignature } from './wire.js'
import type {
  AdmissionLike,
  CredentialLoad,
  HealthLike,
  HandleReason,
  KfMessage,
  KfService,
  KfStats,
  KfStatus,
  KfTransport,
  KitLike,
  PollOutcome,
  PollReason,
  QueryLike,
  QueueItemLike,
  RouterLike,
  SendOutcome,
  SendReason,
  VerifyOutcome,
} from './types.js'
import { CHANNEL_ID } from './types.js'

/** 日志形状（只声明本插件用到的三档）。 */
export interface LogLike {
  /** 普通。 */
  info(format: string, ...args: readonly unknown[]): void
  /** 警告。 */
  warn(format: string, ...args: readonly unknown[]): void
  /** 错误。 */
  error(format: string, ...args: readonly unknown[]): void
}

/** 适配器依赖。全部是「取的时候才取」，缺一个也不会在构造期炸。 */
export interface AdapterDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志（命名空间 `channel.wechat-kf`）。 */
  readonly log: LogLike
  /** 时间源（毫秒）。 */
  readonly now: () => number
  /** 状态文件路径（空串 = 不落盘）。 */
  readonly stateFile: string
  /** 凭据读取结果。 */
  readonly credential: CredentialLoad
  /** 取传输（可能为 undefined：凭据没齐时不会建）。 */
  readonly transport: () => KfTransport | undefined
  /** 取路由服务（O-055）。 */
  readonly router: () => RouterLike | undefined
  /** 取公共段（O-056）。 */
  readonly kit: () => KitLike | undefined
  /** 取探针（O-057）。 */
  readonly health: () => HealthLike | undefined
}

/** 会话 id 前缀。 */
export const CONVERSATION_PREFIX = CHANNEL_ID + '/'

/** 一次释放最多再答几条（防「一释放就排回去」的死循环）。 */
export const MAX_DRAIN = 8

/** 状态文件权限。 */
const FILE_MODE = 0o600

/**
 * 拼会话 id。
 * @param openKfId 客服号。
 * @param externalUserId 外部联系人。
 */
export function conversationOf(openKfId: string, externalUserId: string): string {
  return CONVERSATION_PREFIX + openKfId + '/' + externalUserId
}

/**
 * 拆会话 id。
 * @param conversationId 会话 id。
 */
export function parseConversation(
  conversationId: string,
): { readonly openKfId: string; readonly externalUserId: string } | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const rest = conversationId.slice(CONVERSATION_PREFIX.length)
  const split = rest.indexOf('/')
  if (split <= 0) return null
  const openKfId = rest.slice(0, split)
  const externalUserId = rest.slice(split + 1)
  if (openKfId === '' || externalUserId === '') return null
  return { openKfId, externalUserId }
}

/**
 * 错误转一句中文（日志里不出现对象字面量）。
 * @param error 任意异常。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 让定时器不阻止进程退出。
 * @param handle 定时器句柄。
 */
function unrefTimer(handle: ReturnType<typeof setInterval>): void {
  const maybe = handle as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

/** 微信客服适配器。 */
export class KfAdapter implements KfService {
  private readonly deps: AdapterDeps
  private state: CursorState
  private stateDirty = false
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private stopped = true
  /** 轮次代际：`stop()` 时 +1，在飞的那一轮据此收尾；手动 `pollOnce()` 拿新代际照跑。 */
  private generation = 0
  private callbackMounted = false
  private lastPersistAt = 0

  private polls = 0
  private fetched = 0
  private answered = 0
  private sent = 0
  private readonly skipped: Record<string, number> = {}
  private lastError: string | null = null

  /** 每个会话的处理链：保证同一个人连发三条时按序回答。 */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(deps: AdapterDeps) {
    this.deps = deps
    this.state = this.loadState()
  }

  /** 现在能不能收。 */
  get available(): boolean {
    return this.deps.settings.enable && this.deps.credential.ok && this.deps.transport() !== undefined
  }

  /** 不能收的原因。 */
  get reason(): PollReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (!this.deps.credential.ok) return 'no-credentials'
    if (this.deps.transport() === undefined) return 'no-transport'
    return undefined
  }

  /** 开始周期性拉取。重复调用无副作用。 */
  start(): void {
    if (this.timer !== null) return
    if (!this.deps.settings.enable) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, this.deps.settings.pollMs)
    unrefTimer(this.timer)
    // 立刻拉一轮：等到 5 秒后才第一次拉，会让「刚打开」看起来像「没反应」。
    void this.pollOnce()
  }

  /** 停止周期性拉取（在飞的这一轮会跑完）。 */
  stop(): void {
    // 先立旗再停定时器：在飞的那一轮会在每个循环边界看见它并收尾，
    // 而不是发完剩下的消息才停（卸载后还在回人，是最难解释的一种 bug）。
    this.stopped = true
    this.generation += 1
    if (this.timer === null) {
      this.flush()
      return
    }
    clearInterval(this.timer)
    this.timer = null
    this.flush()
  }

  /** 回调路由挂上/撤掉了（只为面板能说清现状）。 */
  markCallbackMounted(mounted: boolean): void {
    this.callbackMounted = mounted
  }

  /**
   * 拉一轮。
   * @param at 时刻（毫秒，回放/测试时可显式传入）。
   */
  async pollOnce(at?: number): Promise<PollOutcome> {
    const settings = this.deps.settings
    const cursorBefore = this.state.cursor

    if (!settings.enable) return this.outcome(false, 'disabled', 0, 0, 0, cursorBefore)
    if (this.polling) {
      // 上一轮还没回来。**不回退成「再开一轮」**：两轮同时推进同一个游标必然丢消息。
      return this.outcome(false, 'busy', 0, 0, 0, cursorBefore)
    }
    const transport = this.deps.transport()
    if (transport === undefined) {
      const reason: PollReason = this.deps.credential.ok ? 'no-transport' : 'no-credentials'
      return this.outcome(false, reason, 0, 0, 0, cursorBefore)
    }

    this.polling = true
    this.polls += 1
    const now = at ?? this.deps.now()
    const generation = this.generation

    let rounds = 0
    let fetched = 0
    let answered = 0
    let cursor = cursorBefore

    try {
      while (rounds < settings.maxRounds) {
        rounds += 1
        const batch = await transport.sync({
          cursor,
          limit: settings.pageLimit,
          openKfId: this.openKfIdOf(),
        })

        if (!batch.ok) {
          this.lastError = '拉取失败（' + (batch.reason ?? 'http') + '）：' + (batch.errmsg ?? '')
          this.report('error', batch.reason ?? 'http')
          return this.outcome(false, this.pollReasonOf(batch.reason), rounds, fetched, answered, cursor, batch.errmsg)
        }

        fetched += batch.messages.length
        this.fetched += batch.messages.length
        if (batch.messages.length > 0) this.report('inbound')

        // 同一批里按会话串行、跨会话受 maxConcurrent 限制。
        answered += await this.runBatch(batch.messages, now)

        // **整批处理完才推进游标**：先推进再处理，崩一次就永远丢那几条。
        const next = batch.nextCursor.trim()
        if (next === '') break
        cursor = next
        this.state.cursor = next
        this.stateDirty = true

        if (!batch.hasMore) break
        // `has_more` 为真但一条都没给：继续拉只会原地打转。
        if (batch.messages.length === 0) break
        if (this.generation !== generation) break
      }

      if (this.stateDirty) this.flush()
      if (settings.verbose) {
        this.deps.log.info('拉取完成：%d 批，%d 条，答了 %d 条', rounds, fetched, answered)
      }
      return this.outcome(true, 'ok', rounds, fetched, answered, cursor)
    } catch (error) {
      this.lastError = '拉取过程抛错：' + messageOf(error)
      this.deps.log.warn('拉取过程抛错：%s', messageOf(error))
      return this.outcome(false, 'http', rounds, fetched, answered, cursor, messageOf(error))
    } finally {
      this.polling = false
    }
  }

  /**
   * 处理一批（按会话分组，跨会话限并发）。
   *
   * 分组不是优化，是**语义要求**：同一个人连发两条时，两条必须按序答，
   * 否则用户看到的是「她先回第二句、再回第一句」。
   * @param messages 这一批。
   * @param at 时刻。
   */
  private async runBatch(messages: readonly KfMessage[], at: number): Promise<number> {
    const limit = Math.max(1, this.deps.settings.maxConcurrent)
    let answered = 0
    let nextIndex = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex
        nextIndex += 1
        const message = messages[index]
        if (message === undefined) return
        const conversationId = conversationOf(message.openKfId, message.externalUserId)
        const reason = await this.enqueue(conversationId, () => this.handle(message, at))
        if (reason === 'answered') answered += 1
      }
    }

    const workers: Promise<void>[] = []
    for (let index = 0; index < Math.min(limit, messages.length); index += 1) workers.push(worker())
    await Promise.all(workers)
    return answered
  }

  /**
   * 把任务挂到某个会话的处理链尾部。
   * @param conversationId 会话 id。
   * @param task 任务。
   */
  private enqueue<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(conversationId) ?? Promise.resolve()
    // 前一条失败也要继续跑下一条：一个人的一次失败不该让他后面的消息全部卡死。
    const next = previous.then(task, task)
    this.chains.set(
      conversationId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /**
   * 处理一条消息。
   * @param message 消息。
   * @param at 时刻。
   */
  private async handle(message: KfMessage, at: number): Promise<HandleReason> {
    const settings = this.deps.settings

    // 1. 来源：别回答接待人员自己的回复（否则两个人格在同一侧对话）。
    if (!settings.respondOrigins.includes(message.origin)) return this.skip('origin')

    // 2. 客服号白名单（一个企业多个客服号时用）。
    if (settings.allowOpenKfIds.length > 0 && !settings.allowOpenKfIds.includes(message.openKfId)) {
      return this.skip('kf-id')
    }

    // 3. 人的名单：拉黑优先于白名单。
    const userId = message.externalUserId
    if (userId === '') return this.skip('no-user')
    if (settings.blockExternalUserIds.includes(userId)) return this.skip('blocked')
    if (settings.allowExternalUserIds.length > 0 && !settings.allowExternalUserIds.includes(userId)) {
      return this.skip('not-whitelisted')
    }

    // 4. 只认文本。图/语音/文件的协议本版没验证过，如实跳过而不是悄悄当成空消息。
    if (message.msgType !== 'text') return this.skip('type.' + message.msgType)
    const text = message.text.trim()
    if (text === '') return this.skip('empty')

    // 5. 去重：**先记再答**。
    const key = dedupeKey(message)
    if (hasSeen(this.state, key)) return this.skip('duplicate')
    markSeen(this.state, key, at)
    markTouched(this.state, userId, at)
    this.stateDirty = true

    const conversationId = conversationOf(message.openKfId, userId)

    // 6. 受理。排队保不住这条消息（拉取式没第二次机会），所以排队也照答。
    const router = this.deps.router()
    let reserved = false
    if (router !== undefined) {
      try {
        const admission: AdmissionLike = router.admit({
          channelId: CHANNEL_ID,
          conversationId,
          kind: 'private',
          trigger: 'message',
          text,
          messageId: message.messageId === '' ? undefined : message.messageId,
          senderId: userId,
          at,
        })
        if (admission.action === 'ignore' || admission.action === 'deny') {
          return this.skip('router.' + admission.reason)
        }
        // `queue` 在这里不等于「晚点再答」：拉取式的消息只有这一次机会。
        // 所以记一笔，然后**照答**——占位照旧记下来，答完 release 时把积压一并交出来。
        if (admission.action === 'queue') this.skip('router.queued')
        reserved = admission.reserved
      } catch (error) {
        // 路由挂了不影响「回一句话」这件事：降级而不是放弃。
        this.deps.log.warn('受理抛错，按不排队继续：%s', messageOf(error))
      }
    }

    try {
      const ok = await this.answerOnce(conversationId, message.openKfId, userId, text, at)
      return ok ? 'answered' : 'send-failed'
    } finally {
      this.releaseAndDrain(conversationId, reserved, at)
    }
  }

  /**
   * 问一次人格并分条发出去。
   * @param conversationId 会话 id。
   * @param openKfId 客服号。
   * @param externalUserId 收信人。
   * @param text 正文。
   * @param at 时刻。
   */
  private async answerOnce(
    conversationId: string,
    openKfId: string,
    externalUserId: string,
    text: string,
    at: number,
  ): Promise<boolean> {
    const kit = this.deps.kit()
    if (kit === undefined) {
      // 没有切条器就没有「把长回复发出去」的能力——如实记，不自己写第二套切法。
      this.lastError = '没有 ondra-channel-kit：长回复无法切条，这条不答'
      this.skip('no-kit')
      return false
    }

    const reply = await this.ask(kit, conversationId, text)
    if (reply === null) return false

    const pieces = this.chunkOf(reply)
    if (pieces.length === 0) return false

    let sent = 0
    for (const piece of pieces) {
      const transport = this.deps.transport()
      if (transport === undefined) break
      const result = await transport.send({ openKfId, externalUserId, text: piece })
      if (!result.ok) {
        this.lastError = '发送失败（' + (result.reason ?? 'http') + ' / ' + String(result.errcode ?? '') + '）'
        this.skip('send.' + (result.reason ?? 'http'))
        break
      }
      sent += 1
      this.sent += 1
      this.report('outbound')
    }

    if (sent === 0) return false
    this.answered += 1
    if (this.deps.settings.verbose) this.deps.log.info('已回 %d 段（%s）', sent, conversationId)
    // 回答之后把窗口刷新一次：同一条链上后面的消息还在窗口内。
    markTouched(this.state, externalUserId, at)
    this.stateDirty = true
    return true
  }

  /**
   * 问人格。**带预算**：卡住的一轮会让整条拉取链路停在 `busy`。
   * @param kit 公共段服务。
   * @param conversationId 会话 id。
   * @param text 正文。
   */
  private async ask(kit: KitLike, conversationId: string, text: string): Promise<string | null> {
    const budget = this.deps.settings.personaTimeoutMs
    const controller = new AbortController()

    // 兜底：实现方忽略 signal 时，race 让调用方拿回控制权（否则整条链僵死）。
    // 定时器在**主作用域**里起，句柄一定存在，结束时可以无条件清掉。
    const expireRef: { fire: () => void } = { fire: () => {} }
    const timeout = new Promise<null>(resolve => {
      expireRef.fire = () => {
        try {
          controller.abort()
        } catch {
          // 已经结束的请求再 abort 会抛，忽略。
        }
        resolve(null)
      }
    })
    const handle = setTimeout(() => {
      expireRef.fire()
    }, budget)
    const maybe = handle as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    try {
      const pending = kit
        .callPersona({
          conversationId,
          text,
          maxChars: this.deps.settings.chunkMax,
          timeoutMs: budget,
          signal: controller.signal,
        })
        .then(result => {
          if (!result.ok) {
            this.lastError = '人格调用失败：' + (result.reason ?? result.failure ?? 'unknown')
            this.skip('persona.' + (result.reason ?? 'failed'))
            return null
          }
          const answer = result.text.trim()
          if (answer === '') {
            this.skip('persona.empty')
            return null
          }
          return answer
        })
        .catch((error: unknown) => {
          this.lastError = '人格调用抛错：' + messageOf(error)
          this.skip('persona.error')
          return null
        })

      // 谁先到听谁的：正常结束清掉定时器，超时则丢弃那一轮的结果。
      return await Promise.race([pending, timeout])
    } finally {
      clearTimeout(handle)
    }
  }

  /**
   * 切条。**只认 O-056**：没有它就不发，绝不自己写第二套切法。
   * @param text 正文。
   */
  private chunkOf(text: string): readonly string[] {
    const max = this.deps.settings.chunkMax
    if (text.length <= max) return Object.freeze([text])
    const kit = this.deps.kit()
    if (kit === undefined) return Object.freeze([])
    try {
      return kit.chunk(text, max).pieces
    } catch (error) {
      this.lastError = '切条抛错：' + messageOf(error)
      return Object.freeze([])
    }
  }

  /**
   * 释放占位并把排队的那几条答掉。
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话。
   * @param at 时刻。
   */
  private releaseAndDrain(conversationId: string, reserved: boolean, at: number): void {
    const router = this.deps.router()
    if (router === undefined) return

    let released: readonly QueueItemLike[] = []
    if (reserved) {
      try {
        released = router.release(conversationId)
      } catch (error) {
        this.deps.log.warn('释放会话抛错：%s', messageOf(error))
        return
      }
    }
    if (released.length === 0) return

    const target = parseConversation(conversationId)
    if (target === null) return

    const queue = released.slice(0, MAX_DRAIN)
    if (released.length > MAX_DRAIN) {
      this.deps.log.warn('积压 %d 条，本轮只答前 %d 条（剩下的会被丢弃：拉取式没有第二次机会）', released.length, MAX_DRAIN)
    }

    // 已经 release 了，这条链是空的：直接串起来跑，不再回 admit（回了就会排回去）。
    void this.enqueue(conversationId, async () => {
      for (const item of queue) {
        if (!this.alive()) return
        const text = item.text.trim()
        if (text === '') continue
        await this.answerOnce(conversationId, target.openKfId, target.externalUserId, text, at)
      }
    })
  }

  /**
   * 主动发一条（窗口外直接拒）。
   * @param conversationId 会话 id。
   * @param text 正文。
   * @param at 时刻。
   */
  async reply(conversationId: string, text: string, at?: number): Promise<SendOutcome> {
    const target = parseConversation(conversationId)
    if (target === null) return this.sendOutcome(false, 'empty', 0, 0)
    if (!this.deps.settings.enable) return this.sendOutcome(false, 'disabled', 0, 0)
    if (!this.deps.credential.ok) return this.sendOutcome(false, 'no-credentials', 0, 0)

    const transport = this.deps.transport()
    if (transport === undefined) return this.sendOutcome(false, 'no-transport', 0, 0)

    const now = at ?? this.deps.now()
    if (!withinWindow(this.state.windows[target.externalUserId], now, this.deps.settings.windowHours)) {
      return this.sendOutcome(false, 'window-expired', 0, 0)
    }

    const trimmed = text.trim()
    if (trimmed === '') return this.sendOutcome(false, 'empty', 0, 0)
    const pieces = this.chunkOf(trimmed)
    if (pieces.length === 0) return this.sendOutcome(false, 'no-kit', 0, 0)

    let sent = 0
    for (const piece of pieces) {
      const result = await transport.send({
        openKfId: target.openKfId,
        externalUserId: target.externalUserId,
        text: piece,
      })
      if (!result.ok) {
        return this.sendOutcome(false, this.sendReasonOf(result.reason), pieces.length, sent, result.errcode, result.errmsg)
      }
      sent += 1
      this.sent += 1
      this.report('outbound')
    }
    return this.sendOutcome(true, 'ok', pieces.length, sent)
  }

  /**
   * 回调验签（只有挂了回调才会被调用）。
   * @param query 请求 query。
   */
  verify(query: QueryLike): VerifyOutcome {
    if (!this.callbackMounted) {
      return {
        ok: false,
        http: 404,
        body: 'callback-off',
        contentType: 'text/plain; charset=utf-8',
        reason: 'callback-off',
        detail: '本插件走拉取式，没有挂回调（callbackPath 为空）',
      }
    }
    const token = this.deps.credential.value?.token ?? ''
    return checkSignature(query, token, this.deps.now())
  }

  /** 现状。 */
  status(): KfStatus {
    return {
      polling: this.timer !== null,
      channelId: CHANNEL_ID,
      pollMs: this.deps.settings.pollMs,
      credential: { ok: this.deps.credential.ok, missing: this.deps.credential.missing },
      cursor: this.state.cursor,
      windowEntries: Object.keys(this.state.windows).length,
      allowlist: this.deps.settings.allowExternalUserIds.length,
      callbackMounted: this.callbackMounted,
      lastError: this.lastError,
    }
  }

  /** 计数。 */
  stats(): KfStats {
    return {
      polls: this.polls,
      fetched: this.fetched,
      answered: this.answered,
      sent: this.sent,
      skipped: Object.freeze({ ...this.skipped }),
    }
  }

  /**
   * 心跳：清过期记录 + 按节流落盘。
   * @param at 时刻。
   */
  tick(at?: number): void {
    const now = at ?? this.deps.now()
    prune(this.state, now, this.deps.settings.windowHours)
    this.stateDirty = true
    this.report('heartbeat')
    if (!this.deps.settings.persist) return
    if (now - this.lastPersistAt < this.deps.settings.persistMs) return
    this.flush()
  }

  /** 立刻落盘。 */
  flush(): void {
    if (!this.deps.settings.persist) return
    if (!this.stateDirty) return
    const file = this.deps.stateFile
    if (file.trim() === '') return

    const payload = {
      cursor: this.state.cursor,
      seen: this.state.seen,
      windows: this.state.windows,
      updatedAt: this.deps.now(),
    }
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = file + '.tmp'
      writeFileSync(temporary, JSON.stringify(payload) + '\n', { mode: FILE_MODE })
      renameSync(temporary, file)
      this.stateDirty = false
      this.lastPersistAt = this.deps.now()
    } catch (error) {
      this.lastError = '状态落盘失败：' + messageOf(error)
      this.deps.log.warn('状态落盘失败：%s', messageOf(error))
    }
  }

  /**
   * 读状态文件。
   *
   * 读不到不是错误（第一次装本来就没有）；坏了按空状态处理，
   * 但**必须打一行 warn**——从空游标重拉会重放一整段历史，
   * 不说清楚就变成「她今天把三个月前的话全回了一遍」。
   */
  private loadState(): CursorState {
    const file = this.deps.stateFile
    if (file.trim() === '') return emptyState()
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return emptyState()
    }
    try {
      return parseState(JSON.parse(text) as unknown)
    } catch {
      this.deps.log.warn('游标状态文件不是合法 JSON（按空状态处理，会从最早重拉）：%s', file)
      return emptyState()
    }
  }

  /**
   * 凭据里的客服号；没凭据时回空串（调用方本来就走不到这里）。
   */
  private openKfIdOf(): string {
    return this.deps.credential.value?.openKfId ?? ''
  }

  /**
   * 运行期还该不该继续。
   *
   * 两个条件都要：通道开着，且没被 `stop()` 停掉。只看 `enable` 会让
   * 「卸载之后还在回消息」变成可能——那是最难解释的一种 bug。
   */
  private alive(): boolean {
    return this.deps.settings.enable && !this.stopped
  }

  /**
   * 记一次跳过。
   * @param key 桶名。
   */
  private skip(key: string): HandleReason {
    this.skipped[key] = (this.skipped[key] ?? 0) + 1
    // 桶名与处置原因同源，返回一个稳定的处置码给调用方。
    if (key.startsWith('duplicate')) return 'duplicate'
    if (key === 'origin') return 'ignored-origin'
    if (key.startsWith('type.') || key === 'empty' || key === 'no-user') return 'unsupported'
    if (key === 'blocked') return 'blocked'
    if (key === 'not-whitelisted' || key === 'kf-id') return 'not-whitelisted'
    if (key.startsWith('router.')) return 'denied'
    return 'send-failed'
  }

  /**
   * 报一次探针。
   * @param kind 事件类型。
   * @param code 原因码。
   */
  private report(kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error', code?: string): void {
    const health = this.deps.health()
    if (health === undefined) return
    try {
      health.report({ channelId: CHANNEL_ID, kind, at: this.deps.now(), code })
    } catch {
      // 探针挂了不影响收发（§16.2-5：失败隔离）。
    }
  }

  /**
   * 拼一个拉取结果。
   * @param ok 是否跑完。
   * @param reason 原因。
   * @param rounds 批数。
   * @param fetched 拉到条数。
   * @param answered 答了几条。
   * @param cursor 游标。
   * @param detail 说明。
   */
  private outcome(
    ok: boolean,
    reason: PollReason,
    rounds: number,
    fetched: number,
    answered: number,
    cursor: string,
    detail?: string,
  ): PollOutcome {
    return { ok, reason, rounds, fetched, answered, cursor, detail }
  }

  /**
   * 把传输层失败归类成拉取原因。
   * @param reason 传输层原因。
   */
  private pollReasonOf(reason: string | undefined): PollReason {
    if (reason === 'timeout') return 'timeout'
    if (reason === 'token') return 'token'
    if (reason === 'no-fetch') return 'no-fetch'
    if (reason === 'bad-body') return 'bad-body'
    return 'http'
  }

  /**
   * 把传输层失败归类成发送原因。
   * @param reason 传输层原因。
   */
  private sendReasonOf(reason: string | undefined): SendReason {
    if (reason === 'timeout') return 'timeout'
    if (reason === 'token') return 'token'
    if (reason === 'no-fetch') return 'no-fetch'
    return 'http'
  }

  /**
   * 拼一个发送结果。
   * @param ok 是否全部发出。
   * @param reason 原因。
   * @param pieces 段数。
   * @param sent 成功段数。
   * @param errcode 平台码。
   * @param errmsg 平台说明。
   */
  private sendOutcome(
    ok: boolean,
    reason: SendReason,
    pieces: number,
    sent: number,
    errcode?: number,
    errmsg?: string,
  ): SendOutcome {
    return { ok, reason, pieces, sent, errcode, errmsg }
  }
}
