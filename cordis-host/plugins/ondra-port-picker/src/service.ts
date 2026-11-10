/**
 * O-083 的服务实现：**只做编排**。判定在 `policy.ts`，三个意图各一个文件
 * （`system.ts` / `fixed.ts` / `endpoint.ts`，按 §14.2 文件隔离），
 * 绑定在 `probe.ts`，记账在 `ledger.ts`。
 *
 * ## 两个意图走两条完全不同的路
 *
 * `listener`（默认）要一个「现在没人绑」的号；`endpoint` 要「宿主已经绑着」的号。
 * 见 `types.ts` 的 `PortIntent`——把这两件事合成一个 `pick()` 的实现，会让子进程
 * 拿到宿主自己占着的端口，症状是启动即 `EADDRINUSE`，而日志里写着「挑到空闲端口」。
 *
 * ## 两个计数点，各一处
 *
 * - 发号只有 `#accept` 一个出口（记账 + `picks` + 日志都在这）。
 * - 失败只有 `#fail` 一个出口（`failures` 只在这加）。
 *
 * 分支文件拿到的 `accept` / `fail` 都是这两个方法包出来的闭包，所以分支里
 * 没有第二套计数——否则「同一个失败记两次」迟早发生。
 *
 * ## 永不抛
 *
 * 所有公开方法都折成 `PickOutcome` / 布尔。端口挑不到是常态（被占、超时、配置错），
 * 让它变成异常，调用方就得在「要不要 try」上做选择，而选择的结果一定是有人忘了。
 */

import { pickEndpoint } from './endpoint.js'
import { pickFixed } from './fixed.js'
import { PortLedger } from './ledger.js'
import {
  describeBranch,
  describeIntent,
  describeReason,
  isLoopbackHost,
  normalizePort,
  purposeOf,
  raceOf,
} from './policy.js'
import { pickSystem } from './system.js'
import type { Config } from './settings.js'
import type {
  LogLike,
  PickOutcome,
  PickRequest,
  PickedPort,
  PortBranch,
  PortIntent,
  PortPickerService,
  PortRange,
  PortReason,
  PortSource,
  PortStats,
  ProbePort,
  WebServerLike,
} from './types.js'

/** 构造依赖。全部用函数取：配置与宿主服务都可能晚于本插件就绪。 */
export interface PortPickerDeps {
  /** 当前配置。 */
  readonly settings: () => Config
  /** 日志。 */
  readonly log: LogLike
  /** 当前时刻（Unix 毫秒）。 */
  readonly now: () => number
  /** 绑定探测。 */
  readonly probe: ProbePort
  /** 宿主 `webServer`；没有就是 `null`。 */
  readonly webServer: () => WebServerLike | null
}

/** 可变的计数器（对外只给快照）。 */
interface MutableStats {
  picks: number
  scans: number
  probes: number
  failures: number
  releases: number
}

