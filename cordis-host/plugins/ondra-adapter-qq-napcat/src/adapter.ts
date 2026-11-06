/**
 * 适配器主体：受理 → 闸门 → 问人格 → 分条发出 → 释放会话。
 *
 * ## 一条消息在这里会经过什么
 *
 * ```
 * 传输来的 NapCatEvent
 *   ├─ 自回声？→ 丢掉（否则她会跟自己聊起来）
 *   ├─ 白名单？→ 不在名单 = 谁也不理（空名单就是全拒）
 *   ├─ 群触发？→ @ 或关键词；都不是就不叫醒她
 *   ├─ router.admit() → wake / reply / queue / ignore / deny
 *   ├─ 六道闸 → 拒就安静地不吭声（不报错、不重试）
 *   ├─ channel-kit.callPersona() → 半句话不发
 *   ├─ channel-kit.chunk() → 平台上限切条（不自造第二套切法）
 *   └─ transport.send() → 记结果、必要时退避/熔断
 * ```
 *
 * ## 三条不可让渡的纪律
 *
 * 1. **半句话不发。** `ok=false` 时 `text` 可能是半截，发了比不发更糟。
 * 2. **release 一定要执行。** 忘了它，这个会话会永远「正忙」，
 *    而症状是「她突然只回别人不回我」——最难查的一类。
 * 3. **发送失败不换通道重试。** 一个通道挂只影响自己（§16.2-5），
 *    悄悄换到另一条路上说话，等于让用户在不知情的情况下换了个出口。
 */

import { Buffer } from 'node:buffer'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AdapterStats,
  AdapterStatus,
  AdmissionLike,
  ConfirmRecord,
  GateVerdict,
  HealthLike,
  IngestOutcome,
  IngestReason,
  KitLike,
  NapCatDuplexLike,
  NapCatEvent,
  NapCatService,
  NapCatTransport,
  NapCatTransportHandlers,
  NapCatUpgradeRequestLike,
  ReplyOutcome,
  ReplyReason,
  RouterLike,
  StartOutcome,
} from './types.js'
import { CHANNEL_ID, CHANNEL_LABEL, START_FAILURE_ZH } from './types.js'
import { Gate, emptyGateState, parseGateState } from './gate.js'
import type { GateState } from './gate.js'
import { isUsableHost, isUsablePath } from './settings.js'
import type { Config as Settings } from './settings.js'
import {
  credentialTemplate,
  maskToken,
  readConfirmRecord,
  readToken,
  writeConfirmRecord,
} from './credential.js'

/** 日志最小面（cordis logger 的 printf 形态）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 适配器依赖。全部按需取，**不在构造时抓死引用**（服务可能后到）。 */
export interface AdapterDeps {
  /** 配置。 */
  readonly settings: Settings
  /** 日志。 */
  readonly log: LogLike
  /** 时间源。 */
  now(): number
  /** 随机源（0–1）。 */
  random(): number
  /** 三个文件的绝对路径（空串表示算不出来）。 */
  readonly files: {
    readonly token: string
    readonly state: string
    readonly confirm: string
  }
  /** 宿主能不能接升级路由（`webServer` 是否存在）。 */
  canAcceptUpgrade(): boolean
  /** 路由服务（可能后到）。 */
  router(): RouterLike | undefined
  /** 公共段服务（可能后到）。 */
  kit(): KitLike | undefined
  /** 探针服务（可能后到）。 */
  health(): HealthLike | undefined
}

/** 一次 drain 最多推几轮。防止「一释放就排回去」这种死循环把进程拖死。 */
const MAX_DRAIN = 8

/** 单次等待的上限（毫秒）：抖动再大也不该让释放推迟到下一个回合。 */
const MAX_DELAY_MS = 5_000

/** 会话 id 的解析式。由 `CHANNEL_ID` 拼出来，不手抄前缀。 */
const CONVERSATION_RE = new RegExp('^' + CHANNEL_ID + ':(private|group):(.+)$')

/**
 * 等一会儿。
 * @param ms 毫秒。
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    if (ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()
  })
}

/**
 * 会话 id。**不做有损归一化**：原样拼，不替换字符。
 *
 * `toConversationId` 那种「压成合法 id」的写法会把两个互不相干的会话
 * 塌成同一个（中文群名全变 `chat`），症状是「她在 A 群说的话，在 B 群接得上」。
 * 这里用不到 slug，就不引入那类风险。
 * @param kind 私聊还是群。
 * @param peerId QQ 号或群号。
 */
