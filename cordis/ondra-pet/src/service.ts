/**
 * O-074 `ondra-pet` 的门面：闸门 → 状态机 → 桥。
 *
 * ## 为什么闸门是一个返回「第一处失败」的纯判定
 *
 * `summon()` 有六道闸（开关 / 许可证 / 渲染档 / 地址 / 来源 / 桥在位）。
 * 若写成六个 `if` 各自 `return`，`status()` 就得再写一遍才能回答「为什么不能用」——
 * 两处判断迟早分叉，而分叉的表现是「面板说可用、一点就失败」。
 * 所以只有 `gate()` 一处，`summon()` 与 `status()` 共用它。
 *
 * ## 为什么状态只记在内存
 *
 * 桌宠是**当下这一刻**的东西：她要么在桌面上，要么不在。把「上次她在」落盘，
 * 下次启动先显示「在桌面上」再发现窗口根本没起，比不显示更糟。
 * 所以进程重启 = 从 `idle` 开始，不需要也没有「恢复上次状态」。
 *
 * ## 为什么 `dispose()` 不替调用方关窗口
 *
 * `dispose()` 是同步的（`ctx.effect()` 的清理函数），而 `bridge.stop()` 是异步的。
 * 在这里 `void stop()` 会得到一个「看起来收起了、其实还在」的窗口——
 * 与 O-073「不假装在线」同一条原则的镜像：**不假装收起**。
 * 于是只丢引用并留一条 warn，由卸载方先 `await dismiss()`。
 */

import { MissingBridge, TOKEN_MIN, checkBridgeUrl, checkOrigins, checkToken } from './bridge.js'
import { PET_ADAPTERS, adapterOf, adapterUsable } from './adapters.js'
import { canTransition, describeState, isBusy, isRunning } from './state.js'
import type { Config } from './settings.js'
import type {
  LogLike,
  PetAdapter,
  PetCode,
  PetLicense,
  PetOutcome,
  PetReason,
  PetService,
  PetSpawnOptions,
  PetState,
  PetStats,
  PetStatus,
  PetBridge,
  SummonOptions,
} from './types.js'

/** 构造依赖。 */
export interface PetDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
}

/** 闸门结论：通过或第一处失败。 */
type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PetReason; readonly detail: string; readonly hint?: string }

/** 可变计数（对外只读副本）。 */
interface Counter {
  summons: number
  summonsOk: number
  dismissals: number
  refused: number
  noBridge: number
  alreadyRunning: number
  failed: number
  exits: number
  bridgeCalls: number
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 桌宠门面。 */
export class PetHub implements PetService {
  /** 本版恒为骨架：没有桥就永远起不来，面板必须看得见这件事。 */
  readonly skeleton: true = true

  private readonly settings: Config

  private readonly log: LogLike

  private bridge: PetBridge = new MissingBridge()

  private current: PetState = 'idle'

  private readonly counter: Counter = {
    summons: 0,
    summonsOk: 0,
    dismissals: 0,
    refused: 0,
    noBridge: 0,
    alreadyRunning: 0,
    failed: 0,
    exits: 0,
    bridgeCalls: 0,
  }

  /**
   * @param deps 配置与日志。
   */
  constructor(deps: PetDeps) {
    this.settings = deps.settings
    this.log = deps.log
  }

  /** 现在能不能叫出来。 */
  get available(): boolean {
    return this.gate().ok
  }

  /** 不能用的原因（可用时 `undefined`）。 */
  get reason(): PetReason | undefined {
    const gate = this.gate()
    return gate.ok ? undefined : gate.code
  }

