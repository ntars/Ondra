/**
 * 适配器主体：验签 → 解析 → 去重 → 路由 → **立刻回 200 空体** → 后台选出口发话。
 *
 * ## 一轮的最坏情况长什么样
 *
 * ```
 * t=0ms     收到 POST
 * t=0..2    验签 + 解析 + 去重（纯计算，不碰网络）
 * t=2ms     回 200 空体（钉钉停止重投）
 * t=2ms+    问人格 → 选出口（sessionWebhook / 主动接口）→ 发出去
 * ```
 *
 * ## 为什么这里连「我在呢」都不回
 *
 * 手册 §9.11 对钉钉的原话是「先回 empty 再异步」。回一句话看起来更亲切，
 * 但它会把「回答」拆成两段（先一句垫场、再一句真话），而垫场那句要占掉
 * 一次发送、一次频控、一条消息气泡。她的回答本来就该是一段完整的话。
 * 真正需要垫场的只有 O-060 那条 5 秒硬限的公众号链路——那里不垫就发不出去。
 *
 * ## 出口怎么选（本文件最要紧的一段）
 *
 * | `replyVia` | 行为 |
 * |---|---|
 * | `auto`（默认） | 这条消息的 `sessionWebhook` 还没过期就走它；过期了就走主动接口 |
 * | `session` | 只走 sessionWebhook；过期即 `expired-session`（排查用） |
 * | `active` | 只走主动接口；没有 `appKey` 即 `no-app-key`（排查用） |
 *
 * **不猜「过期」的错误码**：钉钉的过期错误码仓内查不到依据，猜错会把
 * 「发送失败」误判成「换个出口重发」，结果是同一句话发两遍。
 * 过期只按报文自带的 `sessionWebhookExpiredTime` 判，而且**每一段发之前重判**
 * （4000 字切三段，最后一段可能刚好跨过期限）。
 *
 * ## 为什么超时不换出口
 *
 * 超时是「不知道发没发出去」。换出口重发拿到的是一个**可能重复**的结果：
 * 用户看到同一句话说两遍，而日志里两条都写着成功。宁可让用户追问一次。
 *
 * ## 为什么同一个会话要排队
 *
 * 群里两个人同时 @ 她，两条回调会几乎同时到达。两条并发会得到两段互不知情的
 * 回答，群里看到的是「她同时在说两件不相干的事」。排队是安全的：
 * 每条消息自带自己的 `sessionWebhook`，晚几秒发完全没问题。
 *
 * ## 去重表为什么用 `Map` 而不是 `Record`
 *
 * `Record<string, number>` 上取下标在 `noUncheckedIndexedAccess` 关闭时类型是
 * `number`，于是「判一下有没有」写成 `!== undefined` 会被 TS 判成「类型无重叠」；
 * 写 `?? 0` 则右操作数是死代码。`Map.get()` 天然是 `number | undefined`，
 * 两种写法都对——这不是风格问题，是一处会编译不过的地方。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AdapterStats,
  AdapterStatus,
  AdmissionLike,
  ConversationKind,
  CredentialLoad,
  DingTalkPush,
  DingtalkService,
  HealthLike,
  InboundMessage,
  IngestOutcome,
  IngestReason,
  KitLike,
  PushResult,
  ReplyVia,
  RouterLike,
  SendOutcome,
  SendReason,
} from './types.js'
import { CHANNEL_ID, JSON_CONTENT_TYPE, SESSION_MARGIN_MS } from './types.js'
import type { Config as Settings } from './settings.js'
import { isRecord } from './settings.js'
import { activeReadyOf } from './credential.js'
import { signReasonText, verifySign } from './sign.js'
import { dedupeKeyOf, inboundOf, msgTypeOf, parseJson, robotCodeOf } from './wire.js'

/** 日志最小面（cordis logger 的 printf 形态）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 去重表的容量上限。 */
export const SEEN_LIMIT = 4_000

/** 学过身份的会话上限：主动发言要用 `staffId` / `openConversationId`。 */
export const CONTACT_LIMIT = 500

/** 一条学到的会话身份（主动接口要用）。 */
interface Contact {
  /** 私聊还是群。 */
  readonly kind: ConversationKind
  /** 私聊要用：收信人 staffId。 */
  readonly staffId: string
  /** 主动接口要用：robotCode（优先取凭据，缺了用报文里的）。 */
  readonly robotCode: string
  /** 最后一次更新时刻（毫秒）。 */
  readonly at: number
}

/**
 * 解析状态文件。坏字段逐条丢弃，**不整份作废**。
 * @param value 读出来的 JSON。
 */
