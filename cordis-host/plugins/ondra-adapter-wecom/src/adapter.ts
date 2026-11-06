/**
 * 适配器主体：验签 → 解密 → 解析 → 白名单 → 去重 → 路由 → **立刻回 `success`** → 后台回答。
 *
 * ## 一轮的最坏情况长什么样
 *
 * ```
 * t=0ms     收到 POST
 * t=0..10   验签 + AES 解密 + 解析 + 去重（纯计算，不碰网络）
 * t=10ms    回 "success"（企业微信立刻停止重试）
 * t=10ms+   问人格 → 走应用消息把话发出去
 * ```
 *
 * 这条路径之所以比 O-060（公众号）短，是因为**企业微信的 `success` 不代表「我说完了」**，
 * 只代表「我收到了」。真正的回答走应用消息，那条通道想什么时候发都行。
 * 所以这里没有降级话术、没有 5 秒预算、没有交棒——三样都是「必须在一个响应里说完」的产物。
 *
 * ## 为什么仍然要「先回再答」
 *
 * 企业微信等的是「有没有响应」，不是「回答得对不对」。先回 `success` 再慢慢答，
 * 用户看到的是「她过几秒发来一条」；先答再回，用户看到的是「转圈」，
 * 而那时候一旦超时，企业微信会重试，同一条消息被答两遍。
 *
 * ## 为什么同一个会话要排队
 *
 * 一个人连发两条时，两条 POST 会几乎同时到达。两条都去问人格，会得到两段**互不知情**的回答，
 * 人看到的是「她同时在说两件不相干的事」。所以：第一条进回答，第二条排队等第一条收尾。
 * 排队在这里是安全的——应用消息随时能发，不存在「排久了就发不出去」。
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
  VerifyReason,
  WecomPush,
  WecomService,
} from './types.js'
import { ACK_TEXT, CHANNEL_ID } from './types.js'
import type { Config as Settings } from './settings.js'
import { openPayload } from './crypt.js'
import { dedupeKeyOf, parseEnvelope, parseInbound } from './wire.js'

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
  push: WecomPush | null
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
 * 会话 id。自建应用只有一对一，所以就是 `wecom:<userid>`。
 * @param userId 成员 UserID。
 */
export function conversationOf(userId: string): string {
  return CONVERSATION_PREFIX + userId
}

/**
 * 从会话 id 反解 UserID。**大小写原样保留**（UserID 由管理员定义，大小写敏感）。
 * @param conversationId 会话 id。
 */
export function parseConversation(conversationId: string): string | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const userId = conversationId.slice(CONVERSATION_PREFIX.length)
  return userId === '' ? null : userId
}

/**
 * 一次 `openPayload` 的失败原因 → 本插件的失败原因。
 *
 * 只有「接收方不是本企业」需要单独说清楚：它意味着 Token 相同但企业不同
 * （多企业共用一套部署时的典型形态），处置方式与「密钥不对」完全不同。
 * @param reason 解密侧的原因。
 */
function verifyReasonOf(reason: string | undefined): VerifyReason {
  return reason === 'corp-mismatch' ? 'corp-mismatch' : 'bad-crypt'
}

/** 企业微信适配器。 */
export class WecomAdapter implements WecomService {
  private readonly deps: AdapterDeps
  private state: SeenState
  private credential: CredentialLoad
  private pushImpl: WecomPush | null
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
  setPush(push: WecomPush | null): void {
    this.pushImpl = push
  }

  /** 重读凭据（改完文件后调用，不必重启）。 */
  reload(): CredentialLoad {
    this.credential = this.deps.readCredential()
    this.pushImpl?.invalidate()
    return this.credential
  }

  /** GET 验证（企业微信后台「保存」时打过来的那一次）。 */
  verify(query: QueryLike): VerifyOutcome {
    if (!this.deps.settings.enable) {
      return {
        ok: false,
        http: 503,
        body: '',
        contentType: 'text/plain; charset=utf-8',
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
        contentType: 'text/plain; charset=utf-8',
        reason: 'no-credentials',
        detail: this.credential.detail,
      }
    }

    const echo = query['echostr'] ?? ''
    if (echo === '') {
      return {
        ok: false,
        http: 400,
        body: '',
        contentType: 'text/plain; charset=utf-8',
        reason: 'missing-params',
        detail: 'POST 走了 GET 分支：缺 echostr（企业微信后台「保存」时会带）',
      }
    }

    const opened = openPayload(value.token, value.encodingAESKey, query, echo, value.corpId)
    if (!opened.ok) {
      this.note('回调验证未通过（%s）：%s', opened.reason ?? 'unknown', opened.detail ?? '')
      return {
        ok: false,
        http: 401,
        body: '',
        contentType: 'text/plain; charset=utf-8',
        reason: verifyReasonOf(opened.reason),
        detail: opened.detail ?? '',
      }
    }

    this.report('connected')
    return {
      ok: true,
      http: 200,
      body: opened.text ?? '',
      contentType: 'text/plain; charset=utf-8',
      detail: '验证通过',
    }
  }

