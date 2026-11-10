/**
 * 注入服务：把「取材 → 装箱 → 渲染」串起来，并记住上一轮的数字。
 *
 * ## 四条纪律
 *
 * 1. **`plan()` 永不抛出**（C3）。它挂在对话主链路上，抛一次就是「她这轮不说话」。
 *    整段包 try/catch，异常时返回一份空计划 + 一条 `block-error`。
 * 2. **读操作不写库**。`plan()` / `render()` / `expand()` 都只读；
 *    `markSeen()` 之类「带出记账」归 O-010，本插件不替它做。
 * 3. **`seen` 与预算互不干扰**。已见条目在装箱**之前**就被摘掉，
 *    所以它们既不占预算、也不进「未展开」的条数——那两件事的处置完全不同。
 * 4. **池判定按 `ref` 缓存**。一次 `plan()` 里同一个记忆 id 只问一次池，
 *    否则 ⑤ 有 40 条命中就是 40 次单行查询。
 */

import { gather } from './blocks.js'
import { djb2 } from './format.js'
import { pack } from './pack.js'
import { budgetOf } from './settings.js'
import type { Config } from './settings.js'
import { BUDGET_PRESETS, BLOCK_IDS } from './types.js'
import type {
  BlockId,
  BudgetPreset,
  Degradation,
  DropReason,
  DroppedItem,
  ExpandedItem,
  InjectionItem,
  InjectionPlan,
  InjectionReason,
  InjectionService,
  InjectionStats,
  LogLike,
  PackRequest,
  PackedSegment,
  RenderedInjection,
  Sources,
  SuppressedItem,
} from './types.js'

/** 构造入参。 */
export interface InjectionOptions {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 上游取值函数（每次现取，上游晚装载能自愈）。 */
  readonly sources: Sources
  /** 当前时刻（注入用）。 */
  readonly now: () => number
}

/** 空段表（异常兜底用）。 */
function emptySegments(): readonly PackedSegment[] {
  return Object.freeze(
    BLOCK_IDS.map((id, index) =>
      Object.freeze({
        id,
        order: index,
        heading: '',
        text: '',
        chars: 0,
        items: 0,
        dropped: 0,
        core: id === 'promises' || id === 'pinned',
      }),
    ),
  )
}

/** 注入服务实现。 */
export class Injection implements InjectionService {
  /** 配置。 */
  private readonly settings: Config
  /** 日志。 */
  private readonly log: LogLike
  /** 上游。 */
  private readonly sources: Sources
  /** 时钟。 */
  private readonly now: () => number
  /** 累计装箱次数。 */
  private plans = 0
  /** 上一次的数字。 */
  private lastUsedChars = 0
  /** 上一次是否超预算。 */
  private lastOverBudget = false
  /** 上一次进了几条。 */
  private lastItems = 0
  /** 上一次掉了几条。 */
  private lastDropped = 0
  /** 上一次被已见挡了几条。 */
  private lastSuppressed = 0
  /** 各块在位情况。 */
  private readonly sourceMap: Record<BlockId, boolean>

  constructor(options: InjectionOptions) {
    this.settings = options.settings
    this.log = options.log
    this.sources = options.sources
    this.now = options.now
    const map: Record<BlockId, boolean> = {
      promises: false,
      pinned: false,
      persons: false,
      anniversary: false,
      recall: false,
      lessons: false,
      ripple: false,
      resurface: false,
    }
    this.sourceMap = map
  }

  /** 是否可用（只受总开关影响）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): InjectionReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /** 三个预算预设。 */
  budgets(): readonly BudgetPreset[] {
    return BUDGET_PRESETS
  }

  /** 当前生效预算。 */
  budget(): number {
    return budgetOf(this.settings)
  }

