/**
 * 适配器主体：解析 → 加密体拒 → 验 token → 验 app_id → 去重 → 路由 → **立刻回 `{"code":0}`** → 后台回答。
 *
 * ## 一轮的最坏情况长什么样
 *
 * ```
 * t=0ms     收到 POST
 * t=0..5    解析 + 验 token + 去重（纯计算，不碰网络）
 * t=5ms     回 {"code":0}（飞书停止重投）
 * t=5ms+    问人格 → 走 im/v1/messages 把话发出去
 * ```
 *
 * ## 为什么这里没有「降级话术」
 *
 * O-060（公众号）必须先回一句人话，是因为微信**只能在那个响应里**把话交给用户。
 * 飞书不是：响应只是「收到了」，之后随时可以调接口发消息。所以这里只回一个
 * `{"code":0}`，用户看到的是「她过几秒发来一条」，而不是「先一句我在呢、再一句真话」。
 *
 * ## 为什么加密体是「明确拒」而不是「尽力解」
 *
 * master-plan §9.11 明写「`encryptKey` 不支持加密体」。既然解不了：
 * 假装解了会把乱码当用户的话发给模型；静默接受会让她永远不回话且日志全绿。
 * 所以返回 **400 + 原因**——飞书开发者后台的「事件订阅」页会当场显示失败，
 * 那正是配置错时需要被看见的地方。
 *
 * ## 为什么同一个会话要排队
 *
 * 群里两个人同时 @ 她，两条事件会几乎同时到达。两条并发会得到两段互不知情的回答，
 * 群里看到的是「她同时在说两件不相干的事」。排队是安全的：消息随时能补发。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AdapterStats,
  AdapterStatus,
  AdmissionLike,
  CredentialLoad,
  FeishuService,
  HealthLike,
  InboundMessage,
  IngestOutcome,
  IngestReason,
  KitLike,
  RouterLike,
  SendOutcome,
  SendReason,
  VerifyOutcome,
  VerifyReason,
  FeishuPush,
} from './types.js'
import { ACK_BODY, CHANNEL_ID, JSON_CONTENT_TYPE } from './types.js'
import type { Config as Settings } from './settings.js'
import { isRecord } from './settings.js'
import {
  buildChallenge,
  challengeOf,
  dedupeKeyOf,
  headerOf,
  inboundOf,
  isEncrypted,
  parseJson,
} from './wire.js'

/** 日志最小面（cordis logger 的 printf 形态）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 去重表的容量上限。 */
export const SEEN_LIMIT = 4_000

/** 去重表的持久化形状。 */
interface SeenState {
  /** 键 → 首次见到它的时刻（毫秒）。 */
  seen: Record<string, number>
}

/** 空状态。 */
function emptyState(): SeenState {
  return { seen: {} }
}

/**
 * 解析状态文件。坏字段逐条丢弃，**不整份作废**。
 * @param value 读出来的 JSON。
 */
function parseState(value: unknown): SeenState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyState()
  const holder = (value as Record<string, unknown>)['seen']
  if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) return emptyState()
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(holder as Record<string, unknown>)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue
    out[key] = raw
  }
  return { seen: out }
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
  push: FeishuPush | null
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
 * 会话 id。用 `chat_id`（单聊与群聊都有），**不是** `open_id`。
 * @param chatId 飞书会话 id。
 */
export function conversationOf(chatId: string): string {
  return CONVERSATION_PREFIX + chatId
}

/**
 * 从会话 id 反解 chat_id。**大小写原样保留**。
 * @param conversationId 会话 id。
 */
export function parseConversation(conversationId: string): string | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const chatId = conversationId.slice(CONVERSATION_PREFIX.length)
  return chatId === '' ? null : chatId
}

/** 飞书适配器。 */
export class FeishuAdapter implements FeishuService {
  private readonly deps: AdapterDeps
  private state: SeenState
  private credential: CredentialLoad
  private pushImpl: FeishuPush | null
  private registered = false
  private stateDirty = false
  private lastFlush = 0
  private lastError: string | null = null

  private inbound = 0
  private answering = 0
  private sent = 0
  private worstAnswerMs = 0
  private readonly rejected: Record<string, number> = {}
  private readonly inflight = new Set<string>()
  private readonly pending = new Map<string, InboundMessage[]>()

