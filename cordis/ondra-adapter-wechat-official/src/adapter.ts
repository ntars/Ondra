/**
 * 适配器主体：验签 → 解析 → 白名单 → 去重 → 路由 → **5 秒预算内给答复** → 超了就交棒。
 *
 * ## 一轮的最坏情况长什么样
 *
 * ```
 * t=0ms    收到 POST（微信开始计时）
 * t=0..50  验签 + 解析 + 去重（纯计算，不碰网络）
 * t=50     开始问人格
 * t=4400   预算到，还没回答 → 立刻写降级话术的 XML，HTTP 200 回给微信
 * t=4400+  那一轮继续跑；跑完走客服消息（48 小时窗口内有效）
 * ```
 *
 * 这条路径是**唯一**能同时满足「5 秒硬限」与「用户最终收到真话」的写法。
 * 只要少了一步，后果都很具体：不交棒 = 用户永远只看到「我在呢」；
 * 不先回降级 = 微信重试三次，用户看到三条一模一样的回答。
 *
 * ## 为什么同一个会话要排队
 *
 * 一个人连发两条时，两条 POST 会几乎同时到达。两条都去问人格，会得到两段**互不知情**的回答，
 * 而人看到的是「她同时在说两件不相干的事」。所以：第一条走正常路径，
 * 第二条立刻回降级话术，然后**排在第一条后面**处理——顺序与因果都保住了。
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
  IngestOutcome,
  IngestReason,
  KitLike,
  QueryLike,
  RouterLike,
  SendOutcome,
  SendReason,
  VerifyOutcome,
  WechatOfficialService,
  WechatPush,
} from './types.js'
import { CHANNEL_ID } from './types.js'
import type { Config as Settings } from './settings.js'
import { readCredentials } from './credential.js'
import { buildTextReply, parseInbound, verifyRequest } from './wire.js'
import {
  dedupeKey,
  emptyWindowState,
  markSeen,
  parseWindowState,
  prune,
  withinBudget,
  withinWindow,
} from './window.js'
import type { WindowState } from './window.js'

/** 日志最小面（cordis logger 的 printf 形态）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 适配器依赖。 */
export interface AdapterDeps {
  /** 配置。 */
  readonly settings: Settings
  /** 日志。 */
  readonly log: LogLike
  /** 时间源。 */
  now(): number
  /** 两个文件的绝对路径（空串表示算不出来）。 */
  readonly files: { readonly credential: string; readonly state: string }
  /** 推送实现（凭据不齐时为 `null`）。 */
  push: WechatPush | null
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
 * 会话 id。公众号只有一对一，所以就是 `wechat-official:<openid>`。
 * @param openId 关注者 openid。
 */
export function conversationOf(openId: string): string {
  return CONVERSATION_PREFIX + openId
}

/**
 * 从会话 id 反解 openid。**大小写原样保留**（openid 大小写敏感）。
 * @param conversationId 会话 id。
 */
export function parseConversation(conversationId: string): string | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const openId = conversationId.slice(CONVERSATION_PREFIX.length)
  return openId === '' ? null : openId
}

/** 微信公众号适配器。 */
export class WechatAdapter implements WechatOfficialService {
  private readonly deps: AdapterDeps
  private state: WindowState
  private credential: CredentialLoad
  private pushImpl: WechatPush | null
  private registered = false
  private stateDirty = false
  private lastFlush = 0
  private lastError: string | null = null
  private inbound = 0
  private replied = 0
  private deferred = 0
  private pushed = 0
  private worstLatency = 0
  private readonly rejected: Record<string, number> = {}
  private readonly inflight = new Set<string>()
  private readonly pending = new Map<string, InboundMessage[]>()

  constructor(deps: AdapterDeps) {
    this.deps = deps
    this.state = this.loadState()
    this.credential = readCredentials(deps.files.credential)
    this.pushImpl = deps.push
    if (this.credential.permissionTightened) {
      deps.log.warn('凭据文件权限过宽，已就地收紧到 0600：%s', deps.files.credential)
    }
    if (!this.credential.ok) {
      deps.log.warn('凭据未就绪（%s）：%s', this.credential.missing ?? 'unknown', this.credential.detail)
    }
  }

