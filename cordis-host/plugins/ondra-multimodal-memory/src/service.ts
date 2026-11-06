/**
 * 入库流水线：**草稿 → 记忆内核 → 边表**。
 *
 * ## 顺序是设计，不是随手排的
 *
 * ```
 * 开关 → 内核在位 → 归一化 → 墓碑 → 去重 → 证据门控 → 截断 → 写记忆 → 写边表
 * ```
 *
 * 五处顺序有理由，改动前请先读：
 *
 * 1. **墓碑在去重之前，而且要判两段。** 反过来的话，用户要求忘记的那条记忆还在
 *    墓碑里、边表行可能还在，去重会命中并回一句「已经记过了」——用户以为忘了，
 *    系统说「我记着」。**先问「这段是不是被要求忘记过」，再问「是不是已经有」。**
 *
 *    两段是因为**墓碑的摘要是按「落库那一版正文」算的**（见 O-010 的 `forget()`：
 *    `digest = digestOf(row.text)`），而本包会把正文截到 200 字。所以：
 *    - 第一段（去重前）按「这次大概会落库的那一版」= 截断后的全文判；
 *    - 第二段（写入前）按「过完证据闸、真正要写进去的那一版」再判一次。
 *    只判全文会漏掉「被截断过的那条被忘了」的情况——那时同一张图再发一次，
 *    正文不同、摘要不同、墓碑判不中，忘掉的内容就复活了。
 * 2. **去重在门控之前。** 门控会做逐字比对与数字覆盖，是不便宜的活；
 *    重复的草稿（同一张图被两个通道各描述一次）没必要跑两遍。
 * 3. **门控在截断之前。** 门控要按完整正文判「数字有没有出处」——
 *    先截断再判，被截掉的数字就查不到了，等于给幻觉开了一道后门。
 * 4. **写记忆在写边表之前。** 正文是主，元数据是辅。反过来的话，
 *    边表写成功、记忆写失败，就留下一条指向不存在记忆的孤儿行。
 * 5. **边表失败不回滚记忆。** 见下。
 *
 * ## 为什么边表写失败不回滚
 *
 * 两个失败方向的代价不对称：
 *
 * - 回滚：内容彻底消失，用户三天后问「我发你的截图」时什么都查不到；
 * - 不回滚：内容在库里能检索能注入，只是「来自哪张图」查不到。
 *
 * 手册 §2.4 的「只忘不删」是同一口气：**内容比元数据重要**。
 * 所以 `indexed: false` + `degraded: 'no-index'`，让这件事可查，而不是把记忆删掉。
 *
 * ## 为什么本包不设定时器、不装监听、不注册工具
 *
 * 它是**被调用方**：通道适配器收到文件才调它。装一个定时器去扫「有没有新图片」
 * 既没有目录可扫，也会在空闲时白耗电。零常驻是 O-143 那条纪律的同一方向。
 */

import { SUMMARY_MAX } from './settings.js'
import type { Config } from './settings.js'
import type {
  AsrLike,
  EvidenceGateLike,
  FramesResultLike,
  IngestOptions,
  IngestResult,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  MmCounters,
  MmEntry,
  MmQuery,
  MmReason,
  MmStats,
  Modality,
  MultimodalDraft,
  MultimodalMemoryService,
  VideoIngestInput,
  VideoIngestResult,
  VisionLike,
} from './types.js'
import type { MmIndex } from './table.js'
import {
  composeFramesText,
  defaultCategoryOf,
  defaultKindOf,
  evidenceSourceOf,
  normalizeDraft,
} from './draft.js'
import { charsOf, clip, fingerprintOf, messageOf, squeeze, titleOf } from './text.js'

/** 视频正文的兜底标题前缀。 */
const VIDEO_TITLE_PREFIX = '视频画面'

/** 依赖注入面（全部是 getter：装载顺序不定，取值必须晚于装载）。 */
export interface MmDeps {
  /** 当前生效配置。 */
  readonly settings: () => Config
  readonly log: LogLike
  /** 时间源。 */
  readonly now: () => number
  /** 记忆内核（缺席即 `no-core`）。 */
  readonly core: () => MemoryCoreLike | undefined
  /** 证据门控（缺席即不过闸，记降级）。 */
  readonly gate: () => EvidenceGateLike | undefined
  /** 边表（缺席即只写记忆）。 */
  readonly index: () => MmIndex | undefined
  /** 视觉（视频合成用）。 */
  readonly vision: () => VisionLike | undefined
  /** 语音转写（视频音轨用）。 */
  readonly asr: () => AsrLike | undefined
}