  /**
   * 处理一条 POST。**先回 `success`，回答在后台跑。**
   * @param rawBody 原始报文。
   * @param query 请求 query（签名在 query 里）。
   * @param at 收到时刻（毫秒，缺省取 now）。
   */
  async ingest(rawBody: string, query: QueryLike, at?: number): Promise<IngestOutcome> {
    const startedAt = at ?? this.deps.now()
    this.inbound += 1

    // 关着的时候也要回 success：回 4xx 会让它一直重试，而关通道是用户的选择，不是故障。
    if (!this.deps.settings.enable) return this.ack('disabled', false, '通道开关关着')

    const value = this.credential.value
    if (!this.credential.ok || value === undefined) {
      return this.reject('no-credentials', this.credential.detail)
    }

    const envelope = parseEnvelope(rawBody)
    if (envelope === null) {
      return this.reject(
        'bad-body',
        '报文里没有 <Encrypt>：接收消息服务器配置必须填 EncodingAESKey（本插件只接受加密回调）',
      )
    }

    const opened = openPayload(value.token, value.encodingAESKey, query, envelope.encrypt, value.corpId)
    if (!opened.ok) return this.reject('bad-crypt', opened.detail ?? '')

    const message = parseInbound(opened.text ?? '', startedAt)
    if (message === null) {
      // 解密成功但报文选不出来：重试也不会有不同结果，回 success 让它停下。
      return this.ack('bad-body', false, '明文报文解析不出一条来信')
    }
    const conversationId = conversationOf(message.userId)
    this.report('inbound')

    // 信封里的 AgentID 与凭据不一致：多半是同一个回调地址被多个应用共用。
    // **只告警、不拒**——「这条消息是不是给我的」由解密后帧尾的 receiveid 判定，
    // 那才是签名保护过的事实；这里只是帮人早一点看见配置串了。
    if (envelope.agentId !== '' && Number(envelope.agentId) !== value.agentId) {
      this.deps.log.warn(
        '回调信封的 AgentID 是 %s，与凭据里的 %d 不一致：请确认后台填的是同一个应用',
        envelope.agentId,
        value.agentId,
      )
    }

    // 屏蔽优先于允许：拉黑的人在白名单里也不回。
    if (this.deps.settings.blockUserIds.includes(message.userId)) {
      return this.ack('not-allowed', false, 'blockUserIds 命中')
    }
    const allow = this.deps.settings.allowUserIds
    if (allow.length > 0 && !allow.includes(message.userId)) {
      return this.ack('not-allowed', false, 'allowUserIds 非空且不含此人')
    }

    if (message.msgType !== 'text') {
      return this.ack('unsupported', false, '只处理文本：' + message.msgType)
    }

    const key = dedupeKeyOf(message)
    const seenAt = this.state.seen[key]
    if (seenAt !== undefined && startedAt - seenAt < this.deps.settings.dedupeWindowMs) {
      // 企业微信没及时收到响应会重试；认出来就回 success（它才会停），但不重复回答。
      return this.ack('duplicate', false, '同一 MsgId 已处理过')
    }
    this.markSeen(key, startedAt)

    // 同一会话已有回合在跑：排队。应用消息随时能发，排久了也不会失效。
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
      // 没有路由就照答：路由管的是「该不该吵醒她」，不是「能不能回话」。
      return { action: 'reply', reason: 'no-router', reserved: false, queueDepth: 0, position: 0 }
    }
    try {
      return router.admit({
        channelId: CHANNEL_ID,
        conversationId,
        // 自建应用回调只有成员与应用的私聊，没有群消息。
        kind: 'private',
        trigger: 'message',
        text: message.text,
        messageId: message.msgId,
        senderId: message.userId,
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
        // 半句话不发：宁可这一条不回，也不发一段没头没尾的话。
        this.note('本轮没有可用回复（%s），不发', result.failure ?? 'unknown')
        return
      }
      const pieces = result.pieces.length > 0 ? result.pieces : [result.text]
      await this.sendPieces(message.userId, pieces)
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
   * 「同会话同时只跑一轮」由 `pump()` 保证：并发会得到两段互不知情的回答（O-058 的教训）。
   * 这里只做两件事——把占位还给路由（并把路由积压的正文发出去）、然后补位。
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话。
   */
  private releaseAndDrain(conversationId: string, reserved: boolean): void {
    const router = this.deps.router()
    if (router !== undefined && reserved) {
      const userId = parseConversation(conversationId)
      try {
        const released = router.release(conversationId)
        if (userId !== null) {
          for (const item of released) {
            if (item.text.trim() === '') continue
            this.deliver(userId, [item.text])
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
   * 每个会话同时只跑一轮（同会话并发会撞上自己的会话冷却）；
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
   * 后台发若干段，异常收在本地。
   *
   * `void this.sendPieces(...)` 的唯一危险是 rejection 变成进程级 `unhandledRejection`：
   * 一次网络抖动会让宿主打一条吓人的告警，而真正的原因只是「这条没发出去」。
   * @param userId 收信人。
   * @param pieces 段。
   */
  private deliver(userId: string, pieces: readonly string[]): void {
    this.sendPieces(userId, pieces).catch((error: unknown) => {
      this.note('后台发送抛错：%s', messageOf(error))
    })
  }

  /**
   * 发若干段。**空串一律跳过**：一个空串会变成一条空气泡，用户看得见、日志全绿。
   * @param userId 收信人。
   * @param pieces 段。
   */
  private async sendPieces(userId: string, pieces: readonly string[]): Promise<void> {
    const ready = this.fitPieces(pieces)
    if (ready.length === 0) return
    const push = this.pushImpl
    if (push === null) {
      this.note('没有推送实现（凭据或 fetch 缺失），这几段发不出去：%d 段', ready.length)
      return
    }

    let done = 0
    for (const piece of ready) {
      const result = await push.push({ userId, text: piece })
      if (!result.ok) {
        this.note(
          '应用消息发送失败（%s / %s）：本轮已发 %d/%d 段',
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
      if (this.deps.settings.verbose) this.deps.log.info('应用消息已发一段（共 %d 段）', ready.length)
    }
  }

  /**
   * 让每一段都不超上限，并丢掉空段。
   *
   * 「切条归 O-056」这条纪律针对的是**怎么切**；这里只做一次长度确认，
   * 因为上游给的 `pieces` 可能按它自己的上限切，而本通道的上限是 2000。
   * 超了不重切就只能发出去被平台拒——拒的理由还会是「参数错误」。
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

  /** 主动发一条（应用消息没有窗口限制，随时可发）。 */
  async reply(conversationId: string, text: string): Promise<SendOutcome> {
    const userId = parseConversation(conversationId)
    if (userId === null) return sendOutcome(false, 'empty', 0, 0)
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
      const result = await push.push({ userId, text: piece })
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
      allowlist: this.deps.settings.allowUserIds.length,
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
    // 显式传入的 at 可能晚于本地时钟（回放/测试），负值没有意义，不计。
    if (spent < 0) return
    if (spent > this.worstAnswerMs) this.worstAnswerMs = spent
  }

  /**
   * 受理 / 忽略都回 `success`（企业微信收到就停），只是原因与是否回答不同。
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
      body: ACK_TEXT,
      contentType: 'text/plain; charset=utf-8',
      disposition,
      reason,
      answering,
    }
    return detail === undefined ? base : { ...base, detail }
  }

  /**
   * 拒绝（只在「配置不对，必须让对方看见」的场合用）。
   *
   * 回 200 会静默丢消息；回 4xx 企业微信会把「回调失败」显示在后台配置页上，
   * 那正是配置出问题时最该被看见的地方。
   * @param reason 原因。
   * @param detail 说明。
   */
  private reject(reason: IngestReason, detail?: string): IngestOutcome {
    this.rejected['reject.' + reason] = (this.rejected['reject.' + reason] ?? 0) + 1
    this.deps.log.warn('请求被拒（%s）：%s', reason, detail ?? '')
    const base: IngestOutcome = {
      http: 401,
      body: '',
      contentType: 'text/plain; charset=utf-8',
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