  get available(): boolean {
    return this.deps.settings.enable && this.credential.ok && this.registered
  }

  get reason(): VerifyOutcome['reason'] {
    if (!this.deps.settings.enable) return 'disabled'
    if (!this.credential.ok) return 'no-credentials'
    return undefined
  }

  /** 读状态文件。坏文件按空状态处理，但一定留一句日志。 */
  private loadState(): WindowState {
    const file = this.deps.files.state
    if (!this.deps.settings.persist || file === '') return emptyWindowState()
    try {
      if (!existsSync(file)) return emptyWindowState()
      return parseWindowState(JSON.parse(readFileSync(file, 'utf8')) as unknown)
    } catch {
      this.deps.log.warn('窗口状态文件读不出来，已按空状态启动（重启后「刚说过话的人」会被当成窗口外）：%s', file)
      return emptyWindowState()
    }
  }

  /**
   * 标记路由已挂上（由入口在 `register()` 成功后调用）。
   * @param value 是否已挂。
   */
  markRegistered(value: boolean): void {
    this.registered = value
  }

  /**
   * 换推送实现（注入测试桩或企业网关时用）。
   * @param push 实现。
   */
  setPush(push: WechatPush | null): void {
    this.pushImpl = push
  }

  /** 重读凭据（改完文件后调用，不必重启）。 */
  reload(): CredentialLoad {
    this.credential = readCredentials(this.deps.files.credential)
    this.pushImpl?.invalidate()
    return this.credential
  }

  /** GET 验证。 */
  verify(query: QueryLike): VerifyOutcome {
    const token = this.credential.ok && this.credential.value !== undefined ? this.credential.value.token : ''
    const outcome = verifyRequest(token, this.deps.settings.enable, query, this.deps.now())
    if (!outcome.ok) this.note('验证未通过（%s）：%s', outcome.reason ?? 'unknown', outcome.detail ?? '')
    return outcome
  }

