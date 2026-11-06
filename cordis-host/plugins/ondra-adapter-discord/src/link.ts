/**
 * 连接状态机。**纯逻辑，不碰网络、不碰定时器。**
 *
 * ## 手册只点名了一个「别重连」的码
 *
 * master-plan §9.11 原话：「**4004 停止重连，其余 5s**」。
 *
 * 4004 是鉴权失败——token 不对。重连一万次也还是不对，而每 5 秒一次的
 * 失败握手会被平台当成异常客户端。所以它必须**停下并留下可见的原因**，
 * 而不是安静地一直重试（那种形态在面板上表现为「通道一直在重连」，
 * 用户会先去怀疑网络，实际是 token 填错了）。
 *
 * 其余码一律 5 秒重连：包括 1000（正常关闭）、1006（网络断）、4000（未知错误）。
 * 1006 是最常见的一个，多半是网络抖动——这时候真要重连。
 *
 * ## 为什么 `stopOnCodes` 是可配名单，且有上界校验
 *
 * 平台还有 4010–4014 一组「参数错」的码同样不该重连，但**仓内无依据**
 * （本仓 `op_code` / `RESUME` / `HELLO` 全 0 命中）。写死它们的好处是省一次配置，
 * 坏处是「手册没写的东西被我当成事实」。
 *
 * 所以做成名单，出厂为空，且**校验范围锁在 1000–9999**：
 * 有人填了 `4` 或 `4004` 之外的怪值，症状会是「一次正常的网络断开被当成
 * 终止码，通道再也不连了」——那是最难查的一类。`4004` 本身不接受重复配置
 * （它已经在代码里）。
 *
 * ## 代际号为什么必需
 *
 * `stop()` 之后，那次 `open()` 的 Promise 可能还没 resolve。若不比对代际号，
 * 它 resolve 之后会把状态改回 `connecting`，于是「已停止」的通道
 * 在 300 毫秒后自己活了——而没人调过 `start()`。
 */

import type { DiscordCredentials, LinkPlan, LinkState } from './types.js'
import { AUTH_CLOSE_CODE, RECONNECT_MS } from './types.js'
import type { Config as Settings } from './settings.js'

/**
 * 从关闭码推出处置。**唯一判定点**：别处不许再写一遍 `code === 4004`。
 * @param closeCode 关闭码。
 * @param settings 配置（取重连间隔与追加名单）。
 */
export function planOf(closeCode: number, settings: Settings): LinkPlan {
  if (closeCode === AUTH_CLOSE_CODE) {
    return {
      action: 'stop',
      delayMs: 0,
      reason: 'auth-failed',
      detail: '关闭码 4004：token 不对。重连没有意义，去改凭据文件再 reload()',
    }
  }
  if (settings.stopOnCodes.includes(closeCode)) {
    return {
      action: 'stop',
      delayMs: 0,
      reason: 'stop-code',
      detail:
        '关闭码 ' +
        String(closeCode) +
        ' 在 stopOnCodes 名单里，按配置不再重连。若这条码本该重连，把它从名单里去掉',
    }
  }
  return {
    action: 'retry',
    delayMs: settings.reconnectMs <= 0 ? RECONNECT_MS : settings.reconnectMs,
    reason: 'reconnect',
    detail: '关闭码 ' + String(closeCode) + '：等 ' + String(settings.reconnectMs) + ' 毫秒后重连',
  }
}

/** 状态机的内部账本。 */
export interface LinkSnapshot {
  /** 当前状态。 */
  readonly state: LinkState
  /** 代际号：`stop()` 与每次 `start()` 都会 +1。 */
  readonly generation: number
  /** 最后一次关闭码（`null` = 还没断过）。 */
  readonly lastCloseCode: number | null
  /** 排重连的时刻（`null` = 没有排）。 */
  readonly nextRetryAt: number | null
}

/** 连接状态机。**只管状态迁移，不管定时器与 IO**。 */
export class LinkMachine {
  private linkState: LinkState = 'closed'
  private generation = 0
  private lastCloseCode: number | null = null
  private nextRetryAt: number | null = null

  /** 快照。 */
  snapshot(): LinkSnapshot {
    return {
      state: this.linkState,
      generation: this.generation,
      lastCloseCode: this.lastCloseCode,
      nextRetryAt: this.nextRetryAt,
    }
  }

  /** 当前状态。 */
  get state(): LinkState {
    return this.linkState
  }

  /** 当前代际号。 */
  get epoch(): number {
    return this.generation
  }

  /**
   * 请求开始连接。返回本次连接的代际号（`0` 表示不该连）。
   * @param credential 凭据（不齐不连）。
   * @param socketPresent 帧层端口是否在位。
   */
  begin(credential: { readonly ok: boolean; readonly value?: DiscordCredentials }, socketPresent: boolean): number {
    if (this.linkState === 'connecting' || this.linkState === 'ready') return 0
    if (!credential.ok || credential.value === undefined) return 0
    if (!socketPresent) return 0
    this.generation += 1
    this.linkState = 'connecting'
    this.nextRetryAt = null
    return this.generation
  }

  /** 握手成功。代际号不匹配就忽略（那一轮已经被放弃了）。 */
  markReady(generation: number): boolean {
    if (generation !== this.generation) return false
    if (this.linkState !== 'connecting') return false
    this.linkState = 'ready'
    return true
  }

  /**
   * 记录一次断开，返回是否要排重连（以及等多久由调用方从 `LinkPlan` 取）。
   * @param generation 这一轮的代际号。
   * @param closeCode 关闭码。
   */
  markClosed(generation: number, closeCode: number): boolean {
    if (generation !== this.generation) return false
    this.lastCloseCode = closeCode
    this.linkState = 'closed'
    return true
  }

  /**
   * 排一次重连。
   * @param at 现在（毫秒）。
   * @param delayMs 等多久。
   */
  scheduleRetry(at: number, delayMs: number): void {
    this.nextRetryAt = at + delayMs
  }

  /** 显式停止（卸载 / 用户关通道 / 鉴权失败）。**幂等**。 */
  halt(): void {
    this.generation += 1
    this.linkState = 'stopped'
    this.nextRetryAt = null
  }

  /** 回到「还没开始」的初态（`reload()` 用，好让 `start()` 能再次生效）。 */
  reset(): void {
    this.generation += 1
    this.linkState = 'closed'
    this.nextRetryAt = null
  }
}
