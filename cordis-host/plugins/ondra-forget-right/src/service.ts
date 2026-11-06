/**
 * 被遗忘权服务的实现：**十一面清算 + 残余如实上报**。
 *
 * 全部上游依赖都是**取值函数**（`() => ctx.get(...)`）：晚装载能自愈，早卸载立刻反映。
 *
 * ## 三条贯穿全文件的纪律
 *
 * 1. **顺序不可调**：`SCRUB_ORDER` 把 `memory-fact` 排在中间（后面只剩删不掉的四面）。
 *    反序的话真源一删，id 列表就再也拼不出来，下游全部只能跳过，
 *    而「跳过」在报告里长得像「本来就没什么要删」。
 * 2. **单面失败不中断**：一面抛错只把那一面记 `failed`，其余照常走完。
 *    半途停下的清算最糟——用户既不知道删到哪儿了，也不知道还剩多少。
 *    但**失败一定要让 `complete=false`**（C3 的同一条精神：错误不传播，但绝不咽下去）。
 * 3. **不直连任何表**：每一面只调上游公开方法。删不掉就报 `blind`，
 *    绝不自己拼 SQL、绝不自己删文件——那是绕过服务边界，而绕过一次就再也说得清边界。
 */

import {
  buildPlan,
  effectiveCapability,
  normalizeTarget,
  residueReportOf,
  residueRowOf,
  MAX_TARGETS,
} from './plan.js'
import type { Availability } from './plan.js'
import {
  assertTarget,
  resolveTarget,
  outcomeOf,
  isComplete,
  residueOf,
  runSummaryOf,
  specOf,
  expectedSurfacesOf,
} from './scrub.js'
import {
  ForgetRightError,
  SCRUB_ORDER,
  SURFACE_IDS,
  SURFACE_SPECS,
} from './types.js'
import type {
  AuditLike,
  CapsuleLike,
  ClockLike,
  DiaryLike,
  ForgetPlan,
  ForgetRightService,
  ForgetRun,
  ForgetStats,
  ForgetTarget,
  ForgetUnavailableReason,
  GraphLike,
  LexiconLike,
  LogLike,
  MemoryCoreLike,
  NarrativeLogLike,
  ProspectiveLike,
  ResidueReport,
  ResidueRow,
  ScrubOutcome,
  SnapshotLike,
  SurfaceId,
  SurfaceSpec,
  VectorLike,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface ForgetRightDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-010 记忆内核（**硬依赖**：没有它就删不了真源）。 */
  readonly core: () => MemoryCoreLike | undefined
  /** O-017 遗忘审计（软；在位时它是删除的**唯一执行口**）。 */
  readonly audit: () => AuditLike | undefined
  /** O-015 记忆图谱（软；缺席时图边这一面报 `absent`）。 */
  readonly graph: () => GraphLike | undefined
  /** O-122 向量索引（软；多数环境没装，报 `absent` 即可）。 */
  readonly vector: () => VectorLike | undefined
  /** O-021 承诺与待办（软）。 */
  readonly prospective: () => ProspectiveLike | undefined
  /** O-101 时间胶囊（软）。 */
  readonly capsule: () => CapsuleLike | undefined
  /** O-137 语感样本（软）。 */
  readonly lexicon: () => LexiconLike | undefined
  /** O-045 日记（软；**只读**，这一面注定删不掉）。 */
  readonly diary: () => DiaryLike | undefined
  /** O-135 叙事日志（软；只读状态，不代调 prune）。 */
  readonly narrative: () => NarrativeLogLike | undefined
  /** O-009 快照（软；**只读清单，不代删**）。 */
  readonly snapshot: () => SnapshotLike | undefined
  /** O-003 时钟（软；缺席退回系统时间）。 */
  readonly clock: () => ClockLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 残余扫描里「最多数几条」。没有分页概念的面用一个足够大的上限，
 * 但**不声称这个数是精确总数**（`detail` 里写「至少」）。
 */
const SCAN_LIMIT = 5000

/** 被遗忘权服务。 */
export class ForgetRight implements ForgetRightService {
  readonly #deps: ForgetRightDeps

  /** 计划过几次。 */
  #planned = 0

  /** 执行过几次。 */
  #executed = 0

  /** 因缺确认令牌被拒几次。 */
  #refused = 0

  /** 逐面累计删掉的条数。 */
  readonly #erasedBySurface: Record<string, number> = {}

  /** 累计失败的面数。 */
  #failedSurfaces = 0

  /** 执行序号（内存内自增，给日志对账用）。 */
  #runSeq = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: ForgetRightDeps) {
    this.#deps = deps
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): ForgetUnavailableReason | undefined {
    return this.#deps.settings.enable ? undefined : 'disabled'
  }

  /** 十一面说明书。 */
  surfaces(): readonly SurfaceSpec[] {
    return SURFACE_SPECS
  }

  /**
   * 出计划。**只读**：不调任何写方法，只调只读查询。
   * @param raw 目标。
   * @param at 时刻。
   */
  plan(raw: ForgetTarget, at?: number): ForgetPlan {
    this.assertEnabled()
    const target = normalizeTarget(raw)
    if (target === undefined) {
      throw new ForgetRightError('bad-target', '目标格式不对：需要 { kind, values[], reason }')
    }
    assertTarget(target)

    const stamp = this.stampOf(at)
    const resolved = this.resolve(target, stamp)
    if (!resolved.hit) {
      throw new ForgetRightError('nothing-to-forget', resolved.note)
    }

    const plan = buildPlan(target, resolved, this.availability(), this.#deps.settings.clearLexicon)
    this.#planned += 1
    return plan
  }

  /**
   * 执行。**必须带 `{ confirm: 'forget' }`**。
   * @param plan 计划。
   * @param confirmation 二次确认。
   */
  execute(plan: ForgetPlan, confirmation: { readonly confirm: 'forget' }): ForgetRun {
    this.assertEnabled()

    // 令牌先判：后面的每一个判断都在「已经确认过」的前提下才成立。
    if (confirmation === undefined || confirmation.confirm !== 'forget') {
      this.#refused += 1
      throw new ForgetRightError(
        'confirm-required',
        '执行删除必须传 { confirm: "forget" }：忘记是不可逆的，没有令牌的删除入口迟早会被某个循环顺手调用',
      )
    }

    const core = this.#deps.core()
    if (core === undefined) {
      throw new ForgetRightError('no-core', '记忆内核（ondra-memory-core）不在位，删不了正文真源')
    }

    const at = this.stampOf()
    this.#runSeq += 1
    const runId = `forget-${String(at)}-${String(this.#runSeq)}`
    const expected = expectedSurfacesOf(plan.scrubs)
    const outcomes: ScrubOutcome[] = []

    for (const surface of SCRUB_ORDER) {
      outcomes.push(this.scrubOne(surface, plan, at))
    }

    const erasedSurfaces = outcomes.filter(outcome => outcome.status === 'done').length
    const erasedItems = outcomes.reduce(
      (sum, outcome) => (outcome.status === 'done' ? sum + outcome.affected : sum),
      0,
    )
    const residue = residueOf(outcomes)
    const failed = outcomes.filter(outcome => outcome.status === 'failed').length
    this.#failedSurfaces += failed

    for (const outcome of outcomes) {
      if (outcome.status !== 'done') continue
      this.#erasedBySurface[outcome.surface] =
        (this.#erasedBySurface[outcome.surface] ?? 0) + outcome.affected
    }

    this.#executed += 1

    const base = {
      runId,
      target: plan.target,
      outcomes: Object.freeze(outcomes),
      complete: isComplete(outcomes, expected),
      erasedSurfaces,
      erasedItems,
      residue,
      at,
    }
    const run: ForgetRun = Object.freeze({ ...base, summary: runSummaryOf(base) })

    if (run.complete) {
      this.#deps.log.info('被遗忘权：%s 已完成，%d 面共 %d 条', runId, erasedSurfaces, erasedItems)
    } else {
      this.#deps.log.warn(
        '被遗忘权：%s **未清干净**（残余 %d 面：%s）',
        runId,
        residue.length,
        residue.join('、'),
      )
    }

    return run
  }

  /**
   * 残余扫描。
   * @param raw 目标，可省略（省略则扫全量）。
   * @param at 时刻。
   */
  residue(raw?: ForgetTarget, at?: number): ResidueReport {
    this.assertEnabled()
    const stamp = this.stampOf(at)

    let ids: readonly string[] | undefined
    if (raw !== undefined) {
      const target = normalizeTarget(raw)
      if (target === undefined) {
        throw new ForgetRightError('bad-target', '目标格式不对：需要 { kind, values[], reason }')
      }
      const resolved = this.resolve(target, stamp)
      // 目标一条没解析出来时**仍然扫全量**：这时候「有东西留着」比「0 条」有用得多。
      ids = resolved.hit ? resolved.ids : undefined
    }

    const rows: ResidueRow[] = []
    for (const surface of SCRUB_ORDER) {
      rows.push(this.residueRow(surface, ids, stamp))
    }
    return residueReportOf(rows)
  }

  /** 统计快照。 */
  stats(): ForgetStats {
    return Object.freeze({
      planned: this.#planned,
      executed: this.#executed,
      refused: this.#refused,
      erasedBySurface: Object.freeze({ ...this.#erasedBySurface }),
      failedSurfaces: this.#failedSurfaces,
    })
  }

  /* --------------------------- 内部：计划解析 --------------------------- */

  /** 未开启就抛。 */
  assertEnabled(): void {
    if (!this.#deps.settings.enable) {
      throw new ForgetRightError('disabled', '被遗忘权已关闭（enable=false）')
    }
  }

  /**
   * 时刻：优先 O-003，缺席用系统时间。
   * @param at 显式时刻。
   */
  stampOf(at?: number): number {
    if (typeof at === 'number' && Number.isFinite(at)) return Math.trunc(at)
    const clock = this.#deps.clock()
    if (clock !== undefined) {
      try {
        return clock.now()
      } catch {
        // 时钟坏了不该让「忘记」失败：退回系统时间只会差几毫秒。
      }
    }
    return this.#deps.now()
  }

  /**
   * 逐面在位情况。**只 `ctx.get` 一次，不调任何方法。**
   */
  availability(): readonly Availability[] {
    return Object.freeze(
      SURFACE_IDS.map(surface => {
        switch (surface) {
          case 'memory-fact':
            return { surface, present: this.#deps.core() !== undefined }
          case 'memory-pin':
            return { surface, present: this.#deps.audit() !== undefined }
          case 'memory-edge':
            return { surface, present: this.#deps.graph() !== undefined }
          case 'memory-vector':
            return { surface, present: this.#deps.vector() !== undefined }
          case 'todo':
          case 'promise':
            return { surface, present: this.#deps.prospective() !== undefined }
          case 'capsule':
            return { surface, present: this.#deps.capsule() !== undefined }
          case 'lexicon':
            return { surface, present: this.#deps.lexicon() !== undefined }
          case 'diary':
            return { surface, present: this.#deps.diary() !== undefined }
          case 'trace':
            return { surface, present: this.#deps.narrative() !== undefined }
          case 'snapshot':
            return { surface, present: this.#deps.snapshot() !== undefined }
          default:
            return { surface, present: false }
        }
      }),
    )
  }

  /**
   * 把目标解析成 id 列表。**只读**。
   * @param target 目标。
   * @param at 时刻。
   */
  resolve(target: ForgetTarget, at: number): ReturnType<typeof resolveTarget> {
    if (target.kind === 'capsule') {
      const capsule = this.#deps.capsule()
      if (capsule === undefined) {
        return resolveTarget(target, [], [], [])
      }
      let ids: readonly string[] = []
      try {
        ids = capsule
          .list(at)
          .filter(item => item.openedAt === 0 && item.state !== 'opened')
          .map(item => item.id)
          .filter(id => target.values.includes(id))
      } catch (error) {
        this.warn('读胶囊清单失败，胶囊面按空处理：%s', messageOf(error))
        ids = []
      }
      return resolveTarget(target, [], ids, [])
    }

    if (target.kind === 'todo') {
      const prospective = this.#deps.prospective()
      if (prospective === undefined) return resolveTarget(target, [], [], [])
      let ids: readonly string[] = []
      try {
        const list = prospective.listTodos?.() ?? []
        ids = list.map(item => item.id).filter(id => target.values.includes(id))
      } catch (error) {
        this.warn('读待办清单失败，待办面按空处理：%s', messageOf(error))
        ids = []
      }
      return resolveTarget(target, [], [], ids)
    }

    const core = this.#deps.core()
    if (core === undefined) return resolveTarget(target, [], [], [])

    let rows: readonly { readonly id: string }[] = []
    try {
      // `fact` 直接给 ids；`subject` 交给上游按 subject 筛（**不自己比字符串**：
      // 主体名的归一化口径归 O-010，自己比会漏掉大小写 / 空白差异的那些）。
      rows =
        target.kind === 'fact'
          ? core.listFacts({ ids: target.values, limit: MAX_TARGETS })
          : target.values.flatMap(subject => core.listFacts({ subject, limit: MAX_TARGETS }))
    } catch (error) {
      this.warn('读记忆清单失败，计划按空处理：%s', messageOf(error))
      rows = []
    }
    // `fact` 类要多做一步：**上游可能把不存在的 id 直接忽略**，也可能原样返回。
    // 只保留确实存在的那些，避免计划里出现「将删除 5 条」而实际只删得掉 3 条。
    if (target.kind === 'fact') {
      const exist = new Set(rows.map(row => row.id))
      const missing = target.values.filter(value => !exist.has(value))
      if (missing.length > 0) {
        this.warn('目标里有 %d 个 id 在记忆库里找不到：%s', missing.length, missing.join('、'))
      }
    }
    return resolveTarget(target, rows, [], [])
  }

  /* --------------------------- 内部：逐面执行 --------------------------- */

  /**
   * 跑一面。**任何异常都收敛成 `failed`**，不外抛。
   * @param surface 面 id。
   * @param plan 计划。
   * @param at 时刻。
   */
  scrubOne(surface: SurfaceId, plan: ForgetPlan, at: number): ScrubOutcome {
    const spec = specOf(surface)
    const present = this.availability().find(item => item.surface === surface)?.present === true
    const capability = effectiveCapability(spec, present)
    const ids = plan.resolved.ids

    if (capability === 'absent') {
      return outcomeOf(surface, 'absent', 0, `${spec.zh}：上游 ${spec.service} 未装载，这一面动不了`)
    }

    if (capability === 'blind') {
      return outcomeOf(surface, 'blind', 0, this.blindDetail(surface, at))
    }

    if (capability === 'erase-all' && !this.#deps.settings.clearLexicon) {
      return outcomeOf(
        surface,
        'skipped',
        0,
        '语感样本只能整份清空（会连带清掉别人说的话），未开启 clear-lexicon，故未动',
      )
    }

    // 待办与胶囊只有目标点名时才动；其余按 id 逐条。
    if (surface === 'todo' && plan.target.kind !== 'todo') {
      return outcomeOf(surface, 'skipped', 0, '本轮目标不是待办，未动')
    }
    if (surface === 'capsule' && plan.target.kind !== 'capsule') {
      return outcomeOf(surface, 'skipped', 0, '本轮目标不是胶囊，未动')
    }
    if (ids.length === 0) {
      return outcomeOf(surface, 'skipped', 0, '没有要处理的 id，未动')
    }

    try {
      switch (surface) {
        case 'todo':
          return outcomeOf(surface, 'done', this.dropTodos(ids), `删掉 ${String(ids.length)} 条待办`)
        case 'capsule':
          return outcomeOf(surface, 'done', this.dropCapsules(ids), `删掉 ${String(ids.length)} 颗未开封胶囊`)
        case 'memory-edge':
          return outcomeOf(surface, 'done', this.clearEdges(ids), '清掉指向这些记忆的图边')
        case 'memory-vector':
          return outcomeOf(surface, 'done', this.dropVectors(ids), '从向量索引移除')
        case 'memory-pin':
          return outcomeOf(surface, 'done', this.unpinAll(ids), '拔掉这些记忆上的钉子')
        case 'memory-fact':
          return this.forgetFacts(ids, plan.target.reason)
        case 'lexicon':
          return outcomeOf(surface, 'done', this.resetLexicon(), '整份清空语感样本')
        default:
          return outcomeOf(surface, 'skipped', 0, '未知面，未动')
      }
    } catch (error) {
      // C3：错误不传播，但绝不咽下去——记 `failed` 并让 complete 为 false。
      this.#deps.log.error('被遗忘权：%s 面失败：%s', spec.zh, messageOf(error))
      return outcomeOf(surface, 'failed', 0, `失败：${messageOf(error)}`)
    }
  }

  /**
   * 删待办。
   * @param ids 待办 id。
   */
  dropTodos(ids: readonly string[]): number {
    const prospective = this.#deps.prospective()
    if (prospective === undefined) return 0
    let done = 0
    for (const id of ids) {
      try {
        if (prospective.dropTodo(id)) done += 1
      } catch (error) {
        this.warn('删待办 %s 失败：%s', id, messageOf(error))
      }
    }
    return done
  }

  /**
   * 删未开封胶囊。**已开封的跳过**（正文已在记忆库，删它等于删记忆的另一面）。
   * @param ids 胶囊 id。
   */
  dropCapsules(ids: readonly string[]): number {
    const capsule = this.#deps.capsule()
    if (capsule === undefined) return 0
    let done = 0
    for (const id of ids) {
      try {
        if (capsule.drop(id, { confirm: 'drop' })) done += 1
      } catch (error) {
        this.warn('删胶囊 %s 失败（多半是已开封）：%s', id, messageOf(error))
      }
    }
    return done
  }

  /**
   * 清图边。
   * @param ids 记忆 id。
   */
  clearEdges(ids: readonly string[]): number {
    const graph = this.#deps.graph()
    if (graph === undefined) return 0
    let removed = 0
    for (const id of ids) {
      try {
        removed += graph.forgetOf(id)
      } catch (error) {
        this.warn('清边失败（%s）：%s', id, messageOf(error))
      }
    }
    return removed
  }

  /**
   * 从向量索引移除。
   * @param ids 记忆 id。
   */
  dropVectors(ids: readonly string[]): number {
    const vector = this.#deps.vector()
    if (vector === undefined) return 0
    let done = 0
    for (const id of ids) {
      try {
        vector.remove(id)
        done += 1
      } catch (error) {
        this.warn('移出向量索引失败（%s）：%s', id, messageOf(error))
      }
    }
    return done
  }

  /**
   * 拔钉。
   * @param ids 记忆 id。
   */
  unpinAll(ids: readonly string[]): number {
    const audit = this.#deps.audit()
    if (audit === undefined) return 0
    let done = 0
    for (const id of ids) {
      try {
        if (audit.unpin(id)) done += 1
      } catch (error) {
        this.warn('拔钉失败（%s）：%s', id, messageOf(error))
      }
    }
    return done
  }

  /**
   * 删正文真源。
   *
   * **优先走 O-017 `audit.forget()`**（台账原话：它是「怎么删」的唯一执行口），
   * 缺席才退回 O-010 `core.forget()`。两条路都写墓碑。
   *
   * 前面几步已经拔过钉、清过边，故 `audit.forget()` 内部的连带清理会是空操作——
   * 这是刻意的：让每一面各自报数，比让一个方法顺手干五件事更容易核对。
   * @param ids 记忆 id。
   * @param reason 原因。
   */
  forgetFacts(ids: readonly string[], reason: string): ScrubOutcome {
    const why = reason.trim() === '' ? '用户行使被遗忘权' : reason.trim()
    const audit = this.#deps.audit()
    const core = this.#deps.core()
    let done = 0
    const failures: string[] = []

    for (const id of ids) {
      try {
        if (audit !== undefined) {
          if (audit.forget(id, why).forgotten) done += 1
        } else if (core !== undefined) {
          if (core.forget(id, why)) done += 1
        }
      } catch (error) {
        failures.push(`${id}（${messageOf(error)}）`)
      }
    }

    if (failures.length > 0) {
      return outcomeOf(
        'memory-fact',
        done > 0 ? 'partial' : 'failed',
        done,
        `${String(failures.length)} 条删失败：${failures.join('、')}`,
      )
    }
    return outcomeOf('memory-fact', 'done', done, `真删 ${String(done)} 条并写墓碑（${why}）`)
  }

  /**
   * 整份清空语感样本。**返回清掉的条数**（清之前读一次 `stats()`）。
   */
  resetLexicon(): number {
    const lexicon = this.#deps.lexicon()
    if (lexicon === undefined) return 0
    let before = 0
    try {
      before = lexicon.stats().samples
    } catch {
      // 读不到就报 0，不猜。
      before = 0
    }
    lexicon.reset()
    return before
  }

  /**
   * 删不掉的那几面：**如实说明为什么，并尽量数出还剩多少**。
   * @param surface 面 id。
   * @param at 时刻。
   */
  blindDetail(surface: SurfaceId, at: number): string {
    switch (surface) {
      case 'promise':
        return `承诺行没有删除方法，只数得出还有 ${String(this.countPromises(undefined))} 条未结算（原文仍在表里）`
      case 'diary':
        return `日记是 Markdown 一天一篇且没有删除方法；现有 ${String(this.countDiary())} 篇，需人在文件系统里删`
      case 'trace':
        return `叙事日志只有 prune() 按保留期整天清理，现有 ${String(this.countTrace())} 条；本插件不代调`
      case 'snapshot':
        return `快照是整份库副本，现有 ${String(this.countSnapshots())} 份；删它不可逆且归 O-009，本插件不代删`
      default:
        void at
        return '删不掉，原因未登记'
    }
  }

  /* --------------------------- 内部：残余计数 --------------------------- */

  /**
   * 数一面的残余。
   * @param surface 面 id。
   * @param ids 目标 id（`undefined` = 全量）。
   * @param at 时刻。
   */
  residueRow(surface: SurfaceId, ids: readonly string[] | undefined, at: number): ResidueRow {
    const spec = specOf(surface)
    const present = this.availability().find(item => item.surface === surface)?.present === true
    if (!present) {
      return residueRowOf(spec, undefined, `${spec.service} 未装载，数不出来`)
    }

    try {
      switch (surface) {
        case 'memory-fact': {
          const core = this.#deps.core()
          if (core === undefined) return residueRowOf(spec, undefined, '记忆内核未装载')
          const remaining =
            ids === undefined ? core.countFacts({ state: 'active' }) : core.countFacts({ ids })
          return residueRowOf(spec, remaining, ids === undefined ? '全部还活着的记忆条数' : '这些 id 里还剩几条')
        }
        case 'memory-pin': {
          const pinned = this.#deps.audit()?.pinned() ?? []
          const remaining =
            ids === undefined ? pinned.length : pinned.filter(pin => ids.includes(pin.id)).length
          return residueRowOf(spec, remaining, '钉住的条数（不该继续指向已删的记忆）')
        }
        case 'memory-edge':
          // O-015 **没有「列举全部边」的入口**（只有 edgeOf / neighbors / forgetOf）。
          // 要数只能直连 memory_link，那是绕过服务边界，故如实报「数不出来」。
          // 同一条限制 O-100 也已登记为待裁决。
          return residueRowOf(spec, undefined, 'O-015 没有列举边的入口，数不出来（不直连表）')
        case 'memory-vector': {
          const vector = this.#deps.vector()
          if (vector === undefined) return residueRowOf(spec, undefined, '向量分支未装载')
          if (ids !== undefined) {
            // `VectorService` 没有「按 id 查在不在」的入口，故按目标扫时数不出来。
            return residueRowOf(spec, undefined, '向量服务没有按 id 查询入口，只数得出总数')
          }
          return residueRowOf(spec, vector.count(), '索引内文档总数')
        }
        case 'todo':
          return residueRowOf(spec, this.countTodos(ids), '未完成的待办条数')
        case 'promise':
          return residueRowOf(spec, this.countPromises(ids), '未结算的承诺条数（**删不掉**）')
        case 'capsule':
          return residueRowOf(spec, this.countCapsules(ids, at), '未开封的胶囊颗数')
        case 'lexicon': {
          const samples = this.#deps.lexicon()?.stats().samples
          return residueRowOf(
            spec,
            samples,
            samples === undefined ? '读不到样本数' : '语感样本条数（只能整份清）',
          )
        }
        case 'diary':
          return this.#deps.settings.scanDiary
            ? residueRowOf(spec, this.countDiary(), '日记篇数（**删不掉**）')
            : residueRowOf(spec, undefined, '已关闭 scan-diary，未统计')
        case 'trace':
          return this.#deps.settings.scanTrace
            ? residueRowOf(spec, this.countTrace(), '叙事日志条数（**删不掉**）')
            : residueRowOf(spec, undefined, '已关闭 scan-trace，未统计')
        case 'snapshot':
          return residueRowOf(spec, this.countSnapshots(), '快照份数（**整份旧库还在**）')
        default:
          return residueRowOf(spec, undefined, '未知面')
      }
    } catch (error) {
      this.warn('残余统计失败（%s）：%s', spec.zh, messageOf(error))
      return residueRowOf(spec, undefined, `数不出来：${messageOf(error)}`)
    }
  }

  /**
   * 数待办。
   * @param ids 目标 id。
   */
  countTodos(ids?: readonly string[]): number {
    const list = this.#deps.prospective()?.listTodos?.() ?? []
    return ids === undefined ? list.length : list.filter(item => ids.includes(item.id)).length
  }

  /**
   * 数未结算承诺。
   * @param ids 目标 id（按 `factId` 关联）。
   */
  countPromises(ids?: readonly string[]): number {
    const open = this.#deps.prospective()?.listOpen?.() ?? []
    if (ids === undefined) return open.length
    return open.filter(item => ids.includes(item.promise.factId)).length
  }

  /**
   * 数未开封胶囊。
   * @param ids 目标 id。
   * @param at 时刻。
   */
  countCapsules(ids: readonly string[] | undefined, at: number): number {
    const list = this.#deps.capsule()?.list(at) ?? []
    const unopened = list.filter(item => item.openedAt === 0 && item.state !== 'opened')
    return ids === undefined ? unopened.length : unopened.filter(item => ids.includes(item.id)).length
  }

  /** 数日记篇数。 */
  countDiary(): number {
    const list = this.#deps.diary()?.list(SCAN_LIMIT) ?? []
    return list.length
  }

  /** 数叙事日志条数（内存环，不代表磁盘总数）。 */
  countTrace(): number {
    return this.#deps.narrative()?.stats().entries ?? 0
  }

  /** 数快照份数。 */
  countSnapshots(): number {
    return this.#deps.snapshot()?.list().length ?? 0
  }

  /**
   * 打一行降级日志（`verbose` 关掉就不打）。
   * @param message 模板。
   * @param args 参数。
   */
  warn(message: string, ...args: unknown[]): void {
    if (!this.#deps.settings.verbose) return
    this.#deps.log.warn(message, ...args)
  }
}
