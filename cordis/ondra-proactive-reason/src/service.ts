/**
 * 话由服务：把「收集 → 排序 → 冷却」接起来。
 *
 * ## 三条纪律
 *
 * 1. **`plan()` 不改冷却表。** 只有 `markUsed()` / `note()` 才记账。
 *    面板每几秒调一次 `plan()` 看「她此刻会说什么」，若刷一次就算说过，
 *    冷却表会被面板刷满——于是她永远没话说，而原因查不出来（§15-73 的同一教训）。
 * 2. **上游抛错不传播。** 收集层已经逐源 try/catch，这里再包一层兜底，
 *    保证 `plan()` 永不抛错：它被主动编排在每一轮调，抛一次就是「这轮没有主动」。
 * 3. **零常驻。** 不装定时器、不订阅事件。冷却表在记账时落盘，过期条目在访问时清。
 */

import { collect } from './collect.js'
import type { CollectDeps } from './collect.js'
import {
  coolingUntil,
  markEntry,
  pruneEntries,
  readCooldown,
  writeCooldown,
} from './cooldown.js'
import type { CooldownEntry } from './cooldown.js'
import { pickOf, rank } from './rank.js'
import { mentions } from './topics.js'
import type { Config as ReasonConfig } from './settings.js'
import {
  KIND_ORDER,
  KIND_ZH,
  NOTE_MAX_FRAGMENT,
  NOTE_MIN_FRAGMENT,
  REASON_SERVICE_KEY,
} from './types.js'
import type {
  CandidateSeed,
  DriveGapLike,
  ExpressLike,
  LogLike,
  PathLike,
  PlanCode,
  ProspectiveLike,
  ReasonCandidate,
  ReasonInput,
  ReasonKind,
  ReasonPlan,
  ReasonService,
  ReasonStats,
  ReasonUnavailableReason,
  SourceStatus,
} from './types.js'

/** 内部计数（可变，故不写成 readonly——§15-60）。 */
interface Counters {
  plans: number
  picks: number
  allCooling: number
  marks: number
  noted: number
  byKind: Record<ReasonKind, number>
  writes: number
  writeFailures: number
  errors: number
}

/** 造一份零计数。 */
function zeroCounters(): Counters {
  const byKind = {} as Record<ReasonKind, number>
  for (const kind of KIND_ORDER) byKind[kind] = 0
  return {
    plans: 0,
    picks: 0,
    allCooling: 0,
    marks: 0,
    noted: 0,
    byKind,
    writes: 0,
    writeFailures: 0,
    errors: 0,
  }
}

/** 构造入参。 */
export interface ReasonOptions {
  /** 配置。 */
  readonly settings: ReasonConfig
  /** 日志。 */
  readonly log: LogLike
  /** 路径服务（可缺席）。 */
  readonly path: () => PathLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
  /** O-016 承诺与待办（可缺席）。 */
  readonly prospective: () => ProspectiveLike | undefined
  /** O-129 缺口池（可缺席）。 */
  readonly gap: () => DriveGapLike | undefined
  /** O-031 情绪表达（可缺席）。 */
  readonly express: () => ExpressLike | undefined
}

/** 内部计算结果（不含计数副作用）。 */
interface Computed {
  readonly at: number
  readonly code: PlanCode
  readonly candidates: readonly ReasonCandidate[]
  readonly pick: ReasonCandidate | undefined
  readonly sources: SourceStatus
}

/** 话由实现。 */
export class Reason implements ReasonService {
  private readonly settings: ReasonConfig
  private readonly log: LogLike
  private readonly path: () => PathLike | undefined
  private readonly now: () => number
  private readonly deps: CollectDeps

  private entries: readonly CooldownEntry[] = []
  private file: string | undefined
  private persisted = false
  private warnedWrite = false
  private counters: Counters = zeroCounters()

