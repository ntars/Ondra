/**
 * `ondra-diary` 的业务层：**四层保底全部收敛到 `tick()` + `ensure()` 两个入口**。
 *
 * ```
 * clock.dailyAt('02:00') ─┐
 * 启动后 60s 一次 ────────┼─→ tick() ─┬─ 在窗口内 → ensure(今天)
 * 窗口内 after() 重试 ────┘           └─ 任何时候 → backfill(昨天及更早)
 * ```
 *
 * ## 为什么「重试」不是「再来一遍 write」
 *
 * `write()` 是无条件重写（面板上的「重写这篇」用它）；`ensure()` 先看文件在不在。
 * 重试必须走 `ensure()`：上一次可能**已经写成功**、只是落盘后抛了个后续错误，
 * 用 `write()` 重试就会把刚写好的日记再生成一遍——字数变了、内容变了，
 * 而用户看到的是「同一篇日记自己改了」。
 *
 * ## 为什么没有「今天已经写过」的标志位
 *
 * 见 `types.ts` 文件头。这里只重复一句：判据是文件，不是内存。所以本类
 * **没有任何运行期状态**参与「写没写」的判断，唯一的运行期状态是 `attempts`
 * ——它只用来数重试次数，丢了最多多试一次，不会写错。
 */

import { buildDoc, isSafeDayKey, localDayKey, parseDoc, shiftDayKey } from './markdown.js'
import { composeBody } from './compose.js'
import type {
  ClockLike,
  DiaryCode,
  DiaryEntry,
  DiaryRef,
  DiaryResult,
  DiaryService,
  DiarySource,
  DiaryStats,
  GatewayLike,
  LogLike,
  MemoryLike,
  TriggerMode,
  WriteOptions,
} from './types.js'
import type { Config } from './settings.js'
import { LIST_LIMIT } from './store.js'
import type { DiaryFileStore } from './store.js'

/** 统计计数器的可变形状（对外只给只读快照）。 */
interface Counters {
  calls: number
  writes: number
  templateWrites: number
  skips: number
  outsideWindow: number
  backfilled: number
  tooOld: number
  modelFailures: number
  writeFailures: number
  errors: number
  metricsStripped: number
}

/** 服务依赖。 */
export interface DiaryOptions {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 文件层。 */
  readonly store: DiaryFileStore
  /** 时钟。 */
  readonly clock: () => ClockLike | undefined
  /** 模型网关。 */
  readonly gateway: () => GatewayLike | undefined
  /** 记忆核心。 */
  readonly memory: () => MemoryLike | undefined
  /** 现在。 */
  readonly now: () => number
  /** 延时一次（来自 `clock.after`，卸载即撤销）。 */
  readonly after: (ms: number, fn: () => void) => () => void
}

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000

/** 服务的实现。 */
export class Diary implements DiaryService {
  private readonly deps: DiaryOptions
  /** 每天已尝试几次模型。**只数次数**，不参与「写没写」的判断。 */
  private readonly attempts = new Map<string, number>()
  private readonly counters: Counters = {
    calls: 0,
    writes: 0,
    templateWrites: 0,
    skips: 0,
    outsideWindow: 0,
    backfilled: 0,
    tooOld: 0,
    modelFailures: 0,
    writeFailures: 0,
    errors: 0,
    metricsStripped: 0,
  }

  constructor(deps: DiaryOptions) {
    this.deps = deps
  }

  get available(): boolean {
    return this.deps.settings.enable
  }

  get reason(): 'disabled' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  get stored(): boolean {
    return this.deps.store.ready
  }

  get ready(): boolean {
    // 没有时钟就没有「02:00 到点」，自动写入整条链都排不起来；此时只剩手动 write()。
    return this.stored && this.deps.clock() !== undefined
  }

  pathOf(dayKey: string): string {
    return this.deps.store.pathOf(dayKey)
  }

  exists(dayKey: string): boolean {
    return this.deps.store.exists(dayKey)
  }

