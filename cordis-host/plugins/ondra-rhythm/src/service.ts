/**
 * 节奏服务的实现：**纯计算，不注册任何定时器**。
 *
 * 计时执行归 O-039 `ondra-rhythm-typing`。本文件只回答四个问题：
 *
 * 1. 这段话该分几条、每条多少字？（`split` / `packMessages`）
 * 2. 每条之前等多久？（`delayOf`）
 * 3. 哪一条之前停顿一下？（`longPause`）
 * 4. 要不要来一次自我修正？（`selfCorrect`，默认关）
 *
 * ## 为什么全部做成纯函数
 *
 * 分条结果必须能被面板预览（O-125）与调试工具**逐字复现**。一旦这里掺了
 * `setTimeout` 或读全局状态，同一个输入两次跑出不同结果，就再也说不清
 * 「她为什么发了 5 条」。
 *
 * 唯一的可变状态是统计计数（`stats()`），它只增不改语义。
 */

import type { Config } from './settings.js'
import { parseHhmm } from './settings.js'
import { capMessages, countChars, packMessages } from './text.js'
import { clampMs, inWindow, typingDelay } from './delay.js'
import { HARD_MAX_MESSAGES } from './types.js'
import type {
  ClockLike,
  ExpressLike,
  LogLike,
  RhythmMessage,
  RhythmNote,
  RhythmPlan,
  RhythmRequest,
  RhythmService,
  RhythmStats,
  RhythmStyle,
  SelfCorrection,
  SplitResult,
} from './types.js'

/**
 * 语速档 → 增量。
 *
 * **有增量就用增量，没有才用档位**：O-031 的雀跃档同时给了
 * `speechRateDelta: 0.1` 与 `tempo: 'brisk'`，两者都乘会变成 1.21 倍——
 * 同一个意思被算了两遍（一个参数不该同时表达两件事）。
 */
const TEMPO_DELTA: Readonly<Record<string, number>> = Object.freeze({
  brisk: 0.1,
  normal: 0,
  slow: -0.15,
})

/**
 * 句形档 → 单条字数系数与条数上限。
 *
 * `messages: null` 表示「不动上限」；数字表示「压到这么多条」。
 * **任何一档都不许把条数顶到 4 以上**——上限在 `shapeOf` 里再夹一次。
 *
 * ## 六个档一个都不能少（第 16 轮补 `ellipsis`）
 *
 * `sentenceShape` 的合法取值由 O-031 的 `SentenceShape` 联合类型决定，共六个：
 * `burst / medium / plain / long-single / clipped / ellipsis`。本表的键**必须**
 * 与那片联合类型逐字对齐。
 *
 * 第 16 轮之前缺 `ellipsis`，而它正是「困」态的句形
 * （`emotion-express/src/specs.ts` 的 `sleepy`）。缺键的后果不是崩溃，是
 * **静默降级成 `plain`**：`shapeOf()` 的 `?? PLAIN_SHAPE` 兜住空值，
 * 同时 `adjusted` 因数值与默认相同而算成 `false`，连 `notes` 里的
 * `{ code: 'shape' }` 都不产生。她困的时候语速确实慢下来了（`tempo: 'slow'`
 * 命中），但分条与单条字数完全按平常档走，面板上「句形」一格还显示
 * `ellipsis / 短句带省略`——看着全对。
 *
 * ## `ellipsis` 的系数为什么抄 `burst` 的 0.75、条数不动
 *
 * 手册 §3.2 对「困」只写了「短句含省略」：**短句**给了（要压字数），
 * **含省略**归 `ondra-oral` 的 `hesitate()`（已实现），**没有一句要求分多条**。
 * 所以 `chars` 取「短句」这一档已有的 0.75，不另编数字；`messages: null`
 * 表示不动条数——只有手册明写「一条说完」（`long-single`）与
 * 「极短常单字、？！」（`clipped`）的两档才有条数要求。
 */
const SHAPE_ADJUST: Readonly<Record<string, { readonly chars: number; readonly messages: number | null }>> =
  Object.freeze({
    burst: Object.freeze({ chars: 0.75, messages: null }),
    medium: Object.freeze({ chars: 1, messages: null }),
    plain: Object.freeze({ chars: 1, messages: null }),
    'long-single': Object.freeze({ chars: 1.5, messages: 1 }),
    clipped: Object.freeze({ chars: 0.5, messages: 2 }),
    // 困：短句（压字数），省略号由 oral 加，条数不动。
    ellipsis: Object.freeze({ chars: 0.75, messages: null }),
  })