  /**
   * @param options 依赖。
   */
  constructor(options: ReasonOptions) {
    this.settings = options.settings
    this.log = options.log
    this.path = options.path
    this.now = options.now
    this.deps = {
      prospective: options.prospective,
      gap: options.gap,
      express: options.express,
      log: options.log,
    }

    const stamp = this.now()
    this.file = this.resolveFile()
    const loaded = readCooldown(this.file, stamp)
    this.entries = loaded ?? []
    this.persisted = loaded !== undefined && this.file !== undefined

    if (this.file === undefined) {
      this.log.warn(
        '没有路径服务（ondra-path-layout）：%d 小时冷却只在内存里，重启后失效（同一件事会被重提）',
        this.settings.cooldownHours,
      )
    } else if (loaded === undefined) {
      this.log.info('话由冷却表还没有内容（首次启动或上次没写成功）：从空表开始')
    }
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): ReasonUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /** 冷却表是否真的落盘。 */
  get stored(): boolean {
    return this.persisted
  }

  /**
   * 取一次话由计划。
   * @param input 入参。
   */
  plan(input?: ReasonInput): ReasonPlan {
    const at = input?.at ?? this.now()
    const computed = this.compute(input ?? {}, at)
    this.counters.plans += 1
    if (computed.code === 'ok') this.counters.picks += 1
    if (computed.code === 'all-cooling') this.counters.allCooling += 1
    for (const candidate of computed.candidates) {
      this.counters.byKind[candidate.kind] += 1
    }
    return Object.freeze({
      at: computed.at,
      code: computed.code,
      candidates: computed.candidates,
      pick: computed.pick,
      sources: computed.sources,
    })
  }

  /**
   * 只要候选列表。
   * @param input 入参。
   */
  candidates(input?: ReasonInput): readonly ReasonCandidate[] {
    return this.compute(input ?? {}, input?.at ?? this.now()).candidates
  }

  /**
   * 只要那一条。
   * @param input 入参。
   */
  pick(input?: ReasonInput): ReasonCandidate | undefined {
    return this.compute(input ?? {}, input?.at ?? this.now()).pick
  }

  /**
   * 记一次「这条用过了」。
   * @param topic 话题键。
   * @param at 时刻。
   */
  markUsed(topic: string, at?: number): number {
    const stamp = at ?? this.now()
    const until = stamp + this.settings.cooldownHours * 3_600_000
    this.entries = markEntry(pruneEntries(this.entries, stamp), topic, until)
    this.counters.marks += 1
    this.persist()
    return until
  }

  /**
   * 从她真的说出口的那句话里认出「说的是哪条由头」并记冷却。
   * @param text 她发出去的话。
   * @param at 时刻。
   */
  note(text: string, at?: number): number {
    const stamp = at ?? this.now()
    const computed = this.compute({ at: stamp }, stamp)
    let entries = pruneEntries(this.entries, stamp)
    let count = 0
    for (const candidate of computed.candidates) {
      if (!mentions(text, candidate.text, NOTE_MIN_FRAGMENT, NOTE_MAX_FRAGMENT)) continue
      const until = stamp + this.settings.cooldownHours * 3_600_000
      entries = markEntry(entries, candidate.topic, until)
      count += 1
    }
    if (count > 0) {
      this.entries = entries
      this.counters.noted += count
      this.persist()
    }
    return count
  }

  /**
   * 某话题是否在冷却里。
   * @param topic 话题键。
   * @param at 时刻。
   */
  cooling(topic: string, at?: number): boolean {
    const stamp = at ?? this.now()
    return coolingUntil(this.entries, topic) > stamp
  }

  /**
   * 一句中文解释（面板用）。
   * @param candidate 候选。
   */
  explain(candidate: ReasonCandidate): string {
    const kind = KIND_ZH[candidate.kind]
    const due =
      candidate.dueAt > 0 ? ' · 到期 ' + new Date(candidate.dueAt).toLocaleString('zh-CN') : ''
    const cool =
      candidate.cooling
        ? ' · 冷却到 ' + new Date(candidate.cooledUntil).toLocaleString('zh-CN')
        : ''
    return (
      '（' +
      kind +
      '）' +
      candidate.text +
      ' · 强度 ' +
      candidate.weight.toFixed(2) +
      ' · 排序分 ' +
      candidate.score.toFixed(2) +
      due +
      cool
    )
  }

