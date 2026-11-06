/**
 * Discord 适配器：**连、判来源、问人格、发回去**。不 listen 任何端口。
 *
 * ## 一层的边界在哪
 *
 * 本包**不认识一个字节的 WS 帧**。它只跟 `DiscordSocket` 端口打交道：
 * `open(handlers)` / `close()`，以及四个回调 `onReady / onEvent / onClosed / onError`。
 * 帧 op 码、IDENTIFY 载荷、心跳与 ACK、RESUME、zlib 分片全归实现方。
 *
 * 这条边界不是「省事」，是**唯一诚实的切法**：手册 §9.11 只有一行
 * （`Gateway WS v10 自实现 IDENTIFY+心跳` / `Bot <token>` / `1900` /
 * `4004 停止重连，其余 5s` / **无去重**），没有 op 码表，本仓 `MESSAGE_CREATE` /
 * `HELLO` / `RESUME` / `op_code` / `intents` 全 0 命中。拼一版假握手的最坏形态是
 * **连上了、READY 也来了、然后一条消息都收不到**（intents 算错），
 * 与「根本没接」在日志上完全同形。
 *
 * ## 「无去重」到底是什么意思
 *
 * 手册写「无去重」。这不是「忘了做」，是三条事实的结论：
 *
 * 1. Discord 靠 `RESUME` + 序列号保证不漏，已 ACK 的事件**不会重投**——
 *    跨时间的去重表本来就无事可做；
 * 2. 用户**真的会**连发两遍同一句话。用文本做键的去重表会吞掉第二句，
 *    症状是「她漏看了我说的那句」，比重复回答更难解释；
 * 3. 去重表要落盘才有意义，落盘就得管容量与过期，而它保护的东西并不存在。
 *
 * 但**同一时刻**同一个 `message.id` 出现两次一定是错的（端口实现方重放）。
 * 所以本包维护一个 `inflightIds` 集合：**容量 = 并发数、不落盘、答完就删**。
 * 它防的是「重复投递」这一种坏情况，不是「用户重复说话」。
 * 两者混为一谈就会做出一个吞消息的去重表。
 *
 * ## 为什么断开只有本插件说了算
 *
 * `DiscordSocket` 的契约写明：实现方**不得自行重连**，断开只能 `onClosed(code)`。
 * 若端口自己重连、本插件也重连，会同时有两条 WS 收同一批事件 →
 * 同一条消息答两遍。而 Discord **没有去重**，重复回答不可逆。
 * 一个决定点（`planOf()`）比两处各一套重连策略安全。
 *
 * ## 为什么 `ingest()` 是同步的
 *
 * 端口调 `onEvent` 时，它期待「这条我交了」。若 `ingest` 是 async，
 * 端口就得决定「等不等它」——而两种选择都错：等，会阻塞整条 WS 的读；
 * 不等，它会以为交完了。所以 `ingest` **只做判定与分派**（同步返回结论），
 * 回答在后台跑。这与「推进游标 ≠ 答完」是同一个取舍。
 */

import type {
  AdapterStats,
  AdapterStatus,
  AdmissionLike,
  CredentialLoad,
  DiscordPush,
  DiscordService,
  DiscordSocket,
  HealthLike,
  IngestOutcome,
  IngestReason,
  InboundMessage,
  KitLike,
  MeResult,
  RouterLike,
  SendOutcome,
  SendReason,
} from './types.js'
import { CHANNEL_ID } from './types.js'
import type { Config as Settings } from './settings.js'
import { redactToken } from './credential.js'
import { LinkMachine, planOf } from './link.js'
import { explainOf } from './wire.js'

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
  /** 日志（命名空间 `channel.discord`）。 */
  readonly log: LogLike
  /** 时间源。 */
  now(): number
  /** 凭据文件绝对路径（只用于提示「权限已收紧」，**不读它**）。 */
  readonly credentialFile: string
  /** REST 实现（凭据不齐时为 `null`）。 */
  readonly push: DiscordPush | null
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
 * Discord 的频道 id 是雪花号（纯数字、全局唯一），所以群与私聊不会撞；
 * 用 `channel_id` 而不是 `guild_id`，因为**回复必须发到频道**——
 * 一个服务器里可能有十几个频道，按 guild 归一化会让回答跑进别的频道。
 * @param channelId 频道 id。
 */
export function conversationOf(channelId: string): string {
  return CONVERSATION_PREFIX + channelId
}

