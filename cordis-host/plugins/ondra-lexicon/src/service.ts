/**
 * 语感服务：收样本、算三个量、出一段正文。
 *
 * ## 为什么这一层没有定时器
 *
 * 语感不是「到点该算一次」的东西，它是**每次要拼提示词时读一眼**的东西。
 * 装定时器只会带来两个后果：空闲时也在跑，以及卸载时忘关。
 * 所以本包全部时刻来自入参或 `now()`（§零常驻）。
 *
 * ## 为什么落盘按条数触发，而不是按时间
 *
 * 按时间要定时器；按条数不需要。代价是「收一条就崩」会丢最多
 * `flushEvery` 条形状——那只是让中位数差一点点，不会让语感变成错的人。
 *
 * ## 失败一律降级，不抛
 *
 * 路径服务缺席、写盘失败、样本形状不对：都只告警。语感是**增强项**，
 * 它坏掉的正确表现是「这一轮没有语感段」，而不是「对话链崩了」。
 */

import { charsOf, composeText, confidenceOf, fnv1a64, medianOf, rateOf, shapeOf, topParticlesOf } from './shape.js'
import { appendShape, emptyState, pruneByAge, readState, writeState, STATE_FILE_NAME, STATE_VERSION } from './state.js'
import type { LexiconState } from './state.js'
import type { Config } from './settings.js'
import { BLOCK_ORDER, MARKER, SAMPLE_WINDOW } from './types.js'
import type {
  LexiconBlock,
  LexiconSample,
  LexiconService,
  LexiconStats,
  LogLike,
  MessageShape,
  ObserveOutcome,
  PathLike,
} from './types.js'

/** 判重的时间窗（毫秒）：同一条正文在 60 秒内再来一次，按通道重推处理。 */
const DEDUPE_WINDOW_MS = 60_000

/** 正文判重表最多记多少条（防止长会话把内存吃掉）。 */
const DEDUPE_MAX = 64

/** 语感段的建议存活时长：一天。语感不会在一小时内变，没必要每轮重算。 */
const BLOCK_TTL_MINUTES = 1440

/** 构造入参。 */
export interface LexiconOptions {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 路径服务取值函数（晚装载能自愈）。 */
  readonly path: () => PathLike | undefined
  /** 当前时刻取值函数。 */
  readonly now: () => number
}

