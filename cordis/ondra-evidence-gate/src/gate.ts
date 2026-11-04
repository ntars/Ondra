/**
 * 门控本体：**纯函数，不碰 ctx、不碰库、不碰模型**。
 *
 * 判定顺序是刻意排的，不是随手写的。每一步都在回答「下一步还值不值得判」：
 *
 * ```
 * ① 正文非空 ──→ 空就直接拒（没有可判的东西）
 * ② 有没有引文 ──→ 一条都没有就直接拒（「无出处不入库」是红线）
 * ③ 引文本身站不站得住 ──→ 来源合法？够长？逐字可查？来源标对了？
 *                            逐条丢，不整条拒（手册：「逐字找不到的引文丢弃」）
 * ④ 还有存活引文吗 ──→ 全丢光了才拒（「没有存活引文的候选丢弃」）
 * ⑤ 数字有没有出处 ──→ 没有就剥（或整条拒）
 * ⑥ 归属站不站得住 ──→ 只有 SELF 说别人的事 → 种子；归功断言无 USER 引文 → 拒
 * ⑦ 截断 ──→ 最后才截，因为前六步都要看完整正文
 * ```
 *
 * ## 为什么③「逐条丢」而不是「一条不合格就整条拒」
 *
 * 模型给三条引文，两条真一条编，是**最常见**的形态。整条拒的后果是：一条真事实
 * 因为「模型多写了一句」而彻底消失，而用户只知道「她没记住」。逐条丢之后，
 * 存活的两条仍然能支撑这条事实——**该拦的拦住了，该记的记住了**。
 *
 * ## 为什么⑦截断放在最后
 *
 * 先截断会让「逐字可查」判在残缺文本上：`用户住在朝阳区三里屯 8 号楼` 截到
 * 200 字之后可能正好切在一个数字中间，于是数字覆盖判定拿到的游程是残的。
 * 顺序错一位，症状是「偶尔有一条记忆莫名其妙被剥了数字」——最难查的那种。
 */

import type { Config } from './settings.js'
import { allowedDigitSources, coveringSource, digitRuns, stripUncoveredClauses } from './digits.js'
import { asSource, isAttributionClaim, resolveSubject, SOURCE_PRIORITY } from './sources.js'
import { charCount, containsVerbatim, cutByCodepoints, normalizeQuote } from './text.js'
import type {
  DigitFinding,
  DroppedEvidence,
  EvidenceSource,
  GateAction,
  GateMaterial,
  GateReason,
  GateReasonCode,
  GateRequest,
  GateVerdict,
  KeptEvidence,
  LocateHit,
} from './types.js'

/** 预筛后的一条候选引文。 */
interface Candidate {
  /** 已解析的来源。 */
  readonly source: EvidenceSource
  /** 已归一化的引文。 */
  readonly quote: string
  /** 原始顺序（恢复顺序用）。 */
  readonly order: number
  /** 调用方给的素材下标提示。 */
  readonly hint: unknown
}

/** 定位结果。 */
interface LocateResult {
  /** 命中的素材下标。 */
  readonly materialIndex: number
  /** 该素材的来源标注（可能没有）。 */
  readonly source: EvidenceSource | undefined
}

/**
 * 在素材池里定位一条引文。
 *
 * 三段顺序，**顺序本身就是一个判定**：
 *
 * 1. 先试调用方给的下标（它离得最近、最可能是对的）。但只有当这条素材的来源
 *    与引文声明**不冲突**时才采纳——否则会漏掉下面第 2 步。
 * 2. 再找**同类来源**的素材。这一步不能省：同一句话常常同时出现在用户的话
 *    与她的回话里（「好的」「哈哈哈」「晚安」），只按「先找到谁算谁」，
 *    一条合法的 `[SELF]` 引文会因为先撞上 `[USER]` 素材而被判成「来源错标」丢掉。
 * 3. 最后才全量扫一遍——扫到了就说明**确实只在别类来源里**，那才是真错标。
 * @param quote 已归一化的引文。
 * @param materials 素材池。
 * @param hint 调用方给的下标提示。
 * @param prefer 引文声明的来源（`undefined` 表示不按来源挑）。
 */