  constructor(deps: AdapterDeps) {
    this.deps = deps
    this.state = this.loadState()
    this.credential = deps.readCredential()
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

  get reason(): VerifyReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (!this.credential.ok) return 'no-credentials'
    if (!this.registered) return 'no-ack'
    return undefined
  }

  /** 读状态文件。坏文件按空状态处理，但一定留一句日志。 */
  private loadState(): SeenState {
    const file = this.deps.files.state
    if (!this.deps.settings.persist || file === '') return emptyState()
    try {
      if (!existsSync(file)) return emptyState()
      return parseState(JSON.parse(readFileSync(file, 'utf8')) as unknown)
    } catch {
      this.deps.log.warn('去重状态文件读不出来，已按空状态启动（重启后可能把同一句话答两遍）：%s', file)
      return emptyState()
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
   * 换推送实现（注入测试桩或企业内网关时用）。
   * @param push 实现。
   */
  setPush(push: FeishuPush | null): void {
    this.pushImpl = push
  }

  /** 重读凭据（改完文件后调用，不必重启）。 */
  reload(): CredentialLoad {
    this.credential = this.deps.readCredential()
    this.pushImpl?.invalidate()
    return this.credential
  }

  /** `url_verification`：回 `{"challenge":"…"}`。 */
  verify(payload: unknown): VerifyOutcome {
    if (!this.deps.settings.enable) {
      return {
        ok: false,
        http: 503,
        body: '',
        contentType: JSON_CONTENT_TYPE,
        reason: 'disabled',
        detail: '通道开关关着',
      }
    }
    const value = this.credential.value
    if (!this.credential.ok || value === undefined) {
      return {
        ok: false,
        http: 401,
        body: '',
        contentType: JSON_CONTENT_TYPE,
        reason: 'no-credentials',
        detail: this.credential.detail,
      }
    }
    if (!isRecord(payload)) {
      return {
        ok: false,
        http: 400,
        body: '',
        contentType: JSON_CONTENT_TYPE,
        reason: 'bad-body',
        detail: '报文不是 JSON 对象',
      }
    }
    if (isEncrypted(payload)) {
      return {
        ok: false,
        http: 400,
        body: '',
        contentType: JSON_CONTENT_TYPE,
        reason: 'encrypted',
        detail: '这是加密体：请在开发者后台关闭 Encrypt Key（本插件不支持加密体）',
      }
    }

    const header = headerOf(payload)
    if (header.token !== value.verificationToken) {
      return {
        ok: false,
        http: 401,
        body: '',
        contentType: JSON_CONTENT_TYPE,
        reason: 'bad-token',
        detail: 'Verification Token 与后台不一致',
      }
    }
    if (header.appId !== '' && header.appId !== value.appId) {
      return {
        ok: false,
        http: 401,
        body: '',
        contentType: JSON_CONTENT_TYPE,
        reason: 'app-mismatch',
        detail: '回调里的 app_id 是「' + header.appId + '」，与凭据不一致',
      }
    }

    const challenge = challengeOf(payload)
    if (challenge === null) {
      return {
        ok: false,
        http: 400,
        body: '',
        contentType: JSON_CONTENT_TYPE,
        reason: 'no-challenge',
        detail: 'type 不是 url_verification，或 challenge 为空',
      }
    }
    this.report('connected')
    return {
      ok: true,
      http: 200,
      body: buildChallenge(challenge),
      contentType: JSON_CONTENT_TYPE,
      detail: '验证通过',
    }
  }

  /**
   * 处理一次回调。**先回 `{"code":0}`，回答在后台跑。**
   * @param rawBody 原始报文。
   * @param at 收到时刻（毫秒，缺省取 now）。
   */
  async ingest(rawBody: string, at?: number): Promise<IngestOutcome> {
    const startedAt = at ?? this.deps.now()
    this.inbound += 1

    // 关着的时候也要回 200：飞书会重投，而关通道是用户的选择，不是故障。
    if (!this.deps.settings.enable) return this.ack('disabled', false, '通道开关关着')

    const value = this.credential.value
    if (!this.credential.ok || value === undefined) {
      return this.reject('no-credentials', 401, this.credential.detail)
    }

    const payload = parseJson(rawBody)
    if (payload === null) return this.reject('bad-body', 400, '报文不是 JSON 对象')
    if (isEncrypted(payload)) {
      return this.reject('encrypted', 400, '这是加密体：请在开发者后台关闭 Encrypt Key（本插件不支持加密体）')
    }

    const header = headerOf(payload)
    if (header.token !== value.verificationToken) {
      return this.reject('bad-token', 401, 'Verification Token 与后台不一致')
    }
    if (header.appId !== '' && header.appId !== value.appId) {
      return this.reject('app-mismatch', 401, '回调里的 app_id 与凭据不一致')
    }

    // 不是消息事件：正常收下，不回话（事件订阅里还有已读、撤单、入群等）。
    if (header.eventType !== 'im.message.receive_v1') {
      return this.ack('ignored', false, '不是消息事件：' + (header.eventType === '' ? '（缺 event_type）' : header.eventType))
    }

    const message = inboundOf(payload, startedAt)
    if (message === null) return this.ack('bad-body', false, '消息事件解析不出 chat_id 或 message')

    const conversationId = conversationOf(message.chatId)
    this.report('inbound')

    // 屏蔽优先于允许：拉黑的人在白名单里也不回。
    const senderKeys = [message.senderId, message.senderUserId]
    const blocked = this.deps.settings.blockSenderIds
    if (blocked.some(id => senderKeys.includes(id))) {
      return this.ack('not-allowed', false, 'blockSenderIds 命中')
    }
    const allow = this.deps.settings.allowSenderIds
    if (allow.length > 0 && !allow.some(id => senderKeys.includes(id))) {
      return this.ack('not-allowed', false, 'allowSenderIds 非空且不含此人')
    }

    if (message.msgType !== 'text') {
      return this.ack('unsupported', false, '只处理文本：' + message.msgType)
    }
    if (message.text === '') {
      // 群里只发了一个 `@她`、没有正文：这不是一句话，回答什么都是猜。
      return this.ack('unsupported', false, '剥掉 @ 占位符后没有正文')
    }

    const key = dedupeKeyOf(message)
    const seenAt = this.state.seen[key]
    if (seenAt !== undefined && startedAt - seenAt < this.deps.settings.dedupeWindowMs) {
      // 飞书三档重投（15s / 5min / 1h）；认出来就回 200（它才会停），但不重复回答。
      return this.ack('duplicate', false, '同一 event_id 已处理过')
    }
    this.markSeen(key, startedAt)

    if (this.inflight.has(conversationId) || this.inflight.size >= this.deps.settings.maxConcurrent) {
      this.enqueue(conversationId, message)
      return this.ack('busy', false, '已有回合在跑，本条排队')
    }

    const admission = this.admit(message, conversationId, startedAt)
    if (admission.action === 'ignore') return this.ack('ignored', false, admission.reason)
    if (admission.action === 'deny') return this.ack('not-allowed', false, admission.reason)
    if (admission.action === 'queue') {
      this.enqueue(conversationId, message)
      return this.ack('queued', false, '路由排队：' + admission.reason)
    }

    this.inflight.add(conversationId)
    this.answering += 1
    void this.answer(message, conversationId, admission.reserved)
    return this.ack('ok', true)
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
    const group = message.chatType === 'group'
    try {
      return router.admit({
        channelId: CHANNEL_ID,
        conversationId,
        kind: group ? 'group' : 'private',
        // 群消息只会在被 @ 时投递（平台行为），所以这里的触发方式天然是 mention。
        trigger: group ? 'mention' : 'message',
        text: message.text,
        messageId: message.messageId,
        senderId: message.senderId,
        at,
      })
    } catch (error) {
      this.note('路由判定抛错（按「直接回」处理）：%s', messageOf(error))
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
      const result = await kit.callPersona({
        conversationId,
        text: message.text,
        maxChars: this.deps.settings.chunkMax,
        timeoutMs: this.deps.settings.requestTimeoutMs,
      })
      if (!result.ok) {
        this.note('本轮没有可用回复（%s），不发', result.failure ?? 'unknown')
        return
      }
      const pieces = result.pieces.length > 0 ? result.pieces : [result.text]
      await this.sendPieces(message.chatId, pieces)
    } catch (error) {
      this.note('回答时抛错：%s', messageOf(error))
    } finally {
      this.observeAnswer(startedAt)
      this.releaseAndDrain(conversationId, reserved)
    }
  }

  /**
   * 释放会话，再把排队中能起的回合起起来。
   *
   * 「同会话同时只跑一轮」由 `pump()` 保证：并发会得到两段互不知情的回答。
   * 这里只做两件事——把占位还给路由（并把路由积压的正文发出去）、然后补位。
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话。
   */
  private releaseAndDrain(conversationId: string, reserved: boolean): void {
    const router = this.deps.router()
    if (router !== undefined && reserved) {
      const chatId = parseConversation(conversationId)
      try {
        const released = router.release(conversationId)
        if (chatId !== null) {
          for (const item of released) {
            if (item.text.trim() === '') continue
            this.deliver(chatId, [item.text])
          }
        }
      } catch (error) {
        this.note('释放会话抛错：%s', messageOf(error))
      }
    }

    // 释放完就把「能起的都起起来」：只处理自己这条队列是不够的。
    // 积压可能是「全局并发已满」造成的（那时被挤掉的是**另一个会话**的来信），
    // 而它的队列只有在任意一轮收尾时才可能被看见——漏了这一步，那条消息会永远躺在 Map 里。
    this.pump()
  }

  /**
   * 在并发额度内尽量把排队的会话起起来。
   *
   * 每个会话同时只跑一轮（群里两条并发会得到两段互不知情的回答）；
   * 全局额度满就停手，等下一次收尾再补。
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
      this.answering += 1
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
   * 后台发若干段，异常收在本地（避免 `unhandledRejection`）。
   * @param chatId 会话 id。
   * @param pieces 段。
   */
  private deliver(chatId: string, pieces: readonly string[]): void {
    this.sendPieces(chatId, pieces).catch((error: unknown) => {
      this.note('后台发送抛错：%s', messageOf(error))
    })
  }

  /**
   * 发若干段。**空串一律跳过**：一个空串会变成一条空气泡，用户看得见、日志全绿。
   * @param chatId 会话 id。
   * @param pieces 段。
   */
  private async sendPieces(chatId: string, pieces: readonly string[]): Promise<void> {
    const ready = this.fitPieces(pieces)
    if (ready.length === 0) return
    const push = this.pushImpl
    if (push === null) {
      this.note('没有推送实现（凭据或 fetch 缺失），这几段发不出去：%d 段', ready.length)
      return
    }

    let done = 0
    for (const piece of ready) {
      const result = await push.push({ chatId, text: piece })
      if (!result.ok) {
        this.note(
          '消息发送失败（%s / %s）：本轮已发 %d/%d 段',
          result.reason ?? 'http',
          String(result.errcode ?? ''),
          done,
          ready.length,
        )
        return
      }
      done += 1
      this.sent += 1
      this.report('outbound')
      if (this.deps.settings.verbose) this.deps.log.info('消息已发一段（共 %d 段）', ready.length)
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
        this.note('切条抛错，这一段不发：%s', messageOf(error))
      }
    }
    return out
  }

  /** 主动发一条（飞书没有窗口限制，随时可发）。 */
  async reply(conversationId: string, text: string): Promise<SendOutcome> {
    const chatId = parseConversation(conversationId)
    if (chatId === null) return sendOutcome(false, 'empty', 0, 0)
    if (!this.deps.settings.enable) return sendOutcome(false, 'disabled', 0, 0)
    if (!this.credential.ok) return sendOutcome(false, 'no-credentials', 0, 0)

    const trimmed = text.trim()
    if (trimmed === '') return sendOutcome(false, 'empty', 0, 0)
    const ready = this.fitPieces([trimmed])
    if (ready.length === 0) return sendOutcome(false, 'no-kit', 0, 0)

    let done = 0
    for (const piece of ready) {
      const push = this.pushImpl
      if (push === null) return sendOutcome(false, 'no-credentials', ready.length, done)
      const result = await push.push({ chatId, text: piece })
      if (!result.ok) {
        return sendOutcome(false, result.reason ?? 'http', ready.length, done, result.errcode, result.errmsg)
      }
      done += 1
      this.sent += 1
      this.report('outbound')
    }
    return sendOutcome(true, 'ok', ready.length, done)
  }

  /** 心跳：清过期去重记录 + 按节流落盘 + 报一次心跳。 */
  tick(at?: number): void {
    const now = at ?? this.deps.now()
    this.prune(now)
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
      this.deps.log.warn('算不出状态文件路径，去重记录只在内存里（重启后可能把同一句话答两遍）')
      return
    }
    try {
      writeTextAtomic(file, JSON.stringify(this.state))
      this.stateDirty = false
    } catch (error) {
      this.deps.log.warn('状态落盘失败（下次再试）：%s', messageOf(error))
    }
  }

