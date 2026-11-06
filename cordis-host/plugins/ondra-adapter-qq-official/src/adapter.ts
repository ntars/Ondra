/**
 * 适配器主体：受理 → 问人格 → 过闸 → 切条 → 发。
 *
 * ## 三处刻意的取舍
 *
 * 1. **依赖全部用「现取」而不是构造时注入。** `router()` / `kit()` / `health()`
 *    是回调，每次用时才 `ctx.get`。理由：插件装载顺序不确定，
 *    构造时取一次会把「装载晚了一步」永久固化成「这个通道永远不知道有路由」。
 * 2. **`ok=false` 的半句话默认不发。** O-056 的 `CallResult` 在超时前可能已经
 *    吐了半句；半句话比没话更糟——用户会以为她说了一句没头没尾的话，
 *    而真正的原因是模型超时。
 * 3. **`release()` 交出来的积压**按序继续处理，**不再回 `admit()`**。
 *    回灌会形成「一释放就排回去」的死循环（O-055 的 `reserved` 就是为这个存在的）。
 */

import { Gate, readGateState, writeGateState } from './gate.js'
import { loadCredentials, maskAppId } from './credential.js'
import type { Config } from './settings.js'
import type {
  AdapterStats,
  AdapterStatus,
  CredentialLoad,
  GateReason,
  HealthLike,
  IngestOutcome,
  KitLike,
  LogLike,
  QqInbound,
  QqOfficialService,
  QqTarget,
  QqTransport,
  QqTransportHandlers,
  ReplyInput,
  ReplyOutcome,
  ReplyReason,
  RouterLike,
  StartOutcome,
} from './types.js'
import { CHANNEL_ID, CHANNEL_LABEL, RISK_CODES, START_FAILURE_ZH } from './types.js'

/** 消息 id 去重窗口：5 分钟。 */
const MSG_DEDUPE_MS = 300_000

/** 消息 id 去重表上限。 */
const MSG_DEDUPE_CAP = 256

/** 「最近一条来信 id」表上限（被动回复要用它）。 */
const LAST_MSG_CAP = 64

/** 一次 `release()` 后最多续处理几条（防「队列无限续」）。 */
const DRAIN_LIMIT = 8

/** 探针心跳间隔（毫秒）。比 O-057 默认的 60 秒期望更密，留两倍余量。 */
export const HEARTBEAT_MS = 30_000

/** 探针证据种类（本插件只用到这几个）。 */
type HealthKind = 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error'

/** 构造依赖。 */
export interface AdapterDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时钟。 */
  readonly now: () => number
  /** 凭据文件绝对路径。 */
  readonly credentialFile: string
  /** 状态文件绝对路径。 */
  readonly stateFile: string
  /** 现取路由服务。 */
  readonly router: () => RouterLike | undefined
  /** 现取公共段服务。 */
  readonly kit: () => KitLike | undefined
  /** 现取探针服务。 */
  readonly health: () => HealthLike | undefined
}

/** 等一会儿。 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

/** 服务实现。 */
export class QqAdapter implements QqOfficialService {
  readonly channelId = CHANNEL_ID

  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  private readonly credentialFile: string
  private readonly stateFile: string
  private readonly routerOf: () => RouterLike | undefined
  private readonly kitOf: () => KitLike | undefined
  private readonly healthOf: () => HealthLike | undefined
  private readonly gate: Gate
  private readonly msgSeen = new Map<string, number>()
  private readonly lastMsgId = new Map<string, string>()

  private transport: QqTransport | null = null
  private started = false
  private connected = false
  private startedAt: number | null = null
  private lastInboundAt: number | null = null
  private lastOutboundAt: number | null = null
  private stateCode: AdapterStatus['state'] = 'closed'
  private stateDetail = '还没启动'
  private counters = { inbound: 0, accepted: 0, duplicates: 0, sent: 0, blocked: 0, failures: 0, riskHits: 0 }

  /**
   * @param deps 依赖。
   */
  constructor(deps: AdapterDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.now = deps.now
    this.credentialFile = deps.credentialFile
    this.stateFile = deps.stateFile
    this.routerOf = deps.router
    this.kitOf = deps.kit
    this.healthOf = deps.health
    this.gate = new Gate(
      { settings: deps.settings, now: deps.now, log: deps.log },
      readGateState(deps.stateFile, deps.now(), deps.log),
    )
    this.gate.warnPatternsOnce()
    if (!deps.settings.enable) {
      this.stateCode = 'disabled'
      this.stateDetail = START_FAILURE_ZH.disabled
    }
  }