  /** 只装箱、不渲染。 */
  plan(request?: PackRequest): InjectionPlan {
    const at = request?.at ?? this.now()
    const includeHeadings = request?.includeHeadings ?? this.settings.includeHeadings
    const budgetChars = request?.budgetChars ?? budgetOf(this.settings)
    const only = request?.only
    try {
      return this.planInner(at, includeHeadings, budgetChars, request, only)
    } catch (error) {
      // 走到这里说明连兜底都出错了。**宁可空着，也不能让对话链断在这一行。**
      this.log.error('注入装箱异常（本轮返回空注入）：%s', messageOf(error))
      return Object.freeze({
        budgetChars,
        usedChars: 0,
        remainingChars: budgetChars,
        overBudget: false,
        coreChars: 0,
        segments: emptySegments(),
        ids: Object.freeze([]),
        suppressed: Object.freeze([]),
        dropped: Object.freeze([]),
        degradations: Object.freeze([
          Object.freeze({ kind: 'block-error' as const, note: `装箱异常：${messageOf(error)}` }),
        ]),
        digest: djb2(''),
        at,
      })
    }
  }

  /** 渲染。 */
  render(request?: PackRequest): RenderedInjection {
    const plan = this.plan(request)
    const blocks: string[] = []
    for (const segment of plan.segments) {
      if (segment.text.length === 0) continue
      blocks.push(segment.heading.length === 0 ? segment.text : `${segment.heading}\n${segment.text}`)
    }
    const text = blocks.join('\n\n')
    return Object.freeze({ text, chars: text.length, plan })
  }

  /** 按 id 取回原文。 */
  expand(ids: readonly string[], at?: number): readonly ExpandedItem[] {
    const when = at ?? this.now()
    const core = this.sources.core()
    const out: ExpandedItem[] = []
    for (const id of ids) {
      const ref = refOf(id)
      if (core === undefined || !core.available) {
        out.push(Object.freeze({ id, ref, text: '', found: false }))
        continue
      }
      try {
        const record = core.getFact(ref)
        if (record === undefined) {
          out.push(Object.freeze({ id, ref, text: '', found: false }))
        } else {
          out.push(Object.freeze({ id, ref, text: record.text, found: true }))
        }
      } catch (error) {
        // 单条失败不影响其余：展开是给人看的，不是主链路。
        this.log.warn('展开 %s 失败（%s 时刻）：%s', id, String(when), messageOf(error))
        out.push(Object.freeze({ id, ref, text: '', found: false }))
      }
    }
    return Object.freeze(out)
  }