/** 一条计数器（可变，快照时拷贝）。 */
interface MutableCounters {
  drafts: number
  ingested: number
  duplicates: number
  tombstoned: number
  rejected: number
  seeded: number
  failed: number
  videoRuns: number
}

/** 全零计数。 */
function zeroCounters(): MutableCounters {
  return {
    drafts: 0,
    ingested: 0,
    duplicates: 0,
    tombstoned: 0,
    rejected: 0,
    seeded: 0,
    failed: 0,
    videoRuns: 0,
  }
}

/** 多模态记忆。 */
export class MultimodalMemory implements MultimodalMemoryService {
  private readonly deps: MmDeps

  private disposed = false
  private readonly counters: MutableCounters = zeroCounters()
  private readonly byReason: Record<string, number> = {}
  private lastOkAt = 0
  private lastError: MmReason | undefined

  /**
   * @param deps 依赖面。
   */
  constructor(deps: MmDeps) {
    this.deps = deps
  }

  /** 服务能不能工作：开关 + 记忆内核。 */
  get available(): boolean {
    if (this.disposed) return false
    if (!this.deps.settings().enable) return false
    const core = this.deps.core()
    return core !== undefined && core.available
  }

  /** 不能工作的原因。 */
  get reason(): MmReason | undefined {
    if (this.disposed) return 'disposed'
    if (!this.deps.settings().enable) return 'disabled'
    const core = this.deps.core()
    if (core === undefined || !core.available) return 'no-core'
    return undefined
  }

  /**
   * 把一份草稿入库。
   * @param draft 草稿。
   * @param options 记忆域判断。
   */
  ingest(draft: MultimodalDraft, options?: IngestOptions): IngestResult {
    const started = this.deps.now()
    const settings = this.deps.settings()

    if (this.disposed) {
      return this.fail('disposed', '', started, '服务已卸载')
    }
    if (!settings.enable) {
      return this.fail('disabled', '', started, '配置里关着')
    }

    const core = this.deps.core()
    if (core === undefined || !core.available) {
      return this.fail('no-core', '', started, '没有可用的 ondra-memory-core，本包不自己存记忆')
    }

    const normalized = normalizeDraft(draft, this.deps.now(), settings)
    if (!normalized.ok) {
      return this.fail(normalized.reason, '', started, normalized.detail)
    }
    const item = normalized.draft
    this.counters.drafts += 1

    try {
      return this.write(core, item, options, started, normalized.notes)
    } catch (error) {
      // 兜底：任何没被内层接住的异常都不许冒泡（调用方站在消息回调路径上）。
      return this.fail('write-failed', item.fingerprint, started, `内部异常：${messageOf(error)}`)
    }
  }

  /**
   * 批量入库。
   * @param drafts 草稿列表。
   * @param options 记忆域判断。
   */
  ingestMany(
    drafts: readonly MultimodalDraft[],
    options?: IngestOptions,
  ): readonly IngestResult[] {
    const out: IngestResult[] = []
    for (const draft of drafts) out.push(this.ingest(draft, options))
    return out
  }

