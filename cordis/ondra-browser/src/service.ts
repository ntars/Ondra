/**
 * 门面：接线状态、计数、以及两个可直接调用的纯函数（`check` / `trim`）。
 *
 * ## `available` 为什么要求「有后端」
 *
 * 护栏装上了但没有任何浏览器后端时，它**什么也不会拦**——因为根本不会有浏览器工具被调用。
 * 这时如果面板显示「已启用」，用户会以为浏览器可用了，点开却什么都没有。
 * 所以 `available` 要求 `enable && providerName !== ''`，并把 `no-provider` 作为原因报出来。
 *
 * 反过来，`hooks` 是**独立**的布尔：护栏挂上了、后端还没装，界面能说出
 * 「护栏在位，等一个浏览器后端」——这比一个笼统的「不可用」有用得多。
 *
 * ## 为什么不在这里缓存后端名
 *
 * provider 可以在本插件装载**之后**才注册（`ctx.browserUse.register()` 由 provider 调）。
 * 缓存一次就会永远显示「没有后端」，而实际早就装好了——这种「面板说没装、实际能用」
 * 是最容易被当成插件坏了的一类错。
 */

import type { Config } from './settings.js'
import type { BrowserReason, BrowserService, BrowserStats, BrowserStatus, HookTarget, LogLike, TrimKind, TrimResult, UrlVerdict } from './types.js'
import { installHooks } from './hooks.js'
import type { HookHandles } from './hooks.js'
import { checkUrl } from './policy.js'
import { trimText } from './trim.js'

/** 依赖注入。 */
export interface BrowserGuardDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 事件源（`ctx`）。 */
  readonly target: HookTarget
  /** 读当前后端名（**每次现取**，不缓存）。 */
  readonly providerName: () => string
}

/** 本插件对外提供的服务实现。 */
export class BrowserGuard implements BrowserService {
  /** 已补全的配置。 */
  private readonly settings: Config

  /** 日志。 */
  private readonly log: LogLike

  /** 现取后端名。 */
  private readonly providerName: () => string

  /** 接线句柄（关着时为 `null`）。 */
  private handles: HookHandles | null = null

  /** 计数。 */
  private seenCount = 0
  private allowedCount = 0
  private trimmedCount = 0
  private trimmedChars = 0
  private readonly deniedCount: Map<string, number> = new Map()

  /**
   * @param deps 依赖。
   */
  constructor(deps: BrowserGuardDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.providerName = deps.providerName
    if (deps.settings.enable) {
      this.handles = installHooks(deps.target, deps.settings, deps.log, {
        seen: () => {
          this.seenCount += 1
        },
        allowed: () => {
          this.allowedCount += 1
        },
        denied: (code: string) => {
          this.deniedCount.set(code, (this.deniedCount.get(code) ?? 0) + 1)
        },
        trimmed: (result: TrimResult) => {
          this.trimmedCount += 1
          this.trimmedChars += Math.max(0, result.before - result.after)
        },
      })
    }
  }

  /** 现在能不能用（开关 + 有后端）。 */
  get available(): boolean {
    return this.settings.enable && this.providerName() !== ''
  }

  /** 不能用的原因。 */
  get reason(): BrowserReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.providerName() === '') return 'no-provider'
    return undefined
  }

  /** 当前后端名（空 = 没有后端）。 */
  get provider(): string {
    return this.providerName()
  }

  /** 两个瀑布是否都挂上了。 */
  get hooks(): { readonly pre: boolean; readonly post: boolean } {
    return this.hookState()
  }

  /**
   * 单独判一个 URL。
   * @param url 待判 URL。
   */
  check(url: string): UrlVerdict {
    return checkUrl(url, this.settings)
  }

  /**
   * 单独裁一段文本。
   * @param text 原文。
   * @param kind 体裁。
   */
  trim(text: string, kind: TrimKind): TrimResult {
    return trimText(text, kind, this.settings.trimChars, this.settings.trimLines)
  }

  /** 现状。 */
  status(): BrowserStatus {
    return {
      enabled: this.settings.enable,
      available: this.available,
      reason: this.reason,
      provider: this.providerName(),
      hooks: this.hookState(),
      prefixes: this.settings.toolPrefixes,
      scriptTools: this.settings.scriptTools,
    }
  }

  /** 计数。 */
  stats(): BrowserStats {
    const denied: Record<string, number> = {}
    for (const [key, value] of this.deniedCount) denied[key] = value
    return {
      seen: this.seenCount,
      allowed: this.allowedCount,
      denied,
      trimmed: this.trimmedCount,
      trimmedChars: this.trimmedChars,
    }
  }

  /** 撤除监听（插件卸载时调用）。 */
  dispose(): void {
    if (this.handles === null) return
    this.handles.dispose()
    this.handles = null
    this.log.info('浏览器护栏已撤除')
  }

  /** 读一次接线状态。 */
  private hookState(): { readonly pre: boolean; readonly post: boolean } {
    const handles = this.handles
    if (handles === null) return { pre: false, post: false }
    return handles.attached()
  }
}
