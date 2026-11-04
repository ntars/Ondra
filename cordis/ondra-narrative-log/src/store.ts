/**
 * 落盘：一天一个 JSONL 文件，只追加。
 *
 * ## 为什么是 JSONL 而不是 SQLite
 *
 * 这份日志的用途是**事后追查**：`grep` 一句「昨天 14 点那次为什么冷淡」，
 * 或者在面板里翻最近几十条。JSONL 一行一条、追加不动旧行、坏一行不影响别的行；
 * 建表则要迁移、要索引、要跟 O-008 的库抢生命周期，而收益只是查询快一点。
 * 追查是低频动作，快一点不值这个复杂度。
 *
 * ## 为什么不做「写到一半断电」的修复
 *
 * 追加写一行通常原子（小于 PIPE_BUF 的单次 write），最坏情况是最后一行半截。
 * 读的时候**逐行解析、坏行跳过**即可——不需要 WAL、不需要临时文件。
 * 这与状态文件不同：状态文件是「覆盖」，半截就是全坏，所以那边必须 rename。
 */

import { appendFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { GATE_VERDICTS, TRACE_VERSION } from './types.js'
import type { GateVerdict, TraceChosen, TraceEntry, TraceFactor, TraceGate } from './types.js'

/** 日志子目录（落在 `user/` 下）。 */
export const LOG_DIR = 'narrative'

/** 一天的日期键格式。**只认这一种**，别的东西一律不碰。 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 文件名格式。`prune()` 只删匹配这个的文件。 */
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

/** 一天的文件名。 */
export function dayFileName(dayKey: string): string {
  return `${dayKey}.jsonl`
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读一个字符串（缺省空串）。 */
function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 读一个整数（缺省 0）。 */
function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

/** 复活一个因子。**认不出就丢**。 */
function reviveFactor(raw: unknown): TraceFactor | undefined {
  if (!isRecord(raw)) return undefined
  const key = textOf(raw['key'], 64)
  if (key === '') return undefined
  const out: { key: string; value?: string | number | boolean; weight?: number; note?: string } = { key }
  const value = raw['value']
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.value = value
  }
  if (typeof raw['weight'] === 'number' && Number.isFinite(raw['weight'])) {
    out.weight = raw['weight']
  }
  const note = textOf(raw['note'], 200)
  if (note !== '') out.note = note
  return Object.freeze(out)
}

/** 复活一道闸门。**认不出就丢**。 */
function reviveGate(raw: unknown): TraceGate | undefined {
  if (!isRecord(raw)) return undefined
  const name = textOf(raw['name'], 64)
  const verdict = textOf(raw['verdict'], 16)
  if (name === '') return undefined
  if (!(GATE_VERDICTS as readonly string[]).includes(verdict)) return undefined
  const reason = textOf(raw['reason'], 200)
  const out: { name: string; verdict: GateVerdict; reason?: string } = {
    name,
    verdict: verdict as GateVerdict,
  }
  if (reason !== '') out.reason = reason
  return Object.freeze(out)
}

/** 复活 `chosen`。 */
function reviveChosen(raw: unknown): TraceChosen {
  if (!isRecord(raw)) return Object.freeze({})
  const out: { register?: string; stage?: string; style?: string; chars?: number } = {}
  const register = textOf(raw['register'], 24)
  if (register !== '') out.register = register
  const stage = textOf(raw['stage'], 24)
  if (stage !== '') out.stage = stage
  const style = textOf(raw['style'], 24)
  if (style !== '') out.style = style
  if (typeof raw['chars'] === 'number' && Number.isFinite(raw['chars'])) {
    out.chars = Math.max(0, Math.trunc(raw['chars']))
  }
  return Object.freeze(out)
}

/**
 * 把一行解析结果复活成条目。**认不出返回 `undefined`**（坏行跳过）。
 * @param raw `JSON.parse` 的结果。
 */
export function reviveEntry(raw: unknown): TraceEntry | undefined {
  if (!isRecord(raw)) return undefined
  if (intOf(raw['version']) !== TRACE_VERSION) return undefined

  const id = textOf(raw['id'], 64)
  const turnId = textOf(raw['turnId'], 64)
  const at = intOf(raw['at'])
  if (id === '' || at <= 0) return undefined

  const factors: TraceFactor[] = []
  if (Array.isArray(raw['factors'])) {
    for (const item of raw['factors']) {
      const factor = reviveFactor(item)
      if (factor !== undefined) factors.push(factor)
    }
  }

  const gates: TraceGate[] = []
  if (Array.isArray(raw['gates'])) {
    for (const item of raw['gates']) {
      const gate = reviveGate(item)
      if (gate !== undefined) gates.push(gate)
    }
  }

  const refs: string[] = []
  if (Array.isArray(raw['refs'])) {
    for (const item of raw['refs']) {
      const ref = textOf(item, 96)
      if (ref !== '') refs.push(ref)
    }
  }

  return Object.freeze({
    version: TRACE_VERSION,
    id,
    at,
    turnId,
    conversationId: textOf(raw['conversationId'], 64),
    producer: textOf(raw['producer'], 64),
    chosen: reviveChosen(raw['chosen']),
    factors: Object.freeze(factors),
    gates: Object.freeze(gates),
    refs: Object.freeze(refs),
    excerpt: textOf(raw['excerpt'], 4000),
    note: textOf(raw['note'], 400),
    truncated: raw['truncated'] === true,
  })
}

/**
 * 追加一条。**会抛**（磁盘满、权限不对），由调用方折成 `write-failed`。
 * @param file 绝对路径。
 * @param entry 条目。
 */
export function appendEntry(file: string, entry: TraceEntry): void {
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' })
}

/**
 * 读一天的文件。
 * @param file 绝对路径。
 * @param limit 最多读几条（从最新往回取）；0 或省略表示全部。
 */
export function readDay(file: string, limit?: number): readonly TraceEntry[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return Object.freeze([])
  }

  const out: TraceEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      // 半截行（断电）或手改坏的行：跳过，不影响别的行。
      continue
    }
    const entry = reviveEntry(parsed)
    if (entry !== undefined) out.push(entry)
  }

  const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0
  return Object.freeze(cap > 0 ? out.slice(-cap) : out)
}

/**
 * 列出目录下所有日期文件（升序）。
 * @param dir 目录绝对路径。
 */
export function listDays(dir: string): readonly string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return Object.freeze([])
  }
  return Object.freeze(names.filter(name => FILE_RE.test(name)).sort())
}

/**
 * 删掉早于某一天的日志文件。**只删匹配 `YYYY-MM-DD.jsonl` 的文件**。
 *
 * 刻意不递归、不通配：这个目录是共享的 `user/`，一个 `rm -rf` 式的实现
 * 迟早会删到别人的东西。
 * @param dir 目录绝对路径。
 * @param beforeDayKey 早于这一天的都删（不含当天）。
 * @returns 删掉几个文件。
 */
export function pruneDays(dir: string, beforeDayKey: string): number {
  if (!DAY_RE.test(beforeDayKey)) return 0
  let removed = 0
  for (const name of listDays(dir)) {
    const day = name.slice(0, 10)
    if (day >= beforeDayKey) continue
    try {
      unlinkSync(join(dir, name))
      removed += 1
    } catch {
      // 删不掉就留着：保留期是清理动作，不是正确性要求。
    }
  }
  return removed
}