  /**
   * 叫出桌宠。
   * @param options 一次性 token。
   */
  async summon(options: SummonOptions = {}): Promise<PetOutcome> {
    this.counter.summons += 1

    const gate = this.gate()
    if (!gate.ok) return this.refuse(gate.code, gate.detail, gate.hint)

    if (isBusy(this.current)) {
      return this.refuse('busy', `正在${describeState(this.current)}，等一下再说。`)
    }
    if (isRunning(this.current)) {
      this.counter.alreadyRunning += 1
      return this.refuse(
        'already-running',
        '桌面上已经有一只了。',
        '要先收起（`dismiss()`）再叫。两只桌宠会让人分不清哪只是她——手册 §6.2 那个「不是同一只鱼」的痛点，不该在桌面上重演。',
      )
    }

    const verdict = checkToken(options.token, TOKEN_MIN)
    if (verdict === 'missing') {
      return this.refuse(
        'token-missing',
        '没有给一次性 token。',
        '桌宠启动后会打印一次性 token，用 `summon({ token })` 传进来。**不要写进配置文件**：它会出现在设置面板和截图里。',
      )
    }
    if (verdict === 'weak') {
      return this.refuse(
        'token-weak',
        `token 形状不合（要求 ≥${TOKEN_MIN} 字符、无空白）。`,
        '多半是复制时截断了。回去重新复制一次——手册语料里「误点重新生成导致两端 token 不一致」就是这类问题的另一种形态。',
      )
    }

    const spawnOptions: PetSpawnOptions = {
      render: this.settings.render,
      bridgeUrl: this.settings.bridgeUrl,
      // 这里把 token 交给桥之后就再也不持有它：不存字段、不打日志、不进 status()。
      token: (options.token ?? '').trim(),
      allowedOrigins: this.settings.allowedOrigins,
      tokenTtlMs: this.settings.tokenTtlMs,
      alwaysOnTop: this.settings.alwaysOnTop,
      scale: this.settings.scale,
    }

    if (!this.move('starting')) {
      return this.refuse('failed', `状态机拒绝了 \`${this.current} → starting\`。`)
    }

    this.counter.bridgeCalls += 1
    try {
      const result = await this.bridge.spawn(spawnOptions)
      if (!result.ok) {
        this.move('failed')
        if (result.reason === 'no-bridge') {
          return this.refuse('no-bridge', result.detail, '把一个 `PetBridge` 实现用 `useBridge()` 接进来即可，本包不用改。')
        }
        return this.refuse('failed', result.detail, '看桥自己的日志；本包已把状态置为 failed，可以再试一次。')
      }
      this.move('running')
      this.counter.summonsOk += 1
      if (this.settings.verbose) {
        // 只记结论与档位，**不记地址与 token**。
        this.log.info('桌宠已叫出（适配器 %s，渲染 %s）', this.settings.adapter, this.settings.render)
      }
      return { ok: true, code: 'ok', state: this.current, detail: '她到桌面上了。' }
    } catch (error) {
      this.move('failed')
      // C3 同源纪律：桥抛错不外抛，折成 failed（计数在 refuse 里按 code 记一次）。
      return this.refuse('failed', `桥抛错：${textOf(error)}`, '这是桥的问题，不是配置问题。')
    }
  }

  /** 收起。 */
  async dismiss(): Promise<PetOutcome> {
    this.counter.dismissals += 1

    if (isBusy(this.current)) {
      return this.refuse('busy', `正在${describeState(this.current)}，等一下再说。`)
    }
    // `failed` 也要允许收：spawn 失败时窗口可能已经开了（桥的返回失败、或回调没回来），
    // 此时若回 not-running，那个窗口就成了收不掉的孤儿。
    if (!isRunning(this.current) && this.current !== 'failed') {
      return this.refuse(
        'not-running',
        `现在没在跑（${describeState(this.current)}）。`,
        '收起是幂等的：没开的时候再收一次，不该被当成错误弹窗。',
      )
    }

    if (!this.move('stopping')) {
      return this.refuse('failed', `状态机拒绝了 \`${this.current} → stopping\`。`)
    }
    this.counter.bridgeCalls += 1
    try {
      const result = await this.bridge.stop()
      if (!result.ok) {
        this.move('failed')
        return this.refuse('failed', result.detail, '窗口可能还开着。看桥的日志，必要时手动关掉那个窗口。')
      }
      this.move('stopped')
      if (this.settings.verbose) this.log.info('桌宠已收起')
      return { ok: true, code: 'ok', state: this.current, detail: '收起来了。' }
    } catch (error) {
      this.move('failed')
      return this.refuse('failed', `桥抛错：${textOf(error)}`)
    }
  }

  /**
   * 外部告知窗口已关（用户直接关了窗口、或上游崩了）。
   * @param detail 说明（只进日志，不进状态）。
   */
  markExited(detail?: string): boolean {
    if (!isRunning(this.current)) return false
    this.move('stopped')
    this.counter.exits += 1
    this.log.info('桌宠窗口已关闭%s', detail === undefined || detail === '' ? '' : `（${detail}）`)
    return true
  }

  /** 现状。 */
  status(): PetStatus {
    const gate = this.gate()
    const adapter = adapterOf(this.settings.adapter)
    const license: PetLicense = adapter === undefined ? 'unknown' : adapter.license
    const verified = adapter === undefined ? false : adapter.verified
    return {
      enabled: this.settings.enable,
      available: gate.ok,
      ...(gate.ok ? {} : { reason: gate.code }),
      state: this.current,
      adapter: this.settings.adapter,
      license,
      verified,
      render: this.settings.render,
      bridge: this.bridge instanceof MissingBridge ? 'missing' : 'ready',
      bridgeConfigured: this.settings.bridgeUrl !== '',
      originCount: this.settings.allowedOrigins.length,
      skeleton: true,
    }
  }

  /** 计数。 */
  stats(): PetStats {
    return Object.freeze({ ...this.counter })
  }