function locateIn(
  quote: string,
  materials: readonly GateMaterial[],
  hint: unknown,
  prefer: EvidenceSource | undefined,
): LocateResult | undefined {
  if (typeof hint === 'number' && Number.isInteger(hint) && hint >= 0 && hint < materials.length) {
    const target = materials.at(hint)
    const compatible = target !== undefined && (prefer === undefined || target.source === undefined || target.source === prefer)
    if (target !== undefined && compatible && containsVerbatim(target.text, quote)) {
      return { materialIndex: hint, source: target.source }
    }
  }
  if (prefer !== undefined) {
    for (let index = 0; index < materials.length; index += 1) {
      const material = materials[index]
      if (material.source === prefer && containsVerbatim(material.text, quote)) {
        return { materialIndex: index, source: prefer }
      }
    }
  }
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index]
    if (containsVerbatim(material.text, quote)) {
      return { materialIndex: index, source: material.source }
    }
  }
  return undefined
}

/** 数字来源策略的中文名（拼进原因里，让人一眼看懂为什么被剥）。 */
function digitPolicyLabel(policy: Config['digitSource']): string {
  if (policy === 'tool-only') return 'TOOL'
  if (policy === 'tool-or-user') return 'TOOL/USER'
  return '任何'
}

/**
 * 只做逐字定位，不判定。给界面「这句话到底出自哪里」用。
 * @param quote 引文。
 * @param materials 素材池。
 */
export function locateQuote(quote: string, materials: readonly GateMaterial[]): LocateHit | undefined {
  const normalized = normalizeQuote(quote)
  if (normalized === '') return undefined
  const hit = locateIn(normalized, materials, undefined, undefined)
  if (hit === undefined) return undefined
  return hit.source === undefined ? { materialIndex: hit.materialIndex } : { materialIndex: hit.materialIndex, source: hit.source }
}

/**
 * 判定一条候选。**同步、纯函数、不抛错**（异常由调用方兜）。
 * @param request 请求。
 * @param settings 已补全的配置。
 */
