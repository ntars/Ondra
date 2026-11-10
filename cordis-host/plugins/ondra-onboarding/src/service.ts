/**
 * O-082 的服务实现：**状态机 + 判定 + 话术**。不渲染、不发送、不安装。
 *
 * ## 三个必须做对的点
 *
 * 1. **顺序即依赖。** 只能推进「当前段」。跳着走会让证据对不上：`open` 段要一个地址，
 *    而那个地址的端口是 `port` 段给的；先跳过去，只能编一个。
 * 2. **证据闸门。** `advance()` 不带证据直接拒。允许空着打勾，验收基线就变成一排
 *    空白勾选——那比没有引导更糟，因为它看起来像走完了。
 * 3. **进度、状态行、完成时刻都在 `#touch()` 一处更新。** 三处各写一次的话，
 *    「状态行记了但进度没记」这类不一致迟早出现，而验收正是拿这两样去判的。
 *
 * ## 为什么 `observeFirstMessage()` 只记录不发
 *
 * 发消息是对话层的事。本包如果自己去发，就绕过了人设、节奏、防封六道闸——
 * 一条「你好呀，我是鲸鲸」在群聊里发出去，后果比少一条引导严重得多。
 *
 * ## 永不抛
 *
 * 所有公开方法折成 `StepResult` / 视图。首启期间任何一步失败都该由界面显示出来，
 * 而不是让宿主在 `apply()` 之后收到一个未捕获的 rejection。
 */

import { acceptanceOf, firstMessageSpecOf, installerTitleOf } from './acceptance.js'
import { diagnoseOf } from './diagnose.js'
import {
  SEGMENTS,
  clamp01,
  currentOf,
  declOf,
  describeReason,
  doneCount,
  emptyRecords,
  isSegmentId,
  normalizeRecords,
  percentOf,
  phaseOf,
  statusLineOf,
  validateEvidence,
} from './segments.js'
import { STATE_VERSION } from './store.js'
import type { FileOnboardingStore } from './store.js'
import type { Config } from './settings.js'
import type {
  AcceptanceFacts,
  AcceptanceReport,
  DiagnoseFacts,
  Diagnosis,
  FirstMessageSpec,
  IdentityLike,
  InstallerTitle,
  LogLike,
  OnboardingReason,
  OnboardingService,
  OnboardingState,
  OnboardingStats,
  Phase,
  PortPickerLike,
  PortSuggestion,
  ProgressView,
  SegmentEvidence,
  SegmentId,
  SegmentRecord,
  SegmentView,
  StepResult,
} from './types.js'

/** 构造依赖。全部用函数取：身份与挑端口服务都可能晚于本插件就绪。 */
export interface OnboardingDeps {
  /** 当前配置。 */
  readonly settings: () => Config
  /** 日志。 */
  readonly log: LogLike
  /** 当前时刻（Unix 毫秒）。 */
  readonly now: () => number
  /** 状态落盘。 */
  readonly store: FileOnboardingStore
  /** O-001 身份（可能缺席）。 */
  readonly identity: () => IdentityLike | null
  /** O-083 挑端口（可能缺席）。 */
  readonly portPicker: () => PortPickerLike | null
}

/** 一轮首启的元信息（段记录单独放，避免两份真源）。 */
interface RunMeta {
  runId: string
  startedAt: number
  samples: number[];
  statusLines: string[];
  firstMessage?: OnboardingState['firstMessage']
  completedAt?: number
}

/** 采样上限：够验收判「动没动」，也不至于把状态文件写大。 */
const MAX_SAMPLES = 64

/** 状态行上限。 */
const MAX_LINES = 16

