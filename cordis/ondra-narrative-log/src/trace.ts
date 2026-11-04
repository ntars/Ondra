/**
 * 决策记录的纯函数层：洗净、脱敏、截断、归一化、说成人话。
 *
 * 全部纯函数（没有 fs、没有时钟、没有 ctx），所以能在自检里逐条对拍。
 * 唯一读时钟的地方通过 `options.now` 传入，方便把「同一时刻」固定下来做对拍。
 */

import { GATE_VERDICTS, NAME_RE, TRACE_VERSION, VERDICT_ZH } from './types.js'
import type {
  GateVerdict,
  TraceChosen,
  TraceEntry,
  TraceFactor,
  TraceGate,
} from './types.js'

/** 码位数（emoji 算一个）。 */
export function charsOf(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** 零宽字符与方向标记。 */
const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\ufeff]/g

/** 控制字符。 */
const CONTROL = /[\u0000-\u001f\u007f]/g

/**
 * 洗净一段文本（单行化）。
 *
 * 决策记录是一行一条 JSONL，正文里带换行会让 `grep` 与人工阅读都变难；
 * 而且换行在面板里会被折叠，看不出「原来这里断过句」。
 * @param text 原文。
 */
export function squeeze(text: string): string {
  return String(text)
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 按码位截断，且不切断代理对。
 * @param text 原文。
 * @param max 最多保留多少码位。
 */
export function clipText(
  text: string,
  max: number,
): { readonly text: string; readonly truncated: boolean } {
  const safe = Math.max(1, Math.trunc(max))
  if (charsOf(text) <= safe) return { text, truncated: false }
  let out = ''
  let count = 0
  for (const ch of text) {
    if (count >= safe) break
    out += ch
    count += 1
  }
  return { text: `${out.trimEnd()}…`, truncated: true }
}

/**
 * 脱敏。四类最常见的「不该留在日志里的东西」。
 *
 * 为什么不是「整段不存」：审计要看的就是「她当时怎么说的」，
 * 全删等于没有日志；而手机号、邮箱、证件号、卡号是**与判定无关**的部分，
 * 删掉它们不影响任何一次复盘。
 *
 * 顺序有讲究：先证件号（18 位）再卡号（16–19 位），否则 18 位会被卡号规则
 * 先咬掉一段，剩下的位数就对不上了。
 * @param text 原文。
 */
export function maskSensitive(text: string): { readonly text: string; readonly masked: boolean } {
  let masked = false
  let out = text

  const before = out
  out = out.replace(/\b(\d{6})\d{8}(\d{3}[\dXx])\b/g, '$1********$2')
  if (out !== before) masked = true

  const beforeCard = out
  out = out.replace(/\b(\d{4})\d{8,11}(\d{4})\b/g, '$1********$2')
  if (out !== beforeCard) masked = true

  const beforePhone = out
  out = out.replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2')
  if (out !== beforePhone) masked = true

  const beforeMail = out
  out = out.replace(
    /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    '$1***$2',
  )
  if (out !== beforeMail) masked = true

  return { text: out, masked }
}

/** 因子键的形状：小写开头，可用点、冒号、连字符、下划线。 */
const FACTOR_KEY_RE = /^[a-z][a-z0-9_.:-]{0,63}$/

/** 闸门名的形状（与插件名同口径，但不要求 `ondra-` 前缀）。 */
const GATE_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 允许的未来偏差。 */
const FUTURE_SKEW_MS = 10 * 60 * 1000

/** 读一个真时刻。 */
function stampOf(value: unknown, now: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return now
  const at = Math.trunc(value)
  if (at <= 0) return now
  if (at > now + FUTURE_SKEW_MS) return now
  return at
}

/** 读一个短字符串（洗净、截断）。 */
function shortOf(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return squeeze(value).slice(0, max)
}

/** 归一化上限。 */
export interface TraceLimits {
  /** 说出口那段最多多少字。 */
  readonly maxExcerptChars: number
  /** 最多几个因子。 */
  readonly maxFactors: number
  /** 最多几道闸。 */
  readonly maxGates: number
  /** 最多几个引用。 */
  readonly maxRefs: number
  /** 是否脱敏。 */
  readonly maskSensitive: boolean
  /** 是否存她说出口的那一段。 */
  readonly storeExcerpt: boolean
}

/** 归一化入参。 */
export interface NormalizeOptions extends TraceLimits {
  /** 当前时刻（补 `at` 用）。 */
  readonly now: number
  /** 进程内序号（拼 id 用）。 */
  readonly seq: number
}

/**
 * 归一化一个因子。**非法就丢这一条，不影响其它因子**。
 * @param raw 原始值。
 * @param limits 上限与脱敏开关。
 */
export function normalizeFactor(raw: unknown, limits: TraceLimits): TraceFactor | undefined {
  if (!isRecord(raw)) return undefined
  const key = shortOf(raw['key'], 64)
  if (!FACTOR_KEY_RE.test(key)) return undefined

  const out: {
    key: string
    value?: string | number | boolean
    weight?: number
    note?: string
  } = { key }

  const value = raw['value']
  if (typeof value === 'string') {
    const cleaned = shortOf(value, 80)
    if (cleaned !== '') out.value = limits.maskSensitive ? maskSensitive(cleaned).text : cleaned
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    out.value = value
  } else if (typeof value === 'boolean') {
    out.value = value
  }

  const weight = raw['weight']
  if (typeof weight === 'number' && Number.isFinite(weight)) {
    out.weight = Math.min(1, Math.max(-1, weight))
  }

  const note = shortOf(raw['note'], 120)
  if (note !== '') out.note = limits.maskSensitive ? maskSensitive(note).text : note

  return Object.freeze(out)
}

/**
 * 归一化一道闸门。`verdict` 不认识就丢。
 * @param raw 原始值。
 */
export function normalizeGate(raw: unknown): TraceGate | undefined {
  if (!isRecord(raw)) return undefined
  const name = shortOf(raw['name'], 64)
  if (!GATE_NAME_RE.test(name)) return undefined
  const verdict = raw['verdict']
  if (typeof verdict !== 'string') return undefined
  if (!(GATE_VERDICTS as readonly string[]).includes(verdict)) return undefined
  const reason = shortOf(raw['reason'], 120)
  const out: { name: string; verdict: GateVerdict; reason?: string } = {
    name,
    verdict: verdict as GateVerdict,
  }
  if (reason !== '') out.reason = reason
  return Object.freeze(out)
}

/** 归一化 `chosen`。全空时返回空对象。 */
function normalizeChosen(raw: unknown): TraceChosen {
  if (!isRecord(raw)) return Object.freeze({})
  const out: {
    register?: string
    stage?: string
    style?: string
    chars?: number
  } = {}
  const register = shortOf(raw['register'], 24)
  if (register !== '') out.register = register
  const stage = shortOf(raw['stage'], 24)
  if (stage !== '') out.stage = stage
  const style = shortOf(raw['style'], 24)
  if (style !== '') out.style = style
  const chars = raw['chars']
  if (typeof chars === 'number' && Number.isFinite(chars)) {
    out.chars = Math.min(1_000_000, Math.max(0, Math.trunc(chars)))
  }
  return Object.freeze(out)
}

/** 按 `|weight|` 降序排因子。权重相同保持原序。 */
export function sortFactors(factors: readonly TraceFactor[]): readonly TraceFactor[] {
  return [...factors].sort(
    (left, right) => Math.abs(right.weight ?? 0) - Math.abs(left.weight ?? 0),
  )
}

/**
 * 把一条入参归一化成记录。**永不抛错**。
 *
 * 拒收口径：不是对象；以及「一个可用字段都没有」——只有时间与 id 的记录
 * 对审计毫无用处，收下只会让面板出现一堆空条目。
 * @param raw 原始值。
 * @param options 上限、时刻与序号。
 */
export function normalizeTrace(raw: unknown, options: NormalizeOptions): TraceEntry | undefined {
  if (!isRecord(raw)) return undefined

  const at = stampOf(raw['at'], options.now)
  const seqText = Math.max(0, Math.trunc(options.seq)).toString(36)
  const turnIdRaw = shortOf(raw['turnId'], 64)
  const turnId = turnIdRaw === '' ? `t-${at.toString(36)}-${seqText}` : turnIdRaw
  const conversationId = shortOf(raw['conversationId'], 64)

  const producerRaw = shortOf(raw['producer'], 64)
  const producer = NAME_RE.test(producerRaw) ? producerRaw : ''

  const chosen = normalizeChosen(raw['chosen'])
  const chosenKeys = Object.keys(chosen)

  let trimmed = false
  const factors: TraceFactor[] = []
  const factorsRaw = raw['factors']
  if (Array.isArray(factorsRaw)) {
    for (const item of factorsRaw) {
      const factor = normalizeFactor(item, options)
      if (factor === undefined) continue
      factors.push(factor)
      if (factors.length >= options.maxFactors) {
        if (factorsRaw.length > options.maxFactors) trimmed = true
        break
      }
    }
  }

  const gates: TraceGate[] = []
  const gatesRaw = raw['gates']
  if (Array.isArray(gatesRaw)) {
    for (const item of gatesRaw) {
      const gate = normalizeGate(item)
      if (gate === undefined) continue
      gates.push(gate)
      if (gates.length >= options.maxGates) {
        if (gatesRaw.length > options.maxGates) trimmed = true
        break
      }
    }
  }

  const refs: string[] = []
  const refsRaw = raw['refs']
  if (Array.isArray(refsRaw)) {
    for (const item of refsRaw) {
      const ref = shortOf(item, 96)
      if (ref === '') continue
      refs.push(ref)
      if (refs.length >= options.maxRefs) {
        if (refsRaw.length > options.maxRefs) trimmed = true
        break
      }
    }
  }

  let excerpt = ''
  if (options.storeExcerpt) {
    const cleaned = shortOf(raw['excerpt'], 4000)
    const safe = options.maskSensitive ? maskSensitive(cleaned).text : cleaned
    const clipped = clipText(safe, options.maxExcerptChars)
    excerpt = clipped.text
    if (clipped.truncated) trimmed = true
  }

  const noteRaw = shortOf(raw['note'], 1000)
  const noteSafe = options.maskSensitive ? maskSensitive(noteRaw).text : noteRaw
  const noteClipped = clipText(noteSafe, 200)
  const note = noteClipped.text
  if (noteClipped.truncated) trimmed = true

  const hasContent =
    chosenKeys.length > 0 ||
    factors.length > 0 ||
    gates.length > 0 ||
    refs.length > 0 ||
    excerpt !== '' ||
    note !== ''
  if (!hasContent) return undefined

  return Object.freeze({
    version: TRACE_VERSION,
    id: `${at.toString(36)}-${seqText}`,
    at,
    turnId,
    conversationId,
    producer,
    chosen,
    factors: Object.freeze(sortFactors(factors)),
    gates: Object.freeze(gates),
    refs: Object.freeze(refs),
    excerpt,
    note,
    truncated: trimmed,
  })
}

/** 一个因子说成人话。 */
function factorText(factor: TraceFactor): string {
  const value = factor.value === undefined ? '' : ` = ${String(factor.value)}`
  const weight = factor.weight === undefined ? '' : `（权重 ${factor.weight.toFixed(2)}）`
  return `${factor.key}${value}${weight}`
}

/**
 * 把一条记录说成一句中文。
 *
 * **只给面板与审计**。这段文字里天然带计数（「拦了 2 处」），
 * 所以它**绝不允许**被拼进提示词——那会直接撞上禁止报数铁律。
 * @param entry 记录。
 */
export function explainOf(entry: TraceEntry): string {
  const parts: string[] = []
  const chosen = entry.chosen

  if (chosen.register !== undefined) parts.push(`语域「${chosen.register}」`)
  if (chosen.stage !== undefined) parts.push(`关系在「${chosen.stage}」`)
  if (chosen.style !== undefined) parts.push(`表达走「${chosen.style}」`)
  if (chosen.chars !== undefined) parts.push(`回了 ${chosen.chars} 字`)

  const top = sortFactors(entry.factors).slice(0, 3)
  if (top.length > 0) parts.push(`主要因为 ${top.map(factorText).join('、')}`)

  if (entry.gates.length > 0) {
    const blocked = entry.gates.filter(gate => gate.verdict !== 'pass')
    if (blocked.length === 0) {
      parts.push(`${entry.gates.length} 道闸全过`)
    } else {
      const detail = blocked
        .map(gate => {
          const reason = gate.reason === undefined ? '' : `（${gate.reason}）`
          return `${gate.name} ${VERDICT_ZH[gate.verdict]}${reason}`
        })
        .join('、')
      parts.push(`闸门：${detail}`)
    }
  }

  if (entry.refs.length > 0) parts.push(`引用了 ${entry.refs.length} 条依据`)

  if (parts.length === 0) return '她这一轮没留下判定因子（上游没交）'
  const head = entry.excerpt === '' ? '她这么回' : `她回了「${entry.excerpt}」`
  return `${head}：${parts.join('；')}。`
}
