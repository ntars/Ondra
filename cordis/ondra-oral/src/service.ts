/**
 * 口语化塑形服务的实现。
 *
 * ## 一次塑形的固定顺序（顺序本身是契约）
 *
 * ```
 * ① 语气词瘦身（减） → ② 省略主语/收尾词（减） → ③ 标点习惯（改） → ④ 口头禅（加）
 * ```
 *
 * 为什么是这个顺序：
 *
 * - 语气词先减，否则「省略主语」之后句子更短，语气词反而显得突兀；
 * - 标点在减之后，因为句号可能在减的过程里被一起带走；
 * - 口头禅最后加，加完就不再改——插进去的那句不该被后面的规则动到。
 *
 * ## 与 O-037 / O-038 的串行位置
 *
 * ```
 * 生成正文 → O-037 过滤（只删） → 本插件塑形（只加） → O-038 分条 → O-039 计时
 * ```
 *
 * 放在 O-037 **之后**：被过滤链删掉的句子不该先被插上口癖（白插，还占额度）。
 * 放在 O-038 **之前**：40 字上限要算上口癖的字数，否则插完会溢出。
 * 放在复读检测之后：口头禅单场最多 2 次，而 O-037 的 4-gram 折叠阈值是 3 次——
 * 两条规则正好不撞车。
 */

import { normalizeEntries, pickHabit, SessionLedger } from './pool.js'
import {
  countChars,
  doubleQuestion,
  dropFinalPeriod,
  dropSubject,
  hesitate,
  insertHabit,
  medianLength,
  trimEnding,
  trimParticles,
} from './text.js'
import type { Config } from './settings.js'
import type {
  ExpressLike,
  HabitEntry,
  HabitEntryInput,
  HabitPoolView,
  LengthReport,
  LogLike,
  OralMark,
  OralRequest,
  OralResult,
  OralService,
  OralStats,
  OralStyle,
  OralTurnRequest,
  OralTurnResult,
  ParticleLevelLike,
  PoolRegistration,
  StickerGate,
} from './types.js'

/** 语气词档 → 句末最多保留几个。`rich` 不在表里：那一档本插件**一个字都不减**。 */
const KEEP_OF_LEVEL: Readonly<Record<Exclude<ParticleLevelLike, 'rich'>, number>> = Object.freeze({
  normal: 2,
  sparse: 1,
  none: 0,
})

/** 默认人格 id（调用方不传时）。 */
const DEFAULT_PERSONA = 'default'

/** 默认会话 id（调用方不传时）。 */
const DEFAULT_SESSION = 'default'

/** 会话账本上限（场）。 */
const MAX_SESSIONS = 200

/** 塑形后不得少于这么多字，否则整条回退。 */
const MIN_RESULT_CHARS = 2

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 一条口头禅的最终插入位。 */
function placementOf(entry: HabitEntry, fallback: string): 'prefix' | 'suffix' {
  if (entry.placement === 'prefix') return 'prefix'
  if (entry.placement === 'suffix') return 'suffix'
  return fallback === 'prefix' ? 'prefix' : 'suffix'
}

/** 洗牌下标（Fisher–Yates，用调用方给的随机源）。 */
function shuffleIndices(count: number, rng: () => number): readonly number[] {
  const out: number[] = []
  for (let i = 0; i < count; i += 1) out.push(i)
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)))
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

/** 塑形到一半的可变结构（`baseShape` 的返回值）。 */
interface Shaped {
  text: string
  marks: OralMark[]
}

/** 服务的外部依赖（全部用取值函数：上游晚装载能自愈，早卸载立刻反映）。 */
export interface OralDeps {
  readonly settings: Config
  readonly log: LogLike
  /** O-031 表达档。 */
  readonly express: () => ExpressLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
}

/** 统计计数器（唯一的可变状态）。 */
interface Counters {
  turns: number
  messages: number
  habits: number
  incompletes: number
  particles: number
  puncts: number
  skipped: number
  expressErrors: number
}

/** 口语化服务实现。 */
export class Oral implements OralService {
  private readonly deps: OralDeps

  private readonly ledger = new SessionLedger(MAX_SESSIONS)

  /** 人格 id → 归一化后的条目。 */
  // 池表实例。与方法 pools() 同名会冲突，故取别名。
  private readonly poolMap = new Map<string, readonly HabitEntry[]>()