export function conversationOf(kind: 'private' | 'group', peerId: string): string {
  return CHANNEL_ID + ':' + kind + ':' + peerId
}

/**
 * 从会话 id 反解出发送目标。
 * @param conversationId 会话 id。
 */
export function parseConversation(
  conversationId: string,
): { readonly kind: 'private' | 'group'; readonly peerId: string } | null {
  const matched = CONVERSATION_RE.exec(conversationId)
  if (matched === null) return null
  const kind = matched[1] === 'group' ? 'group' : 'private'
  return { kind, peerId: matched[2] }
}

/** QQ（NapCat）通道适配器。 */
export class NapCatAdapter implements NapCatService {
  private readonly deps: AdapterDeps
  private readonly gate: Gate
  private transport: NapCatTransport | null = null
  private running = false
  private lastReason: StartOutcome['reason'] = undefined
  private record: ConfirmRecord
  private stateDirty = false
  private lastFlush = 0
  private lastError: string | null = null
  private readonly busy = new Set<string>()
  private inbound = 0
  private acceptedCount = 0
  private sent = 0
  private readonly rejected: Record<string, number> = {}
  private readonly startFailures: Record<string, number> = {}

  constructor(deps: AdapterDeps) {
    this.deps = deps
    this.gate = new Gate({
      settings: {
        contentMaxLen: deps.settings.contentMaxLen,
        blockPatterns: deps.settings.blockPatterns,
        quietEnabled: deps.settings.quietEnabled,
        quietStart: deps.settings.quietStart,
        quietEnd: deps.settings.quietEnd,
        dedupeWindowMs: deps.settings.dedupeWindowMs,
        dedupeMinLen: deps.settings.dedupeMinLen,
        perMinute: deps.settings.perMinute,
        perHour: deps.settings.perHour,
        perDay: deps.settings.perDay,
        cooldownGroupMs: deps.settings.cooldownGroupMs,
        cooldownPrivateMs: deps.settings.cooldownPrivateMs,
        jitterMs: deps.settings.jitterMs,
        circuitStrikes: deps.settings.circuitStrikes,
        circuitCooldownMs: deps.settings.circuitCooldownMs,
        failureStopMs: deps.settings.failureStopMs,
      },
      now: () => deps.now(),
      random: () => deps.random(),
      state: this.loadState(),
      onChange: () => {
        this.stateDirty = true
      },
    })
    this.record = readConfirmRecord(deps.files.confirm).record
  }

  get available(): boolean {
    return this.running
  }

  get reason(): StartOutcome['reason'] {
    return this.running ? undefined : this.lastReason
  }

  /**
   * 读状态文件。**坏文件按空状态处理，且一定留一句日志**——
   * 「重启后防封计数悄悄清零」正是 §5.3-7 要堵的那条路。
   */
  private loadState(): GateState {
    const now = this.deps.now()
    const file = this.deps.files.state
    if (!this.deps.settings.persist || file === '') return emptyGateState(now)
    try {
      if (!existsSync(file)) return emptyGateState(now)
      return parseGateState(JSON.parse(readFileSync(file, 'utf8')) as unknown, now)
    } catch {
      this.deps.log.warn('防封状态文件读不出来，已按空状态启动（重启清零等于给防封开后门）：%s', file)
      return emptyGateState(now)
    }
  }

  /**
   * 注入传输实现。运行中注入会立刻重新装配（老实现先 detach，避免两份都在收）。
   * @param transport 实现；`null` 表示撤掉。
   */
  useTransport(transport: NapCatTransport | null): void {
    if (this.transport !== null) {
      try {
        this.transport.detach()
        this.transport.close()
      } catch (error) {
        this.deps.log.warn('撤掉旧传输时抛错（忽略）：%s', messageOf(error))
      }
    }
    this.transport = transport
    if (transport !== null && this.running) this.attach()
  }

