/**
 * 微信个人号适配器：**接线、双闸门、两种回复出口**。不操作微信、不注册端口。
 *
 * ## 一条消息进来会发生什么
 *
 * ```
 * 桥接端 POST JSON
 *   ├─ 解析（bad-body 就 200 + ok:false，不返回 4xx：4xx 会让桥接端重试，
 *   │        而本通道**无去重**，重试就会答两遍）
 *   ├─ 资格三条（开关 / 确认位 / 确认档案）
 *   ├─ 礼貌四条（群 / 拉黑 / 白名单 / 冷却）
 *   ├─ admit（O-055）
 *   ├─ 问人格（O-056，预算 replyBudgetMs）
 *   └─ 出口：sync 写进响应；webhook 推到用户地址；超预算自动改走 webhook
 * ```
 *
 * ## 超预算为什么「交棒」而不是「取消」
 *
 * 这与 O-060（公众号）同源：那一轮不是废了，是换了出口。
 * 区别在于这里**没有平台硬限**——`replyBudgetMs` 只是「别让桥接端的 HTTP 请求干等」。
 * 所以超时后原 promise 继续跑，跑完走 webhook；同时必须立刻挂上 `then/catch`，
 * 否则那是一个 `unhandledRejection`（进程级告警，而用户完全不知道发生了什么）。
 *
 * ## 为什么没有去重
 *
 * 手册 §9.11 写的是 `无去重`，本插件照办：不去猜「这条是不是刚见过」。
 * 代价是桥接端重试会答两遍，所以**拒绝也要回 200**——把「不该回」伪装成
 * 「已处理」，让桥接端没有重试的理由。这条取舍写进 README 已知限制。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from './settings.js'
import { checkGate, markAnswered, parseCooldown, pruneCooldown } from './gate.js'
import { emptyRecord, readConfirmRecord, revokeConfirmRecord, writeConfirmRecord } from './confirm.js'
import type {
  BridgeInbound,
  ConfirmRecord,
  GateVerdict,
  HealthLike,
  IngestOutcome,
  IngestReason,
  KitLike,
  PersonalPush,
  PersonalService,
  PersonalStats,
  PersonalStatus,
  QueueItemLike,
  RouterLike,
  SendOutcome,
  SendReason,
} from './types.js'
import { CHANNEL_ID, CONFIRM_NOTE_MIN } from './types.js'

/** 日志形状（只声明本插件用到的三档）。 */
export interface LogLike {
  /** 普通。 */
  info(format: string, ...args: readonly unknown[]): void
  /** 警告。 */
  warn(format: string, ...args: readonly unknown[]): void
  /** 错误。 */
  error(format: string, ...args: readonly unknown[]): void
}

/** 适配器依赖。 */
export interface AdapterDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志（命名空间 `channel.wechat-personal`）。 */
  readonly log: LogLike
  /** 时间源（毫秒）。 */
  readonly now: () => number
  /** 确认档案路径。 */
  readonly confirmFile: string
  /** 冷却状态文件路径（空串 = 不落盘）。 */
  readonly stateFile: string
  /** 取出站实现（没配 webhook 时是 undefined）。 */
  readonly push: () => PersonalPush | undefined
  /** 取路由服务（O-055）。 */
  readonly router: () => RouterLike | undefined
  /** 取公共段（O-056）。 */
  readonly kit: () => KitLike | undefined
  /** 取探针（O-057）。 */
  readonly health: () => HealthLike | undefined
}

/** 会话 id 前缀。 */
export const CONVERSATION_PREFIX = CHANNEL_ID + ':'

/** 状态文件权限。 */
const FILE_MODE = 0o600

/** 一次释放最多再答几条（防「一释放就排回去」）。 */
export const MAX_DRAIN = 8

/**
 * 拼会话 id。
 * @param contact 会话对象。
 */
export function conversationOf(contact: string): string {
  return CONVERSATION_PREFIX + contact
}

/**
 * 拆会话 id。
 * @param conversationId 会话 id。
 */
