/**
 * 门面：限频、超时、整形、沙箱、计数、电量事件。
 *
 * ## 失败方向
 *
 * 本包是**限制型**服务（读得到就给你看），所以失败一律「不返回数据」：
 * `data` 恒为 `null`，`text` 给一句可读的原因。带半份数据的失败会被当成成功，
 * 而「读了一半的进程列表」比「没读到」更容易被当成完整事实。
 *
 * ## 为什么每个失败都带 `hint`
 *
 * 手册 §6.6 逐字：「拒绝提示从『禁止』改成『指路』（告诉它该用什么替代）」。
 * 只回「不支持」等于把问题弹回给模型，它会开始猜、然后编。
 *
 * ## 为什么不装定时器
 *
 * 电量事件在**每次 sysinfo 调用时**顺带判一次档位变化，没有常驻轮询。
 * 装一个 30 秒定时器去读电池，等于把一个只读插件变成常驻后台服务
 * （master-plan §12.4 明确禁止），而收益只是「更早几秒知道」。
 */

import type { Config } from './settings.js'
import type {
  BatteryInfo,
  DesktopBridge,
  DesktopEvent,
  DesktopService,
  DesktopStats,
  DesktopStatus,
  FileHit,
  InvokeReason,
  LogLike,
  SortKey,
  ToolDescriptor,
  ToolRegistrar,
  ToolResult,
} from './types.js'
import { TOOL_KEYS, TOOL_NAMES } from './types.js'
import { bandOf, poseClipboard, poseForeground, poseHit, poseProcess, poseSysinfo } from './privacy.js'
import { renderLines } from './sandbox.js'
import { buildDescriptors, normalizeArgs } from './tools.js'

/** 依赖注入。 */
export interface DesktopHubDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 当前时刻（毫秒）。 */
  readonly now: () => number
  /** 初始来源（可为空）。 */
  readonly bridge: DesktopBridge | null
  /** 初始注册器（可为空）。 */
  readonly registrar: ToolRegistrar | null
}

/** 可累加的计数器（接口上的 `readonly` 不能直接 `+=`，这里用可变镜像）。 */
interface MutableCounters {
  calls: number
  ok: number
  throttled: number
  timeouts: number
  late: number
  worstMs: number
  batteryEvents: number
  rejected: Map<string, number>
}

/** 一次调用的内部结论（比 `ToolResult` 少几个待填字段）。 */
interface Verdict {
  readonly ok: boolean
  readonly reason: InvokeReason
  readonly data: unknown
  readonly lines: readonly string[]
  readonly detail: string
  readonly hint?: string
}

/** 把异常折成一句话。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 给一个超时闸。
 *
 * 超时返回 `null`（而不是一个 `{timedOut:true}` 标记对象）：
 * `null` 是字面量类型，`outcome === null` 能被 TypeScript 正确收窄；
 * 对象标记只能靠 `in` 判断，容易被写成一个不收窄的等值比较。
 *
 * 超时不是「结束」：原 promise 仍会落地，落地后**丢弃**并计一次 `late`。
 * 不挂 `.then` 会得到 `unhandledRejection`；挂了不丢会得到「迟到的结果覆盖新结果」。
 * 错误**不在这里吞掉**——它照常抛给调用方，由统一的那处 try/catch 折成 `error`。
 * @param work 原工作。
 * @param ms 超时。
 * @param onLate 迟到回调（只对「迟到的成功」计数）。
 */