export function parseSeen(value: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!isRecord(value)) return out
  const holder = value['seen']
  if (!isRecord(holder)) return out
  for (const [key, raw] of Object.entries(holder)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue
    out.set(key, raw)
  }
  return out
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
  /** 发信实现（凭据不齐时为 `null`）。 */
  readonly push: DingTalkPush | null
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
 * 会话 id（本项目口径）。
 *
 * 钉钉的 `conversationId` 里可能带 `=`、`+`、`/`（base64），这些字符进 id 没问题，
 * 但**不能做大小写折叠**——只差大小写的两个 id 是两个不同的群。
 * @param conversationId 钉钉会话 id。
 */
export function conversationOf(conversationId: string): string {
  return CONVERSATION_PREFIX + conversationId
}

/**
 * 从会话 id 反解钉钉的 `conversationId`。**大小写原样保留**。
 * @param conversationId 本项目的会话 id。
 */
export function parseConversation(conversationId: string): string | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const inner = conversationId.slice(CONVERSATION_PREFIX.length)
  return inner === '' ? null : inner
}

/** 钉钉适配器。 */
export class DingtalkAdapter implements DingtalkService {
  private readonly deps: AdapterDeps
  private readonly seen: Map<string, number>
  private credential: CredentialLoad
  private pushImpl: DingTalkPush | null
  private registered = false
  private stateDirty = false
  private lastFlush = 0
  private lastError: string | null = null

  private inbound = 0
  private answering = 0
  private sent = 0
  private sentSession = 0
  private sentActive = 0
  private worstAnswerMs = 0
  /** 按原因分桶的忽略/拒绝计数。用 `Map` 的理由同去重表：`Record` 下标 + `??` 是死代码。 */
  private readonly rejected = new Map<string, number>()
  private readonly inflight = new Set<string>()
  private readonly pending = new Map<string, InboundMessage[]>()
  private readonly contacts = new Map<string, Contact>()

  constructor(deps: AdapterDeps) {
    this.deps = deps
    this.seen = this.loadState()
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

  get reason(): IngestReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (!this.credential.ok) return 'no-credentials'
    return undefined
  }