/**
 * 从会话 id 反解频道 id。
 * @param conversationId 本项目的会话 id。
 */
export function parseConversation(conversationId: string): string | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const text = conversationId.slice(CONVERSATION_PREFIX.length)
  if (!/^\d{1,20}$/.test(text)) return null
  return text
}

/** 一条排队中的来信。 */
interface QueuedMessage {
  readonly message: InboundMessage
  readonly at: number
}

/** Discord 适配器。 */
export class DiscordAdapter implements DiscordService {
  private readonly deps: AdapterDeps
  private credential: CredentialLoad
  private pushImpl: DiscordPush | null
  private socket: DiscordSocket | null = null
  private botUserId = ''
  private botUsername: string | null = null

  private readonly link = new LinkMachine()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private halted = false

  private lastEventAt = 0
  private lastError: string | null = null

  private events = 0
  private messages = 0
  private answered = 0
  private sent = 0
  private connects = 0
  private reconnects = 0
  private worstAnswerMs = 0
  /** 按原因分桶的忽略数。用 `Map` 的理由同 `inflightIds`：`Record` 下标 + `??` 是死代码。 */
  private readonly rejected = new Map<string, number>()
  private readonly inflight = new Set<string>()
  /**
   * 幂等占位：`message.id` → 接住时刻。
   *
   * **不是去重表**（手册 §9.11 明写「无去重」）：它只覆盖「**已接住、还没答完**」
   * 这一小段窗口——在飞的 + 排队的；答完（或过期丢弃）立刻删。不跨时间、不落盘。
   * 防的只有一种情况：端口实现方把同一条已 ACK 的事件又递了一遍。
   *
   * 它**不**拦「用户连发两遍同一句话」——那两条 `message.id` 不同，照答。
   * 用**文本**做键才会吞消息，这是本包刻意不做的（见文件头）。
   */
  private readonly inflightIds = new Map<string, number>()
  private readonly pending = new Map<string, QueuedMessage[]>()

  constructor(deps: AdapterDeps) {
    this.deps = deps
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
    return this.deps.settings.enable && this.credential.ok && this.socket !== null && this.link.state === 'ready'
  }