  /**
   * 处理一条 POST。
   * @param rawBody 原始报文。
   * @param query 请求 query（签名在 query 里）。
   * @param at 收到时刻（毫秒，缺省取 now）。
   */
  async ingest(rawBody: string, query: QueryLike, at?: number): Promise<IngestOutcome> {
    const startedAt = at ?? this.deps.now()
    this.inbound += 1

    if (!this.deps.settings.enable) return this.silent('disabled')
    if (!this.credential.ok || this.credential.value === undefined) return this.silent('bad-body', '凭据未就绪，无法验签')

    const token = this.credential.value.token
    const checked = verifyRequest(token, true, query, startedAt)
    if (!checked.ok) return this.reject('bad-signature', checked.detail)

    const message = parseInbound(rawBody, startedAt)
    if (message === null) return this.silent('bad-body', '报文解析不出来（或带 DTD）')
    const conversationId = conversationOf(message.openId)

    this.report('inbound')

    // 屏蔽优先于允许：拉黑的人在白名单里也不回。
    if (this.deps.settings.blockOpenIds.includes(message.openId)) {
      return this.silent('ignored', 'blockOpenIds 命中')
    }
    const allow = this.deps.settings.allowOpenIds
    if (allow.length > 0 && !allow.includes(message.openId)) {
      return this.silent('not-whitelisted', 'allowOpenIds 非空且不含此人')
    }

    if (message.msgType !== 'text') {
      return this.silent('unsupported', '只处理文本：' + message.msgType)
    }

    const key = dedupeKey(message.openId, message.msgId, message.createdAt, message.text, message.event)
    const seenAt = this.state.seen[key]
    if (seenAt !== undefined && startedAt - seenAt < this.deps.settings.dedupeWindowMs) {
      // 微信没在 5 秒内收到响应会重试三次；认出来就回空 body（200），它才会停。
      return this.silent('duplicate', '同一 MsgId 已处理过')
    }
    markSeen(this.state, key, startedAt)
    this.state.lastSeen[message.openId] = startedAt
    this.stateDirty = true

    // 同一会话已有回合在跑：先回降级话术，再到队尾等着（见文件头「为什么同一个会话要排队」）。
    if (this.inflight.has(conversationId)) {
      const queue = this.pending.get(conversationId) ?? []
      queue.push(message)
      this.pending.set(conversationId, queue)
      this.deferred += 1
      return this.degrade(message, 'deferred', '同一会话已有回合在跑，本条排到队尾')
    }

    // 全局并发也有限：一次涌进一百条时不该开一百个模型请求。
    if (this.inflight.size >= this.deps.settings.maxConcurrent) {
      const queue = this.pending.get(conversationId) ?? []
      queue.push(message)
      this.pending.set(conversationId, queue)
      this.deferred += 1
      return this.degrade(message, 'deferred', '并发已满（maxConcurrent=' + this.deps.settings.maxConcurrent + '）')
    }

    const admission = this.admit(message, conversationId, startedAt)
    if (admission.action === 'ignore') return this.silent('ignored', admission.reason)
    if (admission.action === 'deny') return this.silent('not-whitelisted', admission.reason)
    if (admission.action === 'queue') {
      // 路由说「排着」——公众号没有轮询循环，得本插件自己排，否则这条就丢了。
      const queue = this.pending.get(conversationId) ?? []
      queue.push(message)
      this.pending.set(conversationId, queue)
      this.deferred += 1
      return this.degrade(message, 'deferred', '路由排队：' + admission.reason)
    }

    return this.respond(message, conversationId, startedAt, admission.reserved)
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
        // 公众号只有一对一：关注者私聊公众号。
        kind: 'private',
        trigger: 'message',
        text: message.text,
        messageId: message.msgId,
        senderId: message.openId,
        at,
      })
    } catch (error) {
      this.note('路由判定抛错（按「直接回」处理）：%s', messageOf(error))
      return { action: 'reply', reason: 'router-error', reserved: false, queueDepth: 0, position: 0 }
    }
  }

  /**
   * 在预算内给答复；超时就交棒。
   * @param message 来信。
   * @param conversationId 会话 id。
   * @param startedAt 收到时刻。
   * @param reserved 是否占用了会话。
   */
  private async respond(
    message: InboundMessage,
    conversationId: string,
    startedAt: number,
    reserved: boolean,
  ): Promise<IngestOutcome> {
    const kit = this.deps.kit()
    if (kit === undefined) {
      // 没有公共段就问不了人格；回降级话术比沉默好：至少她知道有人在。
      return this.degrade(message, 'no-kit', '没有 ondra-channel-kit')
    }

    this.inflight.add(conversationId)
    const budget = this.deps.settings.replyBudgetMs
    let work: Promise<Awaited<ReturnType<KitLike['callPersona']>>>
    try {
      work = kit.callPersona({
        conversationId,
        text: message.text,
        maxChars: this.deps.settings.chunkMax,
        timeoutMs: budget,
      })
    } catch (error) {
      this.inflight.delete(conversationId)
      this.note('问人格时同步抛错：%s', messageOf(error))
      return this.degrade(message, 'deferred', '调用人格抛错')
    }

    const raced = await withinBudget(work, budget)
    if (!raced.settled) {
      // 交棒：先把 5 秒的账平掉，这一轮继续跑，跑完走客服消息。
      this.deferred += 1
      void this.finishLater(message, conversationId, work, startedAt, reserved)
      return this.degrade(message, 'deferred', '预算 ' + budget + 'ms 内没答完')
    }

    this.inflight.delete(conversationId)
    const result = raced.value
    if (!result.ok) {
      // 半句话不发：宁可回降级话术，也不发一段没头没尾的话。
      this.releaseAndDrain(conversationId, reserved)
      return this.degrade(message, 'partial', '本轮没有可用回复（' + (result.failure ?? 'unknown') + '）')
    }

    const pieces = result.pieces.length > 0 ? result.pieces : [result.text]
    const first = pieces[0] ?? ''
    if (first.trim() === '') {
      this.releaseAndDrain(conversationId, reserved)
      return this.degrade(message, 'partial', '回复为空')
    }

    // 第一段走被动回复（在 5 秒内），其余段落走客服消息。
    const outcome = this.replyOutcome(message, first, startedAt)
    if (pieces.length > 1) {
      this.deferred += 1
      void this.pushRest(message.openId, pieces.slice(1))
    }
    this.releaseAndDrain(conversationId, reserved)
    return outcome
  }

  /**
   * 预算超时之后的那一段：等这一轮跑完，走客服消息发出去。
   * @param message 来信。
   * @param conversationId 会话 id。
   * @param work 还在跑的那一轮。
   * @param startedAt 收到时刻。
   */
  private async finishLater(
    message: InboundMessage,
    conversationId: string,
    work: Promise<Awaited<ReturnType<KitLike['callPersona']>>>,
    startedAt: number,
    reserved: boolean,
  ): Promise<void> {
    try {
      const result = await work
      if (result.ok) {
        const pieces = result.pieces.length > 0 ? result.pieces : [result.text]
        await this.pushRest(message.openId, pieces)
      } else {
        this.deps.log.info('交棒后仍没有可用回复（%s），不发', result.failure ?? 'unknown')
      }
    } catch (error) {
      this.note('交棒后的回合抛错：%s', messageOf(error))
    } finally {
      this.inflight.delete(conversationId)
      this.observeLatency(startedAt)
      this.releaseAndDrain(conversationId, reserved)
    }
  }

  /**
   * 释放会话并处理排队的来信（串行，一条一条来）。
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话。
   */
  private releaseAndDrain(conversationId: string, reserved: boolean): void {
    const router = this.deps.router()
    if (router !== undefined && reserved) {
      try {
        const released = router.release(conversationId)
        const openId = parseConversation(conversationId)
        for (const item of released) {
          if (openId === null || item.text.trim() === '') continue
          // 这些已经是「过了 5 秒窗口」的消息，只能走客服消息。
          void this.pushRest(openId, [item.text])
        }
      } catch (error) {
        this.note('释放会话抛错：%s', messageOf(error))
      }
    }

    const queue = this.pending.get(conversationId)
    if (queue === undefined || queue.length === 0) {
      this.pending.delete(conversationId)
      return
    }
    const next = queue.shift()
    if (queue.length === 0) this.pending.delete(conversationId)
    if (next === undefined) return
    if (this.inflight.has(conversationId)) return

    this.inflight.add(conversationId)
    void this.answerQueued(next, conversationId)
  }

  /**
   * 处理一条排队的来信。**它已经没有被动回复的机会**（那条路只对当前请求有效），
   * 所以问完直接走客服消息。
   * @param message 来信。
   * @param conversationId 会话 id。
   */
  private async answerQueued(message: InboundMessage, conversationId: string): Promise<void> {
    const at = this.deps.now()
    const kit = this.deps.kit()
    try {
      if (kit === undefined) return
      const result = await kit.callPersona({
        conversationId,
        text: message.text,
        maxChars: this.deps.settings.chunkMax,
        timeoutMs: this.deps.settings.replyTimeoutMs,
      })
      if (result.ok) {
        const pieces = result.pieces.length > 0 ? result.pieces : [result.text]
        await this.pushRest(message.openId, pieces)
      }
    } catch (error) {
      this.note('排队消息处理失败：%s', messageOf(error))
    } finally {
      this.inflight.delete(conversationId)
      this.observeLatency(at)
      this.releaseAndDrain(conversationId, false)
    }
  }

  /**
   * 走客服消息发若干段。
   * @param openId 收信人。
   * @param pieces 段。
   */
  private async pushRest(openId: string, pieces: readonly string[]): Promise<void> {
    if (pieces.length === 0) return
    const push = this.pushImpl
    if (push === null) {
      this.note('没有推送实现（凭据或 fetch 缺失），这几段发不出去：%d 段', pieces.length)
      return
    }
    if (!withinWindow(this.state.lastSeen[openId], this.deps.now(), this.deps.settings.windowHours)) {
      this.rejected['push.window-expired'] = (this.rejected['push.window-expired'] ?? 0) + 1
      this.deps.log.info('客服消息窗口已关（%d 小时），这几段不发：%d 段', this.deps.settings.windowHours, pieces.length)
      return
    }

    for (const piece of pieces) {
      const result = await push.push({ openId, text: piece })
      if (!result.ok) {
        this.note(
          '客服消息发送失败（%s / %s）：已发 %d/%d 段',
          result.reason ?? 'http',
          String(result.errcode ?? ''),
          this.pushed,
          pieces.length,
        )
        return
      }
      this.pushed += 1
      this.report('outbound')
      if (this.deps.settings.verbose) this.deps.log.info('客服消息已发一段（共 %d 段）', pieces.length)
    }
  }

  /** 主动发一条（窗口外直接拒，理由 `window-expired`）。 */
  async reply(conversationId: string, text: string, at?: number): Promise<SendOutcome> {
    const openId = parseConversation(conversationId)
    if (openId === null) return sendOutcome(false, 'empty', 0, 0)
    if (!this.deps.settings.enable) return sendOutcome(false, 'disabled', 0, 0)
    if (this.credential.value === undefined) return sendOutcome(false, 'no-credentials', 0, 0)

    const now = at ?? this.deps.now()
    if (!withinWindow(this.state.lastSeen[openId], now, this.deps.settings.windowHours)) {
      return sendOutcome(false, 'window-expired', 0, 0)
    }

    const trimmed = text.trim()
    if (trimmed === '') return sendOutcome(false, 'empty', 0, 0)
    const pieces = this.chunkOf(trimmed)
    if (pieces.length === 0) return sendOutcome(false, 'empty', 0, 0)

    let sent = 0
    for (const piece of pieces) {
      const push = this.pushImpl
      if (push === null) return sendOutcome(false, 'no-credentials', pieces.length, sent)
      const result = await push.push({ openId, text: piece })
      if (!result.ok) {
        return sendOutcome(false, result.reason ?? 'http', pieces.length, sent, result.errcode, result.errmsg)
      }
      sent += 1
      this.pushed += 1
      this.report('outbound')
    }
    return sendOutcome(true, 'ok', pieces.length, sent)
  }

  /**
   * 切条。**只认 O-056**：没有它就不发，绝不自己写第二套切法。
   * @param text 正文。
   */
  private chunkOf(text: string): readonly string[] {
    const max = this.deps.settings.chunkMax
    if (text.length <= max) return Object.freeze([text])
    const kit = this.deps.kit()
    if (kit === undefined) {
      this.note('没有 ondra-channel-kit：这条超过单条上限，不自己写第二套切法，故不发')
      return Object.freeze([])
    }
    try {
      return kit.chunk(text, max).pieces
    } catch (error) {
      this.note('切条抛错，本条不发：%s', messageOf(error))
      return Object.freeze([])
    }
  }

  /** 心跳：清过期记录 + 按节流落盘。 */
  tick(at?: number): void {
    const now = at ?? this.deps.now()
    prune(this.state, now, this.deps.settings.dedupeWindowMs, this.deps.settings.windowHours)
    this.stateDirty = true
    this.report('heartbeat')
    if (!this.deps.settings.persist) return
    if (now - this.lastFlush < this.deps.settings.persistMs) return
    this.flush()
  }

  /** 落盘（只在脏的时候写）。 */
  flush(): void {
    this.lastFlush = this.deps.now()
    if (!this.deps.settings.persist || !this.stateDirty) return
    const file = this.deps.files.state
    if (file === '') {
      this.deps.log.warn('算不出状态文件路径，窗口记录只在内存里（重启后刚说过话的人会被当成窗口外）')
      return
    }
    try {
      writeTextAtomic(file, JSON.stringify(this.state))
      this.stateDirty = false
    } catch (error) {
      this.deps.log.warn('状态落盘失败（下次再试）：%s', messageOf(error))
    }
  }

  /** 通道现状。 */
  status(): AdapterStatus {
    const now = this.deps.now()
    let windowOpen = 0
    for (const at of Object.values(this.state.lastSeen)) {
      if (withinWindow(at, now, this.deps.settings.windowHours)) windowOpen += 1
    }
    return {
      registered: this.registered,
      channelId: CHANNEL_ID,
      routePath: this.deps.settings.routePath,
      credential: this.credential.ok
        ? { ok: true }
        : { ok: false, missing: this.credential.missing ?? 'shape' },
      allowlist: this.deps.settings.allowOpenIds.length,
      windowOpen,
      lastError: this.lastError,
    }
  }

  /** 计数。 */
  stats(): AdapterStats {
    return {
      inbound: this.inbound,
      replied: this.replied,
      deferred: this.deferred,
      pushed: this.pushed,
      rejected: { ...this.rejected },
      worstLatencyMs: this.worstLatency,
    }
  }

  /**
   * 拼一条被动回复（并记账）。
   * @param message 来信。
   * @param text 正文。
   * @param startedAt 收到时刻。
   */
  private replyOutcome(message: InboundMessage, text: string, startedAt: number): IngestOutcome {
    const atSec = Math.trunc(this.deps.now() / 1000)
    this.replied += 1
    this.observeLatency(startedAt)
    return {
      http: 200,
      body: buildTextReply(message.openId, message.accountId, text, atSec),
      contentType: 'application/xml; charset=utf-8',
      disposition: 'reply',
      conversationId: conversationOf(message.openId),
      reason: 'ok',
      deferred: false,
    }
  }

  /**
   * 降级话术（把 5 秒的账平掉）。
   * @param message 来信。
   * @param reason 原因。
   * @param detail 说明。
   */
  private degrade(message: InboundMessage, reason: IngestReason, detail: string): IngestOutcome {
    const atSec = Math.trunc(this.deps.now() / 1000)
    this.replied += 1
    this.rejected['degrade.' + reason] = (this.rejected['degrade.' + reason] ?? 0) + 1
    return {
      http: 200,
      body: buildTextReply(message.openId, message.accountId, this.deps.settings.degradeText, atSec),
      contentType: 'application/xml; charset=utf-8',
      disposition: 'degrade',
      conversationId: conversationOf(message.openId),
      reason,
      deferred: reason === 'deferred',
      detail,
    }
  }

  /**
   * 安静地回一个空 200。
   *
   * **空 body 是有效应答**：微信收到 200 且 body 为空就停止重试；
   * 而回 500 会让它重试三次，同一份「不该回」的判断被算三遍。
   * @param reason 原因。
   * @param detail 说明。
   */
  private silent(reason: IngestReason, detail?: string): IngestOutcome {
    this.rejected['silent.' + reason] = (this.rejected['silent.' + reason] ?? 0) + 1
    if (reason !== 'ignored') this.deps.log.info('静默应答（%s）：%s', reason, detail ?? '')
    return { http: 200, body: '', contentType: 'text/plain; charset=utf-8', disposition: 'silent', reason, deferred: false, detail }
  }

  /**
   * 拒绝（只在验签失败这类「必须让对方看见」的场合用）。
   * @param reason 原因。
   * @param detail 说明。
   */
  private reject(reason: IngestReason, detail?: string): IngestOutcome {
    this.rejected['reject.' + reason] = (this.rejected['reject.' + reason] ?? 0) + 1
    this.deps.log.warn('请求被拒（%s）：%s', reason, detail ?? '')
    return { http: 401, body: '', contentType: 'text/plain; charset=utf-8', disposition: 'reject', reason, deferred: false, detail }
  }

  /**
   * 记一次延迟。**5 秒预算是否真的守住，只有这个数能证明。**
   * @param startedAt 收到时刻。
   */
  private observeLatency(startedAt: number): void {
    const spent = this.deps.now() - startedAt
    // 显式传入的 at 可能晚于本地时钟（回放/测试），负值没有意义，不计。
    if (spent < 0) return
    if (spent > this.worstLatency) this.worstLatency = spent
  }

  /**
   * 向探针上报。探针缺席时静默。
   * @param kind 事件类型。
   */
  private report(kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error'): void {
    const health = this.deps.health()
    if (health === undefined) return
    try {
      health.report({ channelId: CHANNEL_ID, kind, at: this.deps.now() })
    } catch {
      // 探针自己出错与通道无关。
    }
  }

  /** 记一条中文日志（不含正文）。 */
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

/** 取错误消息文本。 */
export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
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