  /**
   * 视频 → 帧条目 + 音轨条目。
   *
   * **不做的事**：不抽帧（问 O-126）、不转写（问 O-127）、不分离音轨
   * （那需要第三个地方再写一遍解码调用，违反 §1.8）。本包只负责把两边的
   * 产物拼成两条记忆，并如实报「哪一半没拼上」。
   * @param input 入参。
   */
  async ingestVideo(input: VideoIngestInput): Promise<VideoIngestResult> {
    const started = this.deps.now()
    const settings = this.deps.settings()

    if (this.disposed) return this.videoFail('disposed', started, '服务已卸载')
    if (!settings.enable) return this.videoFail('disabled', started, '配置里关着')

    const path = typeof input?.path === 'string' ? input.path.trim() : ''
    if (path === '') return this.videoFail('bad-path', started, 'path 是空的')

    const vision = this.deps.vision()
    if (vision === undefined || !vision.available) {
      return this.videoFail('no-vision', started, '没有可用的 ondra-vision，抽不了帧')
    }

    this.counters.videoRuns += 1
    const want = input.frameCount ?? settings.videoFrames
    const count = Number.isFinite(want) ? Math.max(1, Math.min(settings.videoFrames, Math.trunc(want))) : settings.videoFrames

    const entries: IngestResult[] = []
    let framesResult: FramesResultLike
    try {
      framesResult = await vision.frames({ path, count })
    } catch (error) {
      return this.videoFail('no-frames', started, `抽帧抛错：${messageOf(error)}`)
    }
    if (!framesResult.ok || framesResult.frames.length === 0) {
      return this.videoFail(
        'no-frames',
        started,
        `抽帧失败（${framesResult.reason}）${framesResult.detail === undefined ? '' : `：${framesResult.detail}`}`,
      )
    }

    const framePaths = framesResult.frames.slice(0, count)
    const descriptions: string[] = []
    if (settings.videoDescribeFrames) {
      for (const frame of framePaths) {
        try {
          const described = await vision.describe({ path: frame })
          descriptions.push(described.ok ? described.text : '')
        } catch {
          // 单帧描述失败不影响整条：少一帧描述比整段视频不入库好。
          descriptions.push('')
        }
      }
    }

    const videoText = composeFramesText(framePaths, descriptions)
    const describedCount = descriptions.filter(text => squeeze(text) !== '').length
    const videoDraft: MultimodalDraft = {
      modality: 'video',
      sourcePath: path,
      text: videoText,
      title: clip(`${VIDEO_TITLE_PREFIX} ${framePaths.length} 帧`, settings.maxTitleChars).text,
      at: this.deps.now(),
      provider: 'ondra-vision',
      chars: charsOf(videoText),
      truncated: false,
      fingerprint: fingerprintOf('video', path, videoText),
      frames: framePaths,
      ...(settings.videoDescribeFrames && describedCount < framePaths.length
        ? { degraded: `frames-undescribed:${framePaths.length - describedCount}` }
        : {}),
    }
    entries.push(this.ingest(videoDraft, input.options))

    if (input.audioPath !== undefined && input.audioPath !== '') {
      const asr = this.deps.asr()
      if (asr === undefined || !asr.available) {
        entries.push(this.fail('no-asr', '', this.deps.now(), '给了音轨但没有可用的 ondra-asr'))
      } else {
        try {
          const transcript = await asr.transcribe({ path: input.audioPath })
          if (!transcript.ok || squeeze(transcript.text) === '') {
            entries.push(
              this.fail(
                'no-audio',
                '',
                this.deps.now(),
                `转写失败（${transcript.reason}）${transcript.detail === undefined ? '' : `：${transcript.detail}`}`,
              ),
            )
          } else {
            const audioDraft: MultimodalDraft = {
              modality: 'audio',
              sourcePath: input.audioPath,
              text: transcript.text,
              title: titleOf(transcript.text, settings.maxTitleChars),
              at: this.deps.now(),
              provider: 'ondra-asr',
              ...(transcript.model === undefined ? {} : { model: transcript.model }),
              chars: charsOf(transcript.text),
              truncated: false,
              fingerprint: fingerprintOf('audio', input.audioPath, transcript.text),
              ...(transcript.spans.length === 0 ? {} : { spans: transcript.spans }),
            }
            entries.push(this.ingest(audioDraft, input.options))
          }
        } catch (error) {
          entries.push(this.fail('no-audio', '', this.deps.now(), `转写抛错：${messageOf(error)}`))
        }
      }
    }

    const ok = entries.some(entry => entry.ok)
    const firstFailure = entries.find(entry => !entry.ok)
    return {
      ok,
      reason: ok ? 'ok' : (firstFailure?.reason ?? 'write-failed'),
      entries,
      ...(ok
        ? {}
        : { detail: firstFailure?.detail ?? '一条都没入库' }),
      elapsedMs: Math.max(0, this.deps.now() - started),
    }
  }

  /**
   * 按记忆 id 取边表行。
   * @param factId 记忆 id。
   */
  get(factId: string): MmEntry | undefined {
    if (this.disposed || typeof factId !== 'string' || factId === '') return undefined
    const index = this.deps.index()
    return index === undefined ? undefined : index.byFactId(factId)
  }

  /**
   * 按记忆 id 取留档的全文。
   * @param factId 记忆 id。
   */
  fullText(factId: string): string | undefined {
    if (this.disposed || typeof factId !== 'string' || factId === '') return undefined
    const index = this.deps.index()
    return index === undefined ? undefined : index.fullTextOf(factId)
  }

