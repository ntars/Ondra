/**
 * 纯函数层：**把上游给的那一条投影成简报里的一段**。
 *
 * 这一层不碰 ctx、不碰时钟真身——时刻运算经 `BriefClock` 传入，
 * 于是「上游缺席时这一段该说什么」这条规则可以被单独对拍，不必先起一个真服务。
 *
 * ## 两条贯穿全文件的判据
 *
 * 1. **点名，不汇总。** 每段只出一件，且逐字引用上游原文。
 *    不写「还有 3 条类似的」——那既报了数字，又让人以为自己已经知道全貌。
 * 2. **空与读不到分开。** `empty` 说「今天确实没有」，`not-available` 说
 *    「这段读不到，别当成没有」。合成一档，用户会在上游挂掉的那天以为一切安好。
 */

import { SLOT_SPECS } from './types.js'
import type { BriefClock, BriefItem, BriefSource } from './types.js'

/**
 * 待办「快过期」的判定窗（两天）。
 *
 * 依据是 O-016 的口径：待办 3 天没提起就自动过期。提前一天提醒，
 * 正好落在晨间简报里——**不是新标定，是从上游那条 3 天规则反推的**。
 */
export const CARRY_URGENT_MS = 2 * 86_400_000

/** 造一个来源项。 */
export function sourceOf(service: string, field: string, ok: boolean): BriefSource {
  return Object.freeze({ service, field, ok })
}

/** 承诺段的候选（已由服务从上游挑好，这里只负责说清楚它）。 */
export interface DueCandidate {
  /** 承诺 id。 */
  readonly id: string
  /** 原文。 */
  readonly text: string
  /** 到期时刻。 */
  readonly dueAt: number
  /** 宽限截止。 */
  readonly graceUntil: number
}

/** 悬着的事的候选。 */
export interface CarryCandidate {
  /** 待办 id。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 过期时刻。 */
  readonly expiresAt: number
}

/**
 * 到期时刻的中文说法。
 * @param dueAt 到期时刻。
 * @param graceUntil 宽限截止。
 * @param clock 时刻运算。
 * @param at 现在。
 */
function dueTextOf(dueAt: number, graceUntil: number, clock: BriefClock, at: number): string {
  if (dueAt <= at) return `已过到期时刻，宽限到 ${clock.hhmm(graceUntil)}`
  const days = clock.daysBetween(at, dueAt)
  if (days <= 0) return `今天 ${clock.hhmm(dueAt)} 前`
  if (days === 1) return `明天 ${clock.hhmm(dueAt)} 前`
  return `${days} 天后（${clock.hhmm(dueAt)} 前）`
}

/**
 * 投影承诺段。
 * @param candidate 挑中的那一条；`null` = 上游在位、今天没有有时限的承诺。
 * @param upstreamOk 承诺服务读到了没有。
 * @param clock 时刻运算。
 * @param at 现在。
 */
export function dueItemOf(
  candidate: DueCandidate | null,
  upstreamOk: boolean,
  clock: BriefClock,
  at: number,
): BriefItem {
  const spec = SLOT_SPECS.promise
  const sources = Object.freeze([sourceOf(spec.owner, 'listOpen()', upstreamOk)])

  if (!upstreamOk) {
    return Object.freeze({
      slot: spec.slot,
      zh: spec.zh,
      state: 'not-available',
      title: '承诺这一块今天读不到',
      detail: '承诺服务没装载或没起来——不是「今天没有承诺」，是读不到。',
      sources,
    })
  }

  if (candidate === null) {
    return Object.freeze({
      slot: spec.slot,
      zh: spec.zh,
      state: 'empty',
      title: '今天没有带期限的承诺',
      detail: '承诺服务在位，今天没有到期的事。',
      sources,
    })
  }

  return Object.freeze({
    slot: spec.slot,
    zh: spec.zh,
    state: 'ready',
    title: candidate.text,
    detail: `到期时间：${dueTextOf(candidate.dueAt, candidate.graceUntil, clock, at)}。`,
    sources,
    ref: Object.freeze({ service: spec.owner, id: candidate.id }),
  })
}

/**
 * 投影「悬着的事」这一段。
 * @param candidate 挑中的那一条；`null` = 上游在位、没有从昨天带过来的事。
 * @param upstreamOk 待办表读到了没有。
 * @param at 现在。
 */
export function carryItemOf(
  candidate: CarryCandidate | null,
  upstreamOk: boolean,
  at: number,
): BriefItem {
  const spec = SLOT_SPECS['carry-over']
  const sources = Object.freeze([sourceOf(spec.owner, 'listTodos()', upstreamOk)])

  if (!upstreamOk) {
    return Object.freeze({
      slot: spec.slot,
      zh: spec.zh,
      state: 'not-available',
      title: '悬着的事这一块今天读不到',
      detail: '待办表没装载或没起来——不是「没有悬着的事」，是读不到。',
      sources,
    })
  }

  if (candidate === null) {
    return Object.freeze({
      slot: spec.slot,
      zh: spec.zh,
      state: 'empty',
      title: '没有从昨天带过来的事',
      detail: '昨天之前记下的待办都已经勾掉了。',
      sources,
    })
  }

  // 不写「挂了几天」：天数会变成倒计时式的压迫，而这条待办本来就已经在了。
  const urgent = candidate.expiresAt > 0 && candidate.expiresAt - at < CARRY_URGENT_MS
  return Object.freeze({
    slot: spec.slot,
    zh: spec.zh,
    state: 'ready',
    title: candidate.text,
    detail: urgent
      ? '这条从昨天之前就记着，还没勾掉；再不提就要自动过期了。'
      : '这条从昨天之前就记着，还没勾掉。',
    sources,
    ref: Object.freeze({ service: spec.owner, id: candidate.id }),
  })
}

/**
 * 一句话总述：只说「今天提哪几段、哪段没有、哪段读不到」。
 *
 * **不报条数、不排序评价、不说「加油」**——一句话里出现数字，它就会被当成进度。
 * @param items 三段。
 */
export function summaryOf(items: readonly BriefItem[]): string {
  const pick = (state: BriefItem['state']): string =>
    items.filter(item => item.state === state).map(item => item.zh).join('、')

  const ready = pick('ready')
  const empty = pick('empty')
  const missing = pick('not-available')

  const parts: string[] = []
  if (ready !== '') parts.push(`今天提：${ready}。`)
  if (empty !== '') parts.push(`今天没有：${empty}。`)
  if (missing !== '') parts.push(`读不到：${missing}。`)
  return parts.join('')
}