  entry(dayKey: string): DiaryEntry | undefined {
    const raw = this.deps.store.read(dayKey)
    if (raw === undefined) return undefined
    const parsed = parseDoc(raw.text, raw.mtime)
    return {
      dayKey,
      path: this.deps.store.pathOf(dayKey),
      chars: parsed.chars,
      source: parsed.source,
      mtime: raw.mtime,
      title: parsed.title,
      body: parsed.body,
      generatedAt: parsed.generatedAt,
    }
  }

  list(limit = 20): readonly DiaryRef[] {
    return this.deps.store.list(limit)
  }

  /* ---------------------------------------------------------------- *
   * 写
   * ---------------------------------------------------------------- */

  /**
   * 无条件写某天（面板「重写这篇」、评估集）。
   * @param dayKey 自然日键。
   * @param options 选项。
   */
  async write(dayKey: string, options: WriteOptions = {}): Promise<DiaryResult> {
    if (!this.deps.settings.enable) return this.fail(dayKey, 'disabled', '日记已关闭（enable=false）')
    if (!isSafeDayKey(dayKey)) return this.fail(dayKey, 'invalid-day', `日期键非法：${dayKey}`)
    if (!this.stored) return this.fail(dayKey, 'no-path', '路径服务未装载，日记无处可写')
    return this.persist(dayKey, options)
  }

  /**
   * 幂等写：已有就跳过。定时与看门狗唯一的写入口。
   * @param dayKey 自然日键，省略取今天。
   * @param options 选项。
   */
  async ensure(dayKey?: string, options: WriteOptions = {}): Promise<DiaryResult> {
    this.counters.calls += 1
    const at = options.at ?? this.deps.now()
    const key = dayKey ?? this.dayKeyOf(at)

    if (!this.deps.settings.enable) {
      return this.fail(key, 'disabled', '日记已关闭（enable=false）')
    }
    if (!isSafeDayKey(key)) return this.fail(key, 'invalid-day', `日期键非法：${key}`)
    if (!this.stored) return this.fail(key, 'no-path', '路径服务未装载，日记无处可写')

    if (options.force !== true && this.deps.store.exists(key)) {
      this.counters.skips += 1
      this.attempts.delete(key)
      return {
        dayKey: key,
        code: 'skipped-exists',
        path: this.deps.store.pathOf(key),
        chars: 0,
        source: 'model',
        at,
        detail: '这一天已经有日记了，不重写',
      }
    }

    const result = await this.persist(key, { ...options, at })
    this.scheduleRetryIfNeeded(result, options.mode ?? 'schedule', at)
    return result
  }

  /**
   * 真正生成并落盘。
   * @param dayKey 自然日键。
   * @param options 选项。
   */
  private async persist(dayKey: string, options: WriteOptions): Promise<DiaryResult> {
    const at = options.at ?? this.deps.now()
    try {
      const composed = await composeBody(
        {
          gateway: this.deps.gateway,
          memory: this.deps.memory,
          clock: this.deps.clock,
          log: this.deps.log,
          settings: this.deps.settings,
        },
        { dayKey, at, templateOnly: options.templateOnly === true },
      )
      if (composed.modelFailed) this.counters.modelFailures += 1
      this.counters.metricsStripped += composed.stripped

      if (composed.body === '') {
        // 模型空 + 模板关掉 = 宁可空着也不写半句。这不是常态，记 error 让自检能看见。
        return this.fail(dayKey, 'empty', '正文为空且模板兜底已关闭')
      }

      const doc = buildDoc({ dayKey, body: composed.body, source: composed.source, generatedAt: at })
      const ok = this.deps.store.write(dayKey, doc)
      if (!ok) {
        this.counters.writeFailures += 1
        return this.fail(dayKey, 'error', '落盘失败（目录不可写或磁盘满）')
      }

      this.counters.writes += 1
      if (composed.source === 'template') this.counters.templateWrites += 1
      if (options.mode === 'catch-up') this.counters.backfilled += 1
      this.attempts.delete(dayKey)

      return {
        dayKey,
        code: composed.source === 'template' ? 'written-template' : 'written',
        path: this.deps.store.pathOf(dayKey),
        chars: composed.body.length,
        source: composed.source,
        at,
        detail:
          composed.source === 'template'
            ? '模型不可用，已按模板写满一篇（程序兜底）'
            : `已写入 ${composed.body.length} 字`,
      }
    } catch (error) {
      this.counters.errors += 1
      this.deps.log.error(
        '写 %s 的日记时抛错（已捕获）：%s',
        dayKey,
        error instanceof Error ? error.message : String(error),
      )
      return this.fail(dayKey, 'error', '内部错误，已捕获')
    }
  }