  /** 装配传输回调。 */
  private attach(): void {
    const transport = this.transport
    if (transport === null) return
    const handlers: NapCatTransportHandlers = {
      onEvent: event => {
        try {
          this.ingest(event)
        } catch (error) {
          // 传输层不能因为一次坏事件整条连接崩掉。
          this.noteError('收信处理抛错：' + messageOf(error))
        }
      },
      onConnection: (connected, why) => {
        if (connected) {
          this.deps.log.info('NapCat 已连入（%s）', CHANNEL_LABEL)
          this.report('connected')
          return
        }
        this.deps.log.warn('NapCat 断开：%s', why ?? '未给原因')
        this.report('disconnected', why)
      },
    }
    try {
      transport.attach(handlers)
    } catch (error) {
      this.noteError('装配传输失败：' + messageOf(error))
    }
  }

  /** 开始监听。 */
  start(): StartOutcome {
    const fail = (reason: Exclude<StartOutcome['reason'], undefined>, detail?: string): StartOutcome => {
      this.lastReason = reason
      this.startFailures[reason] = (this.startFailures[reason] ?? 0) + 1
      const text = detail ?? START_FAILURE_ZH[reason]
      this.deps.log.warn('启动未完成（%s）：%s', reason, text)
      return { ok: false, reason, detail: text }
    }

    if (this.running) return fail('already-running')
    if (!this.deps.settings.enable) return fail('disabled')
    if (!this.deps.settings.confirmed) return fail('unconfirmed')
    this.record = readConfirmRecord(this.deps.files.confirm).record
    if (this.deps.settings.requireConfirmRecord && !this.record.confirmed) return fail('no-confirm-record')
    if (!isUsableHost(this.deps.settings.listHost)) return fail('bad-host')
    if (!isUsablePath(this.deps.settings.path)) return fail('bad-path')
    const transport = this.transport
    if (transport === null) return fail('no-transport')
    if (transport.requiresUpgradeRoute && !this.deps.canAcceptUpgrade()) return fail('no-web-server')

    // 凭据：读到才算「能连」。这里读完只用来做一次存在性校验，token 不往上存。
    const credential = readToken(this.deps.files.token)
    if (!credential.ok || credential.value === undefined) {
      return fail('no-credential', credential.detail + ' ' + credentialTemplate(this.deps.files.token))
    }
    if (credential.permissionTightened) {
      this.deps.log.warn('凭据文件权限过宽，已就地收紧到 0600：%s', this.deps.files.token)
    }

    // 把 token 交给传输实现（它才是真正要出示凭据的那一层）。
    try {
      transport.configure?.({ token: credential.value.token })
    } catch (error) {
      return fail('no-transport', '传输实现拒绝了凭据：' + messageOf(error))
    }

    this.running = true
    this.lastReason = undefined
    this.attach()
    this.deps.log.info(
      'NapCat 通道开始监听：NapCat 侧填 ws://%s:%d%s（token %s）',
      this.deps.settings.listHost,
      this.deps.settings.port,
      this.deps.settings.path,
      maskToken(credential.value.token),
    )
    // 真正的「在线」由传输的 onConnection 决定：端口开着但 NapCat 没连进来，不算在线。
    return { ok: true, detail: '已装配传输，等待 NapCat 连入' }
  }

  /** 停止监听。 */
  stop(): void {
    if (this.transport !== null) {
      try {
        this.transport.detach()
        this.transport.close()
      } catch (error) {
        this.deps.log.warn('关闭传输时抛错（忽略）：%s', messageOf(error))
      }
    }
    if (this.running) this.report('disconnected', '插件停用')
    this.running = false
    this.busy.clear()
    this.flush()
  }

  /**
   * 接受一条已升级的连接。**没跑起来时在这里就拒掉，不把 socket 交给空实现。**
   * @param request 升级请求。
   * @param socket 已升级的 socket。
   * @param head 升级时残留的首包字节。
   */
  acceptUpgrade(request: NapCatUpgradeRequestLike, socket: NapCatDuplexLike, head: Uint8Array): void {
    if (!this.running) {
      rejectUpgrade(socket, 503, '通道未启用（enable / confirmed / 确认档案 / 传输实现 至少缺一样），详见日志原因码')
      return
    }
    const transport = this.transport
    if (transport === null) {
      rejectUpgrade(socket, 503, '没有 OneBot 编解码实现：本插件不写假握手')
      return
    }
    try {
      transport.accept(request, socket, head)
    } catch (error) {
      this.noteError('接受入站连接失败：' + messageOf(error))
      rejectUpgrade(socket, 500, '接受连接时抛错')
    }
  }