  /**
   * 查边表。
   * @param query 条件。
   */
  list(query?: MmQuery): readonly MmEntry[] {
    if (this.disposed) return []
    const index = this.deps.index()
    return index === undefined ? [] : index.list(query)
  }

  /**
   * 按指纹查。
   * @param fingerprint 指纹。
   */
  seen(fingerprint: string): MmEntry | undefined {
    if (this.disposed || typeof fingerprint !== 'string' || fingerprint === '') return undefined
    const index = this.deps.index()
    return index === undefined ? undefined : index.byFingerprint(fingerprint)
  }

  /** 统计快照。 */
  stats(): MmStats {
    const core = this.deps.core()
    const index = this.deps.index()
    const coreProvider = (() => {
      if (core === undefined) return ''
      try {
        return core.stats().provider
      } catch {
        return ''
      }
    })()

    return {
      available: this.available,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      indexed: index !== undefined && index.available,
      rows: index === undefined ? 0 : index.count(),
      coreProvider,
      storeProvider: index === undefined ? '' : index.provider,
      counters: { ...this.counters } satisfies MmCounters,
      byReason: { ...this.byReason },
      lastOkAt: this.lastOkAt,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /** 卸载（幂等）。 */
  dispose(): void {
    this.disposed = true
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 真正的写入。调用方已保证 `item` 是归一化后的草稿、内核在位。
   * @param core 记忆内核。
   * @param item 归一化草稿。
   * @param options 记忆域判断。
   * @param started 起始时刻。
   * @param notes 归一化阶段的降级说明。
   */
  private write(
    core: MemoryCoreLike,
    item: MultimodalDraft,
    options: IngestOptions | undefined,
    started: number,
    notes: readonly string[],
  ): IngestResult {
    const settings = this.deps.settings()
    const index = this.deps.index()
    const degraded: string[] = []
    if (item.degraded !== undefined && item.degraded !== '') degraded.push(item.degraded)
    for (const note of notes) if (!degraded.includes(note)) degraded.push(note)

    // ① 墓碑（第一段）：用户要求忘记过的内容，不许靠「再发一次同一张图」复活。
    //
    // 判的是**截断后**的正文：墓碑摘要是按落库那一版算的，拿全文去比，
    // 被截断过的那条永远判不中（这是本包最容易漏的一个坑）。
    const storedGuess = clip(item.text, settings.maxTextChars).text
    if (settings.respectTombstone) {
      const first = this.tombstoned(core, storedGuess)
      if (first === 'error') degraded.push('tombstone-unchecked')
      if (first === 'hit') {
        return this.fail('tombstoned', item.fingerprint, started, '这段内容被要求忘记过（墓碑命中），不再入库')
      }
      if (storedGuess !== item.text) {
        // 全文也判一次：上一版可能是「没被截断」就落库的（用户改过 max-text-chars）。
        const second = this.tombstoned(core, item.text)
        if (second === 'error') {
          if (!degraded.includes('tombstone-unchecked')) degraded.push('tombstone-unchecked')
        }
        if (second === 'hit') {
          return this.fail('tombstoned', item.fingerprint, started, '这段内容被要求忘记过（墓碑命中），不再入库')
        }
      }
    }

    // ② 去重：按指纹。边表不可用时无法判重，只能放行（记降级）。
    if (settings.dedupe) {
      if (index === undefined || !index.available) {
        if (!degraded.includes('no-index')) degraded.push('no-index')
      } else {
        const hit = index.byFingerprint(item.fingerprint)
        if (hit !== undefined) {
          this.counters.duplicates += 1
          this.bump('duplicate')
          return {
            ok: true,
            reason: 'duplicate',
            factId: hit.factId,
            duplicateOf: hit.factId,
            fingerprint: item.fingerprint,
            chars: hit.chars,
            truncated: hit.truncated,
            indexed: true,
            elapsedMs: Math.max(0, this.deps.now() - started),
          }
        }
      }
    }

    // ③ 证据门控（手册 §2.2「无出处不入库」）。
    const source = evidenceSourceOf(item.modality)
    let body = item.text
    let summary = options?.summary ?? item.title
    const gate = this.deps.gate()
    if (settings.useEvidenceGate) {
      if (gate === undefined || !gate.available) {
        degraded.push('no-gate')
      } else {
        try {
          const verdict = gate.judge({
            text: body,
            summary,
            subject: options?.subject ?? settings.defaultSubject,
            evidence: [{ source, quote: body }],
            materials: [{ text: body, source }],
            channel: 'multimodal',
            at: item.at,
          })
          if (verdict.action === 'reject') {
            this.counters.rejected += 1
            this.bump('rejected')
            return this.fail(
              'rejected',
              item.fingerprint,
              started,
              `证据门控拒绝：${verdict.reasons.map(reason => reason.code).join('/') || '未给原因'}`,
            )
          }
          if (verdict.action === 'seed') {
            this.counters.seeded += 1
            this.bump('seeded')
            return this.fail(
              'seeded',
              item.fingerprint,
              started,
              '证据门控判为种子（只有 SELF 引文）；本包没有种子文件落点，故不入库',
            )
          }
          if (verdict.action === 'strip') degraded.push('gate-stripped')
          if (verdict.text !== '') body = verdict.text
          if (verdict.summary !== '') summary = verdict.summary
        } catch (error) {
          // 门控抛错：记降级并照常入库。门控自己的承诺是「永不抛错」，
          // 真抛了就说明它有 bug——但那条 bug 不该让用户的一张图消失。
          degraded.push('gate-error')
          this.deps.log.warn('证据门控抛错（照常入库，已记降级）：%s', messageOf(error))
        }
      }
    }

    // ④ 截断：条目 ≤200 字（手册 §2.2），全文留边表。
    const clipped = clip(body, settings.maxTextChars)
    const text = clipped.text
    if (squeeze(text) === '') {
      return this.fail('empty-text', item.fingerprint, started, '过闸后正文变成空的')
    }
    const truncated = item.truncated || clipped.truncated
    if (clipped.truncated) degraded.push('text-truncated')

    const summaryClipped = clip(squeeze(summary), SUMMARY_MAX).text

    // ④b 墓碑（第二段）：过完证据闸、截完断之后，正文可能已经不是刚才那一版了。
    //     这一段判的是**真正要写进去的那个字符串**——与 `forget()` 写墓碑时的
    //     摘要口径完全一致，所以它才是权威的那一次。
    if (settings.respectTombstone && text !== storedGuess) {
      const again = this.tombstoned(core, text)
      if (again === 'error') {
        if (!degraded.includes('tombstone-unchecked')) degraded.push('tombstone-unchecked')
      }
      if (again === 'hit') {
        return this.fail('tombstoned', item.fingerprint, started, '这段内容被要求忘记过（墓碑命中），不再入库')
      }
    }

    // ⑤ 写记忆。
    const input = {
      kind: options?.kind ?? defaultKindOf(item.modality, settings),
      category: options?.category ?? defaultCategoryOf(item.modality, settings),
      text,
      summary: summaryClipped === '' ? undefined : summaryClipped,
      subject: options?.subject ?? settings.defaultSubject,
      channel: options?.channel ?? settings.defaultChannel,
      ...(options?.salience === undefined ? {} : { salience: options.salience }),
      ...(options?.arousal === undefined ? {} : { arousal: options.arousal }),
      // 引文用**落库的那一版正文**：它才是这条记忆里逐字可查的东西。
      evidence: [{ source, quote: text }],
      at: options?.at ?? item.at,
    }
    let record: MemoryRecordLike
    try {
      record = core.addFact(input)
    } catch (error) {
      this.counters.failed += 1
      return this.fail('write-failed', item.fingerprint, started, `写记忆失败：${messageOf(error)}`)
    }

    // ⑥ 写边表（失败不回滚，见文件头）。
    let indexed = false
    if (index !== undefined) {
      const entry: MmEntry = {
        factId: record.id,
        modality: item.modality,
        sourcePath: item.sourcePath,
        fingerprint: item.fingerprint,
        title: item.title,
        provider: item.provider,
        model: item.model ?? null,
        chars: charsOf(text),
        fullChars: charsOf(item.text),
        truncated,
        frames: item.frames ?? [],
        spans: item.spans ?? [],
        boxes: item.boxes ?? [],
        degraded: degraded.length === 0 ? null : degraded.join(','),
        at: item.at,
        createdAt: this.deps.now(),
      }
      indexed = index.put(entry, clip(item.text, settings.maxFullChars).text)
      if (!indexed && !degraded.includes('no-index')) degraded.push('no-index')
    } else if (!degraded.includes('no-index')) {
      degraded.push('no-index')
    }

    // 后端不一致时提醒：边表在 A 库、记忆在 B 库，重启后边表行会指向不存在的记忆。
    if (indexed && index !== undefined) {
      try {
        const coreProvider = core.stats().provider
        if (coreProvider !== '' && index.provider !== '' && coreProvider !== index.provider) {
          degraded.push('provider-mismatch')
          this.deps.log.warn(
            '边表与记忆不在同一个后端（%s vs %s）：重启后「这条记忆来自哪张图」可能查不到',
            index.provider,
            coreProvider,
          )
        }
      } catch {
        // 读不到后端标识不影响这次写入。
      }
    }

    this.counters.ingested += 1
    this.lastOkAt = this.deps.now()
    this.bump('ok')

    if (settings.verbose) {
      this.deps.log.info(
        '多模态入库：%s %s → 记忆 %s（%d 字%s）',
        item.modality,
        item.provider,
        record.id,
        charsOf(text),
        indexed ? '' : '，边表未写入',
      )
    }

    return {
      ok: true,
      reason: 'ok',
      factId: record.id,
      fingerprint: item.fingerprint,
      chars: charsOf(text),
      truncated,
      indexed,
      ...(degraded.length === 0 ? {} : { degraded: degraded.join(',') }),
      elapsedMs: Math.max(0, this.deps.now() - started),
    }
  }

  /**
   * 记一次失败（统一出口：计数、最近原因、日志）。
   * @param reason 原因码。
   * @param fingerprint 指纹（可能为空）。
   * @param started 起始时刻。
   * @param detail 说明。
   */
  private fail(reason: MmReason, fingerprint: string, started: number, detail: string): IngestResult {
    // `disabled` / `disposed` 是状态不是失败：把它们计进 `failed`
    // 会让「面板上失败了 300 次」变成一个吓人但毫无意义的数字。
    if (reason !== 'disabled' && reason !== 'disposed') this.counters.failed += 1
    this.bump(reason)
    this.lastError = reason
    if (!this.deps.settings().quiet && reason !== 'disabled') {
      this.deps.log.warn('多模态入库未完成（%s）：%s', reason, detail)
    }
    return {
      ok: false,
      reason,
      fingerprint,
      chars: 0,
      truncated: false,
      indexed: false,
      detail,
      elapsedMs: Math.max(0, this.deps.now() - started),
    }
  }

  /**
   * 视频整批失败。
   * @param reason 原因码。
   * @param started 起始时刻。
   * @param detail 说明。
   */
  private videoFail(reason: MmReason, started: number, detail: string): VideoIngestResult {
    this.bump(reason)
    this.lastError = reason
    if (!this.deps.settings().quiet && reason !== 'disabled') {
      this.deps.log.warn('视频入库未完成（%s）：%s', reason, detail)
    }
    return {
      ok: false,
      reason,
      entries: [],
      detail,
      elapsedMs: Math.max(0, this.deps.now() - started),
    }
  }

  /**
   * 查墓碑。**三态**，不是布尔：
   *
   * - `hit`：确定被要求忘记过 → 拒绝；
   * - `miss`：确定没被忘记 → 放行；
   * - `error`：查不了 → 放行 + 记降级。
   *
   * 为什么 `error` 要放行：拦了会让一次库抖动变成「她永远记不住这张图」，
   * 而放行的代价是「可能复活一条」。手册 §2.4 的「只忘不删」倾向后者可逆：
   * 用户再说一次「忘掉」就能删掉，而一条从未存在的记忆补不回来。
   * @param core 记忆内核。
   * @param text 待判正文。
   */
  private tombstoned(core: MemoryCoreLike, text: string): 'hit' | 'miss' | 'error' {
    try {
      return core.tombstoned(text) ? 'hit' : 'miss'
    } catch (error) {
      this.deps.log.debug('墓碑查询失败（照常入库，已记降级）：%s', messageOf(error))
      return 'error'
    }
  }

  /**
   * 累计一个原因码。
   * @param reason 原因码。
   */
  private bump(reason: MmReason): void {
    this.byReason[reason] = (this.byReason[reason] ?? 0) + 1
  }
}

/** 便利：把一条来源的默认种类/类别取出来（给界面与自检读，避免它们各写一份）。 */
export function defaultsOf(modality: Modality, config: Config): { kind: string; category: string } {
  return { kind: defaultKindOf(modality, config), category: defaultCategoryOf(modality, config) }
}