/** 首启引导服务。 */
export class Onboarding implements OnboardingService {
  readonly #deps: OnboardingDeps
  readonly #stats: { begins: number; advances: number; skips: number; failures: number; resets: number } = {
    begins: 0,
    advances: 0,
    skips: 0,
    failures: 0,
    resets: 0,
  }
  #records: Record<SegmentId, SegmentRecord>
  #run: RunMeta | undefined
  #disposed = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: OnboardingDeps) {
    this.#deps = deps
    const loaded = deps.store.read()
    if (loaded === null) {
      this.#records = emptyRecords()
      this.#run = undefined
      return
    }
    this.#records = normalizeRecords(loaded.segments)
    this.#run = {
      runId: loaded.runId,
      startedAt: loaded.startedAt,
      samples: [...loaded.samples],
      statusLines: [...loaded.statusLines],
      ...(loaded.firstMessage === undefined ? {} : { firstMessage: loaded.firstMessage }),
      ...(loaded.completedAt === undefined ? {} : { completedAt: loaded.completedAt }),
    }
  }

  get available(): boolean {
    return !this.#disposed && this.#deps.settings().enable
  }

  get reason(): OnboardingReason | undefined {
    if (this.#disposed) return 'disposed'
    return this.#deps.settings().enable ? undefined : 'disabled'
  }

  /**
   * 开一次首启。
   * @param options `restart: true` 强制重来。
   */
  begin(options?: { readonly restart?: boolean }): StepResult {
    const guard = this.#guard()
    if (guard !== null) return guard

    const restart = options?.restart === true
    if (this.#run !== undefined && !restart) {
      // 四段全完但 `completedAt` 没落上（旧文件 / 中途被杀）时也要认「已走完」，
      // 否则用户会被引导第二遍，而他已经配好了。
      if (this.#run.completedAt !== undefined || this.progress().phase === 'ready') {
        return this.#reject('already-done', this.progress())
      }
      // 有未完成的一轮：接着走，不重置。重置会把已经拿到的证据一起丢掉。
      return { ok: true, progress: this.progress(), detail: '接着上一轮未完成的首启' }
    }

    const now = this.#deps.now()
    this.#records = emptyRecords()
    this.#run = { runId: `run-${now.toString(36)}`, startedAt: now, samples: [], statusLines: [] }
    this.#stats.begins += 1

    const first = SEGMENTS[0].id
    this.#records[first] = { state: 'active', fraction: 0, at: now }
    const progress = this.#touch()
    this.#persist()
    if (this.#deps.settings().verbose) this.#deps.log.info('首启开始（第 1/4 段：%s）', declOf(first).title)
    return { ok: true, segment: this.#viewOf(first), progress }
  }

  /**
   * 推进当前段。**必须带证据。**
   * @param id 段 id。
   * @param evidence 证据。
   */
  advance(id: SegmentId, evidence?: SegmentEvidence): StepResult {
    const guard = this.#guard()
    if (guard !== null) return guard
    if (!isSegmentId(id)) return this.#reject('bad-segment', this.progress())
    if (this.#run === undefined) return this.#reject('not-started', this.progress())

    const current = currentOf(this.#records)
    const existing = this.#records[id]
    if (existing.state === 'done' || existing.state === 'skipped') {
      return this.#reject('already-done', this.progress(), `「${declOf(id).title}」已经算完了`)
    }
    if (current !== id) {
      return this.#reject(
        'out-of-order',
        this.progress(),
        `当前该做的是「${current === undefined ? '（没有）' : declOf(current).title}」`,
      )
    }

    const verdict = validateEvidence(id, evidence)
    if (!verdict.ok) {
      const reason: OnboardingReason = evidence === undefined ? 'no-evidence' : 'bad-evidence'
      return this.#reject(reason, this.progress(), verdict.detail)
    }

    const now = this.#deps.now()
    this.#records[id] = {
      state: 'done',
      fraction: 1,
      at: now,
      ...(evidence === undefined ? {} : { evidence }),
    }
    this.#stats.advances += 1
    this.#activateNext(now)
    const progress = this.#touch()
    this.#persist()
    if (this.#deps.settings().verbose) {
      this.#deps.log.info('首启推进：%s 完成，当前 %d%%', declOf(id).title, progress.percent)
    }
    return { ok: true, segment: this.#viewOf(id), progress }
  }

  /**
   * 跳过一段（只有可选段可跳）。
   * @param id 段 id。
   * @param detail 为什么跳。
   */
  skip(id: SegmentId, detail?: string): StepResult {
    const guard = this.#guard()
    if (guard !== null) return guard
    if (!isSegmentId(id)) return this.#reject('bad-segment', this.progress())
    if (this.#run === undefined) return this.#reject('not-started', this.progress())

    const decl = declOf(id)
    if (decl.required) return this.#reject('not-skippable', this.progress(), `「${decl.title}」是必需段`)

    const current = currentOf(this.#records)
    if (current !== id) {
      return this.#reject(
        'out-of-order',
        this.progress(),
        `当前该做的是「${current === undefined ? '（没有）' : declOf(current).title}」`,
      )
    }

    const now = this.#deps.now()
    this.#records[id] = {
      state: 'skipped',
      fraction: 1,
      at: now,
      ...(detail === undefined || detail.trim() === '' ? {} : { detail: detail.trim() }),
    }
    this.#stats.skips += 1
    this.#activateNext(now)
    const progress = this.#touch()
    this.#persist()
    return { ok: true, segment: this.#viewOf(id), progress }
  }

  /**
   * 把当前段标成失败（停下来，**不自动重试**）。
   * @param id 段 id。
   * @param detail 失败原因。
   */
  fail(id: SegmentId, detail: string): StepResult {
    const guard = this.#guard()
    if (guard !== null) return guard
    if (!isSegmentId(id)) return this.#reject('bad-segment', this.progress())
    if (this.#run === undefined) return this.#reject('not-started', this.progress())

    const now = this.#deps.now()
    const existing = this.#records[id]
    this.#records[id] = {
      state: 'failed',
      fraction: clamp01(existing.fraction),
      at: now,
      ...(detail.trim() === '' ? {} : { detail: detail.trim() }),
    }
    this.#stats.failures += 1
    const progress = this.#touch()
    this.#persist()
    return { ok: true, segment: this.#viewOf(id), progress }
  }

  progress(): ProgressView {
    const phase: Phase = phaseOf(this.#records)
    const current = currentOf(this.#records)
    return {
      percent: percentOf(this.#records),
      phase,
      statusLine: statusLineOf(phase, current),
      ...(current === undefined ? {} : { current }),
      done: doneCount(this.#records),
      total: SEGMENTS.length,
    }
  }

  segments(): readonly SegmentView[] {
    return SEGMENTS.map(decl => this.#viewOf(decl.id))
  }

  /**
   * 跑五条验收。
   * @param facts 外部补充事实。
   */
  acceptance(facts: AcceptanceFacts = {}): AcceptanceReport {
    const run = this.#run
    return acceptanceOf({
      title: this.title(),
      records: this.#records,
      samples: run === undefined ? [] : run.samples,
      statusLines: run === undefined ? [] : run.statusLines,
      firstMessage: run === undefined ? undefined : run.firstMessage,
      facts,
    })
  }

  /**
   * 新手坑诊断。
   * @param facts 事实。
   */
  diagnose(facts: DiagnoseFacts): readonly Diagnosis[] {
    return diagnoseOf(facts, this.#deps.settings().requiredNodeMajor)
  }

  title(): InstallerTitle {
    return installerTitleOf(this.#deps.identity())
  }

  /**
   * 首条消息规格。
   * @param personaName 当前人设名。
   */
  firstMessage(personaName?: string): FirstMessageSpec {
    return firstMessageSpecOf(personaName)
  }

  /**
   * 记录首条消息。
   * @param input 文案与发起方。
   */
  observeFirstMessage(input: {
    readonly text: string
    readonly initiative?: 'persona' | 'user' | 'unknown'
  }): boolean {
    if (this.#disposed) return false
    const run = this.#run
    if (run === undefined) return false
    // 只记第一条：第二条开始就不是「首条消息」了，覆盖会让验收变成「最后一次说得对」。
    if (run.firstMessage !== undefined) return false
    const text = input.text.trim()
    if (text === '') return false
    run.firstMessage = {
      text,
      initiative: input.initiative === 'persona' || input.initiative === 'user' ? input.initiative : 'unknown',
      at: this.#deps.now(),
    }
    this.#persist()
    return true
  }

  /**
   * 给要启动的服务要一个空闲号（`listener` 意图）。
   */
  async suggestPort(): Promise<PortSuggestion> {
    return await this.#suggest('listener')
  }

  /**
   * 取界面在哪个号上（`endpoint` 意图）。
   */
  async suggestEndpoint(): Promise<PortSuggestion> {
    return await this.#suggest('endpoint')
  }

  state(): OnboardingState | undefined {
    const run = this.#run
    if (run === undefined) return undefined
    return Object.freeze({
      version: STATE_VERSION,
      runId: run.runId,
      startedAt: run.startedAt,
      segments: Object.freeze({ ...this.#records }),
      samples: Object.freeze([...run.samples]),
      statusLines: Object.freeze([...run.statusLines]),
      ...(run.firstMessage === undefined ? {} : { firstMessage: run.firstMessage }),
      ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    })
  }

  stats(): OnboardingStats {
    return Object.freeze({
      begins: this.#stats.begins,
      advances: this.#stats.advances,
      skips: this.#stats.skips,
      failures: this.#stats.failures,
      resets: this.#stats.resets,
    })
  }

  reset(): void {
    this.#records = emptyRecords()
    this.#run = undefined
    this.#stats.resets += 1
    this.#deps.store.clear()
  }

  dispose(): void {
    this.#disposed = true
  }

  /**
   * 卸载 / 关闭时的统一守卫。
   */
  #guard(): StepResult | null {
    if (this.#disposed) return this.#reject('disposed', this.progress())
    if (!this.#deps.settings().enable) return this.#reject('disabled', this.progress())
    return null
  }

  /**
   * 把下一个 `pending` 段点亮成 `active`。
   * @param now 当前时刻。
   */
  #activateNext(now: number): void {
    const next = currentOf(this.#records)
    if (next === undefined) return
    if (this.#records[next].state !== 'pending') return
    this.#records[next] = { state: 'active', fraction: 0, at: now }
  }

  /**
   * **唯一**更新进度读数、状态行、完成时刻的地方。
   */
  #touch(): ProgressView {
    const progress = this.progress()
    const run = this.#run
    if (run === undefined) return progress

    const last = run.samples.length === 0 ? -1 : run.samples[run.samples.length - 1]
    if (progress.percent !== last) {
      run.samples.push(progress.percent)
      if (run.samples.length > MAX_SAMPLES) run.samples.splice(0, run.samples.length - MAX_SAMPLES)
    }

    if (!run.statusLines.includes(progress.statusLine)) {
      run.statusLines.push(progress.statusLine)
      if (run.statusLines.length > MAX_LINES) run.statusLines.splice(0, run.statusLines.length - MAX_LINES)
    }

    if (progress.phase === 'ready' && run.completedAt === undefined) {
      run.completedAt = this.#deps.now()
    }
    return progress
  }

  /**
   * 落盘。写不进去只 warn，不影响本次运行（`store` 内部已做）。
   */
  #persist(): void {
    const snapshot = this.state()
    if (snapshot === undefined) return
    this.#deps.store.write(snapshot)
  }

  /**
   * 一段的视图。
   * @param id 段 id。
   */
  #viewOf(id: SegmentId): SegmentView {
    const decl = declOf(id)
    return { ...decl, ...this.#records[id] }
  }

  /**
   * 造一个失败结果（`failures` 只在这里加）。
   * @param reason 原因码。
   * @param progress 进度快照。
   * @param detail 补充事实。
   */
  #reject(reason: OnboardingReason, progress: ProgressView, detail?: string): StepResult {
    this.#stats.failures += 1
    const action = describeReason(reason)
    return {
      ok: false,
      progress,
      reason,
      detail: detail === undefined ? action : `${detail}；${action}`,
    }
  }

  /**
   * 走 O-083 要一个号。**永不抛**。
   * @param intent 意图。
   */
  async #suggest(intent: 'listener' | 'endpoint'): Promise<PortSuggestion> {
    const picker = this.#deps.portPicker()
    if (picker === null) {
      return {
        ok: false,
        reason: 'no-picker',
        detail: '没有 `ondra-port-picker`：装它才能挑端口，或由调用方自己决定端口',
      }
    }
    try {
      const outcome = await picker.pick({ intent, purpose: 'onboarding' })
      if (!outcome.ok) {
        return {
          ok: false,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        }
      }
      const picked = outcome.picked
      if (picked === undefined) {
        return { ok: false, reason: 'no-picked', detail: '挑端口服务说成功，但没给出号（契约不一致）' }
      }
      return {
        ok: true,
        port: picked.port,
        host: picked.host,
        ...(picked.race === undefined ? {} : { race: picked.race }),
        ...(picked.source === undefined ? {} : { source: picked.source }),
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.#deps.log.warn('向 ondra-port-picker 要端口时抛异常（已折成失败）：%s', text)
      return { ok: false, reason: 'picker-error', detail: text }
    }
  }
}
