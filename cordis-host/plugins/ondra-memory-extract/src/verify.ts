/**
 * 证据校验：**确定性代码闸门**（手册 §2.2）。
 *
 * 提示词写「必须逐字引用」是没用的——模型会把「逐字」理解成「差不多」。
 * 所以这里做三件确定性检查，每一件都对应提示词里的一条规则：
 *
 * | 检查 | 对应规则 | 拒绝码 |
 * |---|---|---|
 * | 引文必须是原文的子串 | 必须逐字相同 | `quote-not-verbatim` |
 * | 数字必须被 TOOL 引文覆盖 | 数字必须有工具来源 | `digit-without-tool` |
 * | 关于别人的断言必须有 USER 引文 | 归属纪律 | `attribution-without-user` |
 *
 * ## 归一化到什么程度（这是本文件最容易搞错的地方）
 *
 * 比对前做三件事：**NFKC 归一**（全角→半角）、**折叠空白**、**去掉引文首尾标点**。
 *
 * 为什么不做更多：一旦把「所有标点都删掉」，`我不去` 就能匹配到 `我，不去`，
 * 两句话意思不同却都通过——闸门就从「防编造」变成了「防不住」。
 * 允许的只有「模型少抄了个句号」这一类，不允许改字、不允许跨句拼接。
 *
 * ## 为什么归属检查要加「有 SELF/ACT 引文」这个条件
 *
 * 「无 [USER] 引文的归功断言拒绝」直译成「subject≠self 且无 USER 就拒」会误杀
 * 一类正常事实：天气、时间这类从 TOOL 拿到的客观信息，本来就没有 USER 引文。
 * 真正的「归功」是**从她自己的话或动作里推断出用户的事**（她说「你昨天说腰疼」
 * 然后记成「用户腰疼」）——那才需要 USER 引文兜底。故条件收窄为：
 * `subject≠self` 且 **没有 USER** 且 **有 SELF 或 ACT**。
 */

import { charCount, cutByCodepoints } from './text.js'
import { EVIDENCE_SOURCES, EXTRACT_CATEGORIES, EXTRACT_KINDS } from './types.js'
import type {
  Evidence,
  EvidenceSource,
  ExtractCategory,
  ExtractedFact,
  ExtractKind,
  RejectionCode,
  TurnMessage,
} from './types.js'
import type { RawCandidate } from './parse.js'

/** 校验需要的配置子集。 */
export interface VerifySettings {
  /** 正文上限（字）。 */
  readonly maxTextChars: number
  /** 摘要上限（字）。 */
  readonly maxSummaryChars: number
  /** 引文最短字数。 */
  readonly minQuoteChars: number
  /** 数字是否必须有 TOOL 来源。 */
  readonly requireToolForDigits: boolean
}

/** 校验结果：要么给一条事实，要么给一条拒绝。**不会两者都有**。 */
export type VerifyOutcome =
  | { readonly fact: ExtractedFact; readonly rejection?: undefined }
  | { readonly fact?: undefined; readonly rejection: { readonly code: RejectionCode; readonly detail: string } }

