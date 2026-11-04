/**
 * 轮询与转交。**本包唯一有副作用的地方**（定时器 + 读设备 + 经桥回一条）。
 *
 * ## 一次轮询的六步，以及每一步失败时「已答集合」怎么处理
 *
 * ```
 * 1. 开关 / 执行器 / 上一次还没跑完    → 直接返回，不动集合
 * 2. 拼命令 + 只读白名单               → denied：不动集合（命令根本没跑）
 * 3. 执行                              → 失败：不动集合（下一轮再试，这是对的）
 * 4. 解析                              → bad-output：不动集合（格式问题不是消息问题）
 * 5. 挑批（剔已答 → 时间升序 → 取前 N 条）
 * 6. 逐条转交                          → **成功才加集合**；失败只累加尝试计数
 * ```
 *
 * 第 6 步是本包最容易写错的地方，两个方向都试过：
 *
 * - **转交之前就加**（"先占位再干活"）：一次 `no-kit`（公共段还没装载完）会让
 *   那条短信永久「已答」，之后她再也不会回它。症状是「有些短信她看都不看」，
 *   而日志里一切正常。
 * - **失败也不加、无限重试**：每 15 秒一次人格调用，一条发不出去的短信能把
 *   模型额度烧穿。
 *
 * 所以取中间：失败**不加**集合，但记一次尝试；到 `MAX_ATTEMPTS` 才放弃并加入集合
 * + 记一条 warn。这样「暂时不可用」能自愈，「永久不可用」会停手，两种情况都可解释。
 *
 * ## 为什么只读查询不加锁，轮询加锁
 *
 * `adb` 是客户端-服务端结构，多个 `shell` 并发是常态，服务端自己排队。
 * 但**轮询**必须自己串行：一轮 20 条、每条一次人格调用，若上一轮还没跑完
 * 下一轮又进来，同一批短信会被两条链路同时转交——这就是重复回答的来源。
 * 一个 `polling` 布尔就是全部需要的锁（单线程事件循环，不需要更复杂的原语）。
 */

import { guardReadOnly } from './policy.js'
import type {
  AdbRunner,
  AdbService,
  AdbStats,
  AdbStatus,
  KitLike,
  LogLike,
  PollOutcome,
  PollReason,
  ReadResult,
  ReplyOutcome,
  ReplyPush,
  SmsMessage,
} from './types.js'
import {
  ATTEMPT_MAX,
  FIRST_POLL_DELAY_MS,
  MAX_ATTEMPTS,
} from './types.js'
import { orderForBatch, parseSmsOutput, queryArgv } from './sms.js'
import type { SeenStore } from './store.js'
import type { Config } from './settings.js'

/** 构造依赖。`runner` / `push` 可变：`useRunner()` / `usePush()` 就地替换。 */
export interface AdbServiceDeps {
  /** 生效配置。 */
  readonly settings: Config
  /** 日志（命名空间由入口按 O-001 给）。 */
  readonly log: LogLike
  /** 统一时间源（缺 O-003 时用 `Date.now`）。 */
  readonly now: () => number
  /** 已答集合。 */
  readonly seen: SeenStore
  /** 执行器（可空）。 */
  runner: AdbRunner | null
  /** 回复桥（可空）。 */
  push: ReplyPush | null
  /** 现取公共段（**每次现取**：O-056 晚装载也能自愈）。 */
  readonly kit: () => KitLike | undefined
}

/**
 * 让定时器不阻止进程退出。
 * @param handle 定时器句柄。
 */
