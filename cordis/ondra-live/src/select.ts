/**
 * 分支**选路与对拍**：三条分支各自一个文件，这里是唯一决定「用谁」的地方。
 *
 * ## 选路顺序（§14.2「默认最稳」）
 *
 * ```
 * provider = solar-only  → 就用公历（用户显式选）
 * provider = lunar-js    → 用它；不在位就退回公历并告警（不静默切换，见下）
 * provider = tyme4ts     → 同上
 * provider = auto        → 按 lunar-js → tyme4ts 的顺序取第一个探测通过的
 * ```
 *
 * **显式指定却不在位时要告警**：用户选了 `lunar-js`、但包里没装，正确表现是
 * 「退回公历 + 一行 warn」，而不是「悄悄按 auto 又选回 lunar-js」（那会让
 * 「我明明关了它」变成一个查不出来的现象），也不是「整个插件不可用」。
 *
 * ## 对拍（§1.7 的「双分支对拍」）
 *
 * 对拍不是「选一个更好的」，是**发现有人在撒谎**：两条独立实现的历法在同一个日子上
 * 给出不同的农历日，说明至少一条的历法表过期了（农历数据是按年维护的）。
 * 结论写进日志与 `crosscheck()` 报告，**不自动改选**——自动改选会让「今天到底几号」
 * 随实现细节变化，而用户只会觉得「这软件连日子都记不准」。
 */

import { createSolarBranch } from './branches/solar.js'
import { createLunarJsBranch } from './branches/lunar-js.js'
import { createTyme4tsBranch } from './branches/tyme4ts.js'
import type { CalendarProvider, LogLike, ProviderChoice, ProviderStatus } from './types.js'

/** 一次选路的完整结果。 */
export interface Selection {
  /** 三条分支的探测结论（含未选中的，面板要显示「为什么没用它」）。 */
  readonly providers: readonly ProviderStatus[]
  /** 当前生效的分支（永远有值：公历分支不会失败）。 */
  readonly chosen: CalendarProvider
  /** 在位的农历分支（没有就是 `null`）。 */
  readonly lunar: CalendarProvider | null
  /** 农历是否在位（快捷位，等于 `lunar !== null`）。 */
  readonly lunarReady: boolean
  /** 在位的分支里，有农历能力的那些（对拍用）。 */
  readonly comparable: readonly CalendarProvider[]
}

/**
 * 探测三条分支并按配置选一条。
 * @param choice 选路策略。
 * @param log 日志。
 */
export function selectProviders(choice: ProviderChoice, log: LogLike): Selection {
  const solar = createSolarBranch()
  const lunarJs = createLunarJsBranch(log)
  const tyme4ts = createTyme4tsBranch(log)

  const statuses: readonly ProviderStatus[] = [
    lunarJs.status,
    tyme4ts.status,
    { name: 'solar-only', ready: true, detail: '公历分支常驻（不依赖外部包）' },
  ]

  const readyLunar: CalendarProvider[] = []
  if (lunarJs.provider !== null) readyLunar.push(lunarJs.provider)
  if (tyme4ts.provider !== null) readyLunar.push(tyme4ts.provider)

  if (choice === 'solar-only') {
    return { providers: statuses, chosen: solar, lunar: null, lunarReady: false, comparable: readyLunar }
  }

  if (choice === 'lunar-js' || choice === 'tyme4ts') {
    const wanted = readyLunar.find(provider => provider.name === choice)
    if (wanted !== undefined) {
      return {
        providers: statuses,
        chosen: wanted,
        lunar: wanted,
        lunarReady: true,
        comparable: readyLunar,
      }
    }
    const reason = statuses.find(status => status.name === choice)?.detail ?? '未知原因'
    log.warn('指定的农历分支（%s）不在位，已退回公历：%s', choice, reason)
    return { providers: statuses, chosen: solar, lunar: null, lunarReady: false, comparable: readyLunar }
  }

  // auto：按「默认最稳」的顺序取第一个可用的农历分支。
  const first = readyLunar[0]
  if (first === undefined) {
    return { providers: statuses, chosen: solar, lunar: null, lunarReady: false, comparable: readyLunar }
  }
  return { providers: statuses, chosen: first, lunar: first, lunarReady: true, comparable: readyLunar }
}

/**
 * 用一句话说明「为什么现在是这条分支」。日志与面板共用，避免两处措辞不一致。
 * @param selection 选路结果。
 */
export function describeSelection(selection: Selection): string {
  if (!selection.lunarReady) {
    const hints = selection.providers
      .filter(status => status.name !== 'solar-only' && !status.ready)
      .map(status => `${status.name}: ${status.detail}`)
    return hints.length === 0 ? '只有公历' : `只有公历（${hints.join('；')}）`
  }
  return `农历分支 ${selection.chosen.name}`
}