  get reason(): IngestReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (!this.credential.ok) return 'no-credential'
    if (this.socket === null) return 'no-socket'
    if (this.link.state !== 'ready') return 'not-ready'
    return undefined
  }
  /**
   * 注入帧层实现。**已在跑时拒绝换**：换掉在跑的那个等于让旧连接的
   * 事件落在新实现上，两条流会混在一起。
   * @param socket 实现（`null` = 摘掉）。
   */
  useSocket(socket: DiscordSocket | null): boolean {
    if (this.link.state === 'connecting' || this.link.state === 'ready') return false
    this.socket = socket
    return true
  }

  /**
   * 换 REST 实现（注入测试桩时用）。
   * @param push 实现。
   */
  setPush(push: DiscordPush | null): void {
    this.pushImpl = push
  }

  /** 重读凭据。**会先停一次连接**，由调用方决定要不要再 `start()`。 */
  reload(): CredentialLoad {
    this.stop()
    this.credential = this.deps.readCredential()
    this.botUserId = ''
    this.botUsername = null
    this.link.reset()
    return this.credential
  }

  /** 开始连接。重复调用无副作用。 */
  start(): void {
    this.halted = false
    this.openOnce()
  }

  /** 停止连接（立旗 → 关端口 → 清定时器；幂等）。 */
  stop(): void {
    // 顺序：立旗 → 关端口 → 清定时器。
    // 先清定时器再立旗，会让在飞的那次 open() 在卸载之后把连接建起来。
    this.halted = true
    this.link.halt()
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const socket = this.socket
    if (socket !== null) {
      try {
        socket.close()
      } catch (error) {
        this.deps.log.warn('关闭帧层端口抛错（已忽略）：%s', redactToken(errorOf(error)))
      }
    }
  }

  /**
   * 尝试连一次。**唯一一处调 `socket.open()`。**
   */
  private openOnce(): void {
    if (this.halted) return
    if (!this.deps.settings.enable) return

    const socket = this.socket
    if (socket === null) {
      // 没有帧层实现：明确说出来，不要安静地什么都不做。
      this.note('没有帧层实现（DiscordSocket）：用 useSocket() 注入后才能连上。现在只注册服务与能力')
      return
    }

    const generation = this.link.begin(this.credential, socket !== null)
    if (generation === 0) return

    this.connects += 1
    const handlers = {
      onReady: (info: { readonly sessionId?: string; readonly botUserId?: string }): void => {
        if (!this.link.markReady(generation)) return
        if (info.botUserId !== undefined && info.botUserId !== '') this.botUserId = info.botUserId
        this.report('connected')
        this.deps.log.info(
          'Discord 网关已连上（%s）。心跳与 RESUME 由帧层实现负责；本插件只管「该不该回」与「回什么」',
          info.sessionId === undefined || info.sessionId === '' ? '无 session 信息' : 'session ' + info.sessionId,
        )
      },
      onEvent: (raw: Record<string, unknown>): void => {
        // 端口交进来的事件一律先计一次数：**收到 ≠ 是消息**，两个数都要能看见。
        this.events += 1
        if (this.deps.settings.verbose) this.deps.log.info('收到事件（第 %d 条）', this.events)
        this.ingest(raw)
      },
      onClosed: (closeCode: number, reason?: string): void => {
        if (!this.link.markClosed(generation, closeCode)) return
        this.report('disconnected', String(closeCode))
        const plan = planOf(closeCode, this.deps.settings)
        this.lastError = plan.detail
        if (reason !== undefined && reason !== '') {
          this.deps.log.warn('网关关闭：%d（%s）→ %s', closeCode, redactToken(reason), plan.detail)
        } else {
          this.deps.log.warn('网关关闭：%d → %s', closeCode, plan.detail)
        }
        if (plan.action === 'stop') {
          // 停下但不调 halt()：`halt()` 会把状态设成 `stopped`，而这里想保留
          // 「它自己断了且不再重连」这个语义，面板要能分辨「用户关的」与「鉴权失败的」。
          this.halted = true
          this.link.halt()
          return
        }
        this.scheduleRetry(plan.delayMs)
      },
      onError: (detail: string): void => {
        // 非致命错误：只记，不改连接状态。改状态会让一次「某条事件解析失败」
        // 把整个连接判死。
        this.deps.log.warn('帧层报错（连接状态未变）：%s', redactToken(detail))
      },
    }

    void socket
      .open(handlers)
      .then(result => {
        if (result.ok) return
        // 打开就失败：与断开走同一套处置，避免两套重连策略。
        const plan = result.reason === 'unauthorized' ? planOf(4004, this.deps.settings) : planOf(0, this.deps.settings)
        this.link.markClosed(generation, result.reason === 'unauthorized' ? 4004 : 0)
        const detail = result.detail === undefined ? plan.detail : redactToken(result.detail)
        this.lastError = '打开连接失败（' + result.reason + '）：' + detail
        this.deps.log.warn('打开连接失败（%s）：%s', result.reason, detail)
        this.report('error', result.reason)
        if (plan.action === 'stop') {
          this.halted = true
          this.link.halt()
          return
        }
        this.scheduleRetry(plan.delayMs)
      })
      .catch((error: unknown) => {
        // 端口契约说 `open()` 永不抛错，但「永不」要靠人守。这里兜一层：
        // 它抛了不能把本插件带走（手册 §8.1-C3：器官错误不得传播）。
        this.link.markClosed(generation, 0)
        this.lastError = '打开连接抛错：' + redactToken(errorOf(error))
        this.deps.log.warn('打开连接抛错（按可重连处理）：%s', this.lastError)
        this.scheduleRetry(this.deps.settings.reconnectMs)
      })
  }

  /**
   * 排一次重连。
   * @param delayMs 等多久。
   */
  private scheduleRetry(delayMs: number): void {
    if (this.halted) return
    if (!this.deps.settings.enable) return
    if (this.retryTimer !== null) return
    const delay = delayMs <= 0 ? this.deps.settings.reconnectMs : delayMs
    this.link.scheduleRetry(this.deps.now(), delay)
    this.reconnects += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.openOnce()
    }, delay)
    const maybe = this.retryTimer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()
  }

  /**
   * 受理一条原始事件。**同步**：只做判定与分派（见文件头）。
   * @param raw 原始事件。
   * @param at 收到时刻（毫秒）。
   */
  ingest(raw: Record<string, unknown>, at?: number): IngestOutcome {
    const startAt = at ?? this.deps.now()
    if (!this.deps.settings.enable) return this.reject('disabled')
    if (!this.credential.ok) return this.reject('no-credential')
    // 连接没 ready 时也接（端口可能在 `connecting` 阶段就递事件），
    // 但**明确记一个理由**：否则面板上「关了」「缺施工件」「还没连上」三种情况
    // 全都显示成「没收到消息」，排查方向完全不同。
    if (this.socket === null) return this.reject('no-socket')

    // `explainOf()` 会告诉我们「为什么不是」，而不是只回 null——
    // 「不是消息」与「她自己发的」在排查时导向相反的方向。
    const parsed = explainOf(raw, this.botUserId)
    if (parsed.message === null) return this.reject(parsed.reason)
    const message = parsed.message

    if (message.text.trim() === '') {
      return this.reject('empty')
    }

    const blocked = this.deps.settings.blockSenderIds
    if (message.senderId === '') {
      return this.reject('bad-id')
    }
    if (blocked.includes(message.senderId)) {
      return this.reject('not-allowed')
    }
    const allow = this.deps.settings.allowSenderIds
    if (allow.length > 0 && !allow.includes(message.senderId)) {
      return this.reject('not-allowed')
    }

    // 同 id 已被接住且还没答完 → 丢弃。**这不是去重表**：只覆盖
    // 「在飞的 + 排队的」那一小段窗口，答完即删（见 `inflightIds` 注释与文件头）。
    if (this.inflightIds.has(message.messageId)) {
      return this.reject('replayed')
    }

    this.messages += 1
    this.lastEventAt = this.deps.now()
    this.report('inbound')

    const conversationId = conversationOf(message.channelId)
    if (this.inflight.has(conversationId) || this.inflight.size >= this.deps.settings.maxConcurrent) {
      // **入队也必须占位**：否则端口把同一条重放一次，就会排进两个队列位、
      // 答两遍。占位在建队列项之前，两者在同一个同步块里，不存在中间态。
      this.inflightIds.set(message.messageId, startAt)
      this.enqueue(conversationId, message, startAt)
      return this.deferred(conversationId)
    }

    const admission = this.admit(message, conversationId, startAt)
    if (admission.action === 'ignore' || admission.action === 'deny') {
      return this.reject('ignored')
    }
    if (admission.action === 'queue') {
      this.inflightIds.set(message.messageId, startAt)
      this.enqueue(conversationId, message, startAt)
      return this.deferred(conversationId)
    }

    this.inflight.add(conversationId)
    this.inflightIds.set(message.messageId, startAt)
    this.answered += 1
    void this.answer(message, conversationId, admission.reserved)
    return { ok: true, reason: 'accepted', conversationId }
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
        // 群里可能没 @ 就来了（取决于 intents 与频道设置），此时按普通消息触发；
        // 是否真回由 router 的唤醒纪律判（手册 §5.4：只在私聊唤醒）。
        trigger: message.kind === 'group' && message.mentioned ? 'mention' : 'message',
        text: message.text,
        messageId: message.messageId,
        senderId: message.senderId,
        at,
      })
    } catch (error) {
      this.note('路由判定抛错（按「直接回」处理）：%s', redactToken(errorOf(error)))
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
      // 刻意不传 `timeoutMs`：`kit` 的配置里那份才是模型超时，
      // 本包的 `requestTimeoutMs` 是 HTTP 超时，两者混用会让模型调用被 15 秒砍断。
      const result = await kit.callPersona({
        conversationId,
        text: message.text,
        maxChars: this.deps.settings.chunkMax,
      })
      if (!result.ok) {
        // **半句话不发**：`ok=false` 时 `text` 可能非空（超时前吐了半句）。
        // 半句话比没话更糟——用户以为她说了一句没头没尾的话。
        this.note('本轮没有可用回复（%s），不发', result.failure ?? 'unknown')
        return
      }
      const pieces = result.pieces.length > 0 ? result.pieces : [result.text]
      await this.sendPieces(message.channelId, this.fitPieces(pieces))
    } catch (error) {
      this.note('回答时抛错：%s', redactToken(errorOf(error)))
    } finally {
      this.observeAnswer(startedAt)
      this.releaseAndDrain(conversationId, reserved, message.messageId)
    }
  }

  /**
   * 释放会话，再把排队中能起的回合起起来。
   *
   * ## 路由交出的正文为什么**不**发出去
   *
   * `router.release()` 交出的 `text` 是**用户说的那句话**，不是她的回答。
   * 发出去等于把用户的话原样复读：用户看得见，而日志每行都是成功。
   * 本地 `pending` 里存着完整来信，由 `pump()` 按正常路径回答。
   *
   * （台账已登记：O-060 / O-063 / O-064 三包有这毛病，未改。）
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话。
   * @param messageId 刚答完的消息 id（从幂等集合里摘掉）。
   */
  private releaseAndDrain(conversationId: string, reserved: boolean, messageId: string): void {
    this.inflightIds.delete(messageId)
    const router = this.deps.router()
    if (router !== undefined && reserved) {
      try {
        const released = router.release(conversationId)
        if (released.length > 0 && this.deps.settings.verbose) {
          this.deps.log.info('路由归还了 %d 条积压，按本地队列继续（不原样复读）', released.length)
        }
      } catch (error) {
        this.note('释放会话抛错：%s', redactToken(errorOf(error)))
      }
    }
    // 只补自己这条队列不够：被全局并发挤掉的往往是**另一个**会话的队列。
    this.pump()
  }

  /** 在并发额度内尽量把排队的回合起起来。 */
  private pump(): void {
    const limit = this.deps.settings.maxConcurrent
    const now = this.deps.now()
    for (const [conversationId, queue] of this.pending) {
      if (this.inflight.size >= limit) return
      if (this.inflight.has(conversationId)) continue

      // 过期的丢掉：五分钟后才答的那句话已经不是回答。
      // 占位必须一起撤，否则这条 id 再也不会被接住（永久「已接住」）。
      let next = queue.shift()
      while (next !== undefined && now - next.at > this.deps.settings.queueTtlMs) {
        this.inflightIds.delete(next.message.messageId)
        this.bucket('drop.expired')
        next = queue.shift()
      }
      if (queue.length === 0) this.pending.delete(conversationId)
      if (next === undefined) continue

      this.inflight.add(conversationId)
      this.inflightIds.set(next.message.messageId, now)
      this.answered += 1
      void this.answer(next.message, conversationId, false)
    }
  }

  /**
   * 入队。
   * @param conversationId 会话 id。
   * @param message 来信。
   * @param at 收到时刻。
   */
  private enqueue(conversationId: string, message: InboundMessage, at: number): void {
    const queue = this.pending.get(conversationId) ?? []
    queue.push({ message, at })
    this.pending.set(conversationId, queue)
  }

  /**
   * 发若干段。**空串一律跳过**：一个空串会变成一条空气泡，用户看得见、日志全绿。
   * @param channelId 频道 id。
   * @param pieces 段。
   */
  private async sendPieces(channelId: string, pieces: readonly string[]): Promise<void> {
    if (pieces.length === 0) return
    const push = this.pushImpl
    if (push === null) {
      this.note('没有 REST 实现（凭据或 fetch 缺失），这几段发不出去：%d 段', pieces.length)
      return
    }

    let done = 0
    for (const piece of pieces) {
      const result = await push.sendMessage({ channelId, text: piece })
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
        this.note('切条抛错，这一段不发：%s', redactToken(errorOf(error)))
      }
    }
    return out
  }

  /**
   * 主动发一条。
   *
   * Discord 没有 Telegram 那样的「用户先说话」窗口限制，随时可发。
   * 但「能发」不等于「该发」——该不该主动开口归 O-042，本包不发那个判断。
   * @param conversationId 会话 id。
   * @param text 正文。
   */
  async reply(conversationId: string, text: string): Promise<SendOutcome> {
    const channelId = parseConversation(conversationId)
    if (channelId === null) return sendOutcome(false, 'empty', 0, 0)
    if (!this.deps.settings.enable) return sendOutcome(false, 'disabled', 0, 0)
    if (!this.credential.ok) return sendOutcome(false, 'no-credentials', 0, 0)

    const trimmed = text.trim()
    if (trimmed === '') return sendOutcome(false, 'empty', 0, 0)

    const ready = this.fitPieces([trimmed])
    if (ready.length === 0) return sendOutcome(false, 'no-kit', 0, 0)

    const push = this.pushImpl
    if (push === null) return sendOutcome(false, 'no-push', 0, 0)

    let done = 0
    for (const piece of ready) {
      const result = await push.sendMessage({ channelId, text: piece })
      if (!result.ok) {
        return sendOutcome(false, result.reason ?? 'http', ready.length, done, result.errcode, result.errmsg)
      }
      done += 1
      this.sent += 1
      this.report('outbound')
    }
    return sendOutcome(true, 'ok', ready.length, done)
  }

  /** 确认 token。**只读**：不改连接状态、不改白名单。 */
  async probe(): Promise<MeResult> {
    const push = this.pushImpl
    if (push === null) {
      const reason: SendReason = this.credential.ok ? 'no-push' : 'no-credentials'
      return { ok: false, reason, errmsg: '没有 REST 实现' }
    }
    const result = await push.me()
    if (result.ok) {
      if (result.id !== undefined && result.id !== '') this.botUserId = result.id
      this.botUsername = result.username === undefined || result.username === '' ? null : result.username
      this.report('connected')
    } else {
      this.lastError = '确认 token 失败（' + (result.reason ?? 'http') + '）：' + (result.errmsg ?? '')
      this.report('error', result.reason ?? 'http')
    }
    return result
  }

  /**
   * 心跳：上报探针 + 清理过期排队。
   *
   * **与 WS 心跳无关**——WS 心跳是帧层实现方的事（手册 §9.11「自实现 IDENTIFY+心跳」）。
   * 这个 `tick()` 只做两件本地事，所以即使帧层心跳断了，它照样能证明
   * 「本插件还活着」，让面板能区分「她卡住」与「WS 断了」。
   * @param at 时刻。
   */
  tick(at?: number): void {
    const now = at ?? this.deps.now()
    this.report('heartbeat')

    // 过期排队在这里清：`pump()` 只在有回合结束时才跑，
    // 而「一直没回合结束」正是最需要清过期项的时刻。
    for (const [conversationId, queue] of this.pending) {
      const kept = queue.filter(item => now - item.at <= this.deps.settings.queueTtlMs)
      const dropped = queue.length - kept.length
      if (dropped > 0) {
        // 与 `pump()` 同一条纪律：丢一条就撤一个占位，否则那个 id 永远「已接住」。
        for (const item of queue) {
          if (now - item.at > this.deps.settings.queueTtlMs) this.inflightIds.delete(item.message.messageId)
        }
        this.rejected.set('drop.expired', (this.rejected.get('drop.expired') ?? 0) + dropped)
      }
      if (kept.length === 0) this.pending.delete(conversationId)
      else this.pending.set(conversationId, kept)
    }
  }

  /** 通道现状。 */
  status(): AdapterStatus {
    let queued = 0
    for (const queue of this.pending.values()) queued += queue.length
    const snapshot = this.link.snapshot()
    return {
      link: snapshot.state,
      channelId: CHANNEL_ID,
      credential: this.credential.ok ? { ok: true } : { ok: false, missing: this.credential.missing ?? 'shape' },
      botUsername: this.botUsername,
      allowlist: this.deps.settings.allowSenderIds.length,
      inflight: this.inflight.size,
      queued,
      lastCloseCode: snapshot.lastCloseCode,
      nextRetryAt: snapshot.nextRetryAt,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    }
  }

  /** 计数。 */
  stats(): AdapterStats {
    return {
      events: this.events,
      messages: this.messages,
      answered: this.answered,
      sent: this.sent,
      connects: this.connects,
      reconnects: this.reconnects,
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
   * 记一个忽略桶并拼结果。
   * @param reason 原因。
   */
  private reject(reason: IngestReason): IngestOutcome {
    this.bucket('ignore.' + reason)
    return { ok: false, reason }
  }

  /**
   * 已进本地队列。**与「忽略」分开**：它没被丢掉，过一会儿会答。
   * 混成一个 `ok:false` 会让面板上的 `queued` 与 `not-allowed` 长得一样。
   * @param conversationId 会话 id。
   */
  private deferred(conversationId: string): IngestOutcome {
    this.bucket('defer.queued')
    return { ok: true, reason: 'queued', conversationId }
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
  private report(
    kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error',
    code?: string,
  ): void {
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
      // 探针自己出错与通道无关（手册 §8.1-C3）。
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
 * 全包只有这一处把异常折成字符串：`fetch` 抛错、端口抛错、`JSON.stringify`
 * 循环引用抛错都会到这里。两处各写一份「取错误消息」迟早有一处忘了脱敏。
 * @param value 任意异常。
 */
export function errorOf(value: unknown): string {
  return redactToken(value instanceof Error ? value.message : String(value))
}
