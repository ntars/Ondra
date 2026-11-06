/**
 * 能力面与调用治理。**本包唯一决定「这次调用成不成立」的地方。**
 *
 * ## 一次调用的七道关，顺序不能换
 *
 * ```
 * 1. 总开关            关 → disabled
 * 2. 工具存在吗         不 → unknown-tool
 * 3. 这个工具开着吗     不 → tool-disabled
 * 4. 参数合规吗         不 → bad-arg（拒绝，不夹紧）
 * 5. 有来源吗           不 → no-bridge
 * 6. 来源声明支持吗     不 → unsupported（8 秒都不用等）
 * 7. 8 秒内回来了吗     不 → timeout（回来也丢，记 late）
 * ```
 *
 * 第 6 关放在第 7 关之前，是有意的：**先问「你能不能」，再等「你回不回」。**
 * 顺序反了，一个不支持的能力会先耗掉 8 秒再报错，而模型会把它读成「设备慢」，
 * 于是重试——每一次重试都再耗 8 秒。
 *
 * ## 超时之后为什么还要盯着结果
 *
 * `Promise.race` 只决定「谁先到」，被落下的那个 Promise 仍在跑。
 * 如果它最终 reject 而没人接，Node 会报 unhandledRejection；如果它最终 resolve，
 * 我们却已经返回了 `timeout`。两种都要处理：给它挂一个**只记账不上报**的尾巴，
 * 计入 `stats().late`。这样「来源很慢」这件事在面板上是可见的，
 * 而不是悄悄消失。
 *
 * ## 为什么失败不带数据
 *
 * `data` 在失败时恒为 `null`。带着半份数据的失败最容易被误用：
 * 调用方看到 `items` 有 3 条就当成成功，于是「只读到 3 条」被当成「只有 3 条」。
 */

import type {
  BridgeResult,
  DeviceBridge,
  DeviceService,
  DeviceStats,
  DeviceStatus,
  InvokeReason,
  LogLike,
  ToolDescriptor,
  ToolRegistrar,
  ToolResult,
  ToolKey,
} from './types.js'
import type { NormalizedArgs } from './tools.js'
import { buildDescriptors, keyOf, normalizeArgs } from './tools.js'
import { shapeContact, shapeNotification, shapeSms } from './privacy.js'
import type { Config } from './settings.js'

/** 构造依赖。`bridge` / `registrar` 可变：`useBridge()` / `useRegistrar()` 就地替换。 */
export interface DeviceHubDeps {
  /** 生效配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 统一时间源。 */
  readonly now: () => number
  /** 数据来源（可空）。 */
  bridge: DeviceBridge | null
  /** 工具注册器（可空；空 = 只提供服务，不交给模型）。 */
  registrar: ToolRegistrar | null
}

/** 超时哨兵。 */
const TIMEOUT = Symbol('timeout')

/** 手机只读能力门面。 */
export class DeviceHub implements DeviceService {
  private readonly deps: DeviceHubDeps

  /** 已注册工具的撤除函数（换注册器或卸载时一并撤掉）。 */
  private registrations: (() => void)[] = []

  private calls = 0
  private okCount = 0
  private timeouts = 0
  private late = 0
  private worstMs = 0
  private readonly rejected: Record<string, number> = {}

  constructor(deps: DeviceHubDeps) {
    this.deps = deps
  }

  /** 能不能用：开关、来源、至少一个工具开着。 */
  get available(): boolean {
    return (
      this.deps.settings.enable &&
      this.deps.bridge !== null &&
      this.descriptors().length > 0
    )
  }