  private readonly counters: Counters = {
    turns: 0,
    messages: 0,
    habits: 0,
    incompletes: 0,
    particles: 0,
    puncts: 0,
    skipped: 0,
    expressErrors: 0,
  }

  constructor(deps: OralDeps) {
    this.deps = deps
  }

  /** 只看配置开关：本插件对上游是可选增强，所以「可用」等于「开着」。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 关闭是唯一不可用原因。 */
  get reason(): 'disabled' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /** 六态语域此刻是否在位（现问，不缓存）。 */
  get expressReady(): boolean {
    const express = this.deps.express()
    return express !== undefined && express.available === true
  }

  /** 全部池的视图。 */
  pools(): readonly HabitPoolView[] {
    const ids = Array.from(this.poolMap.keys()).sort()
    return Object.freeze(ids.map(id => this.poolOf(id)))
  }

  /** 取一个人格的池。没有则返回空池（不抛、不建）。 */
  poolOf(personaId: string): HabitPoolView {
    const entries = this.poolMap.get(personaId) ?? []
    const byState = new Map<string, number>()
    for (const entry of entries) {
      if (entry.states === undefined) {
        byState.set('any', (byState.get('any') ?? 0) + 1)
        continue
      }
      for (const state of entry.states) {
        byState.set(state, (byState.get(state) ?? 0) + 1)
      }
    }
    const size = entries.length
    return Object.freeze({
      personaId,
      size,
      ready: size >= this.deps.settings.habitMinPoolSize,
      byState: Object.freeze(Object.fromEntries(byState)),
      entries,
    })
  }

  /** 注册/覆盖一个池。**永不抛错**。 */
  registerPool(personaId: string, entries: readonly HabitEntryInput[]): PoolRegistration {
    const id = typeof personaId === 'string' && personaId.trim() !== '' ? personaId.trim() : DEFAULT_PERSONA
    try {
      const normalized = normalizeEntries(entries, this.deps.settings.habitMaxPoolSize)
      this.poolMap.set(id, normalized.entries)
      if (normalized.dropped > 0 && this.deps.settings.verbose) {
        this.deps.log.warn(
          '人格「%s」的口头禅池丢弃了 %d 条：%s',
          id,
          normalized.dropped,
          normalized.issues.join('；'),
        )
      }
      return Object.freeze({
        ok: true,
        size: normalized.entries.length,
        dropped: normalized.dropped,
        issues: normalized.issues,
      })
    } catch (error) {
      // 归一化本身写了 try/catch，这里是最后一道：注册不该让宿主加载失败。
      this.deps.log.error('注册口头禅池失败（人格「%s」）：%s', id, messageOf(error))
      return Object.freeze({ ok: false, size: 0, dropped: 0, issues: Object.freeze([messageOf(error)]) })
    }
  }

  /** 删一个池。 */
  dropPool(personaId: string): boolean {
    return this.poolMap.delete(personaId)
  }

  /** 当前表达档。 */
  styleOf(at?: number): OralStyle {
    const express = this.deps.express()
    if (express === undefined || express.available !== true) return {}
    try {
      const profile = express.profileOf(at)
      return Object.freeze({
        state: profile.view.state,
        particles: profile.prompt.particles,
        punctuation: profile.prompt.punctuation,
        sentenceShape: profile.prompt.sentenceShape,
      })
    } catch (error) {
      this.counters.expressErrors += 1
      if (this.deps.settings.verbose) {
        this.deps.log.warn('读表达档失败（按默认标点与语气词处理）：%s', messageOf(error))
      }
      return {}
    }
  }

  /** 单条塑形。 */
  apply(request: OralRequest): OralResult {
    const settings = this.deps.settings
    const source = typeof request.text === 'string' ? request.text : ''
    this.counters.messages += 1

    if (!settings.enable) return this.plain(source, 'disabled')
    if (source.trim() === '') return this.plain('', 'empty-text')

    const at = this.atOf(request.at)
    const rng = typeof request.rng === 'function' ? request.rng : Math.random
    const sessionId = request.sessionId ?? DEFAULT_SESSION
    const personaId = request.personaId ?? DEFAULT_PERSONA
    const style = this.mergeStyle(this.styleOf(at), request.style)

    const shaped = this.baseShape(source, style)
    let text = shaped.text

    if (settings.incompleteEnabled && request.allowIncomplete !== false) {
      const incomplete = this.tryIncomplete(text, rng)
      if (incomplete !== undefined) {
        text = incomplete.text
        shaped.marks.push(incomplete.mark)
        this.counters.incompletes += 1
      }
    }

    const picked = this.selectHabit(style, sessionId, personaId, at, rng)
    let habit: string | undefined
    if (picked.entry !== undefined) {
      text = insertHabit(text, picked.entry.text, placementOf(picked.entry, settings.habitPlacement))
      habit = picked.entry.text
    } else {
      this.counters.skipped += 1
    }
    shaped.marks.push(picked.mark)

    // 塑形不该把一句话削成两个字。真削到了，整条回退——宁可没有口癖，也不能不像话。
    if (countChars(text) < MIN_RESULT_CHARS && countChars(source) >= MIN_RESULT_CHARS) {
      return this.plain(source, 'too-short')
    }

    return this.resultOf(text, source, shaped.marks, habit)
  }

