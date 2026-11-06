/**
 * O-075 `ondra-pet-mobile` 的门面：前提判定 → 绑定簿 → 中继。
 *
 * ## 为什么上游探测做成注进来的闭包
 *
 * `ctx.get()` 只有宿主上下文里有。若服务自己去取，这个类就没法在不启动宿主的情况下
 * 被单独推演（本轮禁实装运行，所有结论靠纯逻辑对拍），而且「谁在哪一刻取的服务」
 * 会散落在业务代码里。所以四个探测函数从 `index.ts` 注进来，服务只消费结果。
 * 这与 O-070 / O-072 的「端口 + 注入口」是同一手法。
 *
 * ## 为什么 `check()` 每次都重算
 *
 * 前提里有一半会随环境变（宿主是否带 `webserver`、O-010 是否已装、桥是否已注入）。
 * 缓存它只有一个后果：用户装完 O-010 之后面板还说「缺记忆」。
 * 代价是每次 `check()` 都要问一遍上游——四次同步 `ctx.get()`，可忽略。
 */

import { BindingBook } from './bindings.js'
import { MissingRelay, checkRelayUrl, relayPortOf } from './bridge.js'
import { PREREQUISITES, evaluatePrereqs } from './prereq.js'
import type { Config } from './settings.js'
import type {
  Binding,
  BindingCode,
  BindingResult,
  LogLike,
  MobilePlatform,
  MobileReason,
  PetMobileBridge,
  PetMobileService,
  PetMobileStats,
  PetMobileStatus,
  Prereq,
  PrereqFacts,
  PrereqReport,
  RelayOutcome,
} from './types.js'

/** 构造依赖。 */
export interface PetMobileDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 取时刻。 */
  readonly now: () => number
  /** O-010 记忆核心在不在。 */
  readonly hasMemoryCore: () => boolean
  /** O-074 桌宠入口在不在。 */
  readonly hasPet: () => boolean
  /** 上游 `webServer` 在不在。 */
  readonly hasWebServer: () => boolean
  /** 读桌宠端状态串（缺席时必须返回 `'unknown'`）。 */
  readonly petState: () => string
}

/** 闸门结论。 */
type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: MobileReason; readonly detail: string; readonly hint?: string }

/** 可变计数。 */
interface Counter {
  binds: number
  bindsOk: number
  unbinds: number
  refused: number
  conflicts: number
  checks: number
  relays: number
  relayFailed: number
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 三端互通门面。 */
export class PetMobileHub implements PetMobileService {
  /** 本版恒为骨架（没有中继实现，手机端也未发布）。 */
  readonly skeleton: true = true

  private readonly settings: Config

  private readonly log: LogLike

  private readonly deps: PetMobileDeps

  private readonly book: BindingBook

  private bridge: PetMobileBridge = new MissingRelay()

  private connected = false

  private readonly counter: Counter = {
    binds: 0,
    bindsOk: 0,
    unbinds: 0,
    refused: 0,
    conflicts: 0,
    checks: 0,
    relays: 0,
    relayFailed: 0,
  }

  /**
   * @param deps 配置、日志与四个上游探测。
   */
  constructor(deps: PetMobileDeps) {
    this.deps = deps
    this.settings = deps.settings
    this.log = deps.log
    this.book = new BindingBook(deps.settings, deps.now)
  }

  /** 服务端侧前提齐了没有。 */
  get available(): boolean {
    return this.gate().ok
  }

  /** 不能用的原因。 */
  get reason(): MobileReason | undefined {
    const gate = this.gate()
    return gate.ok ? undefined : gate.code
  }

  /** 七条技术前提（静态定义，含出处）。 */
  prerequisites(): readonly Prereq[] {
    return PREREQUISITES
  }

  /** 逐条判定。 */
  check(): PrereqReport {
    this.counter.checks += 1
    try {
      return evaluatePrereqs(this.facts())
    } catch (error) {
      // 判定本身不该抛；真抛了也不能让面板崩（这里给一份「全判不了」的保守报告）。
      this.log.error('前提判定抛错（按「全部判不了」处理）：%s', textOf(error))
      return evaluatePrereqs({
        at: this.deps.now(),
        memoryCore: false,
        petEntry: false,
        webServer: false,
        portConflict: false,
        relayPortValid: false,
        bridge: false,
        relayConfigured: false,
        originCount: 0,
        mobileShipped: false,
      })
    }
  }