  /** 统计快照。 */
  stats(): InjectionStats {
    const sources: Record<BlockId, boolean> = {
      promises: this.sourceMap.promises,
      pinned: this.sourceMap.pinned,
      persons: this.sourceMap.persons,
      anniversary: this.sourceMap.anniversary,
      recall: this.sourceMap.recall,
      lessons: this.sourceMap.lessons,
      ripple: this.sourceMap.ripple,
      resurface: this.sourceMap.resurface,
    }
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      budgetChars: budgetOf(this.settings),
      lastUsedChars: this.lastUsedChars,
      lastOverBudget: this.lastOverBudget,
      lastItems: this.lastItems,
      lastDropped: this.lastDropped,
      lastSuppressed: this.lastSuppressed,
      plans: this.plans,
      sources: Object.freeze(sources),
    })
  }

  /** 真正的装箱流程。 */
  private planInner(
    at: number,
    includeHeadings: boolean,
    budgetChars: number,
    request: PackRequest | undefined,
    only: readonly BlockId[] | undefined,
  ): InjectionPlan {
    const gathered = gather({
      at,
      query: request?.query ?? '',
      settings: this.settings,
      sources: this.sources,
      log: this.log,
    })
    for (const id of BLOCK_IDS) {
      this.sourceMap[id] = gathered.available[id]
    }

    const included = (block: BlockId): boolean => only === undefined || only.includes(block)
    const degradations: Degradation[] = [...gathered.degradations]

    // 1. 已见摘除（在装箱之前，既不占预算也不进未展开）。
    const seen = request?.seen
    const suppressed: SuppressedItem[] = []
    const candidates: InjectionItem[] = []
    for (const item of gathered.items) {
      if (!included(item.block)) continue
      if (seen !== undefined && seen.has(item.id)) {
        suppressed.push(Object.freeze({ id: item.id, block: item.block }))
        continue
      }
      candidates.push(item)
    }

    // 2. 池判定（按 ref 缓存一次）。
    const pool = this.sources.pool()
    const poolCache = new Map<string, DropReason | undefined>()
    if (this.settings.respectPool && (pool === undefined || !pool.available)) {
      degradations.push(
        Object.freeze({ kind: 'no-pool', note: '记忆池服务缺席：不判「海马体永不注入」' }),
      )
    }
    const guard = (item: InjectionItem): DropReason | undefined => {
      if (!this.settings.respectPool) return undefined
      if (item.block === 'promises') return undefined
      if (pool === undefined || !pool.available) return undefined
      const cached = poolCache.get(item.ref)
      if (cached !== undefined || poolCache.has(item.ref)) return cached
      let verdict: DropReason | undefined
      try {
        const eligibility = pool.eligibleForInjection(item.ref, at)
        verdict = eligibility.eligible ? undefined : 'pool-denied'
      } catch (error) {
        this.log.warn('池判定失败（%s），按放行处理：%s', item.ref, messageOf(error))
        verdict = undefined
      }
      poolCache.set(item.ref, verdict)
      return verdict
    }

    // 3. 装箱。
    const packed = pack({ items: candidates, budgetChars, includeHeadings, guard })

    // 4. 条数上限挡下的（只统计被 `only` 放行的块）。
    const dropped: DroppedItem[] = gathered.capDropped.filter(item => included(item.block))
    dropped.push(...packed.dropped)

    if (packed.overBudget) {
      degradations.push(
        Object.freeze({
          kind: 'over-budget',
          note: `预算 ${budgetChars} 字装不下，实际 ${packed.usedChars} 字`,
        }),
      )
      if (packed.coreChars > budgetChars) {
        degradations.push(
          Object.freeze({
            kind: 'core-exempt',
            note: `核心段单独就占 ${packed.coreChars} 字，已整块带上（到期提醒与钉住不参与装箱）`,
          }),
        )
      }
    }

    const digest = djb2(packed.segments.map(segment => `${segment.id}:${segment.text}`).join('|'))
    const plan: InjectionPlan = Object.freeze({
      budgetChars,
      usedChars: packed.usedChars,
      remainingChars: budgetChars - packed.usedChars,
      overBudget: packed.overBudget,
      coreChars: packed.coreChars,
      segments: packed.segments,
      ids: packed.ids,
      suppressed: Object.freeze(suppressed),
      dropped: Object.freeze(dropped),
      degradations: Object.freeze(degradations),
      digest,
      at,
    })

    this.plans += 1
    this.lastUsedChars = plan.usedChars
    this.lastOverBudget = plan.overBudget
    this.lastItems = plan.ids.length
    this.lastDropped = plan.dropped.length
    this.lastSuppressed = plan.suppressed.length
    /*
     * 回写各块在位情况。
     *
     * 早先 `sourceMap` 是构造函数里写死的一排 `false`，**从来没有人写过**，
     * 于是 `stats().sources` 恒为全 false——诊断看上去像「八块一块都没接上」，
     * 而系统提示词里其实有内容。这个字段本身是**唯一一处能回答「哪一块真的
     * 产出了正文」的地方**，恒 false 等于把它废掉。
     *
     * 判据取 `plan.segments` 里 `text` 非空的段，而不是「服务取得到」：
     * 服务在但库里没数据时，那一块照样没有正文，两者对用户是同一种结果。
     */
    const filled = new Set(
      plan.segments.filter((segment) => segment.text.length > 0).map((segment) => segment.id),
    )
    for (const key of Object.keys(this.sourceMap) as (keyof typeof this.sourceMap)[]) {
      this.sourceMap[key] = filled.has(key)
    }
    return plan
  }
}

/**
 * 条目 id → 原始 id。
 *
 * `mem:` / `pin:` 后面是记忆 id；`promise:` 后面是承诺 id（**不是记忆 id**），
 * 所以 `expand()` 对承诺会返回 `found: false`——承诺正文本来就在注入行里，
 * 不需要展开，而拿承诺 id 去查记忆只会查到一个不存在的记录。
 * @param id 条目 id。
 */
export function refOf(id: string): string {
  const index = id.indexOf(':')
  if (index < 0) return id
  return id.slice(index + 1)
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