  /** 受理一条来信。 */
  ingest(event: NapCatEvent): IngestOutcome {
    this.inbound += 1
    const kind: 'private' | 'group' = event.kind === 'group' ? 'group' : 'private'
    const peerId = kind === 'group' ? (event.groupId ?? '') : event.userId
    const conversationId = conversationOf(kind, peerId)

    if (!this.running) return this.out(conversationId, 'disabled')
    if (!this.deps.settings.enable || !this.deps.settings.confirmed) {
      return this.out(conversationId, 'unconfirmed')
    }
    if (peerId === '' || event.messageId === '') return this.out(conversationId, 'bad-shape')

    // 自回声：OneBot 会把本账号发出的消息也推上来，不掐掉她会跟自己聊。
    if (event.selfId !== undefined && event.selfId === event.userId) {
      return this.out(conversationId, 'ignored')
    }

    if (!this.whitelisted(kind, event, peerId)) return this.out(conversationId, 'not-whitelisted')

    let trigger: 'message' | 'mention' | 'keyword' = 'message'
    if (kind === 'group') {
      const keyword = this.deps.settings.groupKeyword
      const byKeyword = keyword !== '' && event.text.includes(keyword)
      if (!event.mentioned && !byKeyword) return this.out(conversationId, 'not-triggered')
      trigger = event.mentioned ? 'mention' : 'keyword'
      // 概率防刷屏：只作用于群，私聊掷骰子是失礼（与 O-055 的唤醒概率同一条口径）。
      const probability = this.deps.settings.groupReplyProbability
      if (probability < 1 && this.deps.random() >= probability) {
        return this.out(conversationId, 'ignored')
      }
    }

    const router = this.deps.router()
    let admission: AdmissionLike
    if (router === undefined) {
      // 没有路由服务时直接回：通道层最该能做到的事，是「缺了路由也照样把话回了」。
      admission = { action: 'reply', reason: 'no-router', reserved: false, queueDepth: 0, position: 0 }
    } else {
      try {
        admission = router.admit({
          channelId: CHANNEL_ID,
          conversationId,
          kind,
          trigger,
          text: event.text,
          messageId: event.messageId,
          senderId: event.userId,
          at: event.at,
        })
      } catch (error) {
        this.noteError('路由判定抛错（按「直接回」处理）：' + messageOf(error))
        admission = { action: 'reply', reason: 'router-error', reserved: false, queueDepth: 0, position: 0 }
      }
    }

    this.report('inbound', admission.reason)

    if (admission.action === 'ignore') return this.out(conversationId, 'ignored')
    if (admission.action === 'deny') return this.out(conversationId, 'denied')
    if (admission.action === 'queue') return this.out(conversationId, 'busy')

    // wake 与 reply 都是「这一条要回」，区别是前者还要把冷会话叫起来——那是 O-055 的事。
    this.acceptedCount += 1
    const acceptedEvent: NapCatEvent = {
      ...event,
      kind,
      groupId: kind === 'group' ? peerId : event.groupId,
      trigger,
    }
    void this.runConversation(conversationId, acceptedEvent, admission.reserved)
    return { accepted: true, reason: 'ok', conversationId }
  }

  /**
   * 白名单判定（§6.1：QQ 号与群号分两类配）。
   * @param kind 私聊还是群。
   * @param event 来信。
   * @param peerId 对端 id。
   */
  private whitelisted(kind: 'private' | 'group', event: NapCatEvent, peerId: string): boolean {
    const settings = this.deps.settings
    if (kind === 'group') {
      if (!settings.allowGroups.includes(peerId)) return false
      // 群在白名单里，不代表群里任何人都能进私聊；发信人还要在 users 名单里。
      return settings.allowUsers.length === 0 || settings.allowUsers.includes(event.userId)
    }
    return settings.allowUsers.includes(peerId)
  }

  /** 记一次未受理并返回。 */
  private out(conversationId: string, reason: Exclude<IngestReason, 'ok'>): IngestOutcome {
    const key = 'ingest.' + reason
    this.rejected[key] = (this.rejected[key] ?? 0) + 1
    if (reason !== 'ignored' && reason !== 'not-triggered') {
      // 「本来就轮不到她」不刷日志，其余原因各记一行：分不出这两类是排查噩梦。
      this.deps.log.info('未受理（%s）：%s', reason, conversationId)
    }
    return { accepted: false, reason, conversationId }
  }