export function parseConversation(conversationId: string): string | null {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) return null
  const contact = conversationId.slice(CONVERSATION_PREFIX.length)
  return contact === '' ? null : contact
}

/**
 * 错误转一句中文。
 * @param error 任意异常。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 序列化响应体。
 * @param payload 内容。
 */
function jsonOf(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload)
  } catch {
    // 理论上不会发生（内容都是字符串与数字），但出口不能因为序列化挂掉。
    return '{"ok":false,"reason":"bad-body"}'
  }
}

/** 微信个人号适配器。 */
export class PersonalAdapter implements PersonalService {
  private readonly deps: AdapterDeps
  private record: ConfirmRecord
  private recordExists: boolean
  private cooldown: Record<string, number>
  private dirty = false
  private mounted = false
  private active = 0
  private lastPersistAt = 0
  private lastError: string | null = null

  private inbound = 0
  private answered = 0
  private deferred = 0
  private pushed = 0
  private readonly rejected: Record<string, number> = {}

  constructor(deps: AdapterDeps) {
    this.deps = deps
    const loaded = readConfirmRecord(deps.confirmFile)
    this.record = loaded.record
    this.recordExists = loaded.exists
    this.cooldown = this.loadState()
  }

  /** 现在能不能收：资格三条全过才算。 */
  get available(): boolean {
    return this.qualify().ok
  }

  /** 不能收的原因。 */
  get reason(): IngestReason | undefined {
    const verdict = this.qualify()
    if (verdict.ok) return undefined
    return this.reasonOf(verdict)
  }

  /** 路由挂上/撤掉了。 */
  markMounted(mounted: boolean): void {
    this.mounted = mounted
  }

  /**
   * 处理一条桥接端推来的消息。
   * @param payload 已解析的 JSON（未校验）。
   * @param at 时刻（毫秒）。
   */
  async ingest(payload: unknown, at?: number): Promise<IngestOutcome> {
    const now = at ?? this.deps.now()
    this.inbound += 1
    this.report('inbound')

    const parsed = this.parseInbound(payload, now)
    if (parsed === null) return this.reject('bad-body', '报文形状不对：需要 {"contact":"...","text":"..."}', 200)

    // 自己发的消息：wxauto 会把「我发出的一条」也当新消息推上来。
    if (parsed.self) return this.reject('ignored', '这条是自己发的（self=true），不回', 200)

    const verdict = checkGate({
      enable: this.deps.settings.enable,
      confirmed: this.deps.settings.confirmed,
      record: this.record,
      recordExists: this.recordExists,
      contact: parsed.contact,
      allow: this.deps.settings.allowContacts,
      block: this.deps.settings.blockContacts,
      allowGroups: this.deps.settings.allowGroups,
      isGroup: parsed.group,
      cooldownMs: this.deps.settings.cooldownMs,
      lastAnsweredAt: this.cooldown[parsed.contact] ?? 0,
      now,
    })
    if (!verdict.ok) {
      const reason = this.reasonOf(verdict)
      return this.reject(reason, this.detailOf(reason, parsed.contact), 200)
    }

    if (parsed.text.trim() === '') return this.reject('unsupported', '空正文（图片/表情/语音本版不处理）', 200)

    const conversationId = conversationOf(parsed.contact)
    const router = this.deps.router()
    let reserved = false
    if (router !== undefined) {
      try {
        const admission = router.admit({
          channelId: CHANNEL_ID,
          conversationId,
          kind: parsed.group ? 'group' : 'private',
          trigger: 'message',
          text: parsed.text,
          messageId: parsed.messageId === '' ? undefined : parsed.messageId,
          senderId: parsed.contact,
          at: now,
        })
        if (admission.action === 'ignore' || admission.action === 'deny') {
          return this.reject('ignored', '路由判定不回（' + admission.reason + '）', 200, conversationId)
        }
        // 排队不等于丢弃：这条消息只有这一次机会，所以照答，答完再 release。
        reserved = admission.reserved
      } catch (error) {
        this.deps.log.warn('受理抛错，按不排队继续：%s', messageOf(error))
      }
    }

    // **释放不在这一层的 finally 里做**：webhook 出口会在 HTTP 响应发出之后才拿到回复，
    // 提前 release 会让同一个人的下一条消息立刻开第二个回合——两段回答就乱了序。
    // 因此把 `reserved` 交下去，由 answerAndDeliver 在「真正结束」时释放。
    return this.answerAndDeliver(parsed, conversationId, now, reserved)
  }