  /**
   * 记一条去重键。超过容量时淘汰最早的那批。
   * @param key 去重键。
   * @param at 时刻。
   */
  private markSeen(key: string, at: number): void {
    this.state.seen[key] = at
    this.stateDirty = true
    const keys = Object.keys(this.state.seen)
    if (keys.length <= SEEN_LIMIT) return
    const sorted = keys.sort((left, right) => this.state.seen[left] - this.state.seen[right])
    const drop = sorted.slice(0, keys.length - SEEN_LIMIT)
    for (const item of drop) delete this.state.seen[item]
  }

  /**
   * 清掉过期的去重记录。
   * @param at 时刻。
   */
  private prune(at: number): void {
    const horizon = at - this.deps.settings.dedupeWindowMs
    for (const [key, seenAt] of Object.entries(this.state.seen)) {
      if (seenAt < horizon) delete this.state.seen[key]
    }
  }

  /** 通道现状。 */
  status(): AdapterStatus {
    let queued = 0
    for (const queue of this.pending.values()) queued += queue.length
    return {
      registered: this.registered,
      channelId: CHANNEL_ID,
      routePath: this.deps.settings.routePath,
      credential: this.credential.ok ? { ok: true } : { ok: false, missing: this.credential.missing ?? 'shape' },
      allowlist: this.deps.settings.allowSenderIds.length,
      inflight: this.inflight.size,
      queued,
      lastError: this.lastError,
    }
  }