  /**
   * 绑一个端。
   * @param platform 平台。
   * @param peerId 该平台的标识。
   */
  bind(platform: MobilePlatform, peerId: string): BindingResult {
    this.counter.binds += 1
    const result = this.book.bind(platform, peerId)
    this.countResult(result.code)
    if (result.ok) this.counter.bindsOk += 1
    return result
  }

  /**
   * 解绑。
   * @param platform 平台。
   */
  unbind(platform: MobilePlatform): BindingResult {
    this.counter.unbinds += 1
    const result = this.book.unbind(platform)
    this.countResult(result.code)
    return result
  }

  /** 全部绑定。 */
  bindings(): readonly Binding[] {
    return this.book.all()
  }

  /**
   * 某个端的绑定。
   * @param platform 平台。
   */
  bindingOf(platform: MobilePlatform): Binding | undefined {
    return this.book.of(platform)
  }

  /** 已绑定的 peer 集合。 */
  peers(): readonly string[] {
    return this.book.peers()
  }

  /** 连上中继。 */
  async connect(): Promise<RelayOutcome> {
    this.counter.relays += 1

    const gate = this.gate()
    if (!gate.ok) return this.outcome(gate.code, gate.detail, gate.hint)
    if (this.connected) {
      return this.outcome('ok', '已经连着（重复连接不改参数）。')
    }

    try {
      const result = await this.bridge.connect({
        relayUrl: this.settings.relayUrl,
        allowedOrigins: this.settings.allowedOrigins,
        apiPort: this.settings.apiPort,
      })
      if (!result.ok) {
        return this.outcome(
          result.reason === 'no-bridge' ? 'no-bridge' : 'failed',
          result.detail,
          result.reason === 'no-bridge'
            ? '写一个 `PetMobileBridge`（`connect` / `disconnect`）用 `useBridge()` 接进来，本包不用改。'
            : '看桥自己的日志。',
        )
      }
      this.connected = true
      if (this.settings.verbose) this.log.info('三端中继已连上')
      return this.outcome('ok', '中继已连上。')
    } catch (error) {
      // C3 同源纪律：桥抛错不外抛（计数在 outcome 里按码记一次）。
      return this.outcome('failed', `桥抛错：${textOf(error)}`, '这是桥的问题，不是配置问题。')
    }
  }

  /** 断开中继（幂等）。 */
  async disconnect(): Promise<RelayOutcome> {
    if (!this.connected) {
      return this.outcome('ok', '本来就没连。')
    }
    try {
      const result = await this.bridge.disconnect()
      this.connected = false
      if (!result.ok) {
        return this.outcome('failed', result.detail, '状态已置为断开；桥那边可能还留着连接，看它的日志。')
      }
      if (this.settings.verbose) this.log.info('三端中继已断开')
      return this.outcome('ok', '断开了。')
    } catch (error) {
      this.connected = false
      return this.outcome('failed', `桥抛错：${textOf(error)}`)
    }
  }

  /** 现状。 */
  status(): PetMobileStatus {
    const gate = this.gate()
    return {
      enabled: this.settings.enable,
      available: gate.ok,
      ...(gate.ok ? {} : { reason: gate.code }),
      platforms: this.settings.platforms,
      bindings: this.book.count(),
      bridge: this.bridge instanceof MissingRelay ? 'missing' : 'ready',
      relayConfigured: this.settings.relayUrl !== '',
      originCount: this.settings.allowedOrigins.length,
      memoryReady: this.safeProbe(this.deps.hasMemoryCore),
      petState: this.safePetState(),
      mobileShipped: false,
      skeleton: true,
    }
  }

  /** 计数。 */
  stats(): PetMobileStats {
    return Object.freeze({ ...this.counter })
  }

  /**
   * 换中继桥。
   *
   * 连着的时候不许换：换掉会丢掉连接引用，之后 `disconnect()` 断不掉它，
   * 而 `status()` 会说「没连」。
   * @param bridge 新桥；`null` 装回缺失实现。
   */
  useBridge(bridge: PetMobileBridge | null): void {
    if (this.connected) {
      this.log.warn('中继已连上，拒绝换桥（会丢连接引用、之后断不掉）。先 disconnect() 再换。')
      return
    }
    this.bridge = bridge ?? new MissingRelay()
    this.log.info('三端中继桥已切换为 %s', this.bridge.id)
  }

  /** 撤（幂等）。**不代断连接**，同 `dispose()` 的同步限制。 */
  dispose(): void {
    if (this.connected) {
      this.log.warn('卸载时中继可能还连着：调用方应先 await disconnect()。本包不代劳（dispose 是同步的）。')
    }
    this.bridge = new MissingRelay()
    this.connected = false
    this.book.clear()
  }