  /**
   * 问 + 投递 + 释放。两条出口的分叉只在这里。
   *
   * **释放时机是本方法的责任**：sync 成功时立刻释放；webhook 与超预算时，
   * 要等那一轮真的结束（并且推完）才释放。早释放 = 同一会话并发两轮。
   * @param message 已解析的消息。
   * @param conversationId 会话 id。
   * @param at 时刻。
   * @param reserved 是否占用了会话（必须 release）。
   */
  private async answerAndDeliver(
    message: BridgeInbound,
    conversationId: string,
    at: number,
    reserved: boolean,
  ): Promise<IngestOutcome> {
    const settings = this.deps.settings

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.releaseAndDrain(conversationId, reserved, at)
    }

    const kit = this.deps.kit()
    if (kit === undefined) {
      this.lastError = '没有 ondra-channel-kit：无法问人格'
      release()
      return this.reject('no-kit', '缺 ondra-channel-kit，这条不答', 200, conversationId)
    }
    if (this.active >= settings.maxConcurrent) {
      release()
      return this.reject('busy', '同时处理的回合已达上限（' + settings.maxConcurrent + '）', 200, conversationId)
    }

    this.active += 1
    // `ask` 自己吞掉所有异常（永不 reject），所以这里只需要一条 `.finally` 归还并发位。
    const work = this.ask(kit, conversationId, message.contact, message.text, at)
    const tracked = work.finally(() => {
      this.active -= 1
    })

    /**
     * 交棒：把已经产出（或将产出）的回复推到 webhook，推完才释放会话。
     * **只在这条路径上推**——sync 成功时回复已经写进响应，
     * 再推一遍用户会收到两条一模一样的消息。
     */
    const handOff = (): void => {
      void tracked
        .then(text => (text === null ? null : this.pushText(text, message.contact, message.messageId)))
        .catch((error: unknown) => {
          this.lastError = '投递抛错：' + messageOf(error)
          return null
        })
        .finally(() => {
          release()
        })
    }

    // 出口 A：webhook —— 先 ack，再推。
    if (settings.replyMode === 'webhook') {
      this.deferred += 1
      handOff()
      return this.outcome(202, 'deferred', 'deferred', conversationId, 0, '已受理，回复稍后推到 webhook')
    }

    // 出口 B：sync —— 在预算内等；超了就交棒（那一轮**不取消**，只是不再等它）。
    const raced = await this.raceBudget(tracked, settings.replyBudgetMs)
    if (raced.timedOut) {
      this.deferred += 1
      handOff()
      return this.outcome(
        202,
        'deferred',
        'deferred',
        conversationId,
        0,
        '超过 ' + settings.replyBudgetMs + 'ms 预算，回复改走 webhook',
      )
    }

