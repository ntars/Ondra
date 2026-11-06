/**
 * 数字的出处检查与「剥离」。
 *
 * 手册 §2.2 的原话是「**数字必须有 `[TOOL]` 来源**」，语料（第十三部分 B 节）
 * 又写「没有 `[TOOL]` 支撑的数字**被剥离**」。一个说必须有，一个说剥掉。
 * 本文件把两句话拆成两个独立决定：
 *
 * | 决定 | 落在哪儿 | 默认值 |
 * |---|---|---|
 * | 哪些来源算「有出处」 | `settings.digitSource` | `tool-or-user`（见下） |
 * | 没出处时剥还是整条拒 | `settings.unbackedDigitAction` | `strip` |
 *
 * ## 为什么默认不是 `tool-only`（本轮最重要的一处口径偏离，已登记待裁决）
 *
 * 按手册字面，只有 `[TOOL]` 能覆盖数字。但这条规则的出处是一个**工程 agent**
 * （distill-kura），它的数字几乎全来自命令输出；而本产品是伴侣，用户最该被记住的
 * 数字恰恰来自**他自己的嘴**：
 *
 * - 「我今年 28 岁」→ 只有 `[USER]` 引文；
 * - 「周五考试」→ 只有 `[USER]` 引文；
 * - 「我住 3 号楼」→ 只有 `[USER]` 引文。
 *
 * 按 `tool-only` 执行，这三条会被整句剥空（单分句时直接整条拒）。这不是「防幻觉」，
 * 这是把她最该记住的东西按规则删掉——而且删得毫无声响。
 *
 * 关键区别在于：**逐字出现在 `[USER]` 引文里的数字，本身就不是编造的**。
 * 手册要防的是「她凭印象写下一个数」，而「有出处」这件事 USER 与 TOOL 同样能给。
 * 所以默认 `tool-or-user`；要严格照手册字面，把 `digitSource` 改成 `tool-only`
 * 即可，代码一行不用动。
 *
 * **代价（如实写在这里）**：`[USER]` 覆盖会放过「用户说过『我 28』而候选写成
 * 『用户 28 岁』」这类**改写**——数字对、语境可能不对。这条只能靠 O-012 的判重
 * 与 O-017 的审计兜，本文件兜不住。
 */

import type { EvidenceSource, KeptEvidence } from './types.js'
import type { Clause } from './text.js'
import { joinClauses, normalizeForMatch, splitClauses } from './text.js'

/** 数字来源策略。 */
export type DigitSourcePolicy = 'tool-or-user' | 'tool-only' | 'off'

/**
 * 找出正文里的数字游程（含小数与千分位）。
 *
 * 全角数字先经 NFKC 归一成半角，所以 `２８` 与 `28` 同等对待。
 * @param text 正文。
 */
export function digitRuns(text: string): readonly string[] {
  const normalized = text.normalize('NFKC')
  const found = normalized.match(/\d+(?:[.,]\d+)?/g)
  return found === null ? [] : [...found]
}

/**
 * 某个策略下「哪些来源可以覆盖数字」。
 * @param policy 策略。
 */
export function allowedDigitSources(policy: DigitSourcePolicy): readonly EvidenceSource[] {
  if (policy === 'off') return []
  if (policy === 'tool-only') return ['TOOL']
  return ['TOOL', 'USER']
}

/**
 * 素材里是否**作为独立数字**出现这个游程。
 *
 * 不能直接用 `includes`：正文写「28 岁」而引文里只有「1280」时，
 * `'1280'.includes('28')` 为真，于是编造的数字被一个无关的长数字「覆盖」了。
 * 这类假通过比拒绝更危险——它让人以为闸门在工作。
 * @param haystack 已归一化的素材。
 * @param run 数字游程。
 */
function containsDigitRun(haystack: string, run: string): boolean {
  let from = 0
  for (;;) {
    const at = haystack.indexOf(run, from)
    if (at < 0) return false
    const before = at === 0 ? '' : haystack.charAt(at - 1)
    const after = haystack.charAt(at + run.length)
    if (!/[0-9]/.test(before) && !/[0-9]/.test(after)) return true
    from = at + 1
  }
}

/**
 * 找出覆盖某个数字的引文来源。
 * @param run 数字游程。
 * @param evidence 存活引文。
 * @param allowed 允许的来源。
 * @returns 覆盖它的来源；没有则 `undefined`。
 */
export function coveringSource(
  run: string,
  evidence: readonly KeptEvidence[],
  allowed: readonly EvidenceSource[],
): EvidenceSource | undefined {
  if (allowed.length === 0) return undefined
  const needle = run.normalize('NFKC')
  for (const item of evidence) {
    if (!allowed.includes(item.source)) continue
    if (containsDigitRun(normalizeForMatch(item.quote), needle)) return item.source
  }
  return undefined
}

/** 剥离结果。 */
export interface StripResult {
  /** 剥离后的正文。 */
  readonly text: string
  /** 被剥掉的数字。 */
  readonly stripped: readonly string[]
}

/**
 * 剥掉含「无出处数字」的分句。
 *
 * 为什么不只删数字：`我今年 28 岁` 删成 `我今年岁` 是一句病句，读起来像模型坏了。
 * 删**分句**（以句读标点为界）才读得通。
 *
 * 为什么末句要还标点：`很高兴，考了 92 分。` 剥掉末句会留下 `很高兴，`——
 * 一个悬空逗号。把原末句的句末标点还给新的末句，结果才是 `很高兴。`
 * @param text 正文。
 * @param uncovered 无出处的数字。
 */
export function stripUncoveredClauses(text: string, uncovered: readonly string[]): StripResult {
  if (uncovered.length === 0) return { text, stripped: [] }
  const clauses = splitClauses(text)
  const kept: Clause[] = []
  const stripped: string[] = []
  for (const clause of clauses) {
    const runs = digitRuns(clause.text)
    const hit = runs.filter(run => uncovered.includes(run))
    if (hit.length > 0) {
      stripped.push(...hit)
      continue
    }
    kept.push(clause)
  }
  const lastClause = clauses.at(-1)
  const lastKept = kept.at(-1)
  if (lastClause !== undefined && lastKept !== undefined && lastClause !== lastKept) {
    kept[kept.length - 1] = { text: lastKept.text, tail: lastClause.tail }
  }
  return { text: joinClauses(kept), stripped }
}