/** 端口挑选服务。 */
export class PortPicker implements PortPickerService {
  readonly #deps: PortPickerDeps
  readonly #ledger: PortLedger
  readonly #stats: MutableStats = { picks: 0, scans: 0, probes: 0, failures: 0, releases: 0 }
  #disposed = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: PortPickerDeps) {
    this.#deps = deps
    // TTL 用函数取：配置改了立刻生效，不必重建账本。
    this.#ledger = new PortLedger(deps.now, () => deps.settings().ledgerTtlMs)
  }

  get available(): boolean {
    return !this.#disposed && this.#deps.settings().enable
  }

  get reason(): PortReason | undefined {
    if (this.#disposed) return 'disposed'
    return this.#deps.settings().enable ? undefined : 'disabled'
  }

  get branch(): PortBranch {
    return this.#deps.settings().branch
  }

  /**
   * 挑一个号。**永不抛**。
   * @param request 请求；全缺省时按 `listener` + 配置分支。
   */
  async pick(request: PickRequest = {}): Promise<PickOutcome> {
    try {
      return await this.#pickInner(request)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.#deps.log.warn('挑端口时出现意外异常（已折成失败结果）：%s', text)
      return this.#fail('probe-failed', `探测实现抛出异常：${text}`)
    }
  }

  /**
   * 登记一个外部已知的号（只记账，不探测）。
   *
   * 「不探测」是刻意的：调用方说这个号已经有人在用了，本包再探一次只会得到
   * 「被占」这个已知结论；而如果它还没被占，探测完也会立刻释放，等于什么都没做。
   * @param port 端口号。
   * @param purpose 谁要的。
   */
  reserve(port: number, purpose?: string): boolean {
    if (this.#disposed) return false
    const settings = this.#deps.settings()
    if (!settings.enable) return false
    const normalized = normalizePort(port)
    if (normalized === null) return false
    if (this.#ledger.has(normalized)) return false
    const pickedAt = this.#deps.now()
    this.#ledger.add(
      Object.freeze({
        port: normalized,
        host: settings.host,
        intent: 'listener' as const,
        branch: settings.branch,
        source: 'reserved' as const,
        purpose: purposeOf(purpose),
        race: raceOf('reserved'),
        pickedAt,
        expiresAt: this.#ledger.expiryOf(pickedAt),
      }),
    )
    return true
  }

  /**
   * 从账本里划掉一个号。
   * @param port 端口号。
   */
  release(port: number): boolean {
    const normalized = normalizePort(port)
    if (normalized === null) return false
    const dropped = this.#ledger.drop(normalized)
    if (dropped) this.#stats.releases += 1
    return dropped
  }

  /**
   * 单次探测。**永不抛**。
   * @param port 端口号。
   * @param host 绑定地址；省略用配置值。
   */
  async isFree(port: number, host?: string): Promise<boolean> {
    if (this.#disposed) return false
    const settings = this.#deps.settings()
    const normalized = normalizePort(port)
    if (normalized === null) return false
    const target = (host ?? settings.host).trim()
    if (!isLoopbackHost(target)) return false
    try {
      return await this.#probeOnce(normalized, target)
    } catch (error) {
      this.#deps.log.warn(
        '探测 %d 时抛出异常（按不可用处理）：%s',
        normalized,
        error instanceof Error ? error.message : String(error),
      )
      return false
    }
  }

  list(): readonly PickedPort[] {
    return this.#ledger.list()
  }

  stats(): PortStats {
    return Object.freeze({
      picks: this.#stats.picks,
      scans: this.#stats.scans,
      probes: this.#stats.probes,
      failures: this.#stats.failures,
      releases: this.#stats.releases,
    })
  }

  dispose(): void {
    this.#disposed = true
    this.#ledger.clear()
  }

  /**
   * 真正的编排：校验 → 分派。
   * @param request 请求。
   */
  async #pickInner(request: PickRequest): Promise<PickOutcome> {
    if (this.#disposed) return this.#fail('disposed')

    const settings = this.#deps.settings()
    if (!settings.enable) return this.#fail('disabled')

    const intent: PortIntent = request.intent === 'endpoint' ? 'endpoint' : 'listener'
    const host = (request.host ?? settings.host).trim()
    if (!isLoopbackHost(host)) {
      return this.#fail('bad-host', `地址「${host}」不是回环字面量`)
    }
    const purpose = purposeOf(request.purpose)

    // 过期项先清一次：这是写操作，只在这里做，读方法（`list()`）保持纯。
    this.#ledger.prune()

    if (intent === 'endpoint') {
      return pickEndpoint(
        {
          bound: this.#webServerBound(host),
          accept: this.#acceptor('endpoint', settings.branch, purpose),
          fail: this.#failer(),
        },
        host,
      )
    }

    const branch: PortBranch =
      request.branch === 'fixed' || request.branch === 'system' ? request.branch : settings.branch

    if (branch === 'system') {
      return await pickSystem(
        {
          assign: async (target: string) => {
            this.#stats.probes += 1
            return await this.#deps.probe.assign(target, settings.probeTimeoutMs)
          },
          taken: (port: number) => this.#ledger.has(port),
          accept: this.#acceptor('listener', 'system', purpose),
          fail: this.#failer(),
        },
        host,
      )
    }

    const range: PortRange = request.range ?? { start: settings.rangeStart, end: settings.rangeEnd }
    this.#stats.scans += 1
    return await pickFixed(
      {
        probe: async (port: number, target: string) => await this.#probeOnce(port, target),
        taken: (port: number) => this.#ledger.has(port),
        maxScan: settings.maxScan,
        bound: this.#webServerBound(host),
        accept: this.#acceptor('listener', 'fixed', purpose),
        fail: this.#failer(),
      },
      host,
      range,
    )
  }

  /**
   * 计数过的单次探测（`probes` 只在这里加）。
   * @param port 端口号。
   * @param host 地址。
   */
  async #probeOnce(port: number, host: string): Promise<boolean> {
    this.#stats.probes += 1
    return await this.#deps.probe.probe(port, host, this.#deps.settings().probeTimeoutMs)
  }

  /**
   * 宿主 `webServer` 已绑定的端口；拿不到为 `null`。
   *
   * 地址不一致也当拿不到：不同网卡上的同一个号，回环未必可达，
   * 把它当「界面地址」会得到一个打不开的链接。
   * @param host 请求的地址。
   */
  #webServerBound(host: string): number | null {
    const server = this.#deps.webServer()
    if (server === null) return null
    const port = normalizePort(server.port)
    if (port === null) return null
    const boundHost = server.host
    if (boundHost !== undefined && boundHost.trim().toLowerCase() !== host.toLowerCase()) return null
    return port
  }

  /**
   * 造一个绑定好意图与分支的发号闭包。
   * @param intent 意图。
   * @param branch 分支。
   * @param purpose 归属。
   */
  #acceptor(
    intent: PortIntent,
    branch: PortBranch,
    purpose: string,
  ): (port: number, host: string, source: PortSource) => PickOutcome {
    return (port: number, host: string, source: PortSource) =>
      this.#accept(port, host, intent, branch, source, purpose)
  }

  /**
   * 造一个失败闭包。分支里的 `reason` 是窄联合，交给 `#fail` 的宽联合即可。
   */
  #failer(): (reason: PortReason, detail?: string) => PickOutcome {
    return (reason: PortReason, detail?: string) => this.#fail(reason, detail)
  }

  /**
   * 唯一发号出口：记账、计数、日志都只在这里做。
   * @param port 端口号。
   * @param host 地址。
   * @param intent 意图。
   * @param branch 分支。
   * @param source 来源。
   * @param purpose 归属。
   */
  #accept(
    port: number,
    host: string,
    intent: PortIntent,
    branch: PortBranch,
    source: PortSource,
    purpose: string,
  ): PickOutcome {
    const pickedAt = this.#deps.now()
    const picked: PickedPort = Object.freeze({
      port,
      host,
      intent,
      branch,
      source,
      purpose,
      race: raceOf(source),
      pickedAt,
      expiresAt: this.#ledger.expiryOf(pickedAt),
    })
    this.#ledger.add(picked)
    this.#stats.picks += 1
    if (this.#deps.settings().verbose) {
      this.#deps.log.info(
        '挑到端口 %d（%s / %s，%s，归属 %s）',
        port,
        describeBranch(branch),
        describeIntent(intent),
        source,
        purpose,
      )
    }
    return { ok: true, picked }
  }

  /**
   * 失败出口：**每条失败都带一句能照做的话**。
   * @param reason 原因码。
   * @param detail 补充事实。
   */
  #fail(reason: PortReason, detail?: string): PickOutcome {
    this.#stats.failures += 1
    const action = describeReason(reason)
    return {
      ok: false,
      reason,
      detail: detail === undefined ? action : `${detail}；${action}`,
    }
  }
}