    try {
      const text = raced.value
      if (text === null) return this.reject('ignored', '这一轮没产出回复（见日志）', 200, conversationId)

      const pieces = this.chunkOf(text)
      if (pieces.length === 0) return this.reject('no-kit', '切条失败，这条不发', 200, conversationId)

      this.answered += 1
      // sync 模式自己把回复写进响应，不再推一遍。
      if (settings.verbose) this.deps.log.info('同步回复 %d 段（%s）', pieces.length, conversationId)
      return this.outcome(200, 'ok', 'reply', conversationId, pieces.length, undefined, text)
    } finally {
      release()
    }
  }

  /**
   * 问人格（带预算、带并发位）。**返回 null 表示这一轮没有可发的东西。**
   * @param kit 公共段服务。
   * @param conversationId 会话 id。
   * @param contact 会话对象（冷却表的键）。
   * @param text 正文。
   * @param at 时刻。
   */
  private async ask(
    kit: KitLike,
    conversationId: string,
    contact: string,
    text: string,
    at: number,
  ): Promise<string | null> {
    const budget = this.deps.settings.replyBudgetMs
    try {
      const result = await kit.callPersona({
        conversationId,
        text,
        maxChars: this.deps.settings.chunkMax,
        timeoutMs: budget,
      })
      if (!result.ok) {
        this.lastError = '人格调用失败：' + (result.reason ?? result.failure ?? 'unknown')
        return null
      }
      const answer = result.text.trim()
      if (answer === '') return null
      // 冷却在「产出回复」时记，而不是在「发出去」时记：
      // 投递失败也是答过一次，否则同一条消息会被连续重答。
      markAnswered(this.cooldown, contact, at)
      this.dirty = true
      return answer
    } catch (error) {
      this.lastError = '人格调用抛错：' + messageOf(error)
      return null
    }
  }

  /**
   * 交棒给 webhook：切条 + 逐段推。
   * @param text 正文。
   * @param contact 会话对象。
   * @param messageId 原消息 id。
   */
  private async pushText(text: string, contact: string, messageId: string): Promise<SendOutcome | null> {
    const push = this.deps.push()
    if (push === undefined) {
      this.lastError = '没有出站 webhook：这条回复发不出去（reply-mode=sync 时它本该写进响应）'
      this.deps.log.warn('没有出站 webhook，这条回复被丢弃：%s', contact)
      return null
    }

    const pieces = this.chunkOf(text)
    if (pieces.length === 0) return null

    let sent = 0
    for (const piece of pieces) {
      const result = await push.push({ contact, text: piece, messageId })
      if (!result.ok) {
        this.lastError = 'webhook 发送失败（' + (result.reason ?? 'http') + '）：' + (result.detail ?? '')
        this.bump('push.' + (result.reason ?? 'http'))
        return { ok: false, reason: result.reason ?? 'http', pieces: pieces.length, sent, detail: result.detail }
      }
      sent += 1
      this.pushed += 1
      this.report('outbound')
    }

    this.answered += 1
    return { ok: true, reason: 'ok', pieces: pieces.length, sent }
  }

  /**
   * 主动发一条。**必须资格三条全过**：高危通道不接受「先发出去再说」。
   * @param contact 会话对象。
   * @param text 正文。
   * @param at 时刻。
   */
  async reply(contact: string, text: string, at?: number): Promise<SendOutcome> {
    const now = at ?? this.deps.now()
    const name = contact.trim()
    if (name === '') return this.send(false, 'empty', 0, 0)

    const verdict = this.qualify()
    if (!verdict.ok) return this.send(false, this.sendReasonOf(verdict), 0, 0)

    // 白名单与拉黑对「主动发」同样生效：手册 §6.2 是「白名单外不发信息」。
    if (this.deps.settings.blockContacts.includes(name)) return this.send(false, 'blocked', 0, 0)
    if (!this.deps.settings.allowContacts.includes(name)) return this.send(false, 'not-whitelisted', 0, 0)

    const trimmed = text.trim()
    if (trimmed === '') return this.send(false, 'empty', 0, 0)
    const push = this.deps.push()
    if (push === undefined) return this.send(false, 'no-webhook', 0, 0)

    const pieces = this.chunkOf(trimmed)
    if (pieces.length === 0) return this.send(false, 'no-kit', 0, 0)

    let sent = 0
    for (const piece of pieces) {
      const result = await push.push({ contact: name, text: piece, messageId: '' })
      if (!result.ok) {
        return this.send(false, result.reason ?? 'http', pieces.length, sent, result.detail)
      }
      sent += 1
      this.pushed += 1
      this.report('outbound')
    }
    markAnswered(this.cooldown, name, now)
    this.dirty = true
    return this.send(true, 'ok', pieces.length, sent)
  }

  /**
   * 写确认档案（**唯一确认入口**）。
   * @param note 说明（≥ 4 字）。
   * @param at 时刻。
   */
  confirm(note: string, at?: number): { readonly ok: boolean; readonly detail: string } {
    const text = note.trim()
    if (text.length < CONFIRM_NOTE_MIN) {
      return {
        ok: false,
        detail: '确认说明太短（至少 ' + CONFIRM_NOTE_MIN + ' 个字）：要说清「确认了什么、用哪个号、知道什么风险」',
      }
    }
    const result = writeConfirmRecord(this.deps.confirmFile, text, at ?? this.deps.now())
    if (result.ok) {
      const loaded = readConfirmRecord(this.deps.confirmFile)
      this.record = loaded.record
      this.recordExists = loaded.exists
      this.deps.log.warn('个人号通道已被确认（%s）：这说明操作者知道封号风险', text)
    }
    return result
  }

  /**
   * 撤销确认（写 `confirmed:false` 并留痕，不删文件）。
   * @param note 撤销说明（可空）。
   * @param at 时刻。
   */
  revoke(note: string, at?: number): { readonly ok: boolean; readonly detail: string } {
    const result = revokeConfirmRecord(this.deps.confirmFile, note, at ?? this.deps.now())
    if (result.ok) {
      this.record = emptyRecord()
      this.recordExists = true
      this.deps.log.warn('个人号通道已撤销确认：在重新确认之前一律不回')
    }
    return result
  }

  /**
   * 资格三条（面板问的是「她有没有资格存在」，不是「某个人能不能触发她」）。
   */
  gate(): GateVerdict {
    return this.qualify()
  }

  /** 现状。 */
  status(): PersonalStatus {
    const verdict = this.qualify()
    return {
      mounted: this.mounted,
      channelId: CHANNEL_ID,
      routePath: this.deps.settings.routePath,
      gate: {
        enable: this.deps.settings.enable,
        confirmed: this.deps.settings.confirmed,
        record: this.record.confirmed,
      },
      allowlist: this.deps.settings.allowContacts.length,
      cooldownEntries: Object.keys(this.cooldown).length,
      webhook: this.deps.settings.outboundWebhook !== '',
      lastError: verdict.ok ? this.lastError : this.detailOf(this.reasonOf(verdict), ''),
    }
  }

  /** 计数。 */
  stats(): PersonalStats {
    return {
      inbound: this.inbound,
      answered: this.answered,
      deferred: this.deferred,
      pushed: this.pushed,
      rejected: Object.freeze({ ...this.rejected }),
    }
  }

  /**
   * 心跳：清过期冷却 + 节流落盘。
   * @param at 时刻。
   */
  tick(at?: number): void {
    const now = at ?? this.deps.now()
    pruneCooldown(this.cooldown, now, this.deps.settings.cooldownMs)
    this.dirty = true
    this.report('heartbeat')
    if (!this.deps.settings.persist) return
    if (now - this.lastPersistAt < this.deps.settings.persistMs) return
    this.flush()
  }

  /** 立刻落盘。 */
  flush(): void {
    if (!this.deps.settings.persist) return
    if (!this.dirty) return
    const file = this.deps.stateFile
    if (file.trim() === '') return
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = file + '.tmp'
      writeFileSync(temporary, JSON.stringify({ cooldown: this.cooldown, updatedAt: this.deps.now() }) + '\n', {
        mode: FILE_MODE,
      })
      renameSync(temporary, file)
      this.dirty = false
      this.lastPersistAt = this.deps.now()
    } catch (error) {
      this.lastError = '冷却表落盘失败：' + messageOf(error)
      this.deps.log.warn('冷却表落盘失败：%s', messageOf(error))
    }
  }

  /** 回环判定失败时的统一响应（由 `index.ts` 调用，保证 403 的形状只有一处定义）。 */
  loopbackReject(): IngestOutcome {
    return {
      http: 403,
      body: jsonOf({ ok: false, reason: 'loopback-only' }),
      contentType: 'application/json; charset=utf-8',
      disposition: 'reject',
      reason: 'loopback-only',
      pieces: 0,
      detail: '这个通道只接受本机请求（127.0.0.1 / ::1）：它不是公网入口',
    }
  }

  /**
   * 资格三条。
   */
  private qualify(): GateVerdict {
    if (!this.deps.settings.enable) return { ok: false, reason: 'disabled' }
    if (!this.deps.settings.confirmed) return { ok: false, reason: 'not-confirmed' }
    if (!this.recordExists) return { ok: false, reason: 'no-confirm-record' }
    if (!this.record.confirmed) return { ok: false, reason: 'not-confirmed' }
    return { ok: true }
  }

  /**
   * 解析桥接端报文。**宽松取值、严格拒绝**：多余的字段忽略，缺关键字段就 null。
   * @param payload 原始输入。
   * @param now 收到时刻（毫秒）。
   */
  private parseInbound(payload: unknown, now: number): BridgeInbound | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const raw = payload as Record<string, unknown>

    const contact = typeof raw['contact'] === 'string' ? raw['contact'].trim() : ''
    const text = typeof raw['text'] === 'string' ? raw['text'] : ''
    if (contact === '' || contact.length > 128) return null

    const messageId = typeof raw['messageId'] === 'string' ? raw['messageId'] : ''
    const at = typeof raw['at'] === 'number' && Number.isFinite(raw['at']) && raw['at'] > 0 ? raw['at'] : now

    return {
      contact,
      text,
      messageId,
      at,
      group: raw['group'] === true,
      self: raw['self'] === true,
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
   * 与预算赛跑：**不取消**那一轮，只是不再等它。
   * @param work 正在跑的任务。
   * @param ms 预算（毫秒）。
   */
  private async raceBudget<T>(
    work: Promise<T>,
    ms: number,
  ): Promise<{ readonly timedOut: boolean; readonly value: T | null }> {
    const expireRef: { fire: () => void } = { fire: () => {} }
    const gate = new Promise<'timeout'>(resolve => {
      expireRef.fire = () => resolve('timeout')
    })
    const handle = setTimeout(() => {
      expireRef.fire()
    }, ms)
    const maybe = handle as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    try {
      const raced = await Promise.race([work.then(value => ({ value })), gate])
      if (raced === 'timeout') return { timedOut: true, value: null }
      return { timedOut: false, value: raced.value }
    } finally {
      clearTimeout(handle)
    }
  }

  /**
   * 释放占位并把排队的那几条也答掉。
   * @param conversationId 会话 id。
   * @param reserved 是否占用了会话。
   * @param at 时刻。
   */
  private releaseAndDrain(conversationId: string, reserved: boolean, at: number): void {
    const router = this.deps.router()
    if (router === undefined || !reserved) return

    let released: readonly QueueItemLike[] = []
    try {
      released = router.release(conversationId)
    } catch (error) {
      this.deps.log.warn('释放会话抛错：%s', messageOf(error))
      return
    }
    if (released.length === 0) return

    const contact = parseConversation(conversationId)
    if (contact === null) return

    const queue = released.slice(0, MAX_DRAIN)
    if (released.length > MAX_DRAIN) {
      this.deps.log.warn('积压 %d 条，本次只答前 %d 条（剩下的丢弃：本通道没有重放能力）', released.length, MAX_DRAIN)
    }

    const kit = this.deps.kit()
    if (kit === undefined) return

    // 已经 release 了，不再回 admit（回了就会排回去）。串行跑，一条一条来。
    void (async () => {
      for (const item of queue) {
        const text = item.text.trim()
        if (text === '') continue
        const answer = await this.ask(kit, conversationId, contact, text, at)
        if (answer !== null) await this.pushText(answer, contact, item.messageId ?? '')
      }
    })().catch((error: unknown) => {
      this.deps.log.warn('排空积压时抛错：%s', messageOf(error))
    })
  }

  /**
   * 拼一个入站结果。
   * @param http 状态码。
   * @param reason 原因。
   * @param disposition 处置。
   * @param conversationId 会话 id。
   * @param pieces 段数。
   * @param detail 说明。
   * @param reply 回复正文（sync 出口用）。
   */
  private outcome(
    http: number,
    reason: IngestReason,
    disposition: IngestOutcome['disposition'],
    conversationId: string | undefined,
    pieces: number,
    detail?: string,
    reply?: string,
  ): IngestOutcome {
    const payload: Record<string, unknown> = { ok: disposition === 'reply' || disposition === 'deferred', reason }
    if (reply !== undefined) payload['reply'] = reply
    if (reply !== undefined) payload['pieces'] = pieces
    return {
      http,
      body: jsonOf(payload),
      contentType: 'application/json; charset=utf-8',
      disposition,
      reason,
      conversationId,
      pieces,
      detail,
    }
  }

  /**
   * 记一次拒绝。
   * @param reason 原因。
   * @param detail 说明。
   * @param http 状态码（默认 200：拒绝也要「已处理」，否则桥接端会重试）。
   * @param conversationId 会话 id。
   */
  private reject(
    reason: IngestReason,
    detail: string,
    http: number,
    conversationId?: string,
  ): IngestOutcome {
    this.bump(reason)
    return {
      http,
      body: jsonOf({ ok: false, reason }),
      contentType: 'application/json; charset=utf-8',
      disposition: 'reject',
      reason,
      conversationId,
      pieces: 0,
      detail,
    }
  }

  /**
   * 按原因码累加一个桶。
   * @param key 桶名。
   */
  private bump(key: string): void {
    this.rejected[key] = (this.rejected[key] ?? 0) + 1
  }

  /**
   * 把闸门原因翻成入站原因。
   * @param verdict 闸门结果。
   */
  private reasonOf(verdict: GateVerdict): IngestReason {
    const reason = verdict.reason
    if (reason === 'disabled') return 'disabled'
    if (reason === 'not-confirmed') return 'not-confirmed'
    if (reason === 'no-confirm-record') return 'no-confirm-record'
    if (reason === 'group-blocked') return 'group-blocked'
    if (reason === 'blocked') return 'blocked'
    if (reason === 'not-whitelisted') return 'not-whitelisted'
    if (reason === 'cooldown') return 'cooldown'
    return 'ignored'
  }

  /**
   * 把闸门原因翻成发送原因。
   * @param verdict 闸门结果。
   */
  private sendReasonOf(verdict: GateVerdict): SendReason {
    if (verdict.reason === 'disabled') return 'disabled'
    return 'not-confirmed'
  }

  /**
   * 给每种拒绝配一句「该去改哪里」。
   * @param reason 原因。
   * @param contact 会话对象。
   */
  private detailOf(reason: IngestReason, contact: string): string {
    if (reason === 'disabled') return '通道关着（enable=false）'
    if (reason === 'not-confirmed') return '没有二次确认：需要 confirmed=true 且确认档案写着已确认'
    if (reason === 'no-confirm-record') return '没有确认档案：先写 ' + this.deps.confirmFile
    if (reason === 'group-blocked') return '群消息默认不回（allow-groups=false）'
    if (reason === 'blocked') return '这个联系人在黑名单里：' + contact
    if (reason === 'not-whitelisted') return '白名单为空或没有这个联系人（空白名单 = 全拒）：' + contact
    if (reason === 'cooldown') return '冷却中（' + this.deps.settings.cooldownMs + 'ms）：同一个人连发时会合并'
    return reason
  }

  /**
   * 拼一个发送结果。
   * @param ok 是否全部发出。
   * @param reason 原因。
   * @param pieces 段数。
   * @param sent 成功段数。
   * @param detail 说明。
   */
  private send(ok: boolean, reason: SendReason, pieces: number, sent: number, detail?: string): SendOutcome {
    return { ok, reason, pieces, sent, detail }
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
   * 读冷却表。坏文件按空表处理并留 warn。
   */
  private loadState(): Record<string, number> {
    const file = this.deps.stateFile
    if (file.trim() === '') return {}
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return {}
    }
    try {
      return parseCooldown(JSON.parse(text) as unknown)
    } catch {
      this.deps.log.warn('冷却状态文件不是合法 JSON（按空表处理）：%s', file)
      return {}
    }
  }
}
