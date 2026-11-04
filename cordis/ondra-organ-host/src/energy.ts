/**
 * 能量会计的**纯函数**部分：报价 → 四态回执。不碰 ctx、不碰 IO。
 *
 * ## 四态是怎么判的（每条都对应一次真实事故形态）
 *
 * | 情形 | 状态 | `denied` | 理由 |
 * |---|---|---|---|
 * | `chargeMode='shadow'` | `shadow` | false | 只记账，不拦人 |
 * | 没有能量源（O-048 缺席） | `shadow` | false | 不假装饥饿，也不假装付过 |
 * | 剩余 ≤ 0 | `starved` | **true** | 一点都付不出 |
 * | 0 < 剩余 < 报价 | `partial` | false | 付了部分，器官自己决定缩小感知范围 |
 * | 剩余 ≥ 报价 | `full` | false | 照单全收 |
 * | 报价为 0（免票） | `full` | false | 免费也要拿回执，只是不扣钱 |
 *
 * ## 两个刻意的「不」
 *
 * 1. **没有能量源时不报 `starved`。** 报饥饿会让所有器官在「只装了 O-132、没装 O-048」
 *    的最小安装上集体装死——那不是饥饿降级，那是整机停摆。如实报 `shadow + no-source`，
 *    让面板能说清「能量会计没接线」，而不是「她累了」。
 * 2. **`partial` 不置 `denied`。** 「只付得起一半」与「付不起」是两件事：
 *    前者可以缩小范围继续看（看一帧而不是看一段视频），后者必须放弃。
 *    把两者合成一个布尔，等于把「省着用」这条能力删掉。
 */

import type { ChargeMode, EnergyReason, EnergyState } from './types.js'

/** 一次报价的输入。 */
export interface EnergyQuoteInput {
  /** 报价（0–100，已归一化）。 */
  readonly requested: number
  /** 剩余；读不到能量源时为 `undefined`。 */
  readonly remaining: number | undefined
  /** 计费模式。 */
  readonly mode: ChargeMode
}

/** 报价结果（回执里除时间戳外的全部字段）。 */
export interface EnergyQuoteResult {
  readonly state: EnergyState
  readonly charged: number
  readonly denied: boolean
  readonly reason: EnergyReason
}

/** 报价上限：0–100（与 §3.3 能量同尺度）。 */
const MAX_COST = 100

/**
 * 归一化一个报价：非数、负数、超过 100 一律夹回合法区间。
 * @param value 原始报价。
 */
export function normalizeCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_COST, Math.max(0, value))
}

/**
 * 判一次回执的四态。
 * @param input 报价输入。
 */
export function quoteEnergy(input: EnergyQuoteInput): EnergyQuoteResult {
  const requested = normalizeCost(input.requested)

  // ① shadow：只记账。剩余照抄（读得到就给，读不到就不给），但一分不扣。
  if (input.mode === 'shadow') {
    return { state: 'shadow', charged: 0, denied: false, reason: 'shadow-mode' }
  }

  // ② 没有能量源：不假装饥饿（见文件头第 1 条）。
  if (input.remaining === undefined || !Number.isFinite(input.remaining)) {
    return { state: 'shadow', charged: 0, denied: false, reason: 'no-source' }
  }

  // ③ 免票：仍要回执，只是不扣钱。
  if (requested === 0) {
    return { state: 'full', charged: 0, denied: false, reason: 'free' }
  }

  const remaining = Math.max(0, input.remaining)

  // ④ 一点都付不出。
  if (remaining <= 0) {
    return { state: 'starved', charged: 0, denied: true, reason: 'insufficient' }
  }

  // ⑤ 付得起一部分。
  if (remaining < requested) {
    return { state: 'partial', charged: remaining, denied: false, reason: 'partial' }
  }

  // ⑥ 照单全收。
  return { state: 'full', charged: requested, denied: false, reason: 'paid' }
}

/**
 * 真扣失败时把回执改成「没付成」。
 *
 * 为什么不在扣之前先判「能不能扣」：能量源没有「预扣」接口，判完再扣中间有时间窗，
 * 两个器官可能同时通过判定。**扣失败就退回 denied**，代价是一次白跑，
 * 收益是「永远不会出现付了钱没扣到」的静默账。
 * @param quote 原报价结果。
 */
export function failedCharge(quote: EnergyQuoteResult): EnergyQuoteResult {
  if (quote.charged <= 0) return quote
  return { state: 'starved', charged: 0, denied: true, reason: 'charge-failed' }
}