/** 语感服务实现。 */
export class Lexicon implements LexiconService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly path: () => PathLike | undefined
  private readonly now: () => number

  private samples: MessageShape[]
  /** 已入窗的指纹集合，与 `samples` 同步重建，避免无界增长。 */
  private seen: Set<string>
  /** 正文哈希 → 最近一次入窗时刻，只用于挡通道重推。 */
  private recent: Map<string, number>
  /** 距上次写盘收了多少条。 */
  private sinceFlush: number
  /** 写盘是否还能用（路径缺席或写失败过一次就置 false）。 */
  private persistOk: boolean
  /** 路径缺席只告警一次。 */
  private warnedNoPath: boolean
  /** 已释放。 */
  private disposed: boolean

  constructor(options: LexiconOptions) {
    this.settings = options.settings
    this.log = options.log
    this.path = options.path
    this.now = options.now
    this.samples = []
    this.seen = new Set<string>()
    this.recent = new Map<string, number>()
    this.sinceFlush = 0
    this.persistOk = options.settings.persist
    this.warnedNoPath = false
    this.disposed = false

    this.load()
  }

  /** 开关开着吗。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 形状存档能不能写。 */
  get stored(): boolean {
    return this.persistOk && this.resolveFile() !== undefined
  }

  /**
   * 存档路径。路径服务缺席时返回 undefined（不猜路径）。
   */
  private resolveFile(): string | undefined {
    const path = this.path()
    if (path === undefined) return undefined
    try {
      return path.prepareFile(path.fileIn('user', STATE_FILE_NAME))
    } catch {
      return undefined
    }
  }

  /** 启动时读一次形状存档。读不到就当空窗口，不报错。 */
  private load(): void {
    if (!this.settings.persist) return
    const file = this.resolveFile()
    if (file === undefined) {
      this.warnNoPath()
      return
    }
    const state: LexiconState = readState(file)
    if (state.samples.length === 0) return
    this.samples = [...state.samples].slice(-this.window())
    this.rebuildSeen()
    this.log.info('语感窗口从存档恢复 %d 条形状（存档里没有原话）', this.samples.length)
  }

  /** 路径缺席只提示一次：每次观察都提示会把日志刷满。 */
  private warnNoPath(): void {
    if (this.warnedNoPath) return
    this.warnedNoPath = true
    this.persistOk = false
    this.log.warn('路径服务未装载：语感形状只在内存里，重启后要重新攒样本')
  }

  /** 窗口条数（配置与契约常量取小，防止配置写得比契约大）。 */
  private window(): number {
    return Math.min(Math.max(1, this.settings.windowSize), Math.max(1, SAMPLE_WINDOW * 4))
  }

  /** 用当前窗口重建指纹集合。 */
  private rebuildSeen(): void {
    const seen = new Set<string>()
    for (const shape of this.samples) seen.add(shape.fingerprint)
    this.seen = seen
  }

  /**
   * 收一条或一批消息。
   * @param input 单条或数组。
   */
  observe(input: LexiconSample | readonly LexiconSample[]): ObserveOutcome {
    if (this.disposed) {
      return Object.freeze({ accepted: 0, duplicate: 0, rejected: 0, samples: this.samples.length })
    }

    const list: readonly LexiconSample[] = Array.isArray(input)
      ? (input as readonly LexiconSample[])
      : [input as LexiconSample]

    let accepted = 0
    let duplicate = 0
    let rejected = 0

    for (const sample of list) {
      const outcome = this.acceptOne(sample)
      if (outcome === 'accepted') accepted += 1
      else if (outcome === 'duplicate') duplicate += 1
      else rejected += 1
    }

    if (accepted > 0) {
      this.sinceFlush += accepted
      if (this.sinceFlush >= Math.max(1, this.settings.flushEvery)) this.flush()
    }

    return Object.freeze({ accepted, duplicate, rejected, samples: this.samples.length })
  }

  /**
   * 收一条。返回处置结果。
   *
   * 入参收成 `unknown` 再收窄：调用方可能从 JSON 里直接丢一个对象进来，
   * 结构不对时应当计入 `rejected`，而不是在 `sample.from` 上抛一次
   * `TypeError`——那样整批样本都会因为一条坏数据丢掉。
   * @param raw 单条。
   */
  private acceptOne(raw: unknown): 'accepted' | 'duplicate' | 'rejected' {
    if (typeof raw !== 'object' || raw === null) return 'rejected'
    const sample = raw as LexiconSample

    const from = sample.from ?? 'user'
    if (from !== 'user') {
      this.note('拒收：来自 assistant（统计的是主人，不是她自己）')
      return 'rejected'
    }
    if (this.settings.ownerOnly && sample.owner === false) {
      this.note('拒收：不是主人本人（ownerOnly 打开）')
      return 'rejected'
    }

    const at = typeof sample.at === 'number' && Number.isFinite(sample.at) ? Math.trunc(sample.at) : this.now()
    const shape = shapeOf(sample, at)
    if (shape === undefined) {
      this.note('拒收：正文为空或只有标点')
      return 'rejected'
    }

    if (this.seen.has(shape.fingerprint)) {
      this.note('判重：同一指纹已入窗')
      return 'duplicate'
    }

    const textHash = fnv1a64(sample.text)
    const previous = this.recent.get(textHash)
    if (previous !== undefined && Math.abs(shape.at - previous) <= DEDUPE_WINDOW_MS) {
      this.note('判重：同一正文 60 秒内重复出现（通道重推）')
      return 'duplicate'
    }
    this.rememberText(textHash, shape.at)

    this.samples = [...appendShape(this.samples, shape, this.window())]
    this.rebuildSeen()

    // 时间窗：以最新一条为锚点，过老的形状让位给「最近」。
    const newestAt = shape.at
    const pruned = pruneByAge(this.samples, newestAt, this.settings.maxAgeHours)
    if (pruned.length !== this.samples.length) {
      this.samples = [...pruned]
      this.rebuildSeen()
    }

    return 'accepted'
  }

  /** 记一条正文哈希，超上限时丢最旧的。 */
  private rememberText(textHash: string, at: number): void {
    this.recent.set(textHash, at)
    if (this.recent.size <= DEDUPE_MAX) return
    let oldestKey = ''
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, value] of this.recent) {
      if (value < oldestAt) {
        oldestAt = value
        oldestKey = key
      }
    }
    if (oldestKey !== '') this.recent.delete(oldestKey)
  }

  /** 噪声日志。 */
  private note(message: string): void {
    if (!this.settings.verbose) return
    const debug = this.log.debug
    if (debug === undefined) return
    debug.call(this.log, message)
  }

  /** 读当前统计。纯读。 */
  stats(): LexiconStats {
    const shapes = this.samples
    const sentenceChars: number[] = []
    let noPunct = 0
    for (const shape of shapes) {
      for (const length of shape.sentenceChars) sentenceChars.push(length)
      if (shape.noPunct) noPunct += 1
    }

    const first: MessageShape | undefined = shapes[0]
    const last: MessageShape | undefined = shapes[shapes.length - 1]

    return Object.freeze({
      samples: shapes.length,
      medianSentenceChars: medianOf(sentenceChars),
      noPunctRate: rateOf(noPunct, shapes.length),
      topParticles: topParticlesOf(shapes, this.settings.topParticles),
      oldestAt: first === undefined ? 0 : first.at,
      newestAt: last === undefined ? 0 : last.at,
    })
  }

  /** 出一段注入正文。样本不足时给空串，不是给占位。 */
  compose(): LexiconBlock {
    if (!this.settings.enable) {
      // 先声明成 `LexiconBlock` 再冻结：直接 `Object.freeze({...})` 会让字面量
      // 在泛型里被放宽成 `string`，`reason` 就不再是 `BlockReason`（编译错误）。
      const disabled: LexiconBlock = {
        marker: MARKER,
        text: '',
        chars: 0,
        order: BLOCK_ORDER,
        ttlMinutes: BLOCK_TTL_MINUTES,
        confidence: 0,
        reason: 'disabled',
      }
      return Object.freeze(disabled)
    }

    const stats = this.stats()
    if (stats.samples < this.settings.minSamples) {
      const tooFew: LexiconBlock = {
        marker: MARKER,
        text: '',
        chars: 0,
        order: BLOCK_ORDER,
        ttlMinutes: BLOCK_TTL_MINUTES,
        confidence: confidenceOf(stats.samples, this.window()),
        reason: 'too-few',
      }
      return Object.freeze(tooFew)
    }

    const text = composeText(stats, {
      maxChars: this.settings.maxChars,
      topParticles: this.settings.topParticles,
    })

    const block: LexiconBlock = {
      marker: MARKER,
      text,
      chars: charsOf(text),
      order: BLOCK_ORDER,
      ttlMinutes: BLOCK_TTL_MINUTES,
      confidence: confidenceOf(stats.samples, this.window()),
      reason: 'ok',
    }
    return Object.freeze(block)
  }

  /** 清空窗口（含存档）。 */
  reset(): void {
    this.samples = []
    this.seen = new Set<string>()
    this.recent = new Map<string, number>()
    this.sinceFlush = 0
    this.flush()
  }

  /** 写一次盘。失败只告警，并把 `stored` 降为 false。 */
  flush(): void {
    this.sinceFlush = 0
    if (!this.settings.persist) return
    const file = this.resolveFile()
    if (file === undefined) {
      this.warnNoPath()
      return
    }
    const state: LexiconState = this.samples.length === 0 ? emptyState() : Object.freeze({
      version: STATE_VERSION,
      samples: Object.freeze([...this.samples]),
    })
    if (writeState(file, state)) {
      this.persistOk = true
      return
    }
    if (this.persistOk) {
      this.persistOk = false
      this.log.warn('语感形状写盘失败：本次运行内不再重试，重启后要重新攒样本')
    }
  }

  /** 卸载：写盘并释放引用。 */
  dispose(): void {
    if (this.disposed) return
    this.flush()
    this.disposed = true
    this.samples = []
    this.seen = new Set<string>()
    this.recent = new Map<string, number>()
  }
}