  /**
   * 跑一轮：闸门 → 问人格 → 分条 → 发出 → 释放 → 接着排队的。
   * @param conversationId 会话 id。
   * @param event 触发的来信。
   * @param reserved 是否占用了会话（占用就必须释放）。
   */
  private async runConversation(
    conversationId: string,
    event: NapCatEvent,
    reserved: boolean,
  ): Promise<void> {
    this.busy.add(conversationId)
    try {
      await this.answerOnce(conversationId, event)
    } catch (error) {
      // 任何一步抛错都要收在这一层：一次坏消息不能让整条通道停摆。
      this.noteError('回合失败：' + messageOf(error))
    } finally {
      this.busy.delete(conversationId)
      if (reserved) await this.drain(conversationId)
    }
  }

  /**
   * 释放会话并把积压一条条跑完。
   *
   * **不能并行**：同一会话的两条并发会撞上自己的会话冷却，第二条被自己拦掉，
   * 表现为「排队的那条永远迟到」。所以这里是 `await` 而不是 `void`。
   * @param conversationId 会话 id。
   */
  private async drain(conversationId: string): Promise<void> {
    const router = this.deps.router()
    if (router === undefined) return
    for (let round = 0; round < MAX_DRAIN; round += 1) {
      let items: ReturnType<RouterLike['release']>
      try {
        items = router.release(conversationId)
      } catch (error) {
        this.noteError('释放会话抛错：' + messageOf(error))
        return
      }
      if (items.length === 0) return
      const item = items[0]
      const target = parseConversation(conversationId)
      await this.answerOnce(conversationId, {
        kind: item.kind,
        userId: item.senderId ?? '',
        groupId: target !== null && item.kind === 'group' ? target.peerId : undefined,
        messageId: item.messageId ?? '',
        text: item.text,
        at: this.deps.now(),
        mentioned: item.trigger === 'mention',
        trigger:
          item.trigger === 'mention'
            ? 'mention'
            : item.trigger === 'keyword'
              ? 'keyword'
              : item.trigger === 'active'
                ? 'active'
                : 'message',
      })
    }
    this.deps.log.warn('会话 %s 的积压推了 %d 轮还没清空，先放手（防死循环）', conversationId, MAX_DRAIN)
  }

  /**
   * 跑一次问答。
   * @param conversationId 会话 id。
   * @param event 来信。
   */
  private async answerOnce(conversationId: string, event: NapCatEvent): Promise<void> {
    const target = parseConversation(conversationId)
    if (target === null) return

    const gateInput = {
      conversationId,
      kind: event.kind,
      text: event.text,
      trigger: event.trigger ?? 'message',
      at: event.at,
    }
    const verdict = this.gate.evaluate(gateInput)
    if (verdict.decision === 'reject') {
      this.noteRejection(verdict.reason)
      this.deps.log.info('闸门拦下（%s）：%s', verdict.reason, conversationId)
      return
    }

    const kit = this.deps.kit()
    if (kit === undefined) {
      this.deps.log.warn('没有 ondra-channel-kit：这一条回不了（不自造第二套切法与问法）')
      return
    }

    // 扣账放在「真的要问了」之后：判定通过但被别的层拦下时不该吃配额。
    this.gate.commit(gateInput)

    let result: Awaited<ReturnType<KitLike['callPersona']>>
    try {
      result = await kit.callPersona({
        conversationId,
        text: event.text,
        maxChars: this.deps.settings.chunkMax,
        timeoutMs: this.deps.settings.replyTimeoutMs,
      })
    } catch (error) {
      this.noteError('问人格抛错：' + messageOf(error))
      return
    }

    if (!result.ok) {
      // 半句话不发：ok=false 时 text 可能是半截。
      this.deps.log.info('本轮没有可用回复（%s），不发', result.failure ?? 'unknown')
      return
    }
    await this.sendText(target.kind, target.peerId, result.pieces, verdict, event.messageId)
  }