  /** 汇总事实。 */
  private facts(): PrereqFacts {
    const relayPort = relayPortOf(this.settings.relayUrl)
    return {
      at: this.deps.now(),
      memoryCore: this.safeProbe(this.deps.hasMemoryCore),
      petEntry: this.safeProbe(this.deps.hasPet),
      webServer: this.safeProbe(this.deps.hasWebServer),
      portConflict: relayPort !== null && relayPort === this.settings.apiPort,
      relayPortValid: relayPort !== null,
      bridge: !(this.bridge instanceof MissingRelay),
      relayConfigured: this.settings.relayUrl !== '',
      originCount: this.settings.allowedOrigins.length,
      mobileShipped: false,
    }
  }

  /** 六道闸，返回**第一处**失败。 */
  private gate(): GateResult {
    if (!this.settings.enable) {
      return { ok: false, code: 'disabled', detail: '三端互通是关的。', hint: '打开 `enable`。端侧默认全关。' }
    }

    if (!this.safeProbe(this.deps.hasMemoryCore)) {
      return {
        ok: false,
        code: 'memory-missing',
        detail: '没有记忆真源（O-010）：三端会各存一份，接起来也是三只。',
        hint: '装 O-010 `ondra-memory-core`。这是根因，不是优化项。',
      }
    }

    if (this.settings.relayUrl.trim() === '') {
      return { ok: false, code: 'bridge-unset', detail: '中继地址是空的。', hint: '填 `relayUrl`。' }
    }

    const check = checkRelayUrl(this.settings.relayUrl)
    if (!check.ok) {
      return { ok: false, code: 'bridge-url', detail: check.detail, ...(check.hint === undefined ? {} : { hint: check.hint }) }
    }

    if (this.settings.allowedOrigins.length === 0) {
      return {
        ok: false,
        code: 'origin-unset',
        detail: '允许来源清单是空的，等于全拒。',
        hint: '在 `allowedOrigins` 里填三端的来源。不填就启动 = 不校验 Origin（§9.2）。',
      }
    }

    if (this.bridge instanceof MissingRelay) {
      return {
        ok: false,
        code: 'no-bridge',
        detail: '没有 WS 中继实现。',
        hint: '本仓不含三端中继（也没有帧格式依据），接一个 `PetMobileBridge` 即可。',
      }
    }

    return { ok: true }
  }

  /**
   * 探一下上游存在性（探错当「不在」）。
   * @param probe 探测函数。
   */
  private safeProbe(probe: () => boolean): boolean {
    try {
      return probe()
    } catch (error) {
      this.log.warn('上游探测抛错（按「不在」处理）：%s', textOf(error))
      return false
    }
  }

  /** 读桌宠端状态（读不出就是 `unknown`）。 */
  private safePetState(): string {
    try {
      const state = this.deps.petState().trim()
      return state === '' ? 'unknown' : state
    } catch (error) {
      this.log.warn('读桌宠端状态失败（按 unknown 处理）：%s', textOf(error))
      return 'unknown'
    }
  }

  /**
   * 造一个结果并**在唯一一处计数**。
   *
   * 两桶分开记，因为排查方向不同：
   * - `relayFailed` → **桥这一侧**的事：`no-bridge`（缺施工件，要写代码）或 `failed`（桥报错，看它的日志）；
   * - `refused` → **闸门挡下**（改配置能解决）。
   *
   * 把两桶合成一个「失败数」，面板上就分不清「我配错了」和「桥坏了」——而这正是用户唯一需要分清的一件事。
   * 三处调用点（`connect` 的闸门拒、桥返回失败、桥抛错）全部走这里，不许在别处再 `+= 1`（会双计）。
   * @param code 结果码。
   * @param detail 说明。
   * @param hint 指路。
   */
  private outcome(code: RelayOutcome['code'], detail: string, hint?: string): RelayOutcome {
    if (code === 'failed' || code === 'no-bridge') this.counter.relayFailed += 1
    else if (code !== 'ok') this.counter.refused += 1
    return { ok: code === 'ok', code, detail, ...(hint === undefined ? {} : { hint }) }
  }

  /**
   * 记一次被拒（绑定簿的拒绝也计入）。
   * @param code 绑定结果码。
   */
  private countResult(code: BindingCode): void {
    if (code === 'conflict') {
      this.counter.conflicts += 1
      this.counter.refused += 1
      return
    }
    if (code !== 'ok') this.counter.refused += 1
  }
}