  /** 计数。 */
  stats(): AdapterStats {
    return {
      inbound: this.inbound,
      answering: this.answering,
      sent: this.sent,
      rejected: { ...this.rejected },
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
   * 受理 / 忽略都回 `{"code":0}`，只是原因与是否回答不同。
   * @param reason 原因。
   * @param answering 是否会回答。
   * @param detail 说明。
   */
  private ack(reason: IngestReason, answering: boolean, detail?: string): IngestOutcome {
    const disposition = reason === 'ok' ? 'accept' : 'ignore'
    if (disposition === 'ignore') {
      this.rejected['ignore.' + reason] = (this.rejected['ignore.' + reason] ?? 0) + 1
      if (reason !== 'ignored') this.deps.log.info('已受理但不再回答（%s）：%s', reason, detail ?? '')
    }
    const base: IngestOutcome = {
      http: 200,
      body: ACK_BODY,
      contentType: JSON_CONTENT_TYPE,
      disposition,
      reason,
      answering,
    }
    return detail === undefined ? base : { ...base, detail }
  }

  /**
   * 拒绝（配置不对时必须让对方看见）。
   * @param reason 原因。
   * @param http 状态码。
   * @param detail 说明。
   */
  private reject(reason: IngestReason, http: number, detail?: string): IngestOutcome {
    this.rejected['reject.' + reason] = (this.rejected['reject.' + reason] ?? 0) + 1
    this.deps.log.warn('请求被拒（%s）：%s', reason, detail ?? '')
    const base: IngestOutcome = {
      http,
      body: '',
      contentType: JSON_CONTENT_TYPE,
      disposition: 'reject',
      reason,
      answering: false,
    }
    return detail === undefined ? base : { ...base, detail }
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

/**
 * 取错误消息文本。
 * @param value 任意异常。
 */
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