  /** 主动发一条（给主动层用）。 */
  async reply(conversationId: string, text: string, at?: number): Promise<ReplyOutcome> {
    const target = parseConversation(conversationId)
    if (target === null) return outcome(false, 'no-conversation', 0, 0)
    if (!this.deps.settings.enable) return outcome(false, 'disabled', 0, 0)
    if (this.transport === null || !this.running) return outcome(false, 'no-transport', 0, 0)

    const gateInput = {
      conversationId,
      kind: target.kind,
      text,
      trigger: 'active' as const,
      at,
    }
    const verdict = this.gate.evaluate(gateInput)
    if (verdict.decision === 'reject') {
      this.noteRejection(verdict.reason)
      return outcome(false, 'rejected', 0, 0)
    }
    const pieces = this.chunkOf(text)
    if (pieces.length === 0) return outcome(false, 'empty', 0, 0)
    this.gate.commit(gateInput)
    return this.sendText(target.kind, target.peerId, pieces, verdict, undefined)
  }

  /**
   * 切条。**只认 O-056**：没有它就不发，绝不自己写第二套切法。
   * @param text 正文。
   */
  private chunkOf(text: string): readonly string[] {
    const trimmed = text.trim()
    if (trimmed === '') return Object.freeze([])
    const max = this.deps.settings.chunkMax
    if (trimmed.length <= max) return Object.freeze([trimmed])
    const kit = this.deps.kit()
    if (kit === undefined) return Object.freeze([])
    try {
      return kit.chunk(trimmed, max).pieces
    } catch (error) {
      // 切条抛错时**截断比不发更糟**：宁可这一条不发。
      this.noteError('切条抛错，本条不发：' + messageOf(error))
      return Object.freeze([])
    }
  }

  /**
   * 逐段发出。
   * @param kind 私聊还是群。
   * @param peerId 对端 id。
   * @param pieces 已切好的段。
   * @param verdict 闸门结论（抖动在这里生效）。
   * @param messageId 被动回复可带的原消息 id。
   */
  private async sendText(
    kind: 'private' | 'group',
    peerId: string,
    pieces: readonly string[],
    verdict: GateVerdict,
    messageId: string | undefined,
  ): Promise<ReplyOutcome> {
    const transport = this.transport
    if (transport === null) return outcome(false, 'no-transport', pieces.length, 0)
    if (pieces.length === 0) return outcome(false, 'empty', 0, 0)

    const delay = Math.min(MAX_DELAY_MS, Math.max(0, verdict.delayMs))
    if (delay > 0) await sleep(delay)

    let sent = 0
    for (const piece of pieces) {
      let result: Awaited<ReturnType<NapCatTransport['send']>>
      try {
        result = await transport.send({
          kind,
          peerId,
          text: piece,
          messageId: sent === 0 ? messageId : undefined,
        })
      } catch (error) {
        result = { ok: false, reason: messageOf(error) }
      }
      if (!result.ok) {
        this.gate.record(result.code ?? 'send-failed')
        this.noteError(
          '发送失败（%s），已发 %d/%d 段',
          result.code ?? result.reason ?? 'unknown',
          sent,
          pieces.length,
        )
        // 后面的段不再发：连续失败只会加速风控（§5.3-6）。
        return outcome(false, 'send-failed', pieces.length, sent, result.code)
      }
      this.gate.record(undefined)
      sent += 1
      this.sent += 1
      this.report('outbound')
      if (this.deps.settings.verbose) {
        this.deps.log.info('已发出第 %d/%d 段（%s）', sent, pieces.length, kind)
      }
    }
    return outcome(true, 'ok', pieces.length, sent)
  }

  /** 写二次确认档案。 */
  confirm(note: string): { readonly ok: boolean; readonly detail: string } {
    const written = writeConfirmRecord(this.deps.files.confirm, note, this.deps.now())
    if (!written.ok) return written
    this.record = readConfirmRecord(this.deps.files.confirm).record
    this.deps.log.info('二次确认已存档：%s', this.deps.files.confirm)
    return written
  }

  /** 心跳：报探针 + 按节流落盘。 */
  tick(at?: number): void {
    const now = at ?? this.deps.now()
    this.report('heartbeat')
    if (!this.deps.settings.persist) return
    if (now - this.lastFlush < this.deps.settings.persistMs) return
    this.flush()
  }