/** 引文首尾要去掉的标点（只去首尾，不动中间）。 */
const EDGE_PUNCTUATION = /^[\s，。、；：！？,.;:!?…—\-"'“”「」『』（）()]+|[\s，。、；：！？,.;:!?…—\-"'“”「」『』（）()]+$/g

/**
 * 比对用的归一化。
 *
 * **不做小写化**：中文没有大小写，而英文专名（GitHub / github）大小写本身就是信息。
 * @param text 原文。
 */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 引文比对用的归一化：在 `normalizeForMatch` 之上再去掉首尾标点。 */
export function normalizeQuote(text: string): string {
  return normalizeForMatch(text).replace(EDGE_PUNCTUATION, '')
}

/**
 * 找出正文里的数字游程（含小数）。
 *
 * 全角数字先经 NFKC 归一成半角，所以 `３` 与 `3` 同等对待。
 * @param text 正文。
 */
export function digitRuns(text: string): readonly string[] {
  const normalized = text.normalize('NFKC')
  const found = normalized.match(/\d+(?:[.,]\d+)?/g)
  return found === null ? [] : Object.freeze([...found])
}

/** 判一个值是不是四类来源之一。 */
function asSource(value: unknown): EvidenceSource | undefined {
  return typeof value === 'string' && (EVIDENCE_SOURCES as readonly string[]).includes(value.toUpperCase())
    ? (value.toUpperCase() as EvidenceSource)
    : undefined
}

/** 判一个值是不是 11 类之一。 */
function asCategory(value: unknown): ExtractCategory | undefined {
  return typeof value === 'string' && (EXTRACT_CATEGORIES as readonly string[]).includes(value)
    ? (value as ExtractCategory)
    : undefined
}

/** 判一个值是不是五类之一。 */
function asKind(value: unknown): ExtractKind | undefined {
  return typeof value === 'string' && (EXTRACT_KINDS as readonly string[]).includes(value)
    ? (value as ExtractKind)
    : undefined
}

/**
 * 校验一条候选。
 * @param raw 未校验候选。
 * @param messages 本轮消息（引文只能来自这里）。
 * @param settings 配置子集。
 */
export function verifyCandidate(
  raw: RawCandidate,
  messages: readonly TurnMessage[],
  settings: VerifySettings,
): VerifyOutcome {
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (text === '') {
    return { rejection: { code: 'empty-text', detail: '候选正文为空' } }
  }

  // 类别决定寿命：**给错就拒**（猜错等于让这条记忆提前死掉，而且死得毫无声响）。
  // 但**缺失走 `misc`**——行式解析天然不产出类别，若缺失也拒，第三级兜底就整段失效，
  // 一条真事实会因为「模型少写一个字段」而彻底消失。代价是这类事实按 20 小时基线算，
  // 会较快变暗（见 README 已知限制 6）。
  let category: ExtractCategory = 'misc'
  if (raw.category !== undefined && raw.category !== '') {
    const parsedCategory = asCategory(raw.category)
    if (parsedCategory === undefined) {
      return {
        rejection: {
          code: 'bad-category',
          detail: `类别「${String(raw.category)}」不在 11 类里（类别决定寿命，不能猜）`,
        },
      }
    }
    category = parsedCategory
  }

  // 种类只是标签，缺失走默认；**给了但不对**才拒——「缺失」与「给错」是两件事。
  let kind: ExtractKind = 'fact'
  if (raw.kind !== undefined && raw.kind !== '') {
    const parsed = asKind(raw.kind)
    if (parsed === undefined) {
      return { rejection: { code: 'bad-kind', detail: `种类「${String(raw.kind)}」不在五类里` } }
    }
    kind = parsed
  }

  const rawEvidence = raw.evidence ?? []
  if (rawEvidence.length === 0) {
    return { rejection: { code: 'no-evidence', detail: '没有任何引文；无出处的记忆不入库' } }
  }

  const evidence: Evidence[] = []
  for (const entry of rawEvidence) {
    const source = asSource(entry.source)
    if (source === undefined) {
      return {
        rejection: {
          code: 'no-evidence',
          detail: `引文来源「${String(entry.source)}」不在 ${EVIDENCE_SOURCES.join('/')} 里`,
        },
      }
    }
    const quoteRaw = typeof entry.quote === 'string' ? entry.quote : ''
    const quote = normalizeQuote(quoteRaw)
    if (quote === '') {
      return { rejection: { code: 'no-evidence', detail: '有一条引文内容为空' } }
    }
    if (charCount(quote) < Math.max(1, settings.minQuoteChars)) {
      return {
        rejection: {
          code: 'quote-too-short',
          detail: `引文「${quote}」不足 ${Math.max(1, settings.minQuoteChars)} 字，做不了证据`,
        },
      }
    }

    // 逐字校验：引文必须能在本轮某条消息里找到。
    const located = locate(quote, messages, entry.messageIndex)
    if (located === undefined) {
      return {
        rejection: {
          code: 'quote-not-verbatim',
          detail: `引文「${quote}」在本轮原文里找不到（可以少标点，不可以改字）`,
        },
      }
    }
    evidence.push({ source, quote, messageIndex: located })
  }

  // 数字必须有工具来源。
  if (settings.requireToolForDigits) {
    const runs = digitRuns(text)
    if (runs.length > 0) {
      const toolText = evidence
        .filter(item => item.source === 'TOOL')
        .map(item => normalizeForMatch(item.quote))
        .join(' ')
      const uncovered = runs.filter(run => !toolText.includes(run.normalize('NFKC')))
      if (uncovered.length > 0) {
        return {
          rejection: {
            code: 'digit-without-tool',
            detail: `正文里的数字「${uncovered.join('、')}」没有 TOOL 引文覆盖（口述数字不入库）`,
          },
        }
      }
    }
  }

  // 归属纪律：关于别人的断言，不能只从她自己的话里来。
  const subject = typeof raw.subject === 'string' && raw.subject.trim() !== '' ? raw.subject.trim() : 'user'
  const hasUser = evidence.some(item => item.source === 'USER')
  const hasSelfOrAct = evidence.some(item => item.source === 'SELF' || item.source === 'ACT')
  if (subject !== 'self' && !hasUser && hasSelfOrAct) {
    return {
      rejection: {
        code: 'attribution-without-user',
        detail: `主体是「${subject}」但只有 SELF/ACT 引文：这是从她自己的话推断用户的事，必须有 USER 引文`,
      },
    }
  }

  const finalText = cutByCodepoints(text, settings.maxTextChars)
  const rawSummary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  const summary = cutByCodepoints(rawSummary === '' ? finalText : rawSummary, settings.maxSummaryChars)

  const hint = raw.salience
  const salienceHint =
    typeof hint === 'number' && Number.isFinite(hint) ? Math.min(100, Math.max(0, hint)) : undefined

  return {
    fact: Object.freeze({
      kind,
      category,
      text: finalText,
      summary,
      subject,
      evidence: Object.freeze(evidence),
      ...(salienceHint === undefined ? {} : { salienceHint }),
    }),
  }
}

/**
 * 在消息里定位引文。
 *
 * 先试模型给的下标（它离得最近、最可能是对的），再全量扫一遍——
 * 下标错了不该让一条真引文被拒，但**引文本身找不到就一定拒**。
 * @param quote 已归一化的引文。
 * @param messages 消息列表。
 * @param hint 模型给的下标。
 * @returns 命中的消息下标；找不到返回 `undefined`。
 */
function locate(quote: string, messages: readonly TurnMessage[], hint: unknown): number | undefined {
  if (typeof hint === 'number' && Number.isInteger(hint) && hint >= 0 && hint < messages.length) {
    const target = messages[hint]
    if (target !== undefined && normalizeForMatch(target.text).includes(quote)) return hint
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message !== undefined && normalizeForMatch(message.text).includes(quote)) return index
  }
  return undefined
}