  get available(): boolean {
    return this.settings.enable
  }

  useTransport(transport: QqTransport): StartOutcome {
    if (this.started) {
      return { ok: false, reason: 'already-started', detail: '已经在跑了，先 stop() 再换传输' }
    }
    this.transport = transport
    this.log.info('已注入传输实现「%s」：连接协议与事件解析归它，本插件只管分条、被动回复与六道闸', transport.name)
    return { ok: true, detail: '传输已就绪，start() 才会真的连' }
  }

  start(): StartOutcome {
    if (!this.settings.enable) {
      return { ok: false, reason: 'disabled', detail: START_FAILURE_ZH.disabled }
    }
    if (this.started) {
      return { ok: false, reason: 'already-started', detail: START_FAILURE_ZH['already-started'] }
    }

    const loaded: CredentialLoad = loadCredentials(this.credentialFile, this.log)
    if (!loaded.ok || loaded.value === undefined) {
      this.stateCode = 'no-credential'
      this.stateDetail = loaded.detail
      this.log.error('QQ 通道启动失败：%s', loaded.detail)
      return { ok: false, reason: 'no-credential', detail: loaded.detail }
    }
    // 刻意**不把 secret 存进字段**：凭据由传输工厂自己拿着用，
    // 本插件只需要知道「读到了、appId 是哪个」。少一处持有，少一处泄漏面。

    if (this.transport === null) {
      this.stateCode = 'no-transport'
      this.stateDetail = START_FAILURE_ZH['no-transport']
      this.log.error(
        'QQ 通道启动失败：凭据已就绪（appId %s），但没有传输实现。' +
          '手册 §9.11 只给了「WS 长连 + /app/getAppAccessToken + QQBot 头 + 被动回复带 msg_id + 单条 1200」，' +
          '没有给 WS 帧格式；本仓也禁止装依赖。故不做「看起来能跑」的握手：请注入 QqTransport 实现后再 start()',
        maskAppId(loaded.value.appId),
      )
      return { ok: false, reason: 'no-transport', detail: START_FAILURE_ZH['no-transport'] }
    }

    this.started = true
    this.startedAt = this.now()
    this.stateCode = 'connecting'
    this.stateDetail = '正在连接'

    const handlers: QqTransportHandlers = {
      onReady: (): void => {
        this.connected = true
        this.stateCode = 'ready'
        this.stateDetail = '已连接'
        this.report('connected', undefined, '传输就绪')
        this.log.info('QQ（官方）通道已连上，单条上限 %d 字', this.settings.chunkMax)
      },
      onInbound: (event: QqInbound): void => {
        this.ingest(event)
      },
      onHeartbeat: (): void => {
        this.report('heartbeat')
      },
      onError: (code: string, detail?: string): void => {
        this.report('error', code, detail)
        this.log.warn('QQ 传输层报错：%s %s', code, detail ?? '')
      },
      onClosed: (reason: string): void => {
        this.connected = false
        this.stateCode = 'closed'
        this.stateDetail = reason
        this.report('disconnected', undefined, reason)
        this.log.warn('QQ 通道断开：%s', reason)
      },
    }

    try {
      void this.transport
        .open(handlers)
        .catch((error: unknown) => {
          this.connected = false
          this.stateCode = 'closed'
          this.stateDetail = error instanceof Error ? error.message : String(error)
          this.report('error', 'open-failed', this.stateDetail)
          this.log.error('QQ 通道连接失败：%s', this.stateDetail)
        })
    } catch (error) {
      this.connected = false
      this.stateCode = 'closed'
      this.stateDetail = error instanceof Error ? error.message : String(error)
      this.report('error', 'open-failed', this.stateDetail)
      return { ok: false, reason: 'no-transport', detail: this.stateDetail }
    }

    this.log.info('QQ 通道已交给传输「%s」去连（appId %s）', this.transport.name, maskAppId(loaded.value.appId))
    return { ok: true, detail: '已开始连接' }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.connected = false
    this.stateCode = 'closed'
    this.stateDetail = '已停止'
    try {
      this.transport?.close()
    } catch {
      // 关不掉也要继续收尾：状态与落盘比 socket 重要。
    }
    this.report('disconnected', undefined, '通道已关闭')
    this.lastMsgId.clear()
    this.msgSeen.clear()
    this.flush()
    this.log.info('QQ 通道已关闭（闸门状态已落盘，重启不会清零）')
  }

