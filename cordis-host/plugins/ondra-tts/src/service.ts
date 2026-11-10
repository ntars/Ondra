/**
 * 语音合成服务：选路 → 净化 → 查缓存 → 合成 → 落盘 → 播放。
 *
 * ## 顺序为什么是这样
 *
 * ```
 * 开关 → 净化 → 长度 → 音色 → 选路 → 缓存 → 合成 → 播放
 * ```
 *
 * - **净化在前**：长度必须按「真正会念的字数」算。一段 200 字的代码块
 *   净化完可能只剩 12 个字，先判长度会把一句能念的话拒掉。
 * - **音色在选路前**：音色不认识是配置错，与「哪条通道」无关；
 *   先选路会让 `no-engine` 盖住 `voice-unknown`，用户改完音色还是不出声，
 *   而且看不出是音色写错了。
 * - **缓存在合成前**：同一句话第二次念，不该再起一个进程。
 *
 * ## 并发去重只做在合成层
 *
 * 面板「试听」与对话链可能同时要同一句。去重让引擎只跑一次。
 * 但**播放不去重**：两个调用方各要一次声音，各播一次是对的。
 *
 * ## 为什么 `stats().cacheFiles` 是一个缓存值
 *
 * `stats()` 是同步读数（面板每帧都可能读），而 `readdir` 是异步的。
 * 把 Promise 放进去，面板只能显示「加载中」。因此这个数在
 * 「装载 / 合成成功 / 清缓存」三处刷新，读的时候直接给。
 */

import {
  cacheKey,
  cachePath,
  clearCache,
  listEntries,
  partPath,
  promote,
  prune,
  readEntry,
  removeFile,
} from './cache.js'
import { charCount, speakable as sanitize } from './speakable.js'
import { PRESETS, VOICES, isVoiceId, presetOf as presetById } from './voices.js'
import { RATE_MAX, RATE_MIN } from './settings.js'
import type { Config } from './settings.js'
import type { Player } from './player.js'
import type {
  EngineChoice,
  EngineName,
  LogLike,
  PresetId,
  PresetView,
  ProbeReport,
  SpeakOptions,
  SpeechEngine,
  TtsReason,
  TtsService,
  TtsStats,
  Utterance,
  VoiceView,
} from './types.js'

/** 一次构建出来的「当前可用能力」。`probe()` 会重建它。 */
export interface EngineSet {
  readonly engines: readonly SpeechEngine[]
  readonly player: Player
}

/** 服务依赖。全部是不可变值或工厂，避免持有会变的上游句柄。 */
export interface TtsDeps {
  readonly settings: Config
  readonly log: LogLike
  /** 缓存目录（已确保存在）。 */
  readonly cacheDir: string
  /** 重建通道集合（装完 CLI 后 `probe()` 用它）。 */
  readonly build: () => EngineSet
  /** 当前时刻。走 O-003 的 `now()`。 */
  readonly now: () => number
}

/** 选路结果。 */
interface Pick {
  readonly engine?: SpeechEngine
  readonly reason?: TtsReason
}

/** 通道 → 音频后缀。**唯一映射**，缓存路径与分支实现共用同一张表。 */
const EXT_OF: Readonly<Record<EngineName, 'wav' | 'mp3'>> = Object.freeze({
  'gpt-sovits': 'wav',
  'macos-say': 'wav',
  'edge-tts': 'mp3',
})

/**
 * 这条通道能不能吃到语速值。
 *
 * GPT-SoVITS 的 `api_v2` 只有与音色耦合的 `speed_factor`，本插件不猜它的口径，
 * 因此该分支恒为 `false`——面板要能看见「设了语速但这次没生效」。
 * @param engine 通道名。
 */
function rateAppliedOf(engine: EngineName): boolean {
  return engine !== 'gpt-sovits'
}

/** 夹一个语速增量（精度到 0.01，再细没有意义）。 */
function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(value * 100) / 100))
}

/** 语音合成服务实现。 */
export class Tts implements TtsService {
  private readonly deps: TtsDeps

  private current: EngineSet

