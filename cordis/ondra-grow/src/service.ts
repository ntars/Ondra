/**
 * 养成服务的实现：**只读派生 + 一次可丢的写**。
 *
 * 全部依赖都是**取值函数**而不是值（`() => ctx.get(...)`）：
 * 上游晚装载时能自愈，早卸载时立刻反映，不需要在 `apply` 时把服务盯死。
 * 这是 O-039 / O-041 已经立好的写法，直接沿用。
 *
 * 一条贯穿全文件的纪律：**任何上游缺席都不抛错**。
 * 养成是「锦上添花」的能力，它崩了不该让对话链受任何影响（§13.4 第 1 问）。
 */

import {
  countOf,
  factorsOf,
  freshOf,
  hintOf,
  levelOf,
  milestoneViewsOf,
  nextLevelOf,
  scoreOf,
  toNextOf,
} from './score.js'
import { emptyState, readState, writeState } from './store.js'
import { GROW_LEVELS, LEVEL_SPECS, MILESTONES, MILESTONE_SPECS } from './types.js'
import type {
  ClockLike,
  GrowInput,
  GrowService,
  GrowStats,
  GrowView,
  LevelSpec,
  LogLike,
  MemoryLike,
  MilestoneId,
  MilestoneSpec,
  PathLike,
  StageLike,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface GrowDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-031 阶段服务。 */
  readonly stage: () => StageLike | undefined
  /** O-010 记忆服务。 */
  readonly memory: () => MemoryLike | undefined
  /** O-003 时钟服务。 */
  readonly clock: () => ClockLike | undefined
  /** O-002 路径服务；缺席时状态只在内存。 */
  readonly path: () => PathLike | undefined
  /** 系统时间兜底（时钟服务缺席时用）。 */
  readonly now: () => number
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 养成服务。 */
export class Grow implements GrowService {
  readonly #deps: GrowDeps

  /** 内存态：路径服务缺席时的兜底，也是落盘失败后的最新真值。 */
  #state = emptyState()

  /** 状态文件绝对路径；`undefined` 表示只在内存。 */
  #file: string | undefined

  /** 累计计算次数。 */
  #computes = 0

  /** 落盘失败次数。 */
  #writeFailures = 0

  /** 最近一次计算用到几个上游（0–3）。 */
  #sources = 0

  /** 是否已经试过读盘（避免每次 `view()` 都撞一次坏文件）。 */
  #loaded = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: GrowDeps) {
    this.#deps = deps
    const path = deps.path()
    if (path !== undefined) {
      try {
        this.#file = path.fileIn('user', 'grow.json')
      } catch (error) {
        deps.log.warn('拼养成状态路径失败，状态只在内存：%s', messageOf(error))
        this.#file = undefined
      }
    } else if (deps.settings.verbose) {
      deps.log.info('路径服务未装载：养成状态只在内存，重启后「已庆祝」会重新播报一次')
    }
  }

  /**
   * 是否可用。
   *
   * 判据是「至少有一个数据上游」而不是「全部到位」：
   * 只有相位服务时天数与关系阶仍然是真的，只有记忆服务时记忆条数也是真的。
   * 一个都没有就等于四项全是 0，「萌芽」这个档位毫无信息量，那时才判不可用。
   */
  get available(): boolean {
    if (!this.#deps.settings.enable) return false
    return this.#sourcesOf() > 0
  }

  /** 不可用原因。 */
  get reason(): 'disabled' | 'no-source' | undefined {
    if (!this.#deps.settings.enable) return 'disabled'
    return this.#sourcesOf() > 0 ? undefined : 'no-source'
  }

  /** 数一下当前有几个数据上游（阶段 / 记忆 / 时钟各算一个）。 */
  #sourcesOf(): number {
    let count = 0
    const stage = this.#deps.stage()
    if (stage !== undefined && stage.available) count += 1
    const memory = this.#deps.memory()
    if (memory !== undefined && memory.available) count += 1
    if (this.#deps.clock() !== undefined) count += 1
    return count
  }

  /** 惰性读盘。只在第一次真的要用状态时读，且只读一次。 */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true
    if (this.#file === undefined) return
    const result = readState(this.#file)
    this.#state = result.state
    if (result.issue !== undefined && this.#deps.settings.verbose) {
      this.#deps.log.warn('%s', result.issue)
    }
  }

  /**
   * 从上游读四项。
   *
   * **缺一项就记 0，并把它记进 `missing`**——不是猜一个像样的中间值。
   * 猜出来的数会让「为什么我的进度条不动」变成无法回答的问题；
   * 记 0 至少诚实地表现为「这一项没数据」，而 `missing` 让体检面板能说清原因。
   * @param at 时刻。
   */
  #readInput(at: number): { readonly input: GrowInput; readonly missing: readonly string[] } {
    const missing: string[] = []

    let days = 0
    let interactions = 0
    let stageOrder = 0
    let stageZh = ''
    let stageId = ''

    const stage = this.#deps.stage()
    if (stage === undefined || !stage.available) {
      missing.push('ondra-emotion-stage')
    } else {
      try {
        const relation = stage.relation(at)
        days = countOf(relation.days)
        interactions = countOf(relation.interactions)
        const view = stage.view(at)
        stageOrder = countOf(view.spec.order)
        stageZh = typeof view.spec.zh === 'string' ? view.spec.zh : ''
        stageId = typeof view.base === 'string' ? view.base : ''
      } catch (error) {
        // 上游读数是花瓣不是骨架：它出错只该少一项，不该让整个视图塌掉。
        missing.push('ondra-emotion-stage')
        this.#deps.log.warn('读关系快照失败，相处天数与互动次数按 0 计：%s', messageOf(error))
      }
    }

    let memories = 0
    const memory = this.#deps.memory()
    if (memory === undefined || !memory.available) {
      missing.push('ondra-memory-core')
    } else {
      try {
        // 只数 `active`：归档与封存不算「攒下」——那两类是用户主动推出视野的东西，
        // 把它们算进养成分，等于给了一个「删都删不掉」的进度条。
        memories = countOf(memory.countFacts({ state: 'active' }))
      } catch (error) {
        missing.push('ondra-memory-core')
        this.#deps.log.warn('数记忆条数失败，按 0 计：%s', messageOf(error))
      }
    }

    if (this.#deps.clock() === undefined) missing.push('ondra-clock')

    return {
      input: Object.freeze({ days, interactions, memories, stageOrder, stageZh, stageId }),
      missing: Object.freeze(missing),
    }
  }

  /**
   * 取当前快照。**只读**：不推进状态、不写盘。
   * @param at 时刻。
   */
  view(at?: number): GrowView {
    this.#computes += 1
    const epoch = this.#epoch(at)
    this.#sources = this.#sourcesOf()

    if (!this.#deps.settings.enable) return this.#blank('disabled', epoch)
    if (this.#sources < 1) return this.#blank('no-source', epoch)

    this.#ensureLoaded()

    const { input, missing } = this.#readInput(epoch)
    const factors = factorsOf(input)
    const score = scoreOf(factors)
    const level = levelOf(score)
    const next = nextLevelOf(level)
    const milestones = milestoneViewsOf(input, this.#state.celebrated)
    const fresh = this.#deps.settings.celebrate ? freshOf(milestones) : Object.freeze([])

    const spec = LEVEL_SPECS[level]
    return Object.freeze({
      available: true,
      level,
      levelZh: spec.zh,
      levelDoc: spec.doc,
      score,
      factors,
      input,
      toNext: toNextOf(score, next),
      next,
      hint: hintOf(factors, next),
      milestones,
      fresh,
      at: epoch,
      missing,
    })
  }

  /** 五档表（按档序）。 */
  levels(): readonly LevelSpec[] {
    return Object.freeze(GROW_LEVELS.map(id => LEVEL_SPECS[id]))
  }

  /** 六条里程碑的判定条件（按 `MILESTONES` 顺序）。 */
  milestones(): readonly MilestoneSpec[] {
    return Object.freeze(MILESTONES.map(id => MILESTONE_SPECS[id]))
  }

  /**
   * 标记「已庆祝」。**唯一的写动作**，且只写「庆祝过」这件事。
   * @param ids 里程碑 id 列表。
   * @param at 时刻。
   */
  ack(ids: readonly MilestoneId[], at?: number): boolean {
    if (!this.#deps.settings.enable) return false
    this.#ensureLoaded()

    const known = new Set<MilestoneId>(this.#state.celebrated)
    let added = false
    for (const id of ids) {
      // 未知 id 静默丢弃：调用方可能带着旧版存档里的名字回来，那时「记不上」比「抛错」合适。
      if (!MILESTONES.includes(id)) continue
      if (known.has(id)) continue
      known.add(id)
      added = true
    }
    if (!added) return true

    this.#state = Object.freeze({
      version: this.#state.version,
      celebrated: Object.freeze([...known]),
      lastCelebratedAt: this.#epoch(at),
    })

    if (this.#file === undefined) return true
    try {
      writeState(this.#file, this.#state)
      return true
    } catch (error) {
      this.#writeFailures += 1
      this.#deps.log.warn('写养成状态失败（读数不受影响，最坏是重复播报一次里程碑）：%s', messageOf(error))
      return false
    }
  }

  /** 统计快照。 */
  stats(): GrowStats {
    this.#ensureLoaded()
    const view = this.view()
    return Object.freeze({
      available: view.available,
      celebratedCount: this.#state.celebrated.length,
      level: view.level,
      score: view.score,
      sources: this.#sources,
      computes: this.#computes,
      writeFailures: this.#writeFailures,
    })
  }

  /** 取时刻：优先时钟服务，其次系统时间。 */
  #epoch(at?: number): number {
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) return Math.trunc(at)
    const clock = this.#deps.clock()
    if (clock !== undefined) {
      try {
        const now = clock.now()
        if (typeof now === 'number' && Number.isFinite(now) && now > 0) return Math.trunc(now)
      } catch {
        // 时钟服务报错就当它没有：退回系统时间，不让「取不到时间」变成一次崩溃。
      }
    }
    return this.#deps.now()
  }

  /** 不可用时的空视图。**仍然返回完整形状**，让应用外壳不必到处判空。 */
  #blank(reason: 'disabled' | 'no-source', at: number): GrowView {
    const spec = LEVEL_SPECS[GROW_LEVELS[0]]
    const input: GrowInput = Object.freeze({
      days: 0,
      interactions: 0,
      memories: 0,
      stageOrder: 0,
      stageZh: '',
      stageId: '',
    })
    return Object.freeze({
      available: false,
      reason,
      level: spec.id,
      levelZh: spec.zh,
      levelDoc: spec.doc,
      score: 0,
      factors: factorsOf(input),
      input,
      toNext: 0,
      next: undefined,
      hint: reason === 'disabled' ? '养成已关闭。' : '数据还不够，先去和她聊几句吧。',
      milestones: milestoneViewsOf(input, this.#state.celebrated),
      fresh: Object.freeze([]),
      at,
      missing: Object.freeze([]),
    })
  }
}