  status(): AdapterStatus {
    return {
      channelId: CHANNEL_ID,
      label: CHANNEL_LABEL,
      enable: this.settings.enable,
      connected: this.connected,
      transport: this.transport === null ? null : this.transport.name,
      state: this.stateCode,
      detail: this.stateDetail,
      startedAt: this.startedAt,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
      circuitOpen: this.gate.circuitOpen(),
    }
  }

  ingest(event: QqInbound): IngestOutcome {
    this.counters.inbound += 1
    const now = this.now()
    const conversationId = conversationOf(event.kind, event.peerId)

    if (!this.settings.enable) {
      return { accepted: false, reason: 'disabled', conversationId, action: '' }
    }
    if (event.messageId.trim() === '' || event.peerId.trim() === '') {
      this.log.warn('收到一条没有消息 id 或没有对端 id 的来信，已丢弃（被动回复必须有 msg_id）')
      return { accepted: false, reason: 'bad-id', conversationId, action: '' }
    }
    if (event.self === true) {
      return { accepted: false, reason: 'self', conversationId, action: '' }
    }
    if (event.text.trim() === '' && event.hasAttachment !== true) {
      return { accepted: false, reason: 'empty', conversationId, action: '' }
    }

    this.pruneMsgSeen(now)
    if (this.msgSeen.has(event.messageId)) {
      this.counters.duplicates += 1
      return { accepted: false, reason: 'duplicate', conversationId, action: '' }
    }
    this.msgSeen.set(event.messageId, now)

    // 被动回复要用的原消息 id：只留最近一条，不猜「哪条是要回的那条」。
    this.lastMsgId.set(conversationId, event.messageId)
    if (this.lastMsgId.size > LAST_MSG_CAP) {
      const oldest = this.lastMsgId.keys().next()
      if (oldest.done !== true) this.lastMsgId.delete(oldest.value)
    }

    this.lastInboundAt = now
    this.counters.accepted += 1
    this.report('inbound', undefined, event.kind === 'group' ? '群里被点名' : '私聊来信')

    const router = this.routerOf()
    if (router === undefined) {
      // 接住了但没人判：**不能静默丢掉**，要留一句能查的话。
      this.log.warn('收到来信但未装载 ondra-router：这一条不会得到处置（%s）', conversationId)
      return { accepted: true, reason: 'accepted', conversationId, action: '' }
    }

    let action = ''
    let reserved = false
    try {
      const admission = router.admit({
        channelId: CHANNEL_ID,
        conversationId,
        kind: event.kind,
        // 群里能收到说明是被 @ 了；私聊就是普通来信。
        trigger: event.kind === 'group' ? 'mention' : 'message',
        text: event.text,
        hasAttachment: event.hasAttachment,
        messageId: event.messageId,
        senderId: event.senderId,
        self: event.self,
        at: event.at,
      })
      action = admission.action
      reserved = admission.reserved
    } catch (error) {
      this.log.error('路由判定失败，这一条按「不处置」处理：%s', error instanceof Error ? error.message : String(error))
      return { accepted: true, reason: 'accepted', conversationId, action: '' }
    }

    if (this.settings.verbose) {
      this.log.info('来信 %s → %s（%s）', conversationId, action, event.kind)
    }

    if (reserved && (action === 'wake' || action === 'reply')) {
      const target: QqTarget = { kind: event.kind, peerId: event.peerId }
      void this.runTurn(conversationId, target, event.text, event.messageId)
    }

    return { accepted: true, reason: 'accepted', conversationId, action }
  }

  /**
   * 跑一轮：问人格 → 回一条 → 释放占用 → 处理积压。
   * **任何异常都在这里收口**，绝不冒泡到传输层（C3 的同类纪律）。
   * @param conversationId 会话 id。
   * @param target 发送目标。
   * @param text 用户正文。
   * @param msgId 触发这条回复的原消息 id。
   */
  private async runTurn(
    conversationId: string,
    target: QqTarget,
    text: string,
    msgId: string,
  ): Promise<void> {
    try {
      await this.answerOnce(conversationId, target, text, msgId)
    } catch (error) {
      this.log.error(
        '处理 %s 时出错（已吞掉，不影响通道）：%s',
        conversationId,
        error instanceof Error ? error.message : String(error),
      )
    }
    // 释放与续处理放在 try/catch 之后，而**不是** finally 里：
    // `finally` 里的 `return` 会吞掉正在抛出的异常，那是排查噩梦。
    await this.drain(conversationId, target)
  }