  /** 整轮塑形（不完整句与口头禅都只有一次）。 */
  applyTurn(request: OralTurnRequest): OralTurnResult {
    const settings = this.deps.settings
    const originals = (Array.isArray(request.texts) ? request.texts : []).filter(
      (item): item is string => typeof item === 'string',
    )
    const at = this.atOf(request.at)
    const rng = typeof request.rng === 'function' ? request.rng : Math.random
    const sessionId = request.sessionId ?? DEFAULT_SESSION
    const personaId = request.personaId ?? DEFAULT_PERSONA
    const style = this.mergeStyle(this.styleOf(at), request.style)
    this.counters.turns += 1

    // 关掉时**一条规则都不跑**：`baseShape` 会改标点，不能先塑形再声明「原样返回」。
    if (!settings.enable) {
      const messages = originals.map(text => this.plain(text, 'disabled'))
      return this.turnResult(messages, sessionId, -1, originals, ['已关闭：原样返回'])
    }

    const shaped: Shaped[] = originals.map(text => this.baseShape(text, style))
    let incompleteAt = -1

    // 不完整句：**整轮最多一条**。逐条判 8% 会让 4 条一轮变成约 28%。
    if (settings.incompleteEnabled && shaped.length > 0 && rng() < settings.incompleteP) {
      for (const index of shuffleIndices(shaped.length, rng)) {
        const target = shaped[index]
        const incomplete = this.shapeIncomplete(target.text)
        if (incomplete === undefined) continue
        target.text = incomplete.text
        target.marks.push(incomplete.mark)
        incompleteAt = index
        this.counters.incompletes += 1
        break
      }
    }

    // 空轮不消耗额度：没有消息可插，就不该记账。
    if (shaped.length === 0) {
      const empty: OralTurnResult = {
        messages: Object.freeze([]),
        sessionId,
        habitUsed: this.ledger.peek(sessionId)?.count ?? 0,
        incompleteAt: -1,
        median: 0,
        inBand: false,
        notes: Object.freeze(['本轮没有消息']),
      }
      return empty
    }

    // 口头禅：整轮最多一条，按插入位选句首或句尾。
    const picked = this.selectHabit(style, sessionId, personaId, at, rng)
    if (picked.entry !== undefined) {
      const placement = placementOf(picked.entry, settings.habitPlacement)
      const index = placement === 'prefix' ? 0 : shaped.length - 1
      const target = shaped[index]
      target.text = insertHabit(target.text, picked.entry.text, placement)
      target.marks.push({ kind: 'habit', code: 'habit-inserted', detail: picked.entry.text })
    } else {
      this.counters.skipped += 1
    }

    const messages = shaped.map((item, index) =>
      this.resultOf(item.text, originals[index] ?? '', item.marks, undefined),
    )
    const finals = shaped.map(item => item.text)
    const median = medianLength(finals)
    const notes: string[] = []
    notes.push('整轮 ' + String(finals.length) + ' 条，中位 ' + String(median) + ' 字')
    if (!this.inBand(median)) {
      notes.push(
        '中位字数不在 ' + String(settings.medianMin) + '–' + String(settings.medianMax) + ' 区间（只报告，不截断）',
      )
    }
    if (incompleteAt >= 0) notes.push('第 ' + String(incompleteAt + 1) + ' 条省略了开头或收尾')
    if (picked.entry !== undefined) notes.push('插入口头禅「' + picked.entry.text + '」')

    return Object.freeze({
      messages: Object.freeze(messages),
      sessionId,
      habitUsed: this.ledger.peek(sessionId)?.count ?? 0,
      incompleteAt,
      median,
      inBand: this.inBand(median),
      notes: Object.freeze(notes),
    })
  }