  /** 进行中的合成（按缓存键去重）。 */
  private readonly inflight = new Map<string, Promise<Utterance>>()

  private calls = 0
  private okCount = 0
  private failures = 0
  private cachedHits = 0
  private playedCount = 0
  private lastOkAt = 0
  private lastError: TtsReason | undefined
  private cacheCount = 0

  constructor(deps: TtsDeps) {
    this.deps = deps
    this.current = deps.build()
    // 装载时数一次已有缓存：否则面板上「缓存 0 个」会一直挂到第一句话合成完。
    void listEntries(deps.cacheDir).then(entries => {
      this.cacheCount = entries.length
      return undefined
    })
  }

  /* ---------------------------------------------------------------- *
   * 选路
   * ---------------------------------------------------------------- */

  private engineNamed(name: EngineName): SpeechEngine | undefined {
    return this.current.engines.find(engine => engine.name === name)
  }

  /**
   * 选一条通道。
   *
   * `auto` 按 `ENGINE_NAMES` 的顺序（= 手册 §9.4 的优先级）取第一条
   * 「存在且配置齐」的；显式指定时**不再回退**——用户点的是那一条，
   * 悄悄换成别的等于面板在说谎。
   */
  private pick(): Pick {
    const settings = this.deps.settings
    if (!settings.enable) return { reason: 'disabled' }

    if (settings.provider === 'auto') {
      for (const engine of this.current.engines) {
        if (engine.present && engine.configured) return { engine }
      }
      return { reason: 'no-engine' }
    }

    const chosen = this.engineNamed(settings.provider)
    if (chosen === undefined) return { reason: 'no-engine' }
    if (!chosen.configured) return { reason: 'not-configured' }
    if (!chosen.present) return { reason: 'no-engine' }
    return { engine: chosen }
  }

  get available(): boolean {
    return this.pick().engine !== undefined
  }

  get reason(): TtsReason | undefined {
    return this.pick().reason
  }

  get engine(): EngineChoice {
    return this.pick().engine?.name ?? 'none'
  }

  /* ---------------------------------------------------------------- *
   * 表
   * ---------------------------------------------------------------- */

  voices(): readonly VoiceView[] {
    return VOICES
  }

  presets(): readonly PresetView[] {
    return PRESETS
  }

  presetOf(id: string): PresetView | undefined {
    return presetById(id)
  }

  /** 可朗读净化：与 `synth()` 内部同一份实现，供闸门按真实字数判定。 */
  speakable(text: string): string {
    return sanitize(text)
  }

  /* ---------------------------------------------------------------- *
   * 合成
   * ---------------------------------------------------------------- */

  async speak(text: string, options: SpeakOptions = {}): Promise<Utterance> {
    const utterance = await this.synth(text, options)
    if (!utterance.ok || utterance.audioPath === undefined) return utterance
    if (options.play === false || this.deps.settings.playback === 'off') return utterance

    const played = await this.current.player.play(utterance.audioPath)
    if (played) {
      this.playedCount += 1
      return Object.freeze({ ...utterance, played: true })
    }
    // 播不出来不是合成失败：音频还在缓存里，面板可以重播。
    // `ok` 仍为 true（音频可用），`reason` 记成 `playback` 让面板能说出真相。
    if (this.deps.settings.verbose) {
      this.deps.log.warn('音频已合成但播不出来（%s）：检查系统输出设备', utterance.audioPath)
    }
    return Object.freeze({ ...utterance, reason: 'playback' as TtsReason })
  }