  /**
   * 释放占用，并把交出来的积压**按序**处理完。
   * @param conversationId 会话 id。
   * @param target 发送目标。
   */
  private async drain(conversationId: string, target: QqTarget): Promise<void> {
    const router = this.routerOf()
    if (router === undefined) return

    let drained: readonly { text: string; messageId?: string }[] = []
    try {
      drained = router.release(conversationId)
    } catch (error) {
      this.log.warn('释放 %s 失败：%s', conversationId, error instanceof Error ? error.message : String(error))
      return
    }

    // 交出来的条目**不再回 admit()**，按序直接处理。
    // 必须串行：同一个会话并行发两条会撞上会话冷却，第二条被自己的闸门拦掉。
    const batch = drained.slice(0, DRAIN_LIMIT)
    for (const item of batch) {
      if (item.text.trim() === '' || item.messageId === undefined) continue
      try {
        await this.answerOnce(conversationId, target, item.text, item.messageId)
      } catch (error) {
        this.log.warn('处理积压条目失败：%s', error instanceof Error ? error.message : String(error))
      }
    }
    if (drained.length > batch.length) {
      this.log.warn(
        '%s 还有 %d 条积压没处理（本轮上限 %d 条）',
        conversationId,
        drained.length - batch.length,
        DRAIN_LIMIT,
      )
    }
  }

  /**
   * 一问一答。
   * @param conversationId 会话 id。
   * @param target 目标。
   * @param text 正文。
   * @param msgId 原消息 id。
   */
  private async answerOnce(
    conversationId: string,
    target: QqTarget,
    text: string,
    msgId: string,
  ): Promise<void> {
    const kit = this.kitOf()
    if (kit === undefined) {
      this.log.warn('未装载 ondra-channel-kit：这一条没法变成回复（不自己造一套问人格的路径）')
      return
    }

    const result = await kit.callPersona({
      conversationId,
      text,
      maxChars: this.settings.chunkMax,
      timeoutMs: this.settings.replyTimeoutMs,
    })

    if (!result.ok) {
      // 半句话默认不发：宁可这一轮没回，也不要让她说一句没头没尾的话。
      this.log.warn(
        '这一轮没拿到可用正文（%s）：%s。半句话已丢弃，不发',
        result.failure ?? 'unknown',
        result.reason ?? '无说明',
      )
      return
    }
    if (result.text.trim() === '') return

    const outcome = await this.reply({ target, text: result.text, msgId, conversationId })
    if (!outcome.ok) {
      this.log.warn('回复没有全部发出（%s / %s）：%s', outcome.reason, outcome.gate, outcome.detail)
    }
  }

  async reply(input: ReplyInput): Promise<ReplyOutcome> {
    const conversationId = input.conversationId ?? conversationOf(input.target.kind, input.target.peerId)
    const active = input.active === true
    const gateInput = {
      text: input.text,
      conversationId,
      kind: input.target.kind,
      active,
    } as const

    try {
      if (!this.settings.enable) {
        return outcome(false, 0, 0, [], 'disabled', 'allow', START_FAILURE_ZH.disabled, 0)
      }

      const checked = this.gate.check({ ...gateInput })
      if (!checked.allow) {
        this.counters.blocked += 1
        if (this.settings.verbose) this.log.info('回复被闸门拦下（%s）：%s', checked.reason, checked.detail)
        return outcome(false, 0, 0, [], 'blocked', checked.reason, checked.detail, 0)
      }

      const pieces = this.split(input.text)
      if (pieces === null) {
        return outcome(
          false,
          0,
          0,
          [],
          'no-kit',
          checked.reason,
          '正文超过单条上限但没有 ondra-channel-kit 可切条（不自己造第二套切法）',
          0,
        )
      }
      if (pieces.length === 0) {
        return outcome(false, 0, 0, [], 'empty', checked.reason, '没有正文', 0)
      }
      if (this.transport === null) {
        return outcome(false, 0, 0, pieces, 'no-transport', checked.reason, START_FAILURE_ZH['no-transport'], 0)
      }

      if (checked.delayMs > 0) await sleep(checked.delayMs)

      const sentPieces: string[] = []
      for (const piece of pieces) {
        const sent = await this.transport.send({
          target: input.target,
          text: piece,
          msgId: input.msgId,
        })
        if (!sent.ok) {
          this.gate.noteResult(false, sent.code)
          this.counters.failures += 1
          if (sent.code !== undefined && RISK_CODES.includes(sent.code)) {
            this.counters.riskHits += 1
          }
          this.report('error', sent.code ?? 'send-failed', sent.message)
          this.log.warn('发送失败（码 %s）：%s', sent.code ?? '无', sent.message ?? '无平台原话')
          const reason: ReplyReason = sentPieces.length === 0 ? 'send-failed' : 'partial'
          return outcome(
            false,
            sentPieces.length,
            pieces.length,
            sentPieces,
            reason,
            checked.reason,
            '第 ' + String(sentPieces.length + 1) + ' 段被拒（码 ' + (sent.code ?? '无') + '）',
            checked.delayMs,
          )
        }

        sentPieces.push(piece)
        this.counters.sent += 1
        this.gate.noteResult(true)
        this.gate.commit({ ...gateInput })
        this.lastOutboundAt = this.now()
        this.report('outbound', undefined, '发出 ' + String(piece.length) + ' 字')
      }

      return outcome(
        true,
        sentPieces.length,
        pieces.length,
        sentPieces,
        'sent',
        checked.reason,
        '全部发出',
        checked.delayMs,
      )
    } catch (error) {
      this.counters.failures += 1
      return outcome(
        false,
        0,
        0,
        [],
        'send-failed',
        'allow',
        error instanceof Error ? error.message : String(error),
        0,
      )
    }
  }