  /** 只量字数，不改文本。 */
  measure(texts: readonly string[]): LengthReport {
    const settings = this.deps.settings
    const list = (Array.isArray(texts) ? texts : []).filter(
      (item): item is string => typeof item === 'string',
    )
    const nums = list.map(countChars).filter(n => n > 0).sort((a, b) => a - b)
    const band = Object.freeze({ min: settings.medianMin, max: settings.medianMax })
    if (nums.length === 0) {
      return Object.freeze({ count: 0, median: 0, min: 0, max: 0, inBand: false, band })
    }
    const median = medianLength(list)
    return Object.freeze({
      count: nums.length,
      median,
      min: nums[0],
      max: nums[nums.length - 1],
      inBand: median >= band.min && median <= band.max,
      band,
    })
  }

  /** 贴纸闸门（只读，不发贴纸）。 */
  stickerGate(sessionId: string): StickerGate {
    const settings = this.deps.settings
    const gap = settings.stickerGap
    if (!settings.enable) {
      const off: StickerGate = { allowed: false, sinceLast: gap, gap, reason: 'disabled' }
      return Object.freeze(off)
    }
    const state = this.ledger.peek(sessionId)
    if (state === undefined) {
      // 从没说过话：第一张贴纸不该被拦。`sinceLast` 报 `gap` 而不是 Infinity，
      // 否则它会以 `null` 的样子出现在面板 JSON 里。
      const fresh: StickerGate = { allowed: true, sinceLast: gap, gap, reason: 'ok' }
      return Object.freeze(fresh)
    }
    const sinceLast = state.lastStickerAt === null ? gap : state.messages - state.lastStickerAt
    const allowed = sinceLast >= gap
    const view: StickerGate = { allowed, sinceLast, gap, reason: allowed ? 'ok' : 'gap' }
    return Object.freeze(view)
  }

  /** 记「又发了几条」。 */
  noteMessages(sessionId: string, count: number): void {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return
    const state = this.ledger.touch(sessionId, this.deps.now())
    state.messages += Math.trunc(count)
  }

  /** 记一次贴纸。 */
  markSticker(sessionId: string): void {
    const state = this.ledger.touch(sessionId, this.deps.now())
    state.lastStickerAt = state.messages
  }

  /** 开一场。 */
  beginSession(sessionId: string): void {
    this.ledger.begin(sessionId, this.deps.now())
  }

  /** 统计快照。 */
  stats(): OralStats {
    return Object.freeze({
      turns: this.counters.turns,
      messages: this.counters.messages,
      habits: this.counters.habits,
      incompletes: this.counters.incompletes,
      particles: this.counters.particles,
      puncts: this.counters.puncts,
      skipped: this.counters.skipped,
      pools: this.poolMap.size,
      sessions: this.ledger.size(),
      expressErrors: this.counters.expressErrors,
    })
  }

  /* ---------------- 内部 ---------------- */

  /** 时刻兜底。 */
  private atOf(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : this.deps.now()
  }

  /** 表达档合并：显式给的字段优先，缺的用 O-031 的。 */
  private mergeStyle(base: OralStyle, override: OralStyle | undefined): OralStyle {
    if (override === undefined) return base
    return {
      state: override.state ?? base.state,
      particles: override.particles ?? base.particles,
      punctuation: override.punctuation ?? base.punctuation,
      sentenceShape: override.sentenceShape ?? base.sentenceShape,
    }
  }

  /** ① 语气词 + ③ 标点（不含不完整句与口癖）。 */
  private baseShape(text: string, style: OralStyle): Shaped {
    const settings = this.deps.settings
    const marks: OralMark[] = []
    let out = text

    if (settings.particlesEnabled && style.particles !== undefined && style.particles !== 'rich') {
      const trimmed = trimParticles(out, KEEP_OF_LEVEL[style.particles])
      if (trimmed.removed > 0) {
        out = trimmed.text
        marks.push({
          kind: 'particle',
          code: 'particle-trim',
          detail: '去掉 ' + String(trimmed.removed) + ' 个句末语气词（档 ' + style.particles + '）',
        })
        this.counters.particles += 1
      }
    }

    if (settings.punctEnabled) {
      if (style.punctuation === 'interrobang' && /？$|\?$/.test(out)) {
        const next = doubleQuestion(out)
        if (next !== out) {
          out = next
          marks.push({ kind: 'punct', code: 'punct-double-question' })
          this.counters.puncts += 1
        }
      } else if (style.sentenceShape === 'ellipsis') {
        const next = hesitate(out)
        if (next !== out) {
          out = next
          marks.push({ kind: 'punct', code: 'punct-ellipsis' })
          this.counters.puncts += 1
        }
      } else {
        const next = dropFinalPeriod(out)
        if (next !== out) {
          out = next
          marks.push({ kind: 'punct', code: 'punct-drop-period' })
          this.counters.puncts += 1
        }
      }
    }

    return { text: out, marks }
  }

