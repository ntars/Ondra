/**
 * 单日额度与自然日。
 *
 * ## 为什么自然日要问 O-003
 *
 * 跨零点、时区、夏令时三件事，`new Date().getDate()` 都会算错一类。
 * O-003 `ondra-clock` 已经把「自然日键」做成了经得起夏令时的实现，
 * 这里只消费它；它缺席时才退回本机时区，并在 README 里写明可能差几小时
 * （与 O-038 的深夜判定同一口径）。
 *
 * ## 为什么用「懒换日」而不是定时器
 *
 * 零常驻（§14.2）：不装定时器、不排队、不后台跑。每天的额度在**下一次访问**
 * 时发现日键变了才重置——代价是「跨零点后第一次访问之前，`used` 还是昨天的」，
 * 而那一刻没有任何东西在读它，所以没有可观测差异。
 */

import type { BreathQuota } from './types.js'

/**
 * 本机时区的自然日键。
 * @param at 时刻（毫秒）。
 */
export function localDayKey(at: number): string {
  const date = new Date(at)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/**
 * 呼吸感动作的账本。**纯内存、无定时器**。
 *
 * 只记两件事：今天用了几次、每个动作今天用了几次。
 * 不记历史——「上周伸了几次懒腰」没有任何消费方，存了就是负债。
 */
export class BreathLedger {
  private dayKey = ''

  private used = 0

  private readonly perAction = new Map<string, number>()

  private days = 0

  /**
   * 确保账本停在给定日键上（必要时重置）。
   * @param dayKey 自然日键。
   * @returns 是否发生了换日。
   */
  ensure(dayKey: string): boolean {
    if (dayKey === '' || dayKey === this.dayKey) return false
    this.dayKey = dayKey
    this.used = 0
    this.perAction.clear()
    this.days += 1
    return true
  }

  /**
   * 某一天用了几次。**只读**：日键不匹配时直接返回 0，不改账本。
   * @param dayKey 自然日键。
   */
  usedOn(dayKey: string): number {
    return this.dayKey === dayKey ? this.used : 0
  }

  /**
   * 某个动作某一天用了几次。**只读**。
   * @param id 动作 id。
   * @param dayKey 自然日键。
   */
  usedOfOn(id: string, dayKey: string): number {
    if (this.dayKey !== dayKey) return 0
    return this.perAction.get(id) ?? 0
  }

  /**
   * 记一次。
   * @param id 动作 id。
   */
  record(id: string): void {
    this.used += 1
    this.perAction.set(id, (this.perAction.get(id) ?? 0) + 1)
  }

  /** 账本当前停在哪个日键。 */
  currentDay(): string {
    return this.dayKey
  }

  /** 跨过几个自然日（含首次）。 */
  dayCount(): number {
    return this.days
  }
}

/**
 * 组装一份额度快照。
 *
 * `remaining` 取「额度剩余」与「还能给几个动作」的**较小值**：
 * 只报额度剩余时，池子只有一条动作的那天会显示「还剩 1 次」，
 * 而 `take()` 永远回 `duplicate-action`——面板说还有、实际给不出，
 * 是最容易被当成 bug 报上来的那种不一致。
 * @param dayKey 自然日键。
 * @param used 今天已用。
 * @param cap 上限。
 * @param remaining 实际还能给几次。
 * @param actions 每个动作的用量。
 */
export function quotaOf(
  dayKey: string,
  used: number,
  cap: number,
  remaining: number,
  actions: BreathQuota['actions'],
): BreathQuota {
  return Object.freeze({
    dayKey,
    used,
    cap,
    remaining: Math.max(0, remaining),
    actions,
  })
}
