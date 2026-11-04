/**
 * 门面：连接状态机 + 闸门 + 计数。**这一层不碰协议**。
 *
 * ## 状态机（五个状态，没有「自动重连」的中间态）
 *
 * ```
 * idle ──connect──> connecting ──成功──> online
 *                        │                  │
 *                        └──失败──> offline <┘（disconnect）
 * ```
 *
 * 刻意没有 `reconnecting`：自动重连看着贴心，实际是两个坑——
 * ①账号在别人的服务器上反复上下线，最容易被判异常；
 * ②重连窗口里她收到什么、错过什么完全不可知。
 * 连接由调用方显式发起，本包不替你决定「再试一次」。
 *
 * ## 限频与预算都在这里，且**只对真正发出去的消息计数**
 *
 * 被闸门拒掉的消息不消耗额度。反过来（先记再判）会让「一条被拒的消息」
 * 同时占用限频窗口与预算，用户看到的是「被拒了但还得等」——两个问题混在一起排查。
 *
 * ## 快照永远带 `at`
 *
 * 一张没有时刻的状态表在下游会被当成「现在」——而它可能是十分钟前的。
 * 驱动不给时刻时，本层补调用时刻，**不补 0**（0 会被当成 1970 年）。
 */

import { MissingDriver, describeSnapshot, driverReady, normalizeSnapshot } from './driver.js'
import { judgeChat, judgeCommand } from './policy.js'
import { descriptorOf, textOfArgs, toolKeyOf } from './tools.js'
import type { Config } from './settings.js'
import { targetOf } from './settings.js'
import { TIMEOUT_CEIL, TIMEOUT_FLOOR, TOOL_NAMES } from './types.js'
import type {
  DriverResult,
  LinkState,
  LogLike,
  McReason,
  McSnapshot,
  McStats,
  McStatus,
  MinecraftDriver,
  MinecraftService,
  PolicyConfig,
  SendOutcome,
  ToolDescriptor,
  ToolRegistrar,
  ToolResult,
} from './types.js'

/** 计数的可变形状（接口上是只读的，这里做一次映射，字段名一字不改）。 */
type MutableStats = { -readonly [K in keyof McStats]: number }

/**
 * 全零计数。
 */
function zeroStats(): MutableStats {
  return {
    connects: 0,
    connected: 0,
    disconnects: 0,
    reads: 0,
    chats: 0,
    commands: 0,
    refused: 0,
    throttled: 0,
    budgetHit: 0,
    noDriver: 0,
    failed: 0,
    emptyReads: 0,
  }
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 门面依赖。 */
export interface McDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 现在（毫秒）。 */
  readonly now: () => number
}

/**
 * 把配置收成闸门要的形状（只给需要的字段）。
 * @param settings 配置。
 */
function policyOf(settings: Config): PolicyConfig {
  return {
    enable: settings.enable,
    enabledTools: settings.enabledTools,
    commandAllowList: settings.commandAllowList,
    minSendIntervalMs: settings.minSendIntervalMs,
    maxPerMinute: settings.maxPerMinute,
    chatMax: settings.chatMax,
  }
}

/** Minecraft 接入服务。 */
export class MinecraftHub implements MinecraftService {
  private readonly deps: McDeps
  private driver: MinecraftDriver
  private disposers: readonly (() => void)[] = Object.freeze([] as readonly (() => void)[])
  private state: LinkState = 'idle'
  private lastSnapshot: McSnapshot | null = null
  private lastSendAt = 0
  /** 当前分钟窗口（`floor(now / 60000)`）。 */
  private minuteBucket = 0
  /** 当前窗口内已发条数。 */
  private minuteCount = 0
  private readonly counters: MutableStats = zeroStats()

  constructor(deps: McDeps) {
    this.deps = deps
    this.driver = new MissingDriver()
  }