  /** ② 不完整句（不含概率判定）。 */
  private shapeIncomplete(text: string): { text: string; mark: OralMark } | undefined {
    const subject = dropSubject(text)
    if (subject !== undefined) {
      return { text: subject, mark: { kind: 'incomplete', code: 'incomplete-subject' } }
    }
    const tail = trimEnding(text)
    if (tail !== undefined) {
      return { text: tail, mark: { kind: 'incomplete', code: 'incomplete-tail' } }
    }
    return undefined
  }

  /** ② 不完整句（含概率判定）。 */
  private tryIncomplete(text: string, rng: () => number): { text: string; mark: OralMark } | undefined {
    if (rng() >= this.deps.settings.incompleteP) return undefined
    return this.shapeIncomplete(text)
  }

  /** ④ 选一条口头禅并记账。**不插**——插入由调用方按位置做。 */
  private selectHabit(
    style: OralStyle,
    sessionId: string,
    personaId: string,
    at: number,
    rng: () => number,
  ): { entry?: HabitEntry; mark: OralMark } {
    const settings = this.deps.settings
    if (!settings.habitEnabled) return { mark: { kind: 'skip', code: 'habit-disabled' } }
    const pool = this.poolOf(personaId)
    if (!pool.ready) {
      return {
        mark: {
          kind: 'skip',
          code: 'habit-no-pool',
          detail: '池内 ' + String(pool.size) + ' 条，少于 ' + String(settings.habitMinPoolSize) + ' 条',
        },
      }
    }
    const session = this.ledger.touch(sessionId, at)
    if (session.count >= settings.habitMaxPerSession) {
      return { mark: { kind: 'skip', code: 'habit-cap' } }
    }
    const entry = pickHabit(pool.entries, style.state, session.used, rng)
    if (entry === undefined) {
      return { mark: { kind: 'skip', code: 'habit-state-miss', detail: '当前档没有可用的口头禅' } }
    }
    session.count += 1
    session.used.add(entry.id)
    this.counters.habits += 1
    return { entry, mark: { kind: 'habit', code: 'habit-inserted', detail: entry.text } }
  }

  /** 判中位字数是否在区间内。 */
  private inBand(median: number): boolean {
    const settings = this.deps.settings
    return median >= settings.medianMin && median <= settings.medianMax
  }

  /** 原样返回（降级路径）。 */
  private plain(text: string, code: string): OralResult {
    this.counters.skipped += 1
    const marks: OralMark[] = [{ kind: 'skip', code }]
    // 先声明成 `OralResult` 再冻结：`Object.freeze` 会把 `typosIntroduced: 0`
    // 拓宽成 `number`，那就与「字面量 0」的承诺不符了（TS2322）。
    const result: OralResult = {
      text,
      changed: false,
      marks: Object.freeze(marks),
      chars: countChars(text),
      typosIntroduced: 0,
    }
    return Object.freeze(result)
  }

  /** 组装单条结果。 */
  private resultOf(text: string, source: string, marks: readonly OralMark[], habit: string | undefined): OralResult {
    const result: OralResult = {
      text,
      changed: text !== source,
      marks: Object.freeze([...marks]),
      chars: countChars(text),
      habit,
      typosIntroduced: 0,
    }
    return Object.freeze(result)
  }

  /** 组装整轮结果。 */
  private turnResult(
    messages: readonly OralResult[],
    sessionId: string,
    incompleteAt: number,
    texts: readonly string[],
    notes: readonly string[],
  ): OralTurnResult {
    const median = medianLength(texts)
    return Object.freeze({
      messages: Object.freeze([...messages]),
      sessionId,
      habitUsed: this.ledger.peek(sessionId)?.count ?? 0,
      incompleteAt,
      median,
      inBand: this.inBand(median),
      notes: Object.freeze([...notes]),
    })
  }
}