  /** 生态桌宠清单（含不能接的，理由在 `note` 里）。 */
  adapters(): readonly PetAdapter[] {
    return PET_ADAPTERS
  }

  /**
   * 换桥。
   *
   * **跑着的时候不许换**：换掉等于把一只已经在桌面上的窗口的引用丢了，
   * 之后 `dismiss()` 收不掉它，而 `status()` 会说「没在跑」。
   * @param bridge 新桥；`null` 装回缺失实现。
   */
  useBridge(bridge: PetBridge | null): void {
    if (isRunning(this.current) || isBusy(this.current)) {
      this.log.warn('桌宠正在运行，拒绝换桥（会丢掉窗口引用、之后收不掉）。先 dismiss() 再换。')
      return
    }
    this.bridge = bridge ?? new MissingBridge()
    this.log.info('桌宠桥已切换为 %s', this.bridge.id)
  }

  /** 撤（幂等）。**不替调用方关窗口**，见文件头。 */
  dispose(): void {
    if (isRunning(this.current)) {
      this.log.warn('卸载时桌宠窗口可能还开着：调用方应先 await dismiss()。本包不代劳（dispose 是同步的，假收比不收更糟）。')
    }
    this.bridge = new MissingBridge()
    this.current = 'idle'
  }

  /**
   * 六道闸，返回**第一处**失败。
   *
   * 顺序按「用户能不能修」排：开关 → 适配器 → 渲染档 → 地址填没填 → 地址合不合规
   * → 来源 → 桥在不在。桥放在最后，是因为它是唯一「用户修不了」的一项（要写代码）。
   */
  private gate(): GateResult {
    if (!this.settings.enable) {
      return { ok: false, code: 'disabled', detail: '桌宠入口是关的。', hint: '在设置里打开 `enable`。端侧能力出厂全关。' }
    }

    const usable = adapterUsable(this.settings.adapter)
    if (!usable.usable) {
      return {
        ok: false,
        code: 'adapter-unusable',
        detail: usable.detail,
        hint: '换成 `dsh-pet` 或 `agentpet`（两项都是 MIT）。AGPL 的实现只能读思路，不能接（手册 §9.1）。',
      }
    }

    if (this.settings.render !== 'static') {
      return {
        ok: false,
        code: 'render-unsupported',
        detail: `渲染档 \`${this.settings.render}\` 在本版不可用。`,
        hint: '改成 `static`。Live2D 的 Cubism Core 专有且不可再分发，手册 §6.3 明确 1.0 阶段不做。',
      }
    }

    if (this.settings.bridgeUrl.trim() === '') {
      return {
        ok: false,
        code: 'bridge-unset',
        detail: '桥地址是空的。',
        hint: '填你装的那只桌宠的本地桥地址（回环 + ws/wss + 显式端口）。',
      }
    }

    const url = checkBridgeUrl(this.settings.bridgeUrl, { allowTokenInUrl: this.settings.allowTokenInUrl })
    if (!url.ok) {
      return { ok: false, code: 'bridge-url', detail: url.detail, ...(url.hint === undefined ? {} : { hint: url.hint }) }
    }

    const origins = checkOrigins(this.settings.allowedOrigins)
    if (!origins.ok) {
      return { ok: false, code: 'origin-unset', detail: origins.detail, ...(origins.hint === undefined ? {} : { hint: origins.hint }) }
    }

    if (this.bridge instanceof MissingBridge) {
      return {
        ok: false,
        code: 'no-bridge',
        detail: '没有桌宠桥。',
        hint: '本仓不含任何桌宠实现（按能力查过，0 命中），也禁装依赖。接一个 `PetBridge` 实现即可。',
      }
    }

    return { ok: true }
  }

  /**
   * 走一次状态迁移。
   * @param to 目标状态。
   */
  private move(to: PetState): boolean {
    if (!canTransition(this.current, to)) return false
    this.current = to
    return true
  }

  /**
   * 造一个被拒的结果（并计数）。
   *
   * **`failed` 不计入 `refused`**：`refused` 回答的是「闸门挡了多少次」（用户能改配置解决），
   * `failed` 回答的是「桥出了多少次错」（用户改配置没用，要看桥的日志）。合成一个数，
   * 面板上就分不清「我配错了」和「桥坏了」——而这正是用户唯一需要分清的一件事。
   * @param code 结果码。
   * @param detail 说明。
   * @param hint 指路。
   */
  private refuse(code: PetCode, detail: string, hint?: string): PetOutcome {
    if (code === 'failed') {
      this.counter.failed += 1
    } else {
      this.counter.refused += 1
    }
    if (code === 'no-bridge') this.counter.noBridge += 1
    return {
      ok: false,
      code,
      state: this.current,
      detail,
      ...(hint === undefined ? {} : { hint }),
    }
  }
}
