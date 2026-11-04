/**
 * 解析：**五级兜底**（master-plan L2「LLM 提炼 + 五级解析兜底」）。
 *
 * 为什么要五级而不是「JSON.parse 一把梭」：模型输出 JSON 的服从度在 90% 上下，
 * 剩下 10% 的形态是固定的几种——带代码块围栏、带前言「好的，以下是…」、写成列表、
 * 写成键值对。把它们逐层兜住，比在提示词里反复强调「只输出 JSON」有效得多
 * （提示词已经强调了，但它不总是听）。
 *
 * 五级的顺序是**从严到宽**，每一级都要求「结构完整」才采纳：
 *
 * | 级 | 形态 | 采纳条件 |
 * |---|---|---|
 * | 1 `strict-json` | `{"facts":[…]}` 或 `[…]` | 能 `JSON.parse` 且取出数组 |
 * | 2 `fenced-json` | ```` ```json … ``` ```` | 围栏内能 parse |
 * | 3 `line` | `- [person] 用户怕狗 \| [USER]「我怕狗」` | 至少一行有正文 |
 * | 4 `key-value` | 空行分块，每块 `text:` / `category:` / `quote:` | 至少一块有 `text` |
 * | 5 `none` | 什么都没解析出来 | 返回空数组，**不抛错** |
 *
 * 第 5 级返回空数组而不是抛错，是刻意的：提炼失败不该让对话链断掉，
 * 而「今天没记住什么」和「今天记住了零条」在结果里必须能区分——
 * 靠 `path === 'none'` 区分。
 */

import type { ParsePath } from './types.js'

/** 模型原始输出里的一条候选（字段全是 `unknown`，校验在 `verify.ts`）。 */
export interface RawEvidence {
  readonly source?: unknown
  readonly quote?: unknown
  readonly messageIndex?: unknown
}

/** 一条未校验的候选。 */
export interface RawCandidate {
  readonly kind?: unknown
  readonly category?: unknown
  readonly text?: unknown
  readonly summary?: unknown
  readonly subject?: unknown
  readonly salience?: unknown
  readonly evidence?: readonly RawEvidence[]
}

/** 解析结果。 */
export interface ParseOutcome {
  /** 候选列表。 */
  readonly candidates: readonly RawCandidate[]
  /** 走通的路径。 */
  readonly path: ParsePath
}

/** 空结果。 */
const EMPTY: ParseOutcome = Object.freeze({ candidates: Object.freeze([]), path: 'none' as ParsePath })

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从任意 JSON 值里取出候选数组。
 *
 * 认三种形状：`{facts:[…]}`（提示词要求的）、`{items:[…]}`（模型偶尔改名）、
 * 裸数组（模型省掉了外层对象）。
 * @param value 已 parse 的值。
 */
function candidatesOf(value: unknown): RawCandidate[] | undefined {
  const array = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value['facts'])
      ? value['facts']
      : isRecord(value) && Array.isArray(value['items'])
        ? value['items']
        : undefined
  if (array === undefined) return undefined

  const out: RawCandidate[] = []
  for (const item of array) {
    if (!isRecord(item)) continue
    const evidenceRaw = item['evidence']
    const evidence: RawEvidence[] = []
    if (Array.isArray(evidenceRaw)) {
      for (const entry of evidenceRaw) {
        if (!isRecord(entry)) continue
        evidence.push({ source: entry['source'], quote: entry['quote'], messageIndex: entry['messageIndex'] })
      }
    }
    out.push({
      kind: item['kind'],
      category: item['category'],
      text: item['text'],
      summary: item['summary'],
      subject: item['subject'],
      salience: item['salience'],
      evidence: Object.freeze(evidence),
    })
  }
  return out
}

/** 尝试 parse 一段文本为 JSON 值。 */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 取第一个代码块的内容。 */
function fencedBody(text: string): string | undefined {
  const match = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text)
  return match?.[1]?.trim()
}

/** 行式解析里的一条证据标记：`[USER]「…」`。 */
const INLINE_EVIDENCE = /\[(USER|TOOL|ACT|SELF)\]\s*(?:"([^"]*)"|“([^”]*)”|「([^」]*)」|'([^']*)')/g