  /**
   * 切条。不超过上限时**不切**——那不需要算法，也就不需要 O-056 在场。
   * @param text 正文。
   * @returns 片；需要切但没有 O-056（或切条抛错）时返回 `null`。
   */
  private split(text: string): readonly string[] | null {
    const limit = this.settings.chunkMax
    if (text.length <= limit) return text.trim() === '' ? [] : [text]
    const kit = this.kitOf()
    if (kit === undefined) return null
    try {
      return kit.chunk(text, limit).pieces
    } catch (error) {
      // 切条抛错时**不发**：宁可这一轮没回，也不要静默截掉她半句话。
      this.log.warn('切条失败，这一条不发（截断比不发更糟）：%s', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  tick(): void {
    if (!this.started) return
    this.report('heartbeat', undefined, '通道存活')
  }

  flush(): void {
    writeGateState(this.stateFile, this.gate.snapshot(), this.log)
  }

  stats(): AdapterStats {
    return { ...this.counters }
  }

  /** 向探针报一条证据。探针缺席/抛错都不能影响发送。 */
  private report(kind: HealthKind, code?: string, detail?: string): void {
    try {
      const health = this.healthOf()
      if (health === undefined) return
      health.report({ channelId: CHANNEL_ID, kind, at: this.now(), code, detail })
    } catch {
      // 探针坏了不影响通道。
    }
  }

  /** 清掉过旧的去重项，并保证表不超过上限。 */
  private pruneMsgSeen(now: number): void {
    for (const [id, at] of this.msgSeen) {
      if (now - at > MSG_DEDUPE_MS) this.msgSeen.delete(id)
    }
    while (this.msgSeen.size >= MSG_DEDUPE_CAP) {
      const oldest = this.msgSeen.keys().next()
      if (oldest.done === true) break
      this.msgSeen.delete(oldest.value)
    }
  }
}

/**
 * 会话 id。
 *
 * 刻意**不做字符替换式的归一化**：那会把不同 id 塌成同一个（`tg:1` / `tg.1`），
 * 症状是「两个会话共用一份历史」。`kind` 前缀 + 原样 `peerId` 既不丢信息，
 * 也不需要指纹补丁。
 * @param kind 私聊还是群。
 * @param peerId 对端 openid。
 */
export function conversationOf(kind: 'private' | 'group', peerId: string): string {
  return CHANNEL_ID + ':' + kind + ':' + peerId
}

/**
 * 造一个回复结果。
 * @param ok 是否全部发出。
 * @param sent 已发条数。
 * @param total 应发条数。
 * @param pieces 已发正文。
 * @param reason 结论。
 * @param gate 闸门结论。
 * @param detail 说明。
 * @param delayMs 等待毫秒数。
 */
function outcome(
  ok: boolean,
  sent: number,
  total: number,
  pieces: readonly string[],
  reason: ReplyReason,
  gate: GateReason,
  detail: string,
  delayMs: number,
): ReplyOutcome {
  return { ok, sent, total, pieces, reason, gate, detail, delayMs }
}
