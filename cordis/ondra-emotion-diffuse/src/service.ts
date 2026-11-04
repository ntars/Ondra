/**
 * 弥散服务：把纯算术接到情绪内核与标记表上。
 *
 * 三个**刻意**的设计：
 *
 * 1. **情绪服务每次现取**（`() => ctx.get(...)`），不在构造时缓存。
 *    装载顺序不确定，缓存一次就等于「谁先装载谁决定弥散能不能用」。
 * 2. **任何异常都转成拒绝结果**，不外抛（器官 ABI 的 C3）。
 *    本服务在会话边界被调用，抛一次就会把「换会话」这个动作整个打断——
 *    为了算一个 0.2 的差值把对话卡死，是本末倒置。
 * 3. **拒绝也返回完整的 plan 结构**，只是 `status` 不同。
 *    让调用方永远不需要写 `if (result === undefined)`——那种分支最容易被漏写，
 *    漏写的表现是「弥散偶尔不生效」，没有任何日志。
 */

import {
  FIRST_RUN_GAP,
  gapMinutesOf,
  normalizeFamiliarity,
  noteOf,
  previewOf,
  retainOf,
} from './diffuse.js'
import type { Config } from './settings.js'
import type { MarkRow, MarkStore } from './store.js'
import {
  MOOD_BASELINE,
  type DiffuseCounters,
  type DiffusePlan,
  type DiffusePreview,
  type DiffuseRequest,
  type DiffuseService,
  type DiffuseStats,
  type DiffuseStatus,
  type DiffuseUnavailableReason,
  type EmotionLike,
  type LogLike,
} from './types.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 从情绪快照里取心情，取不到用基线。 */
function moodOf(emotion: EmotionLike | undefined, at: number): number {
  if (emotion === undefined) return MOOD_BASELINE
  try {
    const snapshot = emotion.state(at)
    const value = snapshot.axes['mood']
    if (typeof value !== 'number' || !Number.isFinite(value)) return MOOD_BASELINE
    return value
  } catch {
    // 情绪内核自己炸了不该连累弥散：按基线算，等于「这次没带走什么」。
    return MOOD_BASELINE
  }
}