const PLAIN_SHAPE = SHAPE_ADJUST['plain'] as { readonly chars: number; readonly messages: number | null }

/** 自我修正的三个模板（手册只写「3 句模板」，没给句子）。 */
const SELF_CORRECT_TEMPLATES: readonly string[] = Object.freeze(['不对，', '啊，说错了，', '等等，'])

/** 可作为自我修正断点的句中标点。 */
const CLAUSE_CUTS: readonly string[] = Object.freeze(['，', '、', '；', '：', ',', ';', ':'])

/** 断点后要去掉的开头符号。 */
const LEADING_MARKS = new Set(['，', '、', '；', '：', ',', ';', ':', ' ', '\u3000'])

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 找第一个句中标点的位置（返回断点之后的下标；找不到返回 -1）。 */
function firstClauseCut(text: string): number {
  let best = -1
  for (const mark of CLAUSE_CUTS) {
    const at = text.indexOf(mark)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best < 0 ? -1 : best + 1
}

/** 去掉开头的标点与空白。 */
function stripLeadingMarks(text: string): string {
  let i = 0
  while (i < text.length && LEADING_MARKS.has(text[i])) i += 1
  return text.slice(i).trim()
}

/** 保留两位小数。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 服务的外部依赖（全部用取值函数：上游晚装载能自愈，早卸载立刻反映）。 */
export interface RhythmDeps {
  readonly settings: Config
  readonly log: LogLike
  /** O-031 表达档。 */
  readonly express: () => ExpressLike | undefined
  /** O-003 时间服务。 */
  readonly clock: () => ClockLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
}

/** 统计计数器（唯一的可变状态）。 */
interface Counters {
  turns: number
  messages: number
  chars: number
  cappedTurns: number
  overflowTurns: number
  longPauses: number
  selfCorrections: number
}

/** 节奏服务实现。 */
export class Rhythm implements RhythmService {
  private readonly deps: RhythmDeps

  private readonly counters: Counters = {
    turns: 0,
    messages: 0,
    chars: 0,
    cappedTurns: 0,
    overflowTurns: 0,
    longPauses: 0,
    selfCorrections: 0,
  }

  constructor(deps: RhythmDeps) {
    this.deps = deps
  }

  /** 只看配置开关：本插件不依赖任何上游，所以「可用」等于「开着」。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 关闭是唯一不可用原因。 */
  get reason(): 'disabled' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /** 分条硬上限，恒为 4。 */
  get maxMessages(): number {
    return HARD_MAX_MESSAGES
  }

  /**
   * 出一次计划。**永不抛出**：异常一律退回一次性整段发出。
   * @param request 分条请求。
   */
  plan(request: RhythmRequest): RhythmPlan {
    const settings = this.deps.settings
    const text = typeof request.text === 'string' ? request.text : ''
    const rng = typeof request.rng === 'function' ? request.rng : Math.random
    const at = typeof request.at === 'number' && Number.isFinite(request.at) ? request.at : this.deps.now()

    try {
      if (!settings.enable) return this.oneShot(text)
      if (text.trim() === '') return this.emptyPlan()

      const style = this.styleOf(request, at)
      const shape = this.shapeOf(style)
      const night = this.nightAt(at)
      const notes: RhythmNote[] = []

      // 1. 切句 + 拆超长 + 装箱（不套条数上限）。
      const packed = packMessages(text, shape.cap)

      // 2. 自我修正（默认关）。放在套上限**之前**，因为它会多出一条。
      let messages = [...packed.messages]
      let selfCorrected = false
      const correction = this.pickCorrection(messages, rng)
      if (correction !== undefined) {
        const next = [...messages]
        next.splice(correction.index, 1, correction.head, correction.template + correction.tail)
        messages = next
        selfCorrected = true
        notes.push({
          code: 'self-correct',
          detail:
            '第 ' +
            String(correction.index + 1) +
            ' 条在「' +
            correction.head.slice(-1) +
            '」处断开，补「' +
            correction.template +
            '」再说完后半句（只改形态，不改内容）',
        })
      }

      // 3. 套条数上限（自我修正可能把条数顶出去，所以必须在这里再收一次）。
      const capped = capMessages(messages, shape.max, shape.cap)
      messages = [...capped.messages]

      if (capped.mergedCount > 0) {
        notes.push({
          code: 'tail-merge',
          detail:
            '原 ' +
            String(capped.mergedCount + messages.length) +
            ' 条超过上限 ' +
            String(shape.max) +
            '，尾部 ' +
            String(capped.mergedCount) +
            ' 条合并为第 ' +
            String(messages.length) +
            ' 条（不截断）',
        })
      }
      if (capped.overflowCount > 0) {
        notes.push({
          code: 'overflow',
          detail: '合并后的第 ' + String(messages.length) + ' 条超过单条上限 ' + String(shape.cap) + ' 字，按内容完整优先保留',
        })
      }
      if (night) {
        notes.push({ code: 'night', detail: '深夜时段（' + settings.nightStart + '–' + settings.nightEnd + '），停顿 ×' + String(settings.nightFactor) })
      }
      if (shape.adjusted) {
        notes.push({ code: 'shape', detail: '句形档 ' + (style.sentenceShape ?? 'plain') + '：单条上限 ' + String(shape.cap) + ' 字，条数上限 ' + String(shape.max) })
      }
      if (shape.rateAdjusted) {
        notes.push({ code: 'rate', detail: '语速按表达档调整为 ' + String(round2(shape.cps)) + ' 字/秒（基准 ' + String(settings.charsPerSecond) + '）' })
      }

      // 4. 长停顿：整轮最多一次，只在第 2 条及以后。
      const pauseAt =
        messages.length >= 2 && rng() < settings.longPauseP
          ? 1 + Math.floor(rng() * (messages.length - 1))
          : -1
      const pauseMs = pauseAt >= 0 ? this.longPause(rng) : 0

      // 5. 逐条算延迟。
      const first = this.firstDelay(rng)
      let totalMs = 0
      let chars = 0
      const lastIndex = messages.length - 1
      const out: RhythmMessage[] = messages.map((item, index) => {
        const itemChars = countChars(item)
        chars += itemChars
        const delayMs = index === 0 ? first : this.delayOf(item, at, shape.cps)
        const itemPause = index === pauseAt ? pauseMs : 0
        totalMs += delayMs + itemPause
        return {
          index,
          text: item,
          chars: itemChars,
          delayMs,
          pauseMs: itemPause,
          longPause: itemPause > 0,
          merged: capped.mergedCount > 0 && index === lastIndex,
          overflow: itemChars > shape.cap,
        }
      })

      // 6. 记账。
      this.counters.turns += 1
      this.counters.messages += out.length
      this.counters.chars += chars
      if (capped.mergedCount > 0) this.counters.cappedTurns += 1
      if (capped.overflowCount > 0) this.counters.overflowTurns += 1
      if (pauseMs > 0) this.counters.longPauses += 1
      if (selfCorrected) this.counters.selfCorrections += 1

      return {
        messages: out,
        totalMs,
        chars,
        cps: shape.cps,
        maxMessages: shape.max,
        maxCharsPerMessage: shape.cap,
        night,
        longPauses: pauseMs > 0 ? 1 : 0,
        selfCorrected,
        mergedCount: capped.mergedCount,
        overflowCount: capped.overflowCount,
        notes,
      }
    } catch (error) {
      if (settings.verbose) {
        this.deps.log.warn('分条计算异常（已退回一次性整段发出）：%s', messageOf(error))
      }
      return this.oneShot(text)
    }
  }

  /**
   * 只分条，不套条数上限、不算延迟。
   * @param text 正文。
   * @param cap 单条上限，省略用配置值。
   */
  split(text: string, cap?: number): SplitResult {
    const limit =
      typeof cap === 'number' && Number.isFinite(cap) && cap > 0
        ? Math.floor(cap)
        : this.deps.settings.maxCharsPerMessage
    return packMessages(typeof text === 'string' ? text : '', limit)
  }

  /**
   * 单条打字时长（已卡限、已乘深夜系数）。
   * @param text 正文。
   * @param at 时刻，省略用系统时间。
   * @param cps 字速，省略用配置值。
   */
  delayOf(text: string, at?: number, cps?: number): number {
    const settings = this.deps.settings
    const body = typeof text === 'string' ? text : ''
    const moment = typeof at === 'number' && Number.isFinite(at) ? at : this.deps.now()
    return typingDelay(
      countChars(body),
      body,
      typeof cps === 'number' && Number.isFinite(cps) ? cps : settings.charsPerSecond,
      { periodMs: settings.pausePeriodMs, ellipsisMs: settings.pauseEllipsisMs, commaMs: settings.pauseCommaMs },
      settings.minDelayMs,
      settings.maxDelayMs,
      this.nightAt(moment),
      settings.nightFactor,
    )
  }

  /**
   * 首字延迟（800–2000ms）。**不乘深夜系数**：这是「看到消息到开始打字」，
   * 不是「打字速度」。
   * @param rng 随机源。
   */
  firstDelay(rng: () => number = Math.random): number {
    const settings = this.deps.settings
    const span = settings.firstDelayMaxMs - settings.firstDelayMinMs
    return clampMs(settings.firstDelayMinMs + rng() * span, settings.firstDelayMinMs, settings.firstDelayMaxMs)
  }

  /**
   * 长停顿时长（3000–9000ms）。
   * @param rng 随机源。
   */
  longPause(rng: () => number = Math.random): number {
    const settings = this.deps.settings
    const span = settings.longPauseMaxMs - settings.longPauseMinMs
    return clampMs(settings.longPauseMinMs + rng() * span, settings.longPauseMinMs, settings.longPauseMaxMs)
  }

  /**
   * 抽一次自我修正（不改入参）。默认关闭时恒返回 `undefined`。
   * @param text 一句话。
   * @param rng 随机源。
   */
  selfCorrect(text: string, rng: () => number = Math.random): SelfCorrection | undefined {
    const settings = this.deps.settings
    if (!settings.selfCorrectEnabled) return undefined
    if (rng() >= settings.selfCorrectP) return undefined
    return this.cut(typeof text === 'string' ? text : '', 0, rng)
  }

  /** 统计快照。 */
  stats(): RhythmStats {
    const c = this.counters
    return {
      turns: c.turns,
      messages: c.messages,
      cappedTurns: c.cappedTurns,
      overflowTurns: c.overflowTurns,
      longPauses: c.longPauses,
      selfCorrections: c.selfCorrections,
      avgMessages: c.turns > 0 ? round2(c.messages / c.turns) : 0,
      avgChars: c.turns > 0 ? round2(c.chars / c.turns) : 0,
    }
  }

  /** 在一条消息的逗号处断开，生成自我修正的三段。 */
  private cut(text: string, index: number, rng: () => number): SelfCorrection | undefined {
    const at = firstClauseCut(text)
    if (at <= 0 || at >= text.length) return undefined
    const head = text.slice(0, at)
    const tail = stripLeadingMarks(text.slice(at))
    if (tail === '') return undefined
    const template = SELF_CORRECT_TEMPLATES[Math.floor(rng() * SELF_CORRECT_TEMPLATES.length)]
    return { index, head, tail, template }
  }

  /** 抽一次修正并指定下标（优先第 2 条起：第一条就改口太假）。 */
  private pickCorrection(messages: readonly string[], rng: () => number): SelfCorrection | undefined {
    const settings = this.deps.settings
    if (!settings.selfCorrectEnabled) return undefined
    if (messages.length === 0) return undefined
    if (rng() >= settings.selfCorrectP) return undefined
    const index = messages.length > 1 ? 1 + Math.floor(rng() * (messages.length - 1)) : 0
    return this.cut(messages[index], index, rng)
  }

  /** 取表达档：入参优先，其次问 O-031，最后用默认。 */
  private styleOf(request: RhythmRequest, at: number): RhythmStyle {
    if (request.style !== undefined) return request.style
    const settings = this.deps.settings
    if (!settings.emotionAdjust) return {}
    const express = this.deps.express()
    if (express === undefined || express.available === false) return {}
    try {
      const profile = express.rhythm(at)
      return {
        speechRateDelta: profile.speechRateDelta,
        tempo: profile.tempo,
        sentenceShape: profile.sentenceShape,
      }
    } catch (error) {
      if (settings.verbose) {
        this.deps.log.debug?.('读表达档失败（按默认语速与句形）：%s', messageOf(error))
      }
      return {}
    }
  }

  /** 由表达档算出本次生效的字速、单条上限、条数上限。 */
  private shapeOf(style: RhythmStyle): {
    readonly cps: number
    readonly cap: number
    readonly max: number
    readonly adjusted: boolean
    readonly rateAdjusted: boolean
  } {
    const settings = this.deps.settings
    const delta =
      typeof style.speechRateDelta === 'number' && Number.isFinite(style.speechRateDelta)
        ? style.speechRateDelta
        : TEMPO_DELTA[style.tempo ?? ''] ?? 0
    const cps = Math.min(20, Math.max(2, settings.charsPerSecond * (1 + delta)))

    const shape = this.shapeOfStyle(style.sentenceShape)
    const cap = Math.min(120, Math.max(8, Math.round(settings.maxCharsPerMessage * shape.chars)))
    // 只能减不能增：shape.messages 再小也不会把上限顶过 4。
    const max = Math.max(1, Math.min(settings.maxMessages, shape.messages ?? settings.maxMessages))

    return {
      cps,
      cap,
      max,
      // 只比数值，不比「用的是哪一档」：`medium` 与 `plain` 数值相同，不该报「被调整过」。
      adjusted: cap !== settings.maxCharsPerMessage || max !== settings.maxMessages,
      rateAdjusted: Math.abs(cps - settings.charsPerSecond) > 1e-9,
    }
  }

  /**
   * 查句形档，遇到不认识的档**留一行诊断**。
   *
   * 查不到就回落 `plain` 本身是对的（总比抛错强），错的是**回落无声**：
   * 第 16 轮之前 `ellipsis` 缺键整整静默了若干轮，面板照常显示
   * 「短句带省略」，只有翻代码才能发现它压根没生效。
   *
   * 所以这里保留回落，同时把这个「表与联合类型脱节」的事件打到日志上。
   * `undefined` 走静默（调用方没给句形是正常情形，不是缺陷），
   * 只有**给了名字却认不出**才报。
   * @param name 句形档名（可能为 `undefined`）。
   */
  private shapeOfStyle(name: string | undefined): { readonly chars: number; readonly messages: number | null } {
    if (name === undefined) return PLAIN_SHAPE
    const found = SHAPE_ADJUST[name]
    if (found !== undefined) return found
    this.deps.log.warn?.(
      '句形档「%s」在 SHAPE_ADJUST 里没有条目，按常句处理（说明本表与 O-031 的 SentenceShape 联合类型脱节了）',
      name,
    )
    return PLAIN_SHAPE
  }

  /** 判深夜。优先问 O-003（它处理跨零点与自然日），缺席时本地算。 */
  private nightAt(at: number): boolean {
    const settings = this.deps.settings
    if (!settings.nightEnabled) return false
    const start = parseHhmm(settings.nightStart)
    const end = parseHhmm(settings.nightEnd)
    if (start === undefined || end === undefined) return false

    const clock = this.deps.clock()
    if (clock !== undefined) {
      try {
        return clock.withinWindow(settings.nightStart, settings.nightEnd, at)
      } catch (error) {
        // 时间服务坏了不该让分条也坏：退回本地算。
        if (settings.verbose) this.deps.log.debug?.('判深夜时时间服务异常（改本地算）：%s', messageOf(error))
      }
    }
    return inWindow(this.minuteOfDay(at), start, end)
  }

  /** 当天第几分钟。 */
  private minuteOfDay(at: number): number {
    const clock = this.deps.clock()
    if (clock !== undefined) {
      try {
        return clock.minuteOfDay(at)
      } catch (error) {
        // 同上：退回本地算。
        void error
      }
    }
    const date = new Date(at)
    return date.getHours() * 60 + date.getMinutes()
  }

  /** 没有正文。 */
  private emptyPlan(): RhythmPlan {
    const settings = this.deps.settings
    return {
      messages: [],
      totalMs: 0,
      chars: 0,
      cps: settings.charsPerSecond,
      maxMessages: settings.maxMessages,
      maxCharsPerMessage: settings.maxCharsPerMessage,
      night: false,
      longPauses: 0,
      selfCorrected: false,
      mergedCount: 0,
      overflowCount: 0,
      notes: [{ code: 'no-text', detail: '没有正文，不出计划' }],
    }
  }

  /** 关闭或异常时的退路：一次性整段发出，不做任何延迟。 */
  private oneShot(text: string): RhythmPlan {
    const settings = this.deps.settings
    const body = typeof text === 'string' ? text.trim() : ''
    const chars = countChars(body)
    const messages: RhythmMessage[] =
      body === ''
        ? []
        : [
            {
              index: 0,
              text: body,
              chars,
              delayMs: 0,
              pauseMs: 0,
              longPause: false,
              merged: false,
              overflow: chars > settings.maxCharsPerMessage,
            },
          ]
    return {
      messages,
      totalMs: 0,
      chars,
      cps: settings.charsPerSecond,
      maxMessages: 1,
      maxCharsPerMessage: settings.maxCharsPerMessage,
      night: false,
      longPauses: 0,
      selfCorrected: false,
      mergedCount: 0,
      overflowCount: messages.length > 0 && chars > settings.maxCharsPerMessage ? 1 : 0,
      notes: [{ code: 'disabled', detail: '插件已关闭，退回一次性整段发出（不模拟打字）' }],
    }
  }
}