  /**
   * 窗口内退避重试。
   *
   * 三道自限：次数上限（`maxAttempts`）、窗口边界、以及「已经写成就不再排」。
   * 少了任何一道，都会出现「整夜每十分钟调一次模型」。
   * @param result 刚才的结论。
   * @param mode 触发方式。
   * @param at 结论时刻。
   */
  private scheduleRetryIfNeeded(result: DiaryResult, mode: TriggerMode, at: number): void {
    if (result.code !== 'error' && result.code !== 'empty') return
    if (mode === 'manual' || mode === 'catch-up') return

    const attempt = (this.attempts.get(result.dayKey) ?? 0) + 1
    this.attempts.set(result.dayKey, attempt)
    if (attempt >= this.deps.settings.maxAttempts) {
      this.deps.log.warn(
        '%s 的日记已尝试 %d 次仍未写成，今天不再重试（明天由看门狗按文件补）',
        result.dayKey,
        attempt,
      )
      return
    }

    const delay = this.deps.settings.retryMinutes * MINUTE_MS
    const clock = this.deps.clock()
    // 出窗口就不再排：窗口外的时间属于「今天已经错过」，重试只会变成深夜的模型调用。
    if (clock !== undefined && !clock.withinWindow(this.deps.settings.windowStart, this.deps.settings.windowEnd, at + delay)) {
      this.deps.log.info('%s 的日记重试会落到窗口之外，改为等看门狗补', result.dayKey)
      return
    }

    try {
      this.deps.after(delay, () => {
        void this.ensure(result.dayKey, { mode: 'retry' }).catch((error: unknown) => {
          this.deps.log.warn('重试写日记失败：%s', error instanceof Error ? error.message : String(error))
        })
      })
    } catch (error) {
      this.deps.log.warn('排重试失败：%s', error instanceof Error ? error.message : String(error))
    }
  }

  /* ---------------------------------------------------------------- *
   * 定时与看门狗
   * ---------------------------------------------------------------- */

  /**
   * 看门狗：**判据是文件，不是时刻**。
   *
   * 在窗口内就补今天；无论何时都把 `backfillDays` 之内的空档扫一遍。
   * 启动时调一次、定时到点调一次，两个入口共用这一段，不各自判一遍窗口。
   * @param at 时刻，省略用系统时间。
   */
  async tick(at?: number): Promise<readonly DiaryResult[]> {
    const now = at ?? this.deps.now()
    const today = this.dayKeyOf(now)
    const out: DiaryResult[] = []

    const clock = this.deps.clock()
    const inWindow =
      clock === undefined
        ? true
        : clock.withinWindow(this.deps.settings.windowStart, this.deps.settings.windowEnd, now)

    if (inWindow) {
      out.push(await this.ensure(today, { mode: 'schedule', at: now }))
    } else {
      this.counters.outsideWindow += 1
      if (this.deps.settings.verbose) {
        this.deps.log.debug?.('%s 不在写入窗口内：今天由明天的看门狗按文件补', today)
      }
    }

    out.push(...(await this.backfill(this.deps.settings.backfillDays, now, false)))
    return out
  }