/** 弥散仓库。 */
export class DiffuseRepository implements DiffuseService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  private readonly emotionOf: () => EmotionLike | undefined
  private readonly marks: MarkStore | undefined
  private readonly fallbackReason: DiffuseUnavailableReason | undefined

  private counters: DiffuseCounters = Object.freeze({
    claims: 0,
    duplicates: 0,
    tooSoon: 0,
    noEmotion: 0,
  })
  private lastClaimAt = 0
  private lastBoundaryKey = ''
  private lastError: string | undefined
  /**
   * 内存里的上一份标记。
   *
   * 没有存储端口时**必须有它**：否则 `marks` 缺席 → 每次提领都读到 `undefined`
   * → 幂等闸与间隔闸同时失效 → 同一场会话里调几次就乘几次 0.4。
   * 那正是两道闸存在的理由，不能因为「没装数据库」就整条撤掉。
   * 代价只是重启后丢一次（多算一次，残差再乘 0.4，可忽略）。
   */
  private memoryMark: MarkRow | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（测试可注入）。
   * @param emotionOf 现取情绪内核。
   * @param marks 标记表；缺席表示只在内存记。
   * @param fallbackReason 建表失败之类的外部原因。
   */
  constructor(
    settings: Config,
    log: LogLike,
    clock: () => number,
    emotionOf: () => EmotionLike | undefined,
    marks: MarkStore | undefined,
    fallbackReason?: DiffuseUnavailableReason,
  ) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.emotionOf = emotionOf
    this.marks = marks
    this.fallbackReason = fallbackReason
  }

  /** 是否可用。每次现算：情绪内核可能比本插件晚装载。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    const emotion = this.emotionOf()
    return emotion !== undefined && emotion.available
  }

  /** 不可用原因。 */
  get reason(): DiffuseUnavailableReason | undefined {
    if (this.fallbackReason !== undefined) return this.fallbackReason
    if (!this.settings.enable) return 'disabled'
    const emotion = this.emotionOf()
    if (emotion === undefined) return 'no-emotion'
    if (!emotion.available) return 'emotion-unavailable'
    return undefined
  }

  /** 保留比例。 */
  retainOf(familiarity: number): number {
    return retainOf(familiarity)
  }

  /**
   * 纯计算。**不读也不写标记表**——这是面板用的「如果现在换会话会怎样」，
   * 预览一次就把额度用掉是不可接受的。
   * @param familiarity 熟悉度。
   * @param at 计算时刻。
   */
  preview(familiarity?: number, at?: number): DiffusePreview {
    const now = at ?? this.clock()
    const emotion = this.emotionOf()
    return previewOf(moodOf(emotion, now), normalizeFamiliarity(familiarity), now)
  }

  /**
   * 提领一次弥散额度。
   * @param request 入参。
   */
  claim(request: DiffuseRequest): DiffusePlan {
    const at = request.at ?? this.clock()
    try {
      return this.claimInner(request, at)
    } catch (error) {
      // C3：错误不外抛。返回一份「没弥散」的结果，并把原因记进 stats。
      this.lastError = messageOf(error)
      this.log.warn('弥散提领失败（按未弥散处理）：%s', this.lastError)
      const preview = previewOf(MOOD_BASELINE, normalizeFamiliarity(request.familiarity), at)
      return this.planOf('bad-request', request.boundaryKey, preview, FIRST_RUN_GAP, '计算异常，本次不弥散')
    }
  }

  /**
   * 提领的主体。
   * @param request 入参。
   * @param at 时刻。
   */
  private claimInner(request: DiffuseRequest, at: number): DiffusePlan {
    const key = typeof request.boundaryKey === 'string' ? request.boundaryKey.trim() : ''
    const fam = normalizeFamiliarity(request.familiarity)
    const emotion = this.emotionOf()
    const preview = previewOf(moodOf(emotion, at), fam, at)

    // 1. 入参不合法：先挡住，免得后面所有分支都要重复判空。
    if (key === '') {
      this.log.warn('弥散缺少边界键：幂等无从判定，本次不弥散')
      return this.planOf('bad-request', key, preview, FIRST_RUN_GAP, '缺少边界键')
    }

    // 2. 配置关闭。
    if (!this.settings.enable) {
      return this.planOf('disabled', key, preview, FIRST_RUN_GAP, '配置关闭')
    }

    // 3. 情绪内核缺席。
    if (emotion === undefined || !emotion.available) {
      this.counters = { ...this.counters, noEmotion: this.counters.noEmotion + 1 }
      this.log.warn('情绪内核不可用，本次不弥散（下游读到的心情不会变）')
      return this.planOf('no-emotion', key, preview, FIRST_RUN_GAP, '情绪内核不可用')
    }

    // 4. 同一个边界已经提领过。没有存储端口时读内存里那份。
    const mark = this.marks === undefined ? this.memoryMark : this.marks.load()
    if (mark !== undefined && mark.boundaryKey === key) {
      this.counters = { ...this.counters, duplicates: this.counters.duplicates + 1 }
      return this.planOf('already', key, preview, 0, '同一场已弥散过')
    }

    // 5. 间隔太短：判定为同一场会话。
    const gap = mark === undefined ? FIRST_RUN_GAP : gapMinutesOf(mark.claimedAt, at)
    if (mark !== undefined && gap < this.settings.minGapMinutes) {
      this.counters = { ...this.counters, tooSoon: this.counters.tooSoon + 1 }
      return this.planOf('no-gap', key, preview, gap, '间隔不足判定阈值')
    }

    // 6. 记下这一次。写失败不影响返回值——本轮的弥散建议依然有效。
    const record = {
      boundaryKey: key,
      claimedAt: at,
      moodBefore: preview.moodBefore,
      target: preview.target,
      familiarity: fam,
    }
    this.memoryMark = record
    const saved = this.marks === undefined ? false : this.marks.save(record)
    if (this.marks !== undefined && !saved) {
      this.lastError = '写弥散标记失败'
    } else {
      this.lastError = undefined
    }

    this.counters = { ...this.counters, claims: this.counters.claims + 1 }
    this.lastClaimAt = at
    this.lastBoundaryKey = key

    const plan = this.planOf('diffused', key, preview, gap, '正常弥散')
    if (this.settings.verbose) {
      this.log.info('弥散：边界 %s，%s', key, plan.note)
    }
    return plan
  }

  /**
   * 拼一份结果。**拒绝也拼完整的**，调用方不必写判空分支。
   * @param status 状态码。
   * @param key 边界键。
   * @param preview 计算值。
   * @param gap 间隔分钟。
   * @param detail 内部说明（拼进 note）。
   */
  private planOf(
    status: DiffuseStatus,
    key: string,
    preview: DiffusePreview,
    gap: number,
    detail: string,
  ): DiffusePlan {
    const base = noteOf(preview, status)
    const note = status === 'diffused' ? base : `${base}（${detail}）`
    return Object.freeze({
      ...preview,
      status,
      boundaryKey: key,
      gapMinutes: gap,
      applied: false as const,
      applyPath: 'set-axis' as const,
      note,
    })
  }

  /** 统计快照。 */
  stats(): DiffuseStats {
    const available = this.available
    const reason = this.reason
    const provider = this.marks === undefined ? 'none' : this.marks.provider
    const out: DiffuseStats = {
      available,
      storeProvider: provider,
      lastClaimAt: this.lastClaimAt,
      lastBoundaryKey: this.lastBoundaryKey,
      counters: this.counters,
    }
    if (reason !== undefined) {
      return { ...out, reason }
    }
    if (this.lastError !== undefined) {
      return { ...out, lastError: this.lastError }
    }
    return out
  }
}