  /** 读状态文件。坏文件按空状态处理，但一定留一句日志。 */
  private loadState(): Map<string, number> {
    const file = this.deps.files.state
    if (!this.deps.settings.persist || file === '') return new Map()
    try {
      if (!existsSync(file)) return new Map()
      return parseSeen(JSON.parse(readFileSync(file, 'utf8')) as unknown)
    } catch {
      this.deps.log.warn('去重状态文件读不出来，已按空状态启动（重启后可能把同一句话答两遍）：%s', file)
      return new Map()
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
   * 换发信实现（注入测试桩或企业内网关时用）。
   * @param push 实现。
   */
  setPush(push: DingTalkPush | null): void {
    this.pushImpl = push
  }

  /** 重读凭据（改完文件后调用，不必重启）。 */
  reload(): CredentialLoad {
    this.credential = this.deps.readCredential()
    this.pushImpl?.invalidate()
    return this.credential
  }

  /**
   * 处理一次回调。**先回 200 空体，回答在后台跑。**
   * @param rawBody 原始报文。
   * @param headers 已归一化（小写键）的请求头；验签要 `timestamp` 与 `sign`。
   * @param at 收到时刻（毫秒，缺省取 now）。
   */
  async ingest(rawBody: string, headers: Readonly<Record<string, string>>, at?: number): Promise<IngestOutcome> {
    const startedAt = at ?? this.deps.now()
    this.inbound += 1

    // 关着的时候也回 200：关通道是用户的选择，不是故障；回 4xx 会让钉钉重投。
    if (!this.deps.settings.enable) return this.ack('disabled', false, '通道开关关着')

    const value = this.credential.value
    if (!this.credential.ok || value === undefined) {
      return this.reject('no-credentials', 401, this.credential.detail)
    }

    // 验签在解析之前：报文都不必信，先确认它是钉钉发的。
    const verdict = verifySign(
      { timestamp: headers['timestamp'] ?? '', sign: headers['sign'] ?? '' },
      value.appSecret,
      startedAt,
      this.deps.settings.signSkewMs,
    )
    if (!verdict.ok) return this.reject('bad-sign', 401, signReasonText(verdict.reason) + '：' + verdict.detail)

    const payload = parseJson(rawBody)
    if (payload === null) return this.reject('bad-body', 400, '报文不是 JSON 对象')

    if (msgTypeOf(payload) !== 'text') {
      // 图片/文件/卡片一律收下但不回：回一句「我看不懂」比不回更烦人。
      return this.ack('unsupported', false, '只处理文本：' + msgTypeOf(payload))
    }

    const message = inboundOf(payload, startedAt)
    if (message === null) return this.ack('bad-body', false, '报文解析不出 conversationId')

    const conversationId = conversationOf(message.conversationId)
    this.report('inbound')

    // 屏蔽优先于允许：拉黑的人在白名单里也不回。
    const senderKeys = [message.senderStaffId, message.senderId]
    const blocked = this.deps.settings.blockSenderIds
    if (blocked.some(id => id !== '' && senderKeys.includes(id))) {
      return this.ack('not-allowed', false, 'blockSenderIds 命中')
    }
    const allow = this.deps.settings.allowSenderIds
    if (allow.length > 0 && !allow.some(id => senderKeys.includes(id))) {
      return this.ack('not-allowed', false, 'allowSenderIds 非空且不含此人')
    }

    if (message.text === '') {
      // 群里只 @ 了她、没有正文：这不是一句话，回答什么都是猜。
      return this.ack('unsupported', false, '剥掉 @ 之后没有正文')
    }

    // 走到这里说明这条真的会被回答，才记它的会话身份（主动接口要用）。
    // 拦在白名单之外的来信不该留下 `staffId`——那等于替被拉黑的人建了档案。
    this.remember(message, robotCodeOf(payload), startedAt)

    const key = dedupeKeyOf(message)
    const seenAt = this.seen.get(key)
    if (seenAt !== undefined && startedAt - seenAt < this.deps.settings.dedupeWindowMs) {
      return this.ack('duplicate', false, '同一 msgId 已处理过')
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
    const group = message.kind === 'group'
    try {
      return router.admit({
        channelId: CHANNEL_ID,
        conversationId,
        kind: message.kind,
        // 群里只有被 @ 才会有这条回调（平台行为），所以触发方式天然是 mention。
        trigger: group || message.inAtList ? 'mention' : 'message',
        text: message.text,
        messageId: message.messageId,
        senderId: message.senderStaffId !== '' ? message.senderStaffId : message.senderId,
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
      await this.sendPieces(message, this.fitPieces(pieces))
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
   * ## 路由交出的正文为什么**不**发出去
   *
   * `router.release()` 交出的 `QueueItem.text` 是**用户说的那句话**，不是她的回答。
   * 把它发到会话里等于「把用户的话原样复读一遍」——用户看得见，日志全绿。
   *
   * 本地 `pending` 里存着同一批消息的**完整来信**（带 `sessionWebhook` 与发信人），
   * 由 `pump()` 按正常路径回答。所以这里只把路由的返回值当「占位已归还」的信号，
   * 数一下条数，剩下交给 `pump()`。
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
        this.note('释放会话抛错：%s', messageOf(error))
      }
    }

    // 释放完就把「能起的都起起来」：只处理自己这条队列是不够的。
    // 被全局并发挤掉的往往是**另一个会话**，它的队列只有在任意一轮收尾时才可能被看见。
    this.pump()
  }

  /**
   * 在并发额度内尽量把排队的回合起起来。
   *
   * 每个会话同时只跑一轮；全局额度满就停手，等下一次收尾再补。
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
   * 发若干段。**空串一律跳过**：一个空串会变成一条空气泡，用户看得见、日志全绿。
   *
   * 每段发之前重判一次出口（4000 字切三段时，最后一段可能刚好跨过 sessionWebhook 期限）。
   * @param message 投递用的身份信息。
   * @param pieces 段。
   */
  private async sendPieces(message: InboundMessage, pieces: readonly string[]): Promise<void> {
    if (pieces.length === 0) return
    const push = this.pushImpl
    if (push === null) {
      this.note('没有发信实现（凭据或 fetch 缺失），这几段发不出去：%d 段', pieces.length)
      return
    }

    let done = 0
    for (const [index, piece] of pieces.entries()) {
      let exit = this.resolveExit(message, this.deps.now())
      if (exit === 'none') {
        this.note('这条没有任何可用出口（%s）：本轮已发 %d/%d 段', this.exitReason(message), done, pieces.length)
        return
      }

      // 只在第一段 @ 提问者：每段都 @ 等于连续三次提醒。
      const atUserIds =
        index === 0 && message.kind === 'group' && message.senderStaffId !== '' ? [message.senderStaffId] : []

      let result: PushResult = await this.sendOne(push, message, piece, exit, atUserIds)

      // 只在这句话**确定没发出去**（sessionWebhook 已过期）时才换出口。
      // 超时不在此列：超时是「不知道发没发」，重发可能让她说两遍。
      if (!result.ok && exit === 'session') {
        const later = this.deps.now()
        if (this.canFallback() && this.expiredAt(message, later)) {
          exit = 'active'
          result = await this.sendOne(push, message, piece, exit, atUserIds)
        }
      }

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
      if (exit === 'active') this.sentActive += 1
      else this.sentSession += 1
      this.report('outbound')
      if (this.deps.settings.verbose) {
        this.deps.log.info('消息已发一段（%d/%d，出口 %s）', done, pieces.length, exit)
      }
    }
  }

  /**
   * 发一段（单条出口调用）。
   * @param push 实现。
   * @param message 投递用的身份信息。
   * @param text 正文。
   * @param exit 走哪条出口。
   * @param atUserIds 要 @ 的人。
   */
  private async sendOne(
    push: DingTalkPush,
    message: InboundMessage,
    text: string,
    exit: 'session' | 'active',
    atUserIds: readonly string[],
  ): Promise<PushResult> {
    if (exit === 'session') {
      return push.pushSession({ webhook: message.sessionWebhook, text, atUserIds })
    }
    const contact = this.contacts.get(message.conversationId)
    const staffId = message.senderStaffId !== '' ? message.senderStaffId : (contact === undefined ? '' : contact.staffId)
    return push.pushActive({
      kind: message.kind,
      conversationId: message.conversationId,
      userId: staffId,
      text,
    })
  }

  /**
   * sessionWebhook 在这一刻还能用吗。
   *
   * 平台没给过期时刻（0）时按**可用**处理：那多半是老形态报文，
   * 拒掉它等于让这批消息一条都发不出去。真过期了会以 `errcode` 回来。
   * @param message 来信。
   * @param at 时刻。
   */
  private expiredAt(message: InboundMessage, at: number): boolean {
    if (message.sessionWebhook.trim() === '') return true
    if (message.sessionExpiredAt <= 0) return false
    return at + SESSION_MARGIN_MS >= message.sessionExpiredAt
  }

  /**
   * 能不能在 sessionWebhook 不可用时改走主动接口。
   */
  private canFallback(): boolean {
    if (this.deps.settings.replyVia !== 'auto') return false
    if (this.pushImpl === null) return false
    return activeReadyOf(this.credential.value)
  }

  /**
   * 这一刻该走哪条出口。`none` = 两条都不行。
   * @param message 来信。
   * @param at 时刻。
   */
  private resolveExit(message: InboundMessage, at: number): 'session' | 'active' | 'none' {
    const via: ReplyVia = this.deps.settings.replyVia
    const expired = this.expiredAt(message, at)
    if (via === 'session') return expired ? 'none' : 'session'
    if (via === 'active') return activeReadyOf(this.credential.value) ? 'active' : 'none'
    if (!expired) return 'session'
    return activeReadyOf(this.credential.value) ? 'active' : 'none'
  }

  /**
   * 说不出出口时给人看的原因。
   * @param message 来信。
   */
  private exitReason(message: InboundMessage): SendReason {
    if (this.expiredAt(message, this.deps.now())) {
      return activeReadyOf(this.credential.value) ? 'expired-session' : 'no-app-key'
    }
    return this.deps.settings.replyVia === 'active' ? 'no-app-key' : 'expired-session'
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

  /**
   * 主动发一条。**必须学过这条会话的身份**（私聊要 staffId、群要 conversationId）。
   *
   * 与「回一条来信」的区别：这里没有 `sessionWebhook`，只能走主动接口，
   * 所以既要求 `appKey`/`robotCode`，也要求这条会话之前来过消息。
   * @param conversationId 会话 id。
   * @param text 正文。
   */
  async reply(conversationId: string, text: string): Promise<SendOutcome> {
    const inner = parseConversation(conversationId)
    if (inner === null) return sendOutcome(false, 'empty', 'none', 0, 0)
    if (!this.deps.settings.enable) return sendOutcome(false, 'disabled', 'none', 0, 0)
    if (!this.credential.ok) return sendOutcome(false, 'no-credentials', 'none', 0, 0)

    const trimmed = text.trim()
    if (trimmed === '') return sendOutcome(false, 'empty', 'none', 0, 0)

    const contact = this.contacts.get(inner)
    if (contact === undefined) return sendOutcome(false, 'no-sender', 'none', 0, 0)
    if (!activeReadyOf(this.credential.value)) return sendOutcome(false, 'no-app-key', 'none', 0, 0)

    const ready = this.fitPieces([trimmed])
    if (ready.length === 0) return sendOutcome(false, 'no-kit', 'none', 0, 0)

    const push = this.pushImpl
    if (push === null) return sendOutcome(false, 'no-transport', 'none', 0, 0)

    let done = 0
    for (const piece of ready) {
      const result = await push.pushActive({
        kind: contact.kind,
        conversationId: inner,
        userId: contact.staffId,
        text: piece,
      })
      if (!result.ok) {
        return sendOutcome(false, result.reason ?? 'http', 'active', ready.length, done, result.errcode, result.errmsg)
      }
      done += 1
      this.sent += 1
      this.sentActive += 1
      this.report('outbound')
    }
    return sendOutcome(true, 'ok', 'active', ready.length, done)
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
      writeTextAtomic(file, JSON.stringify({ seen: Object.fromEntries(this.seen) }))
      this.stateDirty = false
    } catch (error) {
      this.deps.log.warn('状态落盘失败（下次再试）：%s', messageOf(error))
    }
  }

  /**
   * 记一条会话身份（主动接口要用），并按容量淘汰最旧的。
   * @param message 来信。
   * @param robotCode 报文里的 robotCode。
   * @param at 时刻。
   */
  private remember(message: InboundMessage, robotCode: string, at: number): void {
    const previous = this.contacts.get(message.conversationId)
    const staffId =
      message.senderStaffId !== '' ? message.senderStaffId : previous === undefined ? '' : previous.staffId
    const code = robotCode !== '' ? robotCode : previous === undefined ? '' : previous.robotCode
    this.contacts.set(message.conversationId, { kind: message.kind, staffId, robotCode: code, at })
    if (this.contacts.size <= CONTACT_LIMIT) return

    // 淘汰最久没说话的那批（一条一条淘汰会在每次插入时都重排一次）。
    const ordered = [...this.contacts.entries()].sort((left, right) => left[1].at - right[1].at)
    for (const [key] of ordered.slice(0, ordered.length - CONTACT_LIMIT)) this.contacts.delete(key)
  }

  /**
   * 记一条去重键。超过容量时淘汰最早的那批。
   * @param key 去重键。
   * @param at 时刻。
   */
  private markSeen(key: string, at: number): void {
    this.seen.set(key, at)
    this.stateDirty = true
    if (this.seen.size <= SEEN_LIMIT) return
    const ordered = [...this.seen.entries()].sort((left, right) => left[1] - right[1])
    for (const [item] of ordered.slice(0, ordered.length - SEEN_LIMIT)) this.seen.delete(item)
  }

  /**
   * 清掉过期的去重记录。
   * @param at 时刻。
   */
  private prune(at: number): void {
    const horizon = at - this.deps.settings.dedupeWindowMs
    for (const [key, seenAt] of this.seen) {
      if (seenAt < horizon) this.seen.delete(key)
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
      activeReady: activeReadyOf(this.credential.value),
      allowlist: this.deps.settings.allowSenderIds.length,
      inflight: this.inflight.size,
      queued,
      contacts: this.contacts.size,
      lastError: this.lastError,
    }
  }

  /** 计数。 */
  stats(): AdapterStats {
    return {
      inbound: this.inbound,
      answering: this.answering,
      sent: this.sent,
      rejected: Object.fromEntries(this.rejected),
      byExit: { session: this.sentSession, active: this.sentActive },
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
   * 受理 / 忽略都回 200 空体，只是原因与是否回答不同。
   * @param reason 原因。
   * @param answering 是否会回答。
   * @param detail 说明。
   */
  private ack(reason: IngestReason, answering: boolean, detail?: string): IngestOutcome {
    const disposition = reason === 'ok' ? 'accept' : 'ignore'
    if (disposition === 'ignore') {
      const bucket = 'ignore.' + reason
      this.count(bucket)
      if (reason !== 'ignored') this.deps.log.info('已受理但不再回答（%s）：%s', reason, detail ?? '')
    }
    const base: IngestOutcome = {
      http: 200,
      body: '',
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
    const bucket = 'reject.' + reason
    this.count(bucket)
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

  /**
   * 计数一个桶。
   * @param bucket 桶名。
   */
  private count(bucket: string): void {
    this.rejected.set(bucket, (this.rejected.get(bucket) ?? 0) + 1)
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
 * @param via 走哪条出口。
 * @param pieces 段数。
 * @param sent 已发段数。
 * @param errcode 平台错误码。
 * @param errmsg 平台错误说明。
 */
function sendOutcome(
  ok: boolean,
  reason: SendReason,
  via: ReplyVia | 'none',
  pieces: number,
  sent: number,
  errcode?: number,
  errmsg?: string,
): SendOutcome {
  const base = { ok, reason, via, pieces, sent }
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