export function judgeCandidate(request: GateRequest, settings: Config): GateVerdict {
  const reasons: GateReason[] = []
  const dropped: DroppedEvidence[] = []
  const materials = request.materials ?? []
  const rawEvidence = request.evidence ?? []

  /**
   * 组一个「拒」的结果。
   *
   * `digits` 可以后补：数字那一步已经算出了覆盖情况，拒掉时把它一起交出去，
   * 界面上才能说清「是哪几个数字没出处」，而不是只说一句「被拒了」。
   */
  const rejectWith = (
    code: GateReasonCode,
    detail: string,
    digits: readonly DigitFinding[] = [],
  ): GateVerdict =>
    Object.freeze({
      action: 'reject' as const,
      text: '',
      summary: '',
      evidence: Object.freeze([]) as readonly KeptEvidence[],
      dropped: Object.freeze(dropped) as readonly DroppedEvidence[],
      digits: Object.freeze([...digits]) as readonly DigitFinding[],
      reasons: Object.freeze([...reasons, { code, detail }]) as readonly GateReason[],
      truncated: false,
    })

  // ① 正文非空。
  const rawText = typeof request.text === 'string' ? request.text.trim() : ''
  if (rawText === '') return rejectWith('empty-text', '候选正文为空，没有可判定的东西')

  // ② 有没有引文。
  if (rawEvidence.length === 0) {
    return rejectWith('no-evidence', '一条引文都没带；无出处的记忆不入库（想法请进种子文件，那里不走这道闸）')
  }

  // ③ 预筛：来源合法 + 引文够长。这两条不需要素材，先筛掉能省一次全量扫描。
  const candidates: Candidate[] = []
  rawEvidence.forEach((item, order) => {
    const source = asSource(item.source)
    const quote = normalizeQuote(typeof item.quote === 'string' ? item.quote : '')
    if (source === undefined) {
      dropped.push({
        source: typeof item.source === 'string' ? item.source : '',
        quote: typeof item.quote === 'string' ? item.quote : '',
        code: 'bad-source',
        detail: `来源标记「${String(item.source)}」不是 USER / TOOL / ACT / SELF 之一`,
      })
      return
    }
    const minChars = Math.max(1, settings.minQuoteChars)
    if (charCount(quote) < minChars) {
      dropped.push({
        source,
        quote,
        code: 'quote-too-short',
        detail: `引文「${quote}」不足 ${minChars} 字，做不了证据`,
      })
      return
    }
    candidates.push({ source, quote, order, hint: item.materialIndex })
  })

  // ③b 引文条数上限：按 USER > TOOL > ACT > SELF 保留，再恢复原顺序。
  //     防的是「给 50 条引文，只要一条蒙中」这种凑数。
  let selected = candidates
  if (candidates.length > settings.maxEvidence) {
    const ranked = [...candidates].sort((left, right) => {
      const byPriority = SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source]
      return byPriority !== 0 ? byPriority : left.order - right.order
    })
    const keepOrders = new Set(ranked.slice(0, settings.maxEvidence).map(item => item.order))
    selected = candidates.filter(item => keepOrders.has(item.order))
    for (const item of candidates) {
      if (keepOrders.has(item.order)) continue
      dropped.push({
        source: item.source,
        quote: item.quote,
        code: 'too-many-quotes',
        detail: `一条候选最多 ${settings.maxEvidence} 条引文，这条被裁掉（优先保留 USER / TOOL）`,
      })
    }
    reasons.push({
      code: 'too-many-quotes',
      detail: `共 ${candidates.length} 条引文，只保留 ${settings.maxEvidence} 条`,
    })
  }

  // ③c 逐字定位 + 来源一致性。
  const kept: KeptEvidence[] = []
  for (const item of selected) {
    const located = locateIn(item.quote, materials, item.hint, item.source)
    if (located === undefined) {
      dropped.push({
        source: item.source,
        quote: item.quote,
        code: 'quote-not-verbatim',
        detail: `引文「${item.quote}」在素材里找不到（可以少标点，不可以改字）`,
      })
      continue
    }
    // 来源一致性：标成 A 类却只出现在 B 类素材里 → 丢。
    // 「归属错误比记不住更伤信任」（手册 §2.2）：把她的猜测标成「用户说过」，
    // 比这条根本没写进来危险得多。
    if (settings.strictSource && located.source !== undefined && located.source !== item.source) {
      dropped.push({
        source: item.source,
        quote: item.quote,
        code: 'source-mismatch',
        detail: `标成 ${item.source}，实际只出现在 ${located.source} 素材里（来源错标一律丢弃）`,
      })
      continue
    }
    kept.push({ source: item.source, quote: item.quote, materialIndex: located.materialIndex })
  }

  // ④ 还有存活引文吗。
  if (kept.length === 0) {
    return rejectWith(
      'all-quotes-dropped',
      `带来的 ${rawEvidence.length} 条引文全部被丢掉（${dropped.map(item => item.code).join('、')}）；没有存活引文的候选丢弃`,
    )
  }

  // ⑤ 数字。
  const findings: DigitFinding[] = []
  let workingText = rawText
  let action: GateAction = 'accept'
  if (settings.digitSource !== 'off') {
    const allowed = allowedDigitSources(settings.digitSource)
    const uncovered: string[] = []
    for (const run of digitRuns(rawText)) {
      const cover = coveringSource(run, kept, allowed)
      findings.push({ run, coveredBy: cover ?? null })
      if (cover === undefined && !uncovered.includes(run)) uncovered.push(run)
    }
    if (uncovered.length > 0) {
      const digits = uncovered.join('、')
      if (settings.unbackedDigitAction === 'reject') {
        return rejectWith(
          'digit-uncovered',
          `正文里的数字「${digits}」没有 ${digitPolicyLabel(settings.digitSource)} 引文覆盖；口述数字不入库`,
          findings,
        )
      }
      const stripped = stripUncoveredClauses(rawText, uncovered)
      if (stripped.text.trim() === '') {
        return rejectWith(
          'empty-after-strip',
          `数字「${digits}」没有出处，剥掉含它的分句后正文什么都不剩了`,
          findings,
        )
      }
      workingText = stripped.text
      action = 'strip'
      reasons.push({
        code: 'digit-uncovered',
        detail: `数字「${digits}」没有 ${digitPolicyLabel(settings.digitSource)} 引文覆盖，已剥掉含它的分句`,
      })
    }
  }

  // ⑥ 归属。两道闸：一道看声明（`subject`），一道看正文（归功动词）。
  const subject = resolveSubject(request.subject)
  const hasUser = kept.some(item => item.source === 'USER')
  const hasSelfOrAct = kept.some(item => item.source === 'SELF' || item.source === 'ACT')
  const selfOnly = kept.every(item => item.source === 'SELF')

  // ⑥a 只有 SELF 引文、说的却是别人的事 —— 「想法进种子，不进记忆库」。
  //     这一支必须排在 ⑥b 之前：SELF-only 是 ⑥b 的子集，先判 ⑥b 会让 `seed` 永远走不到。
  let seeded = false
  if (selfOnly && subject !== 'self') {
    if (settings.selfOnlyAction === 'reject') {
      return rejectWith(
        'self-only-bare-fact',
        `主体是「${subject}」但只有 SELF 引文：她自己想到的事不能当事实入库`,
      )
    }
    seeded = true
    action = 'seed'
    reasons.push({
      code: 'self-only-bare-fact',
      detail: `主体是「${subject}」但只有 SELF 引文；按「想法进种子文件、不进记忆库」处理`,
    })
  }

  // `seed` 之后不再跑归功闸：种子本来就进不了记忆库，而 ⑥c 要防的是**记忆被污染**。
  // 反过来说，靠正文动词区分「她的假设」与「她替用户说话」是做不到的——
  // 「我觉得用户可能喜欢猫」与「用户答应了周末吃饭」在字面上都带用户标记 + 归功动词，
  // 一个该进种子、一个该拒。既然 seed 的落点根本不在记忆库，让它一律走 seed 是安全的；
  // 真有人把 `seed` 当 `accept` 用，`stats().byAction.seed` 会让这件事立刻显形。
  if (!seeded) {
    // ⑥b 关于别人的断言，不能只从她自己的话或动作里来（与 O-011 同一口径）。
    if (subject !== 'self' && !hasUser && hasSelfOrAct) {
      return rejectWith(
        'attribution-without-user',
        `主体是「${subject}」但只有 SELF/ACT 引文：这是从她自己的话推断用户的事，必须有 USER 引文`,
      )
    }
    // ⑥c 文本级归功：字段可以填对，正文照样能替用户说话。
    //     这里**刻意不判 `subject`**：`subject` 是模型填的字段，它完全可以写 `self`
    //     而正文写着「用户答应周末一起吃饭」。手册原话「把决定归功于人类但没有
    //     USER 引文的，最后一道门拒绝」也没有 subject 条件——判的是**正文在替谁说话**。
    if (settings.strictAttribution && !hasUser && isAttributionClaim(workingText)) {
      return rejectWith(
        'attribution-without-user',
        `正文在替「${subject}」说话（含用户标记 + 归功动词），却没有 USER 引文`,
      )
    }
  }

  // ⑦ 截断（放在最后：前六步都要看完整正文）。
  const textTruncated = charCount(workingText) > settings.maxTextChars
  const finalText = cutByCodepoints(workingText, settings.maxTextChars)
  if (textTruncated) {
    reasons.push({
      code: 'text-truncated',
      detail: `正文 ${charCount(workingText)} 字，超过 ${settings.maxTextChars} 字已截断`,
    })
  }
  const rawSummary = typeof request.summary === 'string' ? request.summary.trim() : ''
  const summarySource = rawSummary === '' ? finalText : rawSummary
  const summaryTruncated = rawSummary !== '' && charCount(rawSummary) > settings.maxSummaryChars
  const finalSummary = cutByCodepoints(summarySource, settings.maxSummaryChars)
  if (summaryTruncated) {
    reasons.push({
      code: 'summary-truncated',
      detail: `摘要 ${charCount(rawSummary)} 字，超过 ${settings.maxSummaryChars} 字已截断`,
    })
  }

  return Object.freeze({
    action,
    text: finalText,
    summary: finalSummary,
    evidence: Object.freeze(kept) as readonly KeptEvidence[],
    dropped: Object.freeze(dropped) as readonly DroppedEvidence[],
    digits: Object.freeze(findings) as readonly DigitFinding[],
    reasons: Object.freeze(reasons) as readonly GateReason[],
    truncated: textTruncated || summaryTruncated,
  })
}