function unrefTimer(handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  const maybe = handle as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

/** 一条日志的统一口径：**永不打印号码与正文**。 */
function brief(rows: readonly SmsMessage[]): string {
  return String(rows.length) + ' 条'
}

/** adb 短信服务。 */
export class AdbPoller implements AdbService {
  private readonly deps: AdbServiceDeps

  /** 生命周期：装载后 `idle`，`start()` 后 `running`，`stop()` 后 `stopped`。 */
  private state: 'idle' | 'running' | 'stopped' = 'idle'
  private polling = false
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null

  private lastPollAt = 0
  private lastReason: PollReason | 'idle' = 'idle'
  private lastDetail = ''

  /** 尝试计数（只在内存；`id → 次数`）。上限 `ATTEMPT_MAX`，超了丢最旧的。 */
  private readonly attempts = new Map<string, number>()

  private polls = 0
  private rows = 0
  private handled = 0
  private answered = 0
  private gaveUp = 0
  private worstPollMs = 0
  private readonly failures: Record<string, number> = {}

  constructor(deps: AdbServiceDeps) {
    this.deps = deps
  }

  /** 能不能读：开关开着、执行器在、没被停掉。 */
  get available(): boolean {
    return this.deps.settings.enable && this.deps.runner !== null && this.state !== 'stopped'
  }

  /** 不能读的原因。 */
  get reason(): PollReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (this.deps.runner === null) return 'no-runner'
    if (this.state === 'stopped') return 'stopped'
    return undefined
  }

  /**
   * 换执行器。
   * @param runner 执行器（`null` = 卸掉）。
   */
  useRunner(runner: AdbRunner | null): void {
    this.deps.runner = runner
  }

  /**
   * 换回复桥。
   * @param push 桥（`null` = 不回）。
   */
  usePush(push: ReplyPush | null): void {
    this.deps.push = push
  }

  /** 开始轮询。重复调用无副作用。 */
  start(): void {
    if (!this.deps.settings.enable) {
      this.lastReason = 'disabled'
      return
    }
    if (this.deps.runner === null) {
      this.lastReason = 'no-runner'
      return
    }
    if (this.state === 'running') return
    this.state = 'running'
    this.lastReason = 'idle'

    // 首次延迟 3 秒：躲开宿主启动争抢，又不至于让用户等满一个周期。
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.poll()
    }, FIRST_POLL_DELAY_MS)
    unrefTimer(this.firstTimer)

    this.intervalTimer = setInterval(() => {
      void this.poll()
    }, this.deps.settings.pollSeconds * 1_000)
    unrefTimer(this.intervalTimer)

    this.deps.log.info(
      '短信轮询已开始：每 %d 秒一次，单轮最多 %d 条，%s',
      this.deps.settings.pollSeconds,
      this.deps.settings.batchLimit,
      this.deps.settings.autoReply ? '自动回复已开（经回复桥）' : '只读模式（不回复）',
    )
  }

  /** 停止轮询（幂等）。 */
  stop(): void {
    this.state = 'stopped'
    if (this.firstTimer !== null) {
      clearTimeout(this.firstTimer)
      this.firstTimer = null
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    // 停之前把集合落一次盘：否则刚答完的几条会在下次启动被重答。
    this.deps.seen.flush()
    if (this.lastReason !== 'idle' && this.lastReason !== 'disabled' && this.lastReason !== 'no-runner') {
      this.lastReason = 'stopped'
    }
  }

  /**
   * 轮询一次。
   * @returns 本轮结论。
   */
  async poll(): Promise<PollOutcome> {
    const startedAt = this.deps.now()

    if (!this.deps.settings.enable) return this.fail('disabled', '开关是关的（enable=false）')
    if (this.state === 'stopped') return this.fail('stopped', '插件已停止轮询（再开要显式 start()）')
    if (this.polling) return this.fail('busy', '上一次轮询还没结束（命令超时可能大于轮询周期）')
    const runner = this.deps.runner
    if (runner === null) return this.fail('no-runner', '没有执行器：调 useRunner() 注入，或检查 adbPath')

    this.polling = true
    this.polls += 1
    try {
      const argv = queryArgv(true)
      const verdict = guardReadOnly(argv)
      if (!verdict.ok) {
        return this.fail('denied', '只读白名单拒绝（' + verdict.rule + '）：' + verdict.detail)
      }

      if (this.deps.settings.verbose) {
        this.deps.log.info('轮询命令：%s', ['adb', ...argv].join(' '))
      }

      const result = await runner.exec(argv, this.deps.settings.execTimeoutMs)
      if (!result.ok) {
        return this.fail(result.reason ?? 'exit', describeExec(result.reason ?? 'exit', result.stderr))
      }

      const parsed = parseSmsOutput(result.stdout)
      this.rows += parsed.rows.length
      if (parsed.rows.length === 0 && !parsed.sawMarker) {
        // 既没有 Row 也没有 "No result found"：格式变了或命令根本没跑到。
        return this.fail(
          'bad-output',
          '输出里既没有 Row: 也没有 No result found（' + String(parsed.badRows) + ' 行无法识别），先手动跑一次命令看看',
        )
      }

      const unseen = parsed.rows.filter(row => !this.deps.seen.has(row.id))
      if (!this.deps.settings.autoReply) {
        return this.done({
          read: parsed.rows.length,
          unseen: unseen.length,
          handled: 0,
          answered: 0,
          gaveUp: 0,
          detail:
            unseen.length === 0
              ? '读成功，没有新的未读短信（只读模式）'
              : '读成功，' + String(unseen.length) + ' 条未处理（只读模式：不会回复）',
        })
      }

      // 自动回复但桥不在：降级为只读（配置层已经拦过一次，这里是兜底）。
      if (this.deps.push === null) {
        return this.done({
          read: parsed.rows.length,
          unseen: unseen.length,
          handled: 0,
          answered: 0,
          gaveUp: 0,
          detail: '自动回复没有可用桥接（replyWebhook 为空或地址被拒），本轮按只读处理',
        })
      }

      const batch = orderForBatch(parsed.rows, id => this.deps.seen.has(id), this.deps.settings.batchLimit)
      let handled = 0
      let answered = 0
      let gaveUp = 0
      for (const message of batch) {
        handled += 1
        const outcome = await this.transfer(message)
        if (outcome === 'answered') answered += 1
        if (outcome === 'gave-up') gaveUp += 1
      }
      this.handled += handled
      this.answered += answered
      this.gaveUp += gaveUp
      this.deps.seen.flush()

      return this.done({
        read: parsed.rows.length,
        unseen: unseen.length,
        handled,
        answered,
        gaveUp,
        detail:
          '读到 ' +
          brief(parsed.rows) +
          '，本轮转交 ' +
          String(handled) +
          ' 条，回出 ' +
          String(answered) +
          ' 条' +
          (gaveUp > 0 ? '，放弃 ' + String(gaveUp) + ' 条（连续失败，见 warn 日志）' : ''),
      })
    } catch (error) {
      // 兜底：端口承诺永不抛错，但真实世界里总会有意外（手册 §8.1-C3）。
      return this.fail('internal', '内部异常：' + textOf(error))
    } finally {
      this.polling = false
      this.lastPollAt = this.deps.now()
      const elapsed = this.lastPollAt - startedAt
      if (elapsed > this.worstPollMs) this.worstPollMs = elapsed
    }
  }

  /**
   * 把一条短信转交人格并经桥回出去。
   * @param message 一条短信。
   */
  private async transfer(message: SmsMessage): Promise<'answered' | 'retry' | 'gave-up'> {
    const attempts = this.attempts.get(message.id) ?? 0
    if (attempts >= MAX_ATTEMPTS) {
      // 已经试满：加入集合并记一次，之后不再碰它。
      this.deps.seen.add(message.id)
      this.attempts.delete(message.id)
      this.deps.log.warn('短信 %s 连续 %d 次无法转交，已放弃并记入已答（不再重试）', message.id, attempts)
      return 'gave-up'
    }

    const kit = this.deps.kit()
    if (kit === undefined) {
      this.bump(message.id)
      this.deps.log.warn('缺 ondra-channel-kit：短信读到了但没人能把它变成回答（下轮再试）')
      return 'retry'
    }

    let text = ''
    try {
      const answer = await kit.callPersona({
        // 会话键：给公共段区分不同号码的对话用。本包**不打印**它（号码不进日志），
        // 但它确实会穿过 kit —— 上游若记录会话键，那是上游的口径。
        conversationId: 'adb:' + (message.address === '' ? 'unknown' : message.address),
        text: message.body,
      })
      if (!answer.ok || answer.text.trim() === '') {
        this.bump(message.id)
        this.deps.log.warn(
          '人格调用未给出可用回答（%s）——本条不标记已答，下轮再试',
          answer.failure ?? (answer.ok ? 'empty' : 'unknown'),
        )
        return 'retry'
      }
      text = answer.text.trim()
    } catch (error) {
      this.bump(message.id)
      this.deps.log.warn('人格调用抛错：%s（本条不标记已答）', textOf(error))
      return 'retry'
    }

    const push = this.deps.push
    if (push === null) {
      this.bump(message.id)
      return 'retry'
    }
    const sent = await push.send({ to: message.address, body: text })
    if (!sent.ok) {
      this.bump(message.id)
      this.deps.log.warn('回复桥投递失败（%s）：%s', sent.reason, sent.detail)
      return 'retry'
    }

    // **只有走到这里才算「已答」**。
    this.deps.seen.add(message.id)
    this.attempts.delete(message.id)
    return 'answered'
  }

  /**
   * 记一次失败尝试（带容量上限，最旧的先丢）。
   * @param id 短信主键。
   */
  private bump(id: string): void {
    const next = (this.attempts.get(id) ?? 0) + 1
    this.attempts.delete(id)
    this.attempts.set(id, next)
    while (this.attempts.size > ATTEMPT_MAX) {
      const oldest = this.attempts.keys().next()
      if (oldest.done === true) break
      this.attempts.delete(oldest.value)
    }
  }

  /**
   * 只读读取。**不改已答集合**。
   * @param input 条数上限与是否只看未读。
   */
  async readSms(input?: { readonly limit?: number; readonly unreadOnly?: boolean }): Promise<ReadResult> {
    const limit = input?.limit ?? this.deps.settings.batchLimit
    const unreadOnly = input?.unreadOnly ?? true
    const empty = (reason: PollReason, detail: string): ReadResult => ({
      ok: false,
      reason,
      rows: Object.freeze([]),
      detail,
      badRows: 0,
    })

    if (!this.deps.settings.enable) return empty('disabled', '开关是关的（enable=false）')
    if (this.state === 'stopped') return empty('stopped', '插件已停止（再开要显式 start()）')
    const runner = this.deps.runner
    if (runner === null) return empty('no-runner', '没有执行器')

    const argv = queryArgv(unreadOnly)
    const verdict = guardReadOnly(argv)
    if (!verdict.ok) return empty('denied', '只读白名单拒绝：' + verdict.detail)

    const result = await runner.exec(argv, this.deps.settings.execTimeoutMs)
    if (!result.ok) return empty(result.reason ?? 'exit', describeExec(result.reason ?? 'exit', result.stderr))

    const parsed = parseSmsOutput(result.stdout)
    if (parsed.rows.length === 0 && !parsed.sawMarker) {
      return { ok: false, reason: 'bad-output', rows: Object.freeze([]), detail: '输出无法识别', badRows: parsed.badRows }
    }

    // 与 `poll()` **刻意相反**：轮询要「最早的未读」才能把队列走完；
    // 读取要「最近的 N 条」——问「最近有什么短信」却拿到三天前那几条，是错的。
    // 切片内部仍按时间升序，便于直接展示。
    const all = [...parsed.rows].sort((left, right) => left.date - right.date)
    const cap = Math.max(1, Math.trunc(limit))
    const rows = all.slice(Math.max(0, all.length - cap))
    return {
      ok: true,
      reason: 'ok',
      rows: Object.freeze(rows),
      detail: '读到 ' + brief(rows) + (unreadOnly ? '（未读）' : ''),
      badRows: parsed.badRows,
    }
  }

  /**
   * 经桥发一条。
   * @param to 接收号码。
   * @param body 正文。
   */
  async reply(to: string, body: string): Promise<ReplyOutcome> {
    if (!this.deps.settings.enable) return { ok: false, reason: 'disabled', detail: '开关是关的' }
    const push = this.deps.push
    if (push === null) return { ok: false, reason: 'no-bridge', detail: '没有可用的回复桥（replyWebhook）' }
    return push.send({ to, body })
  }

  /** 现状快照。 */
  status(): AdbStatus {
    return {
      enabled: this.deps.settings.enable,
      available: this.available,
      reason: this.reason,
      runner: this.deps.runner === null ? '' : this.deps.runner.id,
      bridge: this.deps.push === null ? '' : this.deps.push.id,
      seen: this.deps.seen.size,
      lastPollAt: this.lastPollAt,
      lastReason: this.lastReason,
      serial: this.deps.settings.serial,
    }
  }

  /** 计数快照。 */
  stats(): AdbStats {
    return {
      polls: this.polls,
      rows: this.rows,
      handled: this.handled,
      answered: this.answered,
      gaveUp: this.gaveUp,
      failures: Object.freeze({ ...this.failures }),
      worstPollMs: this.worstPollMs,
    }
  }

  /**
   * 重读已答集合。
   * @returns 读回条数。
   */
  reloadSeen(): number {
    return this.deps.seen.reload()
  }

  /** 记一次失败并返回结论。 */
  private fail(reason: PollReason, detail: string): PollOutcome {
    this.lastReason = reason
    this.lastDetail = detail
    this.failures[reason] = (this.failures[reason] ?? 0) + 1
    this.deps.log.warn('短信轮询结束（%s）：%s', reason, detail)
    return { ok: false, reason, read: 0, unseen: 0, handled: 0, answered: 0, gaveUp: 0, detail }
  }

  /** 记一次成功结论。 */
  private done(input: {
    readonly read: number
    readonly unseen: number
    readonly handled: number
    readonly answered: number
    readonly gaveUp: number
    readonly detail: string
  }): PollOutcome {
    this.lastReason = 'ok'
    this.lastDetail = input.detail
    if (this.deps.settings.verbose) {
      this.deps.log.info('短信轮询结束（ok）：%s', input.detail)
    }
    return { ok: true, reason: 'ok', ...input }
  }

  /** 上次结论（面板用）。 */
  get detail(): string {
    return this.lastDetail
  }
}

/**
 * 把执行失败折成一句能照做的话。
 * @param reason 原因码。
 * @param stderr 标准错误（**只取首行**，避免把整段 usage 刷进日志）。
 */
export function describeExec(reason: string, stderr: string): string {
  const firstLine = stderr.split('\n').map(line => line.trim()).filter(line => line !== '')[0] ?? ''
  const tail = firstLine === '' ? '' : '（adb 回显：' + firstLine + '）'
  if (reason === 'no-adb') return '找不到 adb 可执行文件：装 platform-tools 或改 adbPath' + tail
  if (reason === 'device-offline') return '没有可用设备：插上、解锁、在手机上允许 USB 调试；多台设备时填 serial' + tail
  if (reason === 'timeout') return 'adb 命令超时：手机可能睡过去了，或 USB 掉了' + tail
  if (reason === 'spawn') return 'adb 启动失败：路径不可执行或权限不足' + tail
  return 'adb 非零退出' + tail
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