  async synth(text: string, options: SpeakOptions = {}): Promise<Utterance> {
    const at = options.at ?? this.deps.now()
    this.calls += 1

    const settings = this.deps.settings
    if (!settings.enable) return this.fail('disabled', at, '', 'none', 0)

    const cleaned = sanitize(text)
    if (cleaned === '') return this.fail('empty', at, '', 'none', 0)
    if (charCount(cleaned) > settings.maxChars) return this.fail('too-long', at, cleaned, 'none', 0)

    // 音色：显式 > 预设（参数里的，其次是配置里的）。
    let voice = ''
    let preset: PresetId | undefined
    if (options.voice !== undefined && options.voice !== '') {
      if (!isVoiceId(options.voice)) return this.fail('voice-unknown', at, cleaned, 'none', 0)
      voice = options.voice
    } else {
      const found = presetById(options.preset ?? settings.preset)
      if (found === undefined) return this.fail('voice-unknown', at, cleaned, 'none', 0)
      preset = found.id
      // 配置里钉了音色就优先用它；但钉的那个必须认识，否则如实报错。
      if (settings.voice !== '') {
        if (!isVoiceId(settings.voice)) return this.fail('voice-unknown', at, cleaned, 'none', 0)
        voice = settings.voice
      } else {
        voice = found.voice
      }
    }

    const rate = clampRate(options.rate ?? settings.rate)
    const volume = options.volume ?? settings.volume

    const pick = this.pick()
    if (pick.engine === undefined) return this.fail(pick.reason ?? 'no-engine', at, cleaned, 'none', rate)
    const engine = pick.engine

    const ext = EXT_OF[engine.name]
    const key = cacheKey([this.cacheIdentity(engine.name, voice), String(rate), volume, cleaned])
    const path = cachePath(this.deps.cacheDir, key, ext)

    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending

    const task = this.produce({ engine, cleaned, voice, preset, rate, volume, path, at })
    this.inflight.set(key, task)
    try {
      return await task
    } finally {
      this.inflight.delete(key)
    }
  }

  /**
   * 缓存身份：同一句话在「不同音色 / 不同语速」下必须算不同文件。
   *
   * 三条分支的「音色」不是同一个东西，所以身份各算各的：
   *
   * - `macos-say` 用系统音色名 + 基准语速，**不用 Edge 的音色 id**。
   *   用 id 会让「换了个 Edge 音色但 say 没变」的两个请求命中同一个文件，
   *   于是换了音色听起来毫无变化，而面板显示音色已改。
   * - `gpt-sovits` 的音色是**参考音频**，不是 id。不把参考音频算进身份，
   *   换一个音色样本后仍会命中旧文件——最典型的表现是「换了角色音却没变声」。
   *   语种也一并算：同一句中文用 `text_lang=ja` 合成出来是另一段音频。
   * - `edge-tts` 的音色就是 id，语速与音量已在缓存键里。
   */
  private cacheIdentity(engine: EngineName, voice: string): string {
    const settings = this.deps.settings
    if (engine === 'macos-say') {
      return 'say:' + settings.sayVoice + ':' + String(settings.sayWpm)
    }
    if (engine === 'gpt-sovits') {
      return 'gsv:' + settings.gsvRefAudio + '|' + settings.gsvTextLang
    }
    return engine + ':' + voice
  }