  /** 开关开着没有。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不能用的原因。 */
  get reason(): McReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (!this.ready) return 'no-driver'
    return this.state === 'online' ? undefined : 'not-connected'
  }

  /** 驱动就绪没有。 */
  get ready(): boolean {
    return driverReady(this.driver)
  }

  /** 本版恒为骨架：没有驱动时它一个字都发不出去，必须让界面显式知道。 */
  get skeleton(): true {
    return true
  }

  /** 开着的工具描述。 */
  descriptors(): readonly ToolDescriptor[] {
    return Object.freeze(this.deps.settings.enabledTools.map(key => descriptorOf(key, this.deps.settings)))
  }

  /**
   * 调一个工具。**永不抛错**。
   * @param tool 工具名。
   * @param args 参数。
   */
  async invoke(tool: string, args?: unknown): Promise<ToolResult> {
    const key = toolKeyOf(tool)
    if (key === undefined) {
      return {
        ok: false,
        tool,
        code: 'bad-arg',
        text: `没有这个工具：${tool}`,
        detail: '工具名不认识。',
        hint: `可用的是 ${Object.values(TOOL_NAMES).join(' / ')}。`,
      }
    }
    if (!this.deps.settings.enabledTools.includes(key)) {
      return {
        ok: false,
        tool,
        code: 'disabled',
        text: `${tool} 没有打开。`,
        detail: '这个能力在 enabled-tools 里没开（出厂只开了 status）。',
        hint: '要开就在配置的 enabled-tools 里加上它。',
      }
    }
    try {
      if (key === 'status') {
        const result = await this.snapshot()
        if (!result.ok) {
          return {
            ok: false,
            tool,
            code: result.reason === 'no-driver' ? 'no-driver' : 'not-connected',
            text: result.detail,
            detail: result.detail,
            hint:
              result.reason === 'no-driver'
                ? '装一个实现 MinecraftDriver 的端口（mineflayer 接线层）并 useDriver() 接进来。'
                : '先调 connect()。',
          }
        }
        return { ok: true, tool, code: 'ok', text: describeSnapshot(result.data), detail: '读到状态。' }
      }
      if (key === 'chat') {
        const text = textOfArgs(args, 'text')
        if (text === undefined) {
          return {
            ok: false,
            tool,
            code: 'bad-arg',
            text: '缺 text。',
            detail: 'text 必须是字符串。',
            hint: '一句话一条，不要分条、不要加前后缀。',
          }
        }
        const outcome = await this.say(text)
        return {
          ok: outcome.ok,
          tool,
          code: outcome.code,
          text: outcome.ok ? `已发送「${outcome.text ?? ''}」。` : outcome.detail,
          detail: outcome.detail,
          ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
        }
      }
      const command = textOfArgs(args, 'command')
      if (command === undefined) {
        return {
          ok: false,
          tool,
          code: 'bad-arg',
          text: '缺 command。',
          detail: 'command 必须是字符串。',
          hint: '例如 /list。指令名必须在 command-allow-list 里。',
        }
      }
      const outcome = await this.run(command)
      return {
        ok: outcome.ok,
        tool,
        code: outcome.code,
        text: outcome.ok ? `已发送指令「${outcome.text ?? ''}」。` : outcome.detail,
        detail: outcome.detail,
        ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
      }
    } catch (error) {
      this.counters.failed += 1
      return {
        ok: false,
        tool,
        code: 'failed',
        text: '这一步没有做成。',
        detail: textOf(error),
      }
    }
  }

  /** 连接。 */
  async connect(): Promise<DriverResult<McSnapshot>> {
    if (!this.deps.settings.enable) {
      return { ok: false, reason: 'unsupported', detail: 'Minecraft 接入是关着的。' }
    }
    if (!this.ready) {
      this.counters.noDriver += 1
      return {
        ok: false,
        reason: 'no-driver',
        detail: '没有 Minecraft 驱动：本包不实现协议，也不会假装在线。',
      }
    }
    const target = targetOf(this.deps.settings)
    if (target === null) {
      return {
        ok: false,
        reason: 'unsupported',
        detail: '服务器地址或用户名是空的，不知道连哪里。',
      }
    }

    this.counters.connects += 1
    this.state = 'connecting'
    const ms = Math.min(TIMEOUT_CEIL, Math.max(TIMEOUT_FLOOR, this.deps.settings.connectTimeoutMs))
    let result: DriverResult<McSnapshot>
    try {
      result = await this.driver.connect(target, ms)
    } catch (error) {
      result = { ok: false, reason: 'failed', detail: textOf(error) }
    }

    if (!result.ok) {
      this.state = 'offline'
      this.counters.failed += 1
      return result
    }

    const snapshot = normalizeSnapshot(result.data, this.deps.now(), this.deps.settings.recentChatKeep)
    if (snapshot === null) {
      this.state = 'offline'
      this.counters.failed += 1
      return { ok: false, reason: 'failed', detail: '驱动连上了，但没给出服务器名与用户名，状态无从判定。' }
    }

    this.state = 'online'
    this.lastSnapshot = snapshot
    this.counters.connected += 1
    return { ok: true, data: snapshot }
  }

  /** 断开（幂等）。 */
  async disconnect(): Promise<DriverResult<null>> {
    if (this.state === 'idle' || this.state === 'offline') return { ok: true, data: null }
    this.state = 'closing'
    try {
      const result = await this.driver.disconnect()
      this.state = 'offline'
      this.counters.disconnects += 1
      return result
    } catch (error) {
      this.state = 'offline'
      this.counters.failed += 1
      return { ok: false, reason: 'failed', detail: textOf(error) }
    }
  }

  /**
   * 发一条聊天。
   * @param input 正文。
   */
  async say(input: string): Promise<SendOutcome> {
    const verdict = judgeChat(input, policyOf(this.deps.settings), this.ready, this.state === 'online')
    if (!verdict.allowed) {
      this.counters.refused += 1
      return {
        ok: false,
        code: verdict.code,
        text: null,
        detail: verdict.detail,
        ...(verdict.hint === undefined ? {} : { hint: verdict.hint }),
      }
    }
    const gate = this.consumeBudget()
    if (gate !== undefined) {
      return {
        ok: false,
        code: gate.code,
        text: null,
        detail: gate.detail,
        ...(gate.hint === undefined ? {} : { hint: gate.hint }),
      }
    }

    try {
      const result = await this.driver.chat(verdict.text)
      if (!result.ok) {
        this.counters.failed += 1
        return {
          ok: false,
          code: 'failed',
          text: null,
          detail: result.detail,
          hint: '消息没有发出去；检查驱动日志（本包不打正文，日志里只有长度）。',
        }
      }
      this.counters.chats += 1
      if (this.deps.settings.verbose) {
        this.deps.log.info('已发送聊天：%d 字符', verdict.text.length)
      }
      return { ok: true, code: 'ok', text: verdict.text, detail: `已发送（${verdict.text.length} 字符）。` }
    } catch (error) {
      this.counters.failed += 1
      return { ok: false, code: 'failed', text: null, detail: textOf(error) }
    }
  }

  /**
   * 发一条指令。
   * @param input 指令。
   */
  async run(input: string): Promise<SendOutcome> {
    const verdict = judgeCommand(input, policyOf(this.deps.settings), this.ready, this.state === 'online')
    if (!verdict.allowed) {
      this.counters.refused += 1
      return {
        ok: false,
        code: verdict.code,
        text: null,
        detail: verdict.detail,
        ...(verdict.hint === undefined ? {} : { hint: verdict.hint }),
      }
    }
    const gate = this.consumeBudget()
    if (gate !== undefined) {
      return {
        ok: false,
        code: gate.code,
        text: null,
        detail: gate.detail,
        ...(gate.hint === undefined ? {} : { hint: gate.hint }),
      }
    }

    try {
      const result = await this.driver.command(verdict.text)
      if (!result.ok) {
        this.counters.failed += 1
        return {
          ok: false,
          code: 'failed',
          text: null,
          detail: result.detail,
          hint: '指令没有发出去；确认服务器插件是否支持这个指令。',
        }
      }
      this.counters.commands += 1
      if (this.deps.settings.verbose) {
        this.deps.log.info('已发送指令：%d 字符', verdict.text.length)
      }
      return { ok: true, code: 'ok', text: verdict.text, detail: `已发送指令（${verdict.text.length} 字符）。` }
    } catch (error) {
      this.counters.failed += 1
      return { ok: false, code: 'failed', text: null, detail: textOf(error) }
    }
  }

  /** 读一眼状态。 */
  async snapshot(): Promise<DriverResult<McSnapshot>> {
    if (!this.deps.settings.enable) {
      return { ok: false, reason: 'unsupported', detail: 'Minecraft 接入是关着的。' }
    }
    if (!this.ready) {
      this.counters.noDriver += 1
      return { ok: false, reason: 'no-driver', detail: '没有 Minecraft 驱动：读不到状态。' }
    }
    if (this.state !== 'online') {
      this.counters.emptyReads += 1
      return { ok: false, reason: 'not-connected', detail: '还没连上服务器，没有状态可读。' }
    }
    this.counters.reads += 1
    let result: DriverResult<McSnapshot>
    try {
      result = await this.driver.snapshot()
    } catch (error) {
      this.counters.failed += 1
      return { ok: false, reason: 'failed', detail: textOf(error) }
    }
    if (!result.ok) {
      this.counters.failed += 1
      return result
    }
    const snapshot = normalizeSnapshot(result.data, this.deps.now(), this.deps.settings.recentChatKeep)
    if (snapshot === null) {
      this.counters.failed += 1
      return { ok: false, reason: 'failed', detail: '驱动返回的状态缺少服务器名或用户名。' }
    }
    this.lastSnapshot = snapshot
    return { ok: true, data: snapshot }
  }

  /**
   * 换驱动。
   * @param driver 驱动或 `null`（`null` 装回 `MissingDriver`）。
   */
  useDriver(driver: MinecraftDriver | null): void {
    this.driver = driver === null ? new MissingDriver() : driver
    // 换驱动等于换连接：旧状态不再可信，直接回到 idle。
    this.state = 'idle'
    this.lastSnapshot = null
  }

  /**
   * 换注册器（`null` 撤掉全部工具）。
   * @param registrar 注册器。
   */
  useRegistrar(registrar: ToolRegistrar | null): void {
    this.disposeTools()
    if (registrar === null) return
    const registered: (() => void)[] = []
    for (const key of this.deps.settings.enabledTools) {
      try {
        registered.push(
          registrar(descriptorOf(key, this.deps.settings), args => this.invoke(TOOL_NAMES[key], args)),
        )
      } catch (error) {
        this.deps.log.warn('注册工具 %s 失败：%s', TOOL_NAMES[key], textOf(error))
      }
    }
    this.disposers = Object.freeze(registered)
  }

  /** 现状。 */
  status(): McStatus {
    const target = targetOf(this.deps.settings)
    const reason = this.reason
    return {
      enabled: this.deps.settings.enable,
      available: this.deps.settings.enable && this.ready,
      driverReady: this.ready,
      ...(reason === undefined ? {} : { reason }),
      driver: this.driver.id,
      link: this.state,
      server: target === null ? '' : `${target.host}:${target.port}`,
      tools: this.deps.settings.enabledTools,
      commands: this.deps.settings.commandAllowList,
      snappedAt: this.lastSnapshot === null ? 0 : this.lastSnapshot.at,
      skeleton: true,
    }
  }

  /** 计数。 */
  stats(): McStats {
    return { ...this.counters }
  }

  /** 撤掉已注册工具（幂等）。 */
  dispose(): void {
    this.disposeTools()
  }

  /**
   * 查限频与分钟预算，通过则**当场记账**。
   *
   * 为什么「当场记账」而不是「发成功后记账」：发出去但驱动抛错的那条消息
   * 在服务端可能已经到了。按「已尝试」计数才不会让失败成为免费通道。
   */
  private consumeBudget(): { code: 'rate-limited' | 'budget-exhausted'; detail: string; hint: string } | undefined {
    const now = this.deps.now()
    if (this.deps.settings.minSendIntervalMs > 0 && this.lastSendAt > 0) {
      const wait = this.deps.settings.minSendIntervalMs - (now - this.lastSendAt)
      if (wait > 0) {
        this.counters.throttled += 1
        return {
          code: 'rate-limited',
          detail: `距上一条不到 ${this.deps.settings.minSendIntervalMs} 毫秒，还要等 ${Math.ceil(wait)} 毫秒。`,
          hint: '等一下再发：多数服务端把 1 秒内的连续消息判为刷屏。',
        }
      }
    }
    const bucket = Math.floor(now / 60_000)
    if (bucket !== this.minuteBucket) {
      this.minuteBucket = bucket
      this.minuteCount = 0
    }
    if (this.minuteCount >= this.deps.settings.maxPerMinute) {
      this.counters.budgetHit += 1
      return {
        code: 'budget-exhausted',
        detail: `这一分钟已经发了 ${this.minuteCount} 条，达到上限 ${this.deps.settings.maxPerMinute} 条。`,
        hint: '等下一分钟；真要发更多就调大 max-per-minute，但那更容易被服务端判刷屏。',
      }
    }
    this.lastSendAt = now
    this.minuteCount += 1
    return undefined
  }

  /**
   * 撤掉已注册工具（幂等）。
   */
  private disposeTools(): void {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        // 撤除失败不影响后续。
      }
    }
    this.disposers = Object.freeze([] as readonly (() => void)[])
  }
}