  /** 不能用的原因。 */
  get reason(): InvokeReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (this.deps.bridge === null) return 'no-bridge'
    if (this.descriptors().length === 0) return 'tool-disabled'
    return undefined
  }

  /** 开着的工具描述。 */
  descriptors(): readonly ToolDescriptor[] {
    const all = buildDescriptors(this.deps.settings.callTimeoutMs)
    const enabled = this.deps.settings.enabledTools
    return Object.freeze(
      all.filter(item => {
        const key = keyOf(item.name)
        return key !== undefined && enabled.includes(key)
      }),
    )
  }

  /**
   * 调一个工具。**永不抛错**。
   * @param tool 工具名。
   * @param args 参数（可空）。
   */
  async invoke(tool: string, args?: unknown): Promise<ToolResult> {
    const startedAt = this.deps.now()
    this.calls += 1
    try {
      const result = await this.run(tool, args, startedAt)
      if (result.ok) this.okCount += 1
      else this.rejected[result.reason] = (this.rejected[result.reason] ?? 0) + 1
      const elapsed = this.deps.now() - startedAt
      if (elapsed > this.worstMs) this.worstMs = elapsed
      if (this.deps.settings.verbose) {
        this.deps.log.info('设备能力调用：%s → %s（%d 毫秒）', tool, result.reason, elapsed)
      }
      return result
    } catch (error) {
      // 手册 §8.1-C3：错误不得传播。
      const elapsed = this.deps.now() - startedAt
      const detail = '内部异常：' + textOf(error)
      this.rejected['error'] = (this.rejected['error'] ?? 0) + 1
      return { ok: false, tool, reason: 'error', data: null, detail, elapsedMs: elapsed, degraded: false }
    }
  }

  /** 真正的七道关。 */
  private async run(tool: string, args: unknown, startedAt: number): Promise<ToolResult> {
    const elapsed = (): number => this.deps.now() - startedAt
    const reject = (reason: InvokeReason, detail: string): ToolResult => ({
      ok: false,
      tool,
      reason,
      data: null,
      detail,
      elapsedMs: elapsed(),
      degraded: false,
    })

    if (!this.deps.settings.enable) return reject('disabled', '开关是关的（enable=false）')

    const key = keyOf(tool)
    if (key === undefined) {
      return reject('unknown-tool', '没有这个工具（可用：' + this.descriptors().map(item => item.name).join(' / ') + '）')
    }
    if (!this.deps.settings.enabledTools.includes(key)) {
      return reject('tool-disabled', '这个能力没开（enabledTools 里没有 ' + key + '）')
    }

    const verdict = normalizeArgs(tool, args, this.deps.settings.defaultLimit)
    if (!verdict.ok) return reject('bad-arg', verdict.detail)

    const bridge = this.deps.bridge
    if (bridge === null) {
      return reject('no-bridge', '没有数据来源：注入 DeviceBridge 后可用（本包不自己读设备，理由见 README）')
    }
    if (!bridge.supports.includes(key)) {
      return reject(
        'unsupported',
        '当前来源不支持 ' + tool + '（支持：' + (bridge.supports.length === 0 ? '无' : bridge.supports.join(' / ')) + '）',
      )
    }

    const timeoutMs = this.deps.settings.callTimeoutMs
    const raced = await this.withTimeout(this.dispatch(bridge, verdict.value, timeoutMs), timeoutMs)
    if (raced === TIMEOUT) {
      this.timeouts += 1
      return reject('timeout', '来源 ' + String(timeoutMs) + ' 毫秒内没有回应（结果若迟到会被丢弃，计入 stats.late）')
    }
    if (!raced.ok) {
      return reject(mapFailure(raced.reason), raced.detail)
    }
    return this.shape(key, tool, raced.value, elapsed())
  }

  /** 按能力分派到来源。 */
  private dispatch(bridge: DeviceBridge, value: NormalizedArgs, timeoutMs: number): Promise<BridgeResult<unknown>> {
    switch (value.kind) {
      case 'notifications':
        return bridge.notifications({ limit: value.limit }, timeoutMs)
      case 'sms':
        return bridge.sms({ limit: value.limit, unreadOnly: value.unreadOnly }, timeoutMs)
      case 'contacts':
        return bridge.contacts({ query: value.query, limit: value.limit }, timeoutMs)
      case 'battery':
        return bridge.battery(timeoutMs)
      case 'foreground':
        return bridge.foreground(timeoutMs)
    }
  }

  /** 隐私加工 + 组装规范返回值。 */
  private shape(key: ToolKey, tool: string, value: unknown, elapsedMs: number): ToolResult {
    const settings = this.deps.settings

    if (key === 'notifications') {
      const items = (value as readonly { app: string; title: string; body?: string; at: number }[]).map(item =>
        shapeNotification(item, settings.includeNotificationBody, settings.smsBodyMax),
      )
      const degraded = items.some(item => item.degraded) || !settings.includeNotificationBody
      return {
        ok: true,
        tool,
        reason: 'ok',
        data: { items: items.map(item => item.value), count: items.length },
        detail:
          '读到 ' +
          String(items.length) +
          ' 条通知' +
          (settings.includeNotificationBody ? '（含正文，已截断）' : '（不含正文：通知里常有验证码与私信）'),
        elapsedMs,
        degraded,
      }
    }

    if (key === 'sms') {
      const items = (value as readonly { id: string; address: string; body: string; date: number }[]).map(item =>
        shapeSms({ ...item, truncated: false }, settings.maskPhones, settings.smsBodyMax),
      )
      return {
        ok: true,
        tool,
        reason: 'ok',
        data: { items: items.map(item => item.value), count: items.length },
        detail:
          '读到 ' +
          String(items.length) +
          ' 条短信' +
          (settings.maskPhones ? '（号码已打码）' : '') +
          (items.some(item => item.value.truncated) ? '，部分正文被截断（见 truncated）' : ''),
        elapsedMs,
        degraded: items.some(item => item.degraded),
      }
    }

    if (key === 'contacts') {
      const items = (value as readonly { name: string; phone: string }[]).map(item =>
        shapeContact(item, settings.maskPhones),
      )
      return {
        ok: true,
        tool,
        reason: 'ok',
        data: { items: items.map(item => item.value), count: items.length },
        detail: '按关键词匹配到 ' + String(items.length) + ' 位联系人' + (settings.maskPhones ? '（号码已打码）' : ''),
        elapsedMs,
        degraded: items.some(item => item.degraded),
      }
    }

    if (key === 'battery') {
      return {
        ok: true,
        tool,
        reason: 'ok',
        data: { battery: value },
        detail: '读到电量信息',
        elapsedMs,
        degraded: false,
      }
    }

    return {
      ok: true,
      tool,
      reason: 'ok',
      data: { foreground: value },
      detail: '读到前台应用',
      elapsedMs,
      degraded: false,
    }
  }

  /**
   * 给一个 Promise 套超时。
   * @param work 来源的 Promise。
   * @param timeoutMs 超时（毫秒）。
   */
  private withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
    if (timeoutMs <= 0) return Promise.resolve(TIMEOUT)

    return new Promise<T | typeof TIMEOUT>(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // 迟到也要有人接：否则 Node 会报 unhandledRejection。
        void work.then(
          () => {
            this.late += 1
          },
          () => {
            this.late += 1
          },
        )
        resolve(TIMEOUT)
      }, timeoutMs)
      const maybe = timer as unknown as { unref?: () => void }
      if (typeof maybe.unref === 'function') maybe.unref()

      void work.then(
        value => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, reason: 'error', detail: '来源抛错（已被折成结果）' } as unknown as T)
        },
      )
    })
  }

  /**
   * 换数据来源。
   * @param bridge 来源（`null` = 卸掉）。
   */
  useBridge(bridge: DeviceBridge | null): void {
    this.deps.bridge = bridge
  }

  /**
   * 换注册器，并把开着的工具注册一遍。
   *
   * 注册器由宿主侧提供（`ctx.tools.register` 外面包一层），本包**不 import**
   * `@ntars/ondra-tools`：一旦 import 且宿主没装，整个插件会在装载期抛错，
   * 而声明 `inject: ['tools']` 又会让它停在 PENDING（手册 §8.3、O-036/O-037 同口径）。
   * @param registrar 注册器（`null` = 撤掉）。
   */
  useRegistrar(registrar: ToolRegistrar | null): void {
    // 先把上一批撤干净：同一工具名注册两次，宿主的注册表会拒绝第二次，
    // 而界面会以为「两个都注册上了」。撤干净再注册是唯一不会留下幽灵的路径。
    this.disposeRegistrations()
    this.deps.registrar = registrar
    if (registrar === null) return

    for (const descriptor of this.descriptors()) {
      try {
        const dispose = registrar(descriptor, args => this.invoke(descriptor.name, args))
        if (typeof dispose === 'function') this.registrations.push(dispose)
        this.deps.log.info('已把只读工具 %s 交给宿主（只读、超时 %d 毫秒）', descriptor.name, descriptor.timeoutMs)
      } catch (error) {
        this.deps.log.warn('注册工具 %s 失败：%s（不影响服务本体）', descriptor.name, textOf(error))
      }
    }
  }

  /** 撤掉全部已注册工具（幂等）。 */
  private disposeRegistrations(): void {
    const pending = this.registrations
    this.registrations = []
    for (const dispose of pending) {
      try {
        dispose()
      } catch {
        // 撤除失败不影响其余：注册表自己会随插件 fiber 一起清掉。
      }
    }
  }

  /** 现状。 */
  status(): DeviceStatus {
    return {
      enabled: this.deps.settings.enable,
      available: this.available,
      reason: this.reason,
      bridge: this.deps.bridge === null ? '' : this.deps.bridge.id,
      supports: this.deps.bridge === null ? Object.freeze([]) : this.deps.bridge.supports,
      tools: Object.freeze(this.descriptors().map(item => item.name)),
      registrar: this.deps.registrar !== null,
    }
  }

  /** 计数。 */
  stats(): DeviceStats {
    return {
      calls: this.calls,
      ok: this.okCount,
      timeouts: this.timeouts,
      late: this.late,
      rejected: Object.freeze({ ...this.rejected }),
      worstMs: this.worstMs,
    }
  }
}

/**
 * 来源失败码 → 调用原因码。
 *
 * 词不一样必须显式翻译：把 `unsupported` 直接透给模型，它会以为「设备不支持」，
 * 而真相是「这个来源不管这件事」——处置完全不同（换来源 vs 换设备）。
 * @param failure 来源失败码。
 */
export function mapFailure(failure: string): InvokeReason {
  if (failure === 'unsupported') return 'unsupported'
  if (failure === 'device-offline') return 'device-offline'
  if (failure === 'denied') return 'denied'
  if (failure === 'timeout') return 'timeout'
  return 'error'
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
