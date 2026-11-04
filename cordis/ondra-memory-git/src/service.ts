/**
 * 记忆版本线服务的实现：**全只读 + 一张标签映射表的小写**。
 *
 * 全部上游依赖都是**取值函数**（`() => ctx.get(...)`）：晚装载能自愈，早卸载立刻反映。
 *
 * 一条贯穿全文件的纪律：**任何上游缺席都不抛错**。版本线是「看得更清楚」的能力，
 * 它崩了不该让对话链受任何影响（§13.4 第 1 问）。
 */

import { depthOf, diffOf, previewOf, stageOf, stageZhOf } from './diff.js'
import { emptyState, readState, writeState } from './store.js'
import { CAPABILITY, GitError, MAX_TAGS, STAGE_SPECS, TAG_RE } from './types.js'
import type {
  Checkpoint,
  CheckoutOutcome,
  ClockLike,
  DiffResult,
  GitCapability,
  GitStats,
  GitUnavailableReason,
  LogLike,
  MemoryCoreLike,
  MemoryGitService,
  MemoryRecordLike,
  PathLike,
  SnapshotLike,
  StageDoc,
  TagRecord,
  VersionView,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface MemoryGitDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-010 记忆内核。 */
  readonly core: () => MemoryCoreLike | undefined
  /** O-009 快照。 */
  readonly snapshot: () => SnapshotLike | undefined
  /** O-002 路径；缺席时状态只在内存。 */
  readonly path: () => PathLike | undefined
  /** O-003 时钟；缺席退回系统时间。 */
  readonly clock: () => ClockLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 记忆版本线服务。 */
export class MemoryGit implements MemoryGitService {
  readonly #deps: MemoryGitDeps

  /** 内存态：路径缺席时的兜底，也是落盘失败后的最新真值。 */
  #state = emptyState()

  /** 状态文件绝对路径；`undefined` 表示只在内存。 */
  #file: string | undefined

  /** 累计视图次数。 */
  #viewed = 0

  /** 累计差异次数。 */
  #diffed = 0

  /** 累计失败次数。 */
  #failed = 0

  /** 落盘失败次数。 */
  #writeFailures = 0

  /** 是否已试过读盘。 */
  #loaded = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: MemoryGitDeps) {
    this.#deps = deps
    const path = deps.path()
    if (path !== undefined) {
      try {
        this.#file = path.fileIn('user', 'memory-git.json')
      } catch (error) {
        deps.log.warn('拼检查点路径失败，状态只在内存：%s', messageOf(error))
        this.#file = undefined
      }
    } else if (deps.settings.verbose) {
      deps.log.info('路径服务未装载：检查点只在内存，重启后标签会丢（快照文件仍在 O-009 目录）')
    }
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.#deps.settings.enable) return false
    return this.#coreReady()
  }

  /** 不可用原因。 */
  get reason(): GitUnavailableReason | undefined {
    if (!this.#deps.settings.enable) return 'disabled'
    return this.#coreReady() ? undefined : 'no-core'
  }

  /** 能力粒度。 */
  get capability(): GitCapability {
    return CAPABILITY
  }

  /** 四阶段说明书。 */
  stages(): readonly StageDoc[] {
    return Object.freeze([STAGE_SPECS.active, STAGE_SPECS.archived, STAGE_SPECS.sealed, STAGE_SPECS.forgotten])
  }

  /**
   * 单条记忆的版本视图。**只读**。
   * @param id 记忆 id。
   * @param at 时刻。
   */
  view(id: string, at?: number): VersionView | undefined {
    const core = this.#core()
    if (core === undefined) return undefined
    if (typeof id !== 'string' || id.trim() === '') return undefined

    const stamp = this.#stamp(at)
    let record: MemoryRecordLike | undefined
    try {
      record = core.getFact(id)
    } catch (error) {
      this.#noteFailure('getFact', error)
      return undefined
    }
    if (record === undefined) return undefined

    this.#viewed += 1
    const stage = stageOf(record)

    // 强度算不出来（端口没聚合面、记录已删）时给 0，而不是抛错：
    // 版本线的价值在「它变过几次、现在在哪一步」，强度只是附带读数。
    let stabilityHours = record.stabilityHours
    let strength = 0
    let remainingHours = 0
    try {
      const view = core.strengthOf(record, stamp)
      stabilityHours = view.stabilityHours
      strength = view.strength
      remainingHours = view.remainingHours
    } catch (error) {
      this.#noteFailure('strengthOf', error)
    }

    return Object.freeze({
      id: record.id,
      stage,
      stageZh: stageZhOf(stage),
      depth: depthOf(record.revisions),
      revisions: record.revisions,
      timesSaid: record.timesSaid,
      hits: record.hits,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      stabilityHours,
      strength,
      remainingHours,
      important: record.important,
      category: record.category,
      kind: record.kind,
      hasPreviousText: record.oldText !== null && record.oldText.trim() !== '',
      preview: previewOf(record.text, this.#deps.settings.previewChars),
    })
  }

  /**
   * 最近一次订正的差异。**纯函数调用 + 内存计算**，不写任何东西。
   * @param id 记忆 id。
   */
  diff(id: string): DiffResult | undefined {
    const core = this.#core()
    if (core === undefined) return undefined
    if (typeof id !== 'string' || id.trim() === '') return undefined

    let record: MemoryRecordLike | undefined
    try {
      record = core.getFact(id)
    } catch (error) {
      this.#noteFailure('getFact', error)
      return undefined
    }
    if (record === undefined) return undefined

    const result = diffOf(record, this.#deps.settings.diffChars, this.#stamp())
    if (result !== undefined) this.#diffed += 1
    return result
  }

  /** 检查点列表。 */
  tags(): readonly Checkpoint[] {
    this.#ensureLoaded()
    const snapshots = this.#snapshotIds()
    return Object.freeze(
      this.#state.tags.map(tag => ({
        label: tag.label,
        snapshotId: tag.snapshotId,
        note: tag.note,
        at: tag.at,
        // 「快照还在不在」每次现查：KEEP 轮转会删文件，缓存下来就会给出过期的「还在」。
        present: snapshots.has(tag.snapshotId),
      })),
    )
  }

  /**
   * 打一个检查点。
   *
   * **先打真快照，成功了才存标签**。反过来的话，`create()` 失败会留下一个
   * 指向空 id 的标签——那是一条骗人的记录。
   * @param label 标签名。
   * @param note 备注。
   */
  tag(label: string, note?: string): Checkpoint {
    this.#ensureLoaded()

    const clean = typeof label === 'string' ? label.trim().toLowerCase() : ''
    if (!TAG_RE.test(clean)) {
      throw new GitError(
        'bad-label',
        '标签名不合规：只能用 1–32 个小写字母、数字、- 或 _，且不能以 - 开头',
        clean,
      )
    }

    const existing = this.#state.tags.find(tag => tag.label === clean)
    if (existing === undefined && this.#state.tags.length >= MAX_TAGS) {
      throw new GitError('too-many-tags', `检查点最多 ${MAX_TAGS} 个：请先删掉几个不再需要的标签`, clean)
    }

    const snapshot = this.#snapshot()
    if (snapshot === undefined) {
      throw new GitError(
        'no-snapshot',
        '快照服务（O-009）未装载：无法打检查点。标签必须绑定一份真快照，存空 id 等于骗人',
        clean,
      )
    }
    if (!snapshot.available) {
      throw new GitError(
        'no-snapshot',
        `快照服务报不可用（${snapshot.unavailableReason ?? '原因未知'}）：无法打检查点`,
        clean,
      )
    }

    let snapshotId = ''
    try {
      const outcome = snapshot.create(`记忆检查点 ${clean}${note === undefined ? '' : `：${note}`}`)
      if (!outcome.ok || outcome.record === undefined) {
        throw new GitError('no-snapshot', '快照创建被拒绝：检查点未建立', clean)
      }
      snapshotId = outcome.record.id
    } catch (error) {
      if (error instanceof GitError) throw error
      this.#noteFailure('snapshot.create', error)
      throw new GitError('no-snapshot', `快照创建失败：${messageOf(error)}`, clean)
    }

    const at = this.#stamp()
    const record: TagRecord = Object.freeze({
      label: clean,
      snapshotId,
      note: typeof note === 'string' ? note.slice(0, 200) : '',
      at,
    })

    const next: TagRecord[] = []
    for (const tag of this.#state.tags) {
      if (tag.label === clean) continue
      next.push(tag)
    }
    next.push(record)

    this.#persist(Object.freeze({ version: this.#state.version, tags: Object.freeze(next) }))

    this.#deps.log.info('检查点已建立：%s → 快照 %s', clean, snapshotId)
    return Object.freeze({ label: clean, snapshotId, note: record.note, at, present: true })
  }

  /**
   * 删标签。**不动快照文件**。
   * @param label 标签名。
   */
  dropTag(label: string): boolean {
    this.#ensureLoaded()
    const clean = typeof label === 'string' ? label.trim().toLowerCase() : ''
    const kept = this.#state.tags.filter(tag => tag.label !== clean)
    if (kept.length === this.#state.tags.length) return false
    this.#persist(Object.freeze({ version: this.#state.version, tags: Object.freeze(kept) }))
    this.#deps.log.info('检查点已删除：%s（快照文件保留，归 O-009 的 KEEP 策略）', clean)
    return true
  }

  /**
   * 把标签指向的快照登记为待恢复。**不换库**。
   *
   * 真正的 `restore()` 归 O-009，且必须人再确认一次。
   * 这里连那次调用的入口都不给——「不做自动回滚」的落地方式是让代码里没有那条路。
   * @param label 标签名。
   */
  checkout(label: string): CheckoutOutcome {
    this.#ensureLoaded()
    const clean = typeof label === 'string' ? label.trim().toLowerCase() : ''
    const found = this.#state.tags.find(tag => tag.label === clean)
    if (found === undefined) {
      return Object.freeze({
        ok: false,
        label: clean,
        snapshotId: '',
        refusal: 'not-found',
        detail: '没有这个检查点标签',
      })
    }

    const snapshot = this.#snapshot()
    if (snapshot === undefined) {
      return Object.freeze({
        ok: false,
        label: clean,
        snapshotId: found.snapshotId,
        refusal: 'no-snapshot',
        detail: '快照服务未装载：无法登记待恢复',
      })
    }

    try {
      const outcome = snapshot.stage(found.snapshotId)
      if (!outcome.ok) {
        return Object.freeze({
          ok: false,
          label: clean,
          snapshotId: found.snapshotId,
          refusal: 'not-found',
          detail: `快照 ${found.snapshotId} 已不在（可能被 KEEP 策略轮转掉了）：标签仍在，但恢复不了`,
        })
      }
    } catch (error) {
      this.#noteFailure('snapshot.stage', error)
      return Object.freeze({
        ok: false,
        label: clean,
        snapshotId: found.snapshotId,
        refusal: 'no-snapshot',
        detail: `登记待恢复失败：${messageOf(error)}`,
      })
    }

    this.#deps.log.warn(
      '检查点 %s 已登记为待恢复（快照 %s）。换库本身仍需人工在 O-009 处二次确认',
      clean,
      found.snapshotId,
    )
    return Object.freeze({
      ok: true,
      label: clean,
      snapshotId: found.snapshotId,
      detail: '已登记为待恢复。换库仍需人工确认——本插件不会自动回滚',
    })
  }

  /** 统计快照。 */
  stats(): GitStats {
    this.#ensureLoaded()
    return Object.freeze({
      available: this.available,
      capability: CAPABILITY,
      checkpoints: this.#state.tags.length,
      snapshots: this.#snapshotIds().size,
      viewed: this.#viewed,
      diffed: this.#diffed,
      failed: this.#failed,
      writeFailures: this.#writeFailures,
    })
  }

  /* ---------------- 内部 ---------------- */

  /** O-010 是否就绪。 */
  #coreReady(): boolean {
    const core = this.#deps.core()
    return core !== undefined && core.available
  }

  /** 取记忆内核；不可用一律当缺席。 */
  #core(): MemoryCoreLike | undefined {
    const core = this.#deps.core()
    if (core === undefined) return undefined
    return core.available ? core : undefined
  }

  /** 取快照服务。 */
  #snapshot(): SnapshotLike | undefined {
    return this.#deps.snapshot()
  }

  /**
   * 当前存在的快照 id 集合。
   *
   * 每次现查而不是缓存：KEEP 轮转会删文件，缓存就会给出过期的「还在」。
   * 快照服务缺席时返回空集合——那样每个标签都会显示 `present=false`，
   * 这是如实的：确实不知道它还在不在。
   */
  #snapshotIds(): ReadonlySet<string> {
    const snapshot = this.#snapshot()
    if (snapshot === undefined) return new Set<string>()
    try {
      return new Set(snapshot.list().map(item => item.id))
    } catch (error) {
      this.#noteFailure('snapshot.list', error)
      return new Set<string>()
    }
  }

  /** 当前时刻：优先时钟，其次系统时间。 */
  #stamp(at?: number): number {
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) return Math.trunc(at)
    const clock = this.#deps.clock()
    if (clock !== undefined) {
      try {
        return Math.trunc(clock.now())
      } catch {
        // 时钟坏了不该让视图失败，退系统时间。
      }
    }
    return Math.trunc(this.#deps.now())
  }

  /** 首次读盘（只试一次，避免每次调用都撞坏文件）。 */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true
    if (this.#file === undefined) return
    const result = readState(this.#file)
    this.#state = result.state
    if (result.issue !== undefined) {
      this.#deps.log.warn('%s（按空状态继续）', result.issue)
    }
  }

  /** 落盘；失败只记账不抛——标签丢了不该让整个调用失败。 */
  #persist(next: { readonly version: number; readonly tags: readonly TagRecord[] }): void {
    this.#state = next
    if (this.#file === undefined) return
    try {
      writeState(this.#file, next)
    } catch (error) {
      this.#writeFailures += 1
      this.#deps.log.warn('检查点状态落盘失败（内存里仍然有效，重启会丢）：%s', messageOf(error))
    }
  }

  /** 记一次失败。 */
  #noteFailure(where: string, error: unknown): void {
    this.#failed += 1
    this.#deps.log.warn('%s 调用失败：%s', where, messageOf(error))
  }
}