/**
 * 第 3 级：行式解析。
 *
 * 认两种写法（模型最常写的两种）：
 * - `- [person] 用户怕狗 | [USER]「我怕狗」`
 * - `- 用户怕狗 [USER]「我怕狗」`
 * @param text 原始输出。
 */
function parseLines(text: string): RawCandidate[] {
  const out: RawCandidate[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('```')) continue
    const isBullet = /^[-*·•]\s*/.test(line)
    // 不以列表符号开头的行，只在含证据标记时才收——否则「好的，以下是提炼结果：」也会成一条事实。
    if (!isBullet && !/\[(USER|TOOL|ACT|SELF)\]/.test(line)) continue
    const stripped = isBullet ? line.replace(/^[-*·•]\s*/, '') : line

    const evidence: RawEvidence[] = []
    INLINE_EVIDENCE.lastIndex = 0
    let match = INLINE_EVIDENCE.exec(stripped)
    let firstIndex = -1
    while (match !== null) {
      if (firstIndex < 0) firstIndex = match.index
      const quote = match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''
      evidence.push({ source: match[1], quote })
      match = INLINE_EVIDENCE.exec(stripped)
    }

    let body = firstIndex >= 0 ? stripped.slice(0, firstIndex) : stripped
    body = body.replace(/\|\s*$/, '').trim()

    let category: string | undefined
    const categoryMatch = /^\[([a-z]+)\]\s*/.exec(body)
    if (categoryMatch?.[1] !== undefined) {
      category = categoryMatch[1]
      body = body.slice(categoryMatch[0].length).trim()
    }

    if (body === '') continue
    out.push({ text: body, category, evidence: Object.freeze(evidence) })
  }
  return out
}

/** 第 4 级：键值对分块解析。 */
function parseKeyValue(text: string): RawCandidate[] {
  const blocks = text.split(/\r?\n\s*\r?\n|^---$/m)
  const out: RawCandidate[] = []
  for (const block of blocks) {
    const fields: Record<string, string> = {}
    const evidence: RawEvidence[] = []
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^[-*·•]\s*/, '')
      const pair = /^([A-Za-z_]+)\s*[:：]\s*(.*)$/.exec(line)
      if (pair === null) continue
      const key = (pair[1] ?? '').toLowerCase()
      const value = (pair[2] ?? '').trim()
      if (key === 'quote' || key === '引文') {
        evidence.push({ source: fields['source'] ?? fields['来源'] ?? 'USER', quote: value })
        continue
      }
      if (value !== '') fields[key] = value
    }
    const body = fields['text'] ?? fields['正文']
    if (body === undefined || body === '') continue
    out.push({
      text: body,
      category: fields['category'] ?? fields['类别'],
      kind: fields['kind'] ?? fields['种类'],
      summary: fields['summary'] ?? fields['摘要'],
      subject: fields['subject'] ?? fields['主体'],
      evidence: Object.freeze(evidence),
    })
  }
  return out
}

/**
 * 五级解析。
 * @param raw 模型原始输出。
 */
export function parseExtraction(raw: string): ParseOutcome {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return EMPTY

  // 第 1 级：整段就是 JSON。
  const strict = candidatesOf(tryJson(text))
  if (strict !== undefined && strict.length > 0) {
    return { candidates: Object.freeze(strict), path: 'strict-json' }
  }
  // 空的 `{"facts":[]}` 是**正确答案**，不是解析失败——必须在这一级就认出来，
  // 否则会掉到行式解析，把提示词里那句 `{"facts":[]}` 当成一条事实。
  if (strict !== undefined) {
    return { candidates: Object.freeze([]), path: 'strict-json' }
  }

  // 第 2 级：代码块里的 JSON。
  const fenced = fencedBody(text)
  if (fenced !== undefined) {
    const parsed = candidatesOf(tryJson(fenced))
    if (parsed !== undefined) {
      return { candidates: Object.freeze(parsed), path: 'fenced-json' }
    }
  }

  // 第 3 级：行式。
  const lines = parseLines(text)
  if (lines.length > 0) return { candidates: Object.freeze(lines), path: 'line' }

  // 第 4 级：键值对。
  const keyValue = parseKeyValue(text)
  if (keyValue.length > 0) return { candidates: Object.freeze(keyValue), path: 'key-value' }

  return EMPTY
}