function withTimeout<T>(work: Promise<T>, ms: number, onLate: () => void): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let settled = false
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, ms)

    work.then(
      value => {
        if (settled) {
          onLate()
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) {
          // 迟到的是错误：没人等它了，吞掉即可（不能让它变成 unhandledRejection）。
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 本插件对外提供的服务实现。 */
export class DesktopHub implements DesktopService {
  /** 已补全的配置。 */
  private readonly settings: Config

  /** 日志。 */
  private readonly log: LogLike

  /** 时钟。 */
  private readonly now: () => number

  /** 当前来源。 */
  private bridge: DesktopBridge | null

  /** 当前注册器。 */
  private registrar: ToolRegistrar | null

  /** 已注册工具的撤除函数。 */
  private disposers: (() => void)[] = []

  /** 每个工具上次调用的时刻（限频用）。 */
  private readonly lastAt: Map<string, number> = new Map()

  /** 最近一分钟的调用时刻。 */
  private window: number[] = []

  /** 电量事件订阅者。 */
  private readonly listeners: Set<(event: DesktopEvent) => void> = new Set()

  /** 最近一次电量读数。 */
  private battery: BatteryInfo | null = null

  /** 上一次的档位（用来判「变了没」）。 */
  private band = 'unknown'

  /** 计数。 */
  private readonly counters: MutableCounters = {
    calls: 0,
    ok: 0,
    throttled: 0,
    timeouts: 0,
    late: 0,
    worstMs: 0,
    batteryEvents: 0,
    rejected: new Map(),
  }

  /**
   * @param deps 依赖。
   */
  constructor(deps: DesktopHubDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.now = deps.now
    this.bridge = deps.bridge
    this.registrar = deps.registrar
    if (deps.registrar !== null) this.attach(deps.registrar)
  }

  /** 现在能不能用。 */
  get available(): boolean {
    return this.settings.enable && this.settings.enabledTools.length > 0
  }

  /** 不能用的原因。 */
  get reason(): InvokeReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.settings.enabledTools.length === 0) return 'tool-disabled'
    return undefined
  }

  /** 开着的工具描述。 */
  descriptors(): readonly ToolDescriptor[] {
    return buildDescriptors(this.settings)
  }

  /**
   * 换来源。已注册的工具不需要重注册（它们调的是本对象的方法）。
   * @param bridge 新来源。
   */
  useBridge(bridge: DesktopBridge | null): void {
    this.bridge = bridge
    this.log.info('数据来源已切换：%s', bridge === null ? '（无）' : bridge.id)
  }

  /**
   * 换注册器。`null` 会撤掉已注册的全部工具。
   * @param registrar 注册器。
   */
  useRegistrar(registrar: ToolRegistrar | null): void {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch (error) {
        this.log.warn('撤除工具注册失败：%s', textOf(error))
      }
    }
    this.disposers = []
    this.registrar = registrar
    if (registrar !== null) this.attach(registrar)
  }

  /**
   * 把描述表交给注册器。
   * @param registrar 注册器。
   */
  private attach(registrar: ToolRegistrar): void {
    for (const descriptor of this.descriptors()) {
      try {
        this.disposers.push(registrar(descriptor, args => this.invoke(descriptor.name, args)))
      } catch (error) {
        this.log.warn('注册工具 %s 失败：%s', descriptor.name, textOf(error))
      }
    }
  }

  /**
   * 订阅电量事件。
   * @param listener 回调。
   */
  subscribe(listener: (event: DesktopEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 最近一次电量读数。 */
  lastBattery(): BatteryInfo | null {
    return this.battery
  }

  /** 现状。 */
  status(): DesktopStatus {
    const bridge = this.bridge
    return {
      enabled: this.settings.enable,
      available: this.available,
      reason: this.reason,
      bridge: bridge === null ? '' : bridge.id,
      supports: bridge === null ? Object.freeze([]) : bridge.supports,
      tools: Object.freeze(this.settings.enabledTools.map(key => TOOL_NAMES[key])),
      registrar: this.registrar !== null,
      roots: this.settings.findRoots.length,
    }
  }

  /** 计数。 */
  stats(): DesktopStats {
    const rejected: Record<string, number> = {}
    for (const [key, value] of this.counters.rejected) rejected[key] = value
    return {
      calls: this.counters.calls,
      ok: this.counters.ok,
      throttled: this.counters.throttled,
      timeouts: this.counters.timeouts,
      late: this.counters.late,
      rejected,
      worstMs: this.counters.worstMs,
      batteryEvents: this.counters.batteryEvents,
    }
  }

  /**
   * 调一个工具。**永不抛错**。
   * @param tool 工具名。
   * @param args 参数。
   */
  async invoke(tool: string, args?: unknown): Promise<ToolResult> {
    const started = this.now()
    this.counters.calls += 1

    const verdict = await this.run(tool, args)
    const elapsedMs = Math.max(0, this.now() - started)

    if (elapsedMs > this.counters.worstMs) this.counters.worstMs = elapsedMs
    if (verdict.ok) this.counters.ok += 1
    else this.counters.rejected.set(verdict.reason, (this.counters.rejected.get(verdict.reason) ?? 0) + 1)

    const rendered = renderLines(verdict.lines)
    if (this.settings.verbose) {
      this.log.info('调用 %s → %s（%d 毫秒，%d 条被裁）', tool, verdict.reason, elapsedMs, rendered.omitted)
    }

    const result: ToolResult = {
      ok: verdict.ok,
      tool,
      reason: verdict.reason,
      data: verdict.data,
      text: rendered.text,
      detail: verdict.detail,
      elapsedMs,
      degraded: rendered.degraded,
      omitted: rendered.omitted,
    }
    return verdict.hint === undefined ? result : { ...result, hint: verdict.hint }
  }

  /**
   * 判定 + 执行。
   * @param tool 工具名。
   * @param args 参数。
   */
  private async run(tool: string, args: unknown): Promise<Verdict> {
    if (!this.settings.enable) {
      return this.refuse('disabled', '电脑只读能力是关着的', '打开 enable 后模型才能看到这些只读工具')
    }

    const key = TOOL_KEYS.find(candidate => TOOL_NAMES[candidate] === tool)
    if (key === undefined) {
      const names = this.settings.enabledTools.map(item => TOOL_NAMES[item]).join(' / ')
      return this.refuse('unknown-tool', `没有这个工具：${tool}`, `可用：${names}`)
    }
    if (!this.settings.enabledTools.includes(key)) {
      return this.refuse('tool-disabled', `${tool} 没在 enabledTools 里`, '把它加进 enabledTools 再试')
    }

    const checked = normalizeArgs(tool, args, this.settings)
    if (!checked.ok) {
      return this.refuse('bad-arg', checked.detail, '按参数说明改一次；越界值不会被自动夹紧')
    }

    const wait = this.throttleOf(tool)
    if (wait > 0) {
      this.counters.throttled += 1
      return this.refuse(
        'rate-limited',
        `${tool} 还要等 ${wait} 毫秒`,
        '连续轮询同一条读数没有新信息；要更快就调小 min-interval-ms',
      )
    }

    const bridge = this.bridge
    if (bridge === null) {
      return this.refuse('no-bridge', '没有接任何数据来源', this.hintOf(key, 'no-bridge'))
    }
    if (!bridge.supports.includes(key)) {
      return this.refuse('unsupported', `来源 ${bridge.id} 不负责 ${key}`, this.hintOf(key, 'unsupported'))
    }

    // 记账放在「真的要打来源」之前：失败也会消耗一次间隔，避免对坏来源反复重试。
    this.lastAt.set(tool, this.now())
    this.window.push(this.now())

    try {
      if (checked.args.tool === 'processes') {
        return await this.doProcesses(bridge, checked.args.limit, checked.args.sort)
      }
      if (checked.args.tool === 'foreground') return await this.doForeground(bridge)
      if (checked.args.tool === 'clipboard') return await this.doClipboard(bridge)
      if (checked.args.tool === 'findFiles') {
        return await this.doFindFiles(bridge, checked.args.keyword, checked.args.depth, checked.args.limit)
      }
      return await this.doSysinfo(bridge)
    } catch (error) {
      return this.refuse('error', textOf(error), this.hintOf(key, 'error'))
    }
  }

  /**
   * 限频判定：先看单工具间隔，再看每分钟总预算。
   * @param tool 工具名。
   * @returns 需要等待的毫秒数（0 = 放行）。
   */
  private throttleOf(tool: string): number {
    const at = this.now()
    const interval = tool === TOOL_NAMES.sysinfo ? this.settings.sysinfoIntervalMs : this.settings.minIntervalMs
    const last = this.lastAt.get(tool)
    if (last !== undefined && interval > 0) {
      const delta = at - last
      if (delta < interval) return interval - delta
    }
    const cutoff = at - 60_000
    this.window = this.window.filter(item => item > cutoff)
    if (this.window.length >= this.settings.callsPerMinute) {
      const oldest = this.window.at(0)
      return oldest === undefined ? 1_000 : Math.max(1, oldest + 60_000 - at)
    }
    return 0
  }

  /** 进程。 */
  private async doProcesses(bridge: DesktopBridge, limit: number, sort: SortKey): Promise<Verdict> {
    const outcome = await withTimeout(
      bridge.processes({ limit, sort }, this.settings.callTimeoutMs),
      this.settings.callTimeoutMs,
      () => {
        this.counters.late += 1
      },
    )
    if (outcome === null) return this.timeoutVerdict('processes')
    if (!outcome.ok) return this.bridgeFailure('processes', outcome.reason, outcome.detail)

    const rows = outcome.value.slice(0, limit).map(item => poseProcess(item))
    const lines = rows.map(item => `${item.name}  pid=${item.pid}  cpu=${item.cpu}%  mem=${item.memMb}MB`)
    if (lines.length === 0) lines.push('（没有可读的进程：来源返回空表）')
    return {
      ok: true,
      reason: 'ok',
      data: Object.freeze(rows),
      lines,
      detail: `${rows.length} 个进程（按 ${sort} 排）`,
    }
  }

  /** 前台应用。 */
  private async doForeground(bridge: DesktopBridge): Promise<Verdict> {
    const outcome = await withTimeout(
      bridge.foreground(this.settings.callTimeoutMs),
      this.settings.callTimeoutMs,
      () => {
        this.counters.late += 1
      },
    )
    if (outcome === null) return this.timeoutVerdict('foreground')
    if (!outcome.ok) return this.bridgeFailure('foreground', outcome.reason, outcome.detail)

    const view = poseForeground(outcome.value, this.settings.includeWindowTitle)
    const title = view.title === '' ? '（标题未返回）' : view.title
    return {
      ok: true,
      reason: 'ok',
      data: view,
      lines: [`${view.app} · ${title}`],
      detail: `前台：${view.app}`,
    }
  }

  /** 剪贴板。 */
  private async doClipboard(bridge: DesktopBridge): Promise<Verdict> {
    const outcome = await withTimeout(
      bridge.clipboardMeta(this.settings.callTimeoutMs),
      this.settings.callTimeoutMs,
      () => {
        this.counters.late += 1
      },
    )
    if (outcome === null) return this.timeoutVerdict('clipboard')
    if (!outcome.ok) return this.bridgeFailure('clipboard', outcome.reason, outcome.detail)

    const view = poseClipboard(outcome.value)
    const shape = view.kind === 'text' ? `${view.chars} 字 / ${view.lines} 行` : view.kind
    return {
      ok: true,
      reason: 'ok',
      data: view,
      lines: [`剪贴板：${shape}`],
      detail: '只有形态与长度，没有内容',
    }
  }

  /** 文件检索（多根目录串行，凑满条数就停）。 */
  private async doFindFiles(bridge: DesktopBridge, keyword: string, depth: number, limit: number): Promise<Verdict> {
    const roots = this.settings.findRoots
    if (roots.length === 0) {
      return this.refuse(
        'no-roots',
        '没有配任何检索根',
        '在 find-roots 里加一个相对目录（如 Desktop），不接受绝对路径与 ..',
      )
    }

    const hits: FileHit[] = []
    const lines: string[] = []
    // 两个「不完整」的原因分开记：一个是预算用尽，一个是目录读不了。
    // 合成一个布尔会让「Documents 不存在」被说成「条目预算用尽」，用户照着调大预算也不会好。
    let budgetHit = false
    let failedRoots = 0
    let scanned = 0

    for (const root of roots) {
      if (hits.length >= limit) break
      const outcome = await withTimeout(
        bridge.findFiles({ root, keyword, depth, limit: limit - hits.length }, this.settings.callTimeoutMs),
        this.settings.callTimeoutMs,
        () => {
          this.counters.late += 1
        },
      )
      if (outcome === null) {
        if (hits.length === 0) return this.timeoutVerdict('findFiles')
        budgetHit = true
        break
      }
      if (!outcome.ok) {
        // 某个根目录不存在或没权限，不该让整次检索失败——带着已有的走。
        if (hits.length === 0 && roots.length === 1) {
          return this.bridgeFailure('findFiles', outcome.reason, outcome.detail)
        }
        failedRoots += 1
        continue
      }
      scanned += outcome.value.scanned
      if (outcome.value.partial) budgetHit = true
      for (const item of outcome.value.hits) {
        if (hits.length >= limit) break
        const view = poseHit(item, root, this.settings.maskPaths)
        hits.push(view)
        lines.push(`${view.path}  ${view.size} 字节`)
      }
    }

    if (lines.length === 0) {
      if (budgetHit) lines.push(`（没找到「${keyword}」，且没扫完：条目预算用尽）`)
      else if (failedRoots > 0) lines.push(`（没找到「${keyword}」；有 ${failedRoots} 个目录读不了，见日志）`)
      else lines.push(`（没找到「${keyword}」）`)
    }
    return {
      ok: true,
      reason: 'ok',
      data: Object.freeze(hits),
      lines,
      detail: `${hits.length} 个命中，扫了 ${scanned} 个条目${budgetHit ? '（预算用尽，未扫完）' : ''}${
        failedRoots > 0 ? `（${failedRoots} 个目录读不了）` : ''
      }`,
    }
  }

  /** 系统状态（顺带判电量档位变化）。 */
  private async doSysinfo(bridge: DesktopBridge): Promise<Verdict> {
    const outcome = await withTimeout(
      bridge.sysinfo(this.settings.callTimeoutMs),
      this.settings.callTimeoutMs,
      () => {
        this.counters.late += 1
      },
    )
    if (outcome === null) return this.timeoutVerdict('sysinfo')
    if (!outcome.ok) return this.bridgeFailure('sysinfo', outcome.reason, outcome.detail)

    const view = poseSysinfo(outcome.value)
    const usedPct = view.totalMb === 0 ? 0 : Math.round(((view.totalMb - view.freeMb) / view.totalMb) * 100)
    const load = view.loadAvg.length === 0 ? '—' : view.loadAvg.map(item => item.toFixed(2)).join(' / ')
    const lines = [
      `${view.platform}/${view.arch} · ${view.cores} 核`,
      `内存 ${view.freeMb}/${view.totalMb}MB 空闲（已用 ${usedPct}%）`,
      `负载 ${load}`,
      `开机 ${Math.floor(view.uptimeSec / 3600)} 小时 ${Math.floor((view.uptimeSec % 3600) / 60)} 分`,
    ]
    if (view.battery === null) {
      lines.push('电量：来源没有电池读数')
    } else {
      lines.push(`电量 ${view.battery.level}%${view.battery.charging ? '（充电中）' : ''}`)
    }

    this.observeBattery(view.battery)
    return {
      ok: true,
      reason: 'ok',
      data: view,
      lines,
      detail: `系统状态（${view.platform}/${view.arch}）`,
    }
  }

  /**
   * 观察电量：档位变化才发事件。
   *
   * 三条刻意的判定：
   * 1. 只发「变化」不发「每次读数」——每 5 秒一条会把消费方淹掉；
   * 2. **首次读到低/严重低电量也要发**，否则启动时就已经快没电的机器永远不报警；
   * 3. 首次读到正常或充电**不发**——那不是变化，是背景。
   * @param battery 本次读数。
   */
  private observeBattery(battery: BatteryInfo | null): void {
    if (battery === null) return
    this.battery = battery
    if (!this.settings.batteryEvents) return

    const band = bandOf(battery)
    const previous = this.band
    if (band === previous) return
    this.band = band
    if (band === 'unknown') return
    if (previous === 'unknown' && band !== 'low' && band !== 'critical') return

    this.counters.batteryEvents += 1
    const event: DesktopEvent = {
      kind: 'battery',
      band,
      level: battery.level,
      charging: battery.charging,
      at: battery.at === 0 ? this.now() : battery.at,
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        // 订阅者崩了不能连累本包（§8.1 C3：器官错误不得传播）。
        this.log.warn('电量事件订阅者抛错：%s', textOf(error))
      }
    }
  }

  /** 超时的统一结论。 */
  private timeoutVerdict(key: string): Verdict {
    this.counters.timeouts += 1
    return this.refuse('timeout', `${key} 超过 ${this.settings.callTimeoutMs} 毫秒没回来`, this.hintOf(key, 'timeout'))
  }

  /** 来源失败的统一结论。 */
  private bridgeFailure(
    key: string,
    reason: 'unsupported' | 'denied' | 'error' | 'timeout',
    detail: string,
  ): Verdict {
    if (reason === 'timeout') return this.timeoutVerdict(key)
    if (reason === 'unsupported') return this.refuse('unsupported', detail, this.hintOf(key, 'unsupported'))
    if (reason === 'denied') return this.refuse('denied', detail, this.hintOf(key, 'denied'))
    return this.refuse('error', detail, this.hintOf(key, 'error'))
  }

  /**
   * 造一个「拒绝」结论。
   * @param reason 原因码。
   * @param detail 说明。
   * @param hint 指路。
   */
  private refuse(reason: InvokeReason, detail: string, hint: string): Verdict {
    return { ok: false, reason, data: null, lines: [detail], detail, hint }
  }

  /**
   * 指路文案。**按能力分开写**：同一条「不支持」对五种能力的下一步动作完全不同。
   * @param key 能力键。
   * @param kind 失败种类。
   */
  private hintOf(key: string, kind: 'no-bridge' | 'unsupported' | 'timeout' | 'denied' | 'error'): string {
    if (kind === 'timeout') {
      return '把 call-timeout-ms 调大，或改用更轻的 desktop-sysinfo（它只读内存与负载）'
    }
    if (kind === 'denied') {
      return '系统权限没给：到「系统设置 → 隐私与安全性」里给宿主进程授权后重试'
    }
    if (kind === 'error') {
      return '来源报错：先看日志里的原因码；连续失败就别再重试，换成 desktop-sysinfo'
    }
    if (key === 'processes') {
      return '替代：用 desktop-sysinfo 看负载与内存，比列进程更省上下文；确实要看进程就得接一个平台桥接'
    }
    if (key === 'foreground') {
      return '替代：直接问用户「你现在在忙什么」——那比猜窗口标题更准，也不涉及隐私'
    }
    if (key === 'clipboard') {
      return '替代：让用户把要处理的内容贴进对话。本包不读剪贴板内容，连长度也需要一个会读内容的来源'
    }
    if (key === 'findFiles') {
      return '替代：把文件拖进对话，或说出大概目录；本包只做文件名检索，不读内容'
    }
    return '替代：没有更轻的来源能回答系统状态；检查宿主是否装载了本插件所需的平台桥接'
  }
}
