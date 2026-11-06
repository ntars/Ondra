/**
 * 链路结晶 —— 把「走过两遍的同一条路」记成一条 skill 候选。
 *
 * ## 为什么是「候选」而不是「skill」
 *
 * 因为本包零模型调用，它没有能力写出一段说明。它能给的只有**结构**：
 * 哪几个工具、按什么顺序、走过几次。把它直接写成一条 skill，等于给出一个
 * 没有一句人话的空壳，然后所有消费方都得猜它是什么意思。
 *
 * 所以本包交出 `SkillCandidate`：名字（确定性指纹）、序列、次数、跨了几个器官。
 * **谁来写成 skill、写成什么措辞，是别人的事**（O-015 记忆写入 / 应用外壳的
 * 学习视图）。这样「零模型调用」这条硬约束才守得住。
 *
 * ## 三条门槛，每一条都在挡一类假阳性
 *
 * | 门槛 | 挡掉什么 |
 * |---|---|
 * | `min-steps`（手册 3） | 两步的「先读后写」是最常见的偶然搭配，不是方法 |
 * | `min-tools 2` | 同一个工具连调三次只是重复劳动，固化成 skill 等于教她背口诀 |
 * | `min-repeats 2` | 一次走通很可能只是用户这次正好这么问（手册 §2.A 的 playbook 口径） |
 */

import { candidateSlugOf, signatureOf } from './naming.js'
import type { ChainSummary, SkillCandidate } from './types.js'

/** 结晶门槛。 */
export interface CrystallizeOptions {
  /** 至少几步。 */
  readonly minSteps: number
  /** 至少跨几个工具。 */
  readonly minTools: number
  /** 至少重复几次。 */
  readonly minRepeats: number
  /** 签名取前几步。 */
  readonly signatureSteps: number
  /** 候选上限。 */
  readonly maxCandidates: number
}

/** 这一条链的去向。 */
export type CrystallizeVerdict =
  /** 正式成为候选（重复次数已达标）。 */
  | 'candidate'
  /** 步数不够。 */
  | 'short'
  /** 只跨一个器官（工具）。 */
  | 'single-organ'
  /** 第一次见，已记账但还没到重复门槛。 */
  | 'first-sight'
  /** 候选已满，拒收新的。 */
  | 'full'

/** 一次结晶的结果。 */
export interface CrystallizeOutcome {
  readonly verdict: CrystallizeVerdict
  /** 当前候选（`full` 时没有）。 */
  readonly candidate?: SkillCandidate
  /** 这一次是不是**刚好跨过**重复门槛（只在这一刻为真，之后重复不再报）。 */
  readonly formed: boolean
}

/** 结晶器。 */
export class Crystallizer {
  private readonly bySignature = new Map<string, SkillCandidate>()

  /** 当前候选数。 */
  get size(): number {
    return this.bySignature.size
  }

  /**
   * 收一条走完的链。
   * @param summary 链快照。
   * @param options 门槛。
   */
  add(summary: ChainSummary, options: CrystallizeOptions): CrystallizeOutcome {
    const tools = summary.tools
    if (tools.length < options.minSteps) return { verdict: 'short', formed: false }

    const organs = new Set(tools).size
    if (organs < options.minTools) return { verdict: 'single-organ', formed: false }

    const signature = signatureOf(tools, options.signatureSteps)
    const existing = this.bySignature.get(signature)

    if (existing === undefined) {
      if (this.bySignature.size >= options.maxCandidates) return { verdict: 'full', formed: false }
      const candidate: SkillCandidate = {
        slug: candidateSlugOf(signature),
        signature,
        steps: Object.freeze(tools.slice(0, options.signatureSteps)),
        repeats: 1,
        organs,
        firstAt: summary.startedAt,
        lastAt: summary.lastAt,
      }
      this.bySignature.set(signature, candidate)
      return {
        verdict: options.minRepeats <= 1 ? 'candidate' : 'first-sight',
        candidate,
        formed: options.minRepeats <= 1,
      }
    }

    const updated: SkillCandidate = {
      slug: existing.slug,
      signature: existing.signature,
      steps: existing.steps,
      repeats: existing.repeats + 1,
      organs: Math.max(existing.organs, organs),
      firstAt: existing.firstAt,
      lastAt: summary.lastAt,
    }
    this.bySignature.set(signature, updated)
    return {
      verdict: updated.repeats >= options.minRepeats ? 'candidate' : 'first-sight',
      candidate: updated,
      formed: updated.repeats === options.minRepeats,
    }
  }

  /**
   * 从库里读回一条候选（重启续数用）。
   * @param candidate 候选。
   */
  restore(candidate: SkillCandidate): void {
    if (candidate.signature === '') return
    this.bySignature.set(candidate.signature, candidate)
  }

  /** 全部候选（重复多的在前）。 */
  list(): readonly SkillCandidate[] {
    const out = [...this.bySignature.values()]
    out.sort((a, b) => (a.repeats === b.repeats ? b.lastAt - a.lastAt : b.repeats - a.repeats))
    return out
  }

  /** 清空。 */
  clear(): void {
    this.bySignature.clear()
  }
}
