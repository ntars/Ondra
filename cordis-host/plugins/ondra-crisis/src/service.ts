/**
 * 危机分级服务的实现：**编译一次，判定纯函数，什么都不存**。
 *
 * ## 为什么判定是纯函数
 *
 * 同一句话在两点钟和四点钟必须得到同一个档位。一旦判定读时钟、读情绪、
 * 读上一轮结论，它就不再可复核——而危机判定恰恰是「事后必须能说清
 * 为什么当时是这一档」的东西。
 *
 * ## 三条降级
 *
 * | 情况 | 表现 |
 * |---|---|
 * | 某条判据编译失败 | 只跳过它自己，`stats().ruleFailures` 与日志留痕 |
 * | 文本超长 | 只扫前 `scanChars` 个字，`flags.truncated=true` |
 * | 没配号码 | `resources().configured=false`，`guidance` 仍有可执行的指引 |
 *
 * ## 关掉开关时 `resources()` 仍然可用
 *
 * 求助指引不该跟着总开关一起消失：关掉判定可能是嫌吵，
 * 但「此刻该去哪求助」这句话在任何时候都不该被关掉。
 */

import { assessText, compileRules } from './assess.js'
import type { CompiledRule } from './assess.js'
import { RULES } from './rules.js'
import type { Config } from './settings.js'
import { CrisisError } from './types.js'
import type {
  CrisisAssessment,
  CrisisErrorCode,
  CrisisLevel,
  CrisisResources,
  CrisisService,
  CrisisSignalSpec,
  CrisisStats,
  LogLike,
} from './types.js'

/**
 * 恒有的中文指引。**不依赖配置**：没填号码时，这段话就是全部资源。
 *
 * 刻意写成「现在就能做的动作」而不是「请寻求专业帮助」：
 * 深夜读到「请寻求专业帮助」只会更无力，而「现在就打给一个你信得过的人」
 * 是能立刻做的第一件事。
 */
export const BASE_GUIDANCE =
  '此刻先别一个人待着：给一个你信得过的人打电话，让他过来陪你，哪怕只是坐在旁边。' +
  '如果身边没人，去最近的急诊，或者拨打当地急救电话。' +
  '如果手边有能伤害自己的东西，先把它放到另一个房间。'

/** 依赖。 */
export interface CrisisDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误消息文本。供入口在日志里复用。 */
export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 危机分级服务。 */
export class CrisisGuard implements CrisisService {
  readonly #deps: CrisisDeps
  readonly #compiled: readonly CompiledRule[]
  readonly #failures: readonly string[]

  /** 判定次数。 */
  #assessments = 0
  /** 各档次数。 */
  readonly #byLevel: Record<CrisisLevel, number> = { none: 0, watch: 0, concern: 0, urgent: 0 }
  /** 空文本拒收次数。 */
  #rejections = 0
  /** 最近一次问题。 */
  #lastIssue: string | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: CrisisDeps) {
    this.#deps = deps
    const result = compileRules(RULES)
    this.#compiled = result.compiled
    this.#failures = result.failures
    if (result.failures.length > 0) {
      // 一条写坏的正则不该让整个护栏失效，但必须喊出来：那类信号现在是盲的。
      this.#lastIssue = `以下判据编译失败，对应信号此时无效：${result.failures.join('、')}`
      deps.log.error('%s', this.#lastIssue)
    }
    if (result.compiled.length === 0) {
      this.#lastIssue = '全部判据编译失败，危机判定此刻完全不可用'
      deps.log.error('%s', this.#lastIssue)
    }
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): CrisisErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /** 判据说明书（**不含正则源串**）。 */
  get signals(): readonly CrisisSignalSpec[] {
    return Object.freeze(
      this.#compiled.map(item => ({
        id: item.rule.id,
        group: item.rule.group,
        note: item.rule.note,
      })),
    )
  }

  /**
   * 判定一段文本。
   *
   * **只传「最新一条用户消息」**：整段历史会被反复命中，
   * 一次「去年想过」会让之后每轮都触发关怀话术。
   * @param text 待判定文本。
   * @param at 时刻。
   */
  assess(text: string, at?: number): CrisisAssessment {
    if (!this.available) {
      throw new CrisisError('disabled', '危机分级已关闭（enable=false）')
    }
    if (typeof text !== 'string' || text.trim() === '') {
      // 空文本不判：判成 none 会让「没说话」被记成「查过没事」。
      this.#rejections += 1
      throw new CrisisError('bad-request', '待判定文本不能为空')
    }
    if (this.#compiled.length === 0) {
      throw new CrisisError('bad-rules', '全部判据编译失败，不出结论（不报 none 以免被当成「没事」）')
    }
    const stamp = typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.trunc(at) : this.#deps.now()
    const assessment = assessText({
      text,
      rules: this.#compiled,
      scanChars: this.#deps.settings.scanChars,
      at: stamp,
    })
    this.#assessments += 1
    this.#byLevel[assessment.level] += 1

    // 「帮朋友问」常常是本人，故默认仍给资源；关掉时**只压这一个标记**，
    // 档位与 askDirectly 不变——要不要给资源是话术问题，不是风险判断。
    if (assessment.flags.thirdParty && !this.#deps.settings.thirdPartyResources) {
      return Object.freeze({ ...assessment, offerResources: false })
    }
    return assessment
  }

  /** 求助资源（配置 + 不依赖配置的兜底指引）。**关掉总开关也可用。** */
  resources(): CrisisResources {
    const hotlines = this.#deps.settings.hotlines
    const extra = this.#deps.settings.extraGuidance
    const guidance = extra === '' ? BASE_GUIDANCE : `${BASE_GUIDANCE}\n${extra}`
    return Object.freeze({
      configured: hotlines.length > 0,
      hotlines,
      guidance,
    })
  }

  /** 累计统计快照。**只在内存。** */
  stats(): CrisisStats {
    const base = {
      assessments: this.#assessments,
      byLevel: Object.freeze({ ...this.#byLevel }),
      ruleFailures: this.#failures.length,
      rejections: this.#rejections,
    }
    return Object.freeze(
      this.#lastIssue === undefined ? base : { ...base, lastIssue: this.#lastIssue },
    )
  }
}