  /** 立刻落盘（只在状态脏的时候写，避免每 5 秒写一次盘）。 */
  flush(): void {
    this.lastFlush = this.deps.now()
    if (!this.deps.settings.persist || !this.stateDirty) return
    const file = this.deps.files.state
    if (file === '') {
      this.deps.log.warn('算不出状态文件路径，防封状态只在内存里（重启清零）')
      return
    }
    try {
      writeTextAtomic(file, JSON.stringify(this.gate.snapshot()))
      this.stateDirty = false
    } catch (error) {
      this.deps.log.warn('状态落盘失败（下次再试）：%s', messageOf(error))
    }
  }

  /** 通道现状。 */
  status(): AdapterStatus {
    const settings = this.deps.settings
    return {
      running: this.running,
      channelId: CHANNEL_ID,
      endpoint: this.running
        ? { host: settings.listHost, port: settings.port, path: settings.path }
        : null,
      whitelist: { users: settings.allowUsers.length, groups: settings.allowGroups.length },
      gate: this.gate.view(),
      transport: this.transport === null ? null : this.transport.id,
      lastError: this.lastError,
    }
  }

  /** 计数。 */
  stats(): AdapterStats {
    return {
      inbound: this.inbound,
      accepted: this.acceptedCount,
      sent: this.sent,
      rejected: { ...this.rejected },
      startFailures: { ...this.startFailures },
    }
  }

  /**
   * 向探针上报。**探针缺席时静默**：通道不该因为「没人看它」而报错。
   * @param kind 事件类型。
   * @param detail 细节（不含正文）。
   */
  private report(
    kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error',
    detail?: string,
  ): void {
    const health = this.deps.health()
    if (health === undefined) return
    try {
      health.report({ channelId: CHANNEL_ID, kind, at: this.deps.now(), detail })
    } catch {
      // 探针自己出错与通道无关（§16.2-5：失败隔离）。
    }
  }

  /** 记一条中文错误（只进日志与状态，不抛）。 */
  private noteError(text: string, ...args: unknown[]): void {
    this.lastError = text
    this.deps.log.warn(text, ...args)
    this.report('error', text)
  }

  /** 记一次闸门拒绝（只进计数，不刷日志——拒绝是常态）。 */
  private noteRejection(reason: string): void {
    const key = 'gate.' + reason
    this.rejected[key] = (this.rejected[key] ?? 0) + 1
  }
}

/**
 * 拼一个回复结果。
 * @param ok 是否全部发出。
 * @param reason 原因。
 * @param pieces 段数。
 * @param sent 已发段数。
 * @param code 平台错误码。
 */
function outcome(
  ok: boolean,
  reason: ReplyReason,
  pieces: number,
  sent: number,
  code?: string,
): ReplyOutcome {
  return code === undefined ? { ok, reason, pieces, sent } : { ok, reason, pieces, sent, code }
}

/** 取错误消息文本。 */
export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 直接在一个已升级的 socket 上回一段 HTTP 错误并关掉。
 *
 * 升级失败时**不能什么都不写**：什么都不写的话 NapCat 只会看到连接被拒，
 * 而原因（没启用 / 没传输实现）只留在了本端日志里，两边对不上号。
 * @param socket 已升级的 socket。
 * @param status 状态码。
 * @param reason 中文原因。
 */
export function rejectUpgrade(socket: NapCatDuplexLike, status: number, reason: string): void {
  const body = JSON.stringify({ ok: false, error: reason })
  const head =
    'HTTP/1.1 ' +
    status +
    (status === 503 ? ' Service Unavailable' : ' Internal Server Error') +
    '\r\nContent-Type: application/json; charset=utf-8\r\n' +
    'Content-Length: ' +
    byteLength(body) +
    '\r\nConnection: close\r\n\r\n'
  try {
    socket.write(encodeUtf8(head + body))
  } catch {
    // socket 已经断了，没什么可做的。
  } finally {
    socket.end()
  }
}

/**
 * UTF-8 字节数。
 * @param text 文本。
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * UTF-8 编码。
 * @param text 文本。
 */
function encodeUtf8(text: string): Uint8Array {
  return Buffer.from(text, 'utf8')
}

/* ------------------------------------------------------------------ *
 * 文件读写（只在本文件用，不扩散到别处）
 * ------------------------------------------------------------------ */

/**
 * 原子写（临时文件 + rename），权限 0600。
 *
 * 半截 JSON 的后果很具体：下次启动读不出来，防封状态清零，
 * 于是「重启就绕过防封」——这条路径必须堵死。
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