  /**
   * 清掉过期冷却条目。
   * @param at 时刻。
   */
  prune(at?: number): number {
    const stamp = at ?? this.now()
    const before = this.entries.length
    const next = pruneEntries(this.entries, stamp)
    const removed = before - next.length
    if (removed > 0) {
      this.entries = next
      this.persist()
    }
    return removed
  }

  /** 统计快照。 */
  stats(): ReasonStats {
    return Object.freeze({
      plans: this.counters.plans,
      picks: this.counters.picks,
      allCooling: this.counters.allCooling,
      marks: this.counters.marks,
      noted: this.counters.noted,
      cooling: this.entries.length,
      byKind: Object.freeze({ ...this.counters.byKind }),
      writes: this.counters.writes,
      writeFailures: this.counters.writeFailures,
      stored: this.persisted,
    })
  }

  /* ---------------------------- 内部 ---------------------------- */

  /** 算一次（不碰计数、不碰冷却）。 */
  private compute(input: ReasonInput, at: number): Computed {
    if (!this.settings.enable) {
      return {
        at,
        code: 'disabled',
        candidates: Object.freeze([]),
        pick: undefined,
        sources: Object.freeze({ gap: false, promise: false, emotion: false, caller: false }),
      }
    }

    let seeds: readonly CandidateSeed[] = []
    let sources: SourceStatus = Object.freeze({
      gap: false,
      promise: false,
      emotion: false,
      caller: false,
    })

    try {
      const collected = collect(input, at, this.deps)
      seeds = collected.seeds
      sources = collected.sources
    } catch (error) {
      this.counters.errors += 1
      this.log.error(
        '收集话由失败（本轮按「没有话由」处理）：%s',
        error instanceof Error ? error.message : String(error),
      )
      return {
        at,
        code: 'no-candidate',
        candidates: Object.freeze([]),
        pick: undefined,
        sources,
      }
    }

    // 过期条目顺手清掉（不额外落盘：真正的落盘在记账时）。
    const entries = pruneEntries(this.entries, at)
    if (entries !== this.entries) this.entries = entries

    const candidates = rank(seeds, entries, at)
    const pick = pickOf(candidates)
    const code: PlanCode =
      candidates.length === 0 ? 'no-candidate' : pick === undefined ? 'all-cooling' : 'ok'
    return { at, code, candidates, pick, sources }
  }

  /** 解析状态文件路径。 */
  private resolveFile(): string | undefined {
    const path = this.path()
    if (path === undefined) return undefined
    try {
      const file = path.fileIn('user', 'proactive-reason.json')
      path.prepareFile(file)
      return file
    } catch (error) {
      this.log.warn(
        '话由冷却表不可用，退回纯内存：%s',
        error instanceof Error ? error.message : String(error),
      )
      return undefined
    }
  }

  /** 写盘。失败只告警一次，不刷屏。 */
  private persist(): boolean {
    if (this.file === undefined) {
      this.persisted = false
      return false
    }
    const ok = writeCooldown(this.file, this.entries)
    if (ok) {
      this.counters.writes += 1
      this.persisted = true
      return true
    }
    this.counters.writeFailures += 1
    this.persisted = false
    if (!this.warnedWrite) {
      this.warnedWrite = true
      this.log.warn(
        '话由冷却表写盘失败（%s）：冷却只在内存里，重启后同一件事会被重提。后续同类失败不再重复告警',
        this.file,
      )
    }
    return false
  }
}

/** 服务键（导出便于自检与消费方断言）。 */
export const SERVICE_KEY = REASON_SERVICE_KEY