  /**
   * 补写（对外）：从昨天往前逐日查，缺的补上。
   * @param days 最多补几天，省略用配置值。
   * @param at 时刻，省略用系统时间。
   */
  async catchUp(days?: number, at?: number): Promise<readonly DiaryResult[]> {
    // 对外入口允许「一篇都没有时也补」：这是**用户/面板显式点名要补**，
    // 与看门狗那种「自己判断要不要补」是两件事（见 backfill 的 allowFirstRun）。
    return this.backfill(days ?? this.deps.settings.backfillDays, at ?? this.deps.now(), true)
  }

  /**
   * 补写的实现。
   *
   * **首次安装不补历史**（`allowFirstRun=false`）：一篇日记都没有时，
   * 「往前补三天」等于凭空给她造三天的生活，还会一次打三次模型。
   * 补写的正当场景只有一个——**她本来就在写日记，只是漏了几天**。
   * @param days 最多补几天。
   * @param at 时刻。
   * @param allowFirstRun 是否允许在「一篇都没有」时也补。
   */
  private async backfill(days: number, at: number, allowFirstRun: boolean): Promise<readonly DiaryResult[]> {
    if (!this.deps.settings.enable || !this.stored || days <= 0) return []

    const today = this.dayKeyOf(at)
    const recent = this.deps.store.list(LIST_LIMIT)
    if (recent.length === 0 && !allowFirstRun) return []

    const existing = new Set(recent.map(ref => ref.dayKey))
    const oldest = recent.length === 0 ? '' : recent[recent.length - 1]?.dayKey ?? ''
    const out: DiaryResult[] = []

    for (let index = 1; index <= days; index += 1) {
      const dayKey = shiftDayKey(today, -index)
      if (existing.has(dayKey)) continue
      out.push(await this.ensure(dayKey, { mode: 'catch-up', at }))
    }

    // 比上限更早的空档只报告、不补：补一个月等于一次性烧一个月的模型费。
    let older = 0
    for (let index = days + 1; index <= days + 7; index += 1) {
      const dayKey = shiftDayKey(today, -index)
      if (existing.has(dayKey)) continue
      // 只统计「她开始写日记之后」的空档，安装之前的空白不算漏。
      if (oldest !== '' && dayKey < oldest) break
      older += 1
    }
    if (older > 0) {
      this.counters.tooOld += older
      out.push({
        dayKey: shiftDayKey(today, -(days + 1)),
        code: 'too-old',
        path: '',
        chars: 0,
        source: 'model',
        at,
        detail: `更早还有 ${older} 天空着，超出补写上限（${days} 天），不补`,
      })
    }
    return out
  }

  /* ---------------------------------------------------------------- *
   * 杂项
   * ---------------------------------------------------------------- */

  /**
   * 某时刻的自然日键。有 `ondra-clock` 就用它（产品时区），没有退回本机时区。
   * @param at 时刻。
   */
  private dayKeyOf(at: number): string {
    const clock = this.deps.clock()
    return clock === undefined ? localDayKey(at) : clock.dayKey(at)
  }

  /**
   * 造一个失败结论，并顺手记日志。
   * @param dayKey 自然日键。
   * @param code 原因码。
   * @param detail 说明。
   */
  private fail(dayKey: string, code: DiaryCode, detail: string): DiaryResult {
    if (this.deps.settings.verbose && code !== 'skipped-exists') {
      this.deps.log.warn('日记未写（%s）：%s', code, detail)
    }
    const source: DiarySource = 'model'
    return { dayKey, code, path: '', chars: 0, source, at: this.deps.now(), detail }
  }

  /** 统计快照。 */
  stats(): DiaryStats {
    return Object.freeze({
      calls: this.counters.calls,
      writes: this.counters.writes,
      templateWrites: this.counters.templateWrites,
      skips: this.counters.skips,
      outsideWindow: this.counters.outsideWindow,
      backfilled: this.counters.backfilled,
      tooOld: this.counters.tooOld,
      modelFailures: this.counters.modelFailures,
      writeFailures: this.counters.writeFailures,
      errors: this.counters.errors,
      metricsStripped: this.counters.metricsStripped,
      stored: this.deps.store.ready,
    })
  }
}