  /** 真正合成一次（含缓存读、原子落盘、淘汰）。 */
  private async produce(input: {
    readonly engine: SpeechEngine
    readonly cleaned: string
    readonly voice: string
    readonly preset: PresetId | undefined
    readonly rate: number
    readonly volume: 'normal' | 'low'
    readonly path: string
    readonly at: number
  }): Promise<Utterance> {
    const startedAt = Date.now()

    const hit = await readEntry(input.path)
    if (hit !== undefined) {
      this.cachedHits += 1
      this.okCount += 1
      this.lastOkAt = input.at
      // 命中缓存时也要按同一条分支的口径报「语速吃没吃」与「实际音色」：
      // 否则同一句话第一次报「语速未生效」、第二次报「已生效」，而声音一模一样。
      return this.done({
        ...input,
        bytes: hit.bytes,
        cached: true,
        rateApplied: rateAppliedOf(input.engine.name),
        voiceUsed: input.engine.voice ?? input.voice,
        elapsedMs: Date.now() - startedAt,
      })
    }

    const part = partPath(input.path)
    const result = await input.engine.synth({
      text: input.cleaned,
      outPath: part,
      voice: input.voice,
      rate: input.rate,
      volume: input.volume,
    })

    if (!result.ok) {
      await removeFile(part)
      return this.fail(result.reason, input.at, input.cleaned, input.engine.name, input.rate)
    }

    try {
      await promote(part, input.path)
    } catch {
      await removeFile(part)
      return this.fail('spawn', input.at, input.cleaned, input.engine.name, input.rate)
    }

    const written = await readEntry(input.path)
    if (written === undefined) {
      // 分支说成功，但目标文件不存在或为 0 字节。宁可报错，也不要让一个
      // 空文件进缓存——下一次同文会命中它，然后「合成成功但没有声音」。
      await removeFile(input.path)
      return this.fail('payload', input.at, input.cleaned, input.engine.name, input.rate)
    }

    const pruned = await prune(this.deps.cacheDir, this.deps.settings.cacheFiles)
    this.cacheCount = (await listEntries(this.deps.cacheDir)).length
    if (this.deps.settings.verbose && pruned > 0) {
      this.deps.log.info('语音缓存淘汰 %d 个最旧文件', pruned)
    }

    this.okCount += 1
    this.lastOkAt = input.at
    return this.done({
      ...input,
      bytes: written.bytes,
      cached: false,
      rateApplied: result.rateApplied,
      voiceUsed: result.voice ?? input.engine.voice ?? input.voice,
      elapsedMs: Date.now() - startedAt,
    })
  }

  /* ---------------------------------------------------------------- *
   * 结果构造
   * ---------------------------------------------------------------- */

  private done(input: {
    readonly engine: SpeechEngine
    readonly cleaned: string
    readonly voice: string
    readonly preset: PresetId | undefined
    readonly rate: number
    readonly path: string
    readonly at: number
    readonly bytes: number
    readonly cached: boolean
    readonly rateApplied: boolean
    readonly voiceUsed: string
    readonly elapsedMs: number
  }): Utterance {
    return Object.freeze({
      ok: true,
      reason: 'ok' as TtsReason,
      text: input.cleaned,
      engine: input.engine.name,
      voice: input.voiceUsed,
      preset: input.preset,
      audioPath: input.path,
      bytes: input.bytes,
      rate: input.rate,
      rateApplied: input.rateApplied,
      cached: input.cached,
      played: false,
      elapsedMs: input.elapsedMs,
      at: input.at,
    })
  }

  private fail(
    reason: TtsReason,
    at: number,
    text: string,
    engine: EngineChoice,
    rate: number,
  ): Utterance {
    this.failures += 1
    this.lastError = reason
    if (this.deps.settings.verbose && reason !== 'disabled') {
      this.deps.log.warn('语音未合成（%s）', reason)
    }
    return Object.freeze({
      ok: false,
      reason,
      text,
      engine,
      rate,
      rateApplied: false,
      cached: false,
      played: false,
      elapsedMs: 0,
      at,
    })
  }

  /* ---------------------------------------------------------------- *
   * 维护
   * ---------------------------------------------------------------- */

  async probe(at?: number): Promise<ProbeReport> {
    // 重建一次通道集合：用户刚装完 `edge-tts` 时，PATH 的解析结果是旧的。
    this.current = this.deps.build()
    const when = at ?? this.deps.now()
    const pick = this.pick()
    return Object.freeze({
      at: when,
      chosen: pick.engine?.name ?? 'none',
      checks: Object.freeze(
        this.current.engines.map(engine =>
          Object.freeze({
            engine: engine.name,
            ready: engine.present && engine.configured,
            detail: engine.detail,
          }),
        ),
      ),
    })
  }

  clear(): void {
    this.cacheCount = 0
    void clearCache(this.deps.cacheDir).then(count => {
      if (count > 0 && this.deps.settings.verbose) {
        this.deps.log.info('已清空语音缓存（%d 个文件）', count)
      }
      return undefined
    })
  }

  stats(): TtsStats {
    return Object.freeze({
      calls: this.calls,
      ok: this.okCount,
      failures: this.failures,
      cachedHits: this.cachedHits,
      played: this.playedCount,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      engine: this.engine,
      cacheFiles: this.cacheCount,
    })
  }
}
