/**
 * 固定回忆（骰子）的**纯算法**。不碰 `ctx`、不读库，输入是记录与强度解析函数。
 *
 * ## 为什么权重是 `(1−R)` 而不是 `R`
 *
 * 手册 §2.3 原话：「**越模糊越容易被想起**」，权重 `(1−R) × (0.5 + 重要度/100)`，
 * 永久再 `×0.6`。
 *
 * 这一条看着反直觉，其实是产品核心：**她「忽然想起」的应该是快要忘掉的事**。
 * 按 `R` 排会变成「每天都在想同一条最牢的记忆」——那是复读，不是回忆。
 *
 * `×0.6` 的永久折扣同理：`self`（自我认知）与 `promise`（约定）基线极长，
 * 不折扣的话它们永远权重最大，于是「她天天想起自己是谁」。
 *
 * ## 为什么用「基线阈值」判「长期 / 永久」
 *
 * 手册说「只从长期/永久挑」，但「长期」是**池**的概念（O-131 八池），
 * 本插件没有池。两条路：
 * 1. 抄一份 11 类表挑类别 → **第二真源**（O-010 改基线，这里不生效且不报错）。
 * 2. 用 `stabilityBaseHours` 的阈值判 → 阈值是**一个数**，基线仍只有 O-010 一份。
 *
 * 选 2。`longTermBaseHours = 240` 恰好是 `person` 的基线，于是
 * `person` / `promise` / `self` 自然落入长期档，`study`(80) 以下不入。
 */

import type { DiceCandidate, DiceSkips, MemoryRecordLike } from './types.js'

/** 强度探针：只要求给出强度，**不接受整份 `StrengthView`**。 */
export type StrengthProbe = (record: MemoryRecordLike) => { readonly strength: number }

/** 骰子用到的配置子集。 */
export interface DiceSettings {
  /** 「长期档」的基线阈值（小时）。 */
  readonly longTermBaseHours: number
  /** 「永久档」的基线阈值（小时）。 */
  readonly permanentBaseHours: number
  /** 强度下沿。 */
  readonly minStrength: number
  /** 强度上沿。 */
  readonly maxStrength: number
  /** 「最近想过」的跳过窗口（天）。 */
  readonly recentSkipDays: number
}

/** 池子的构建结果。 */
export interface DicePool {
  /** 进入池子的候选。 */
  readonly candidates: readonly DiceCandidate[]
  /** 各类筛掉的条数。 */
  readonly skips: DiceSkips
  /** 权重和。 */
  readonly totalWeight: number
}

/** 一天多少毫秒（跳过窗口换算用）。 */
const DAY_MS = 86_400_000

/** 空的筛除计数。 */
export function emptySkips(): DiceSkips {
  return Object.freeze({ shortTerm: 0, outOfBand: 0, recent: 0, sealed: 0, archived: 0 })
}

/**
 * 抽中权重。
 *
 * `(1−R) × (0.5 + 重要度/100) × (永久 ? 0.6 : 1)`
 *
 * 重要度用 `salience / 100`（0–100 归一），不是 `important` 布尔——
 * 布尔只有两档，「很重要」与「稍微重要」会被压成同一个权重。
 * @param strength 当前强度 0–1。
 * @param salience 显著度 0–100。
 * @param permanent 是否永久档。
 */
export function diceWeight(strength: number, salience: number, permanent: boolean): number {
  const r = Math.min(1, Math.max(0, strength))
  const importance = Math.min(100, Math.max(0, salience)) / 100
  const base = (1 - r) * (0.5 + importance)
  return permanent ? base * 0.6 : base
}

/**
 * 构建骰子池。
 * @param records 候选记录（调用方已按 `scanLimit` 取好）。
 * @param at 时间戳。
 * @param settings 配置子集。
 * @param strengthOf 强度解析（来自 O-010，**本插件不重算**）。
 * @param includeArchived 是否纳入已沉底。
 */
export function buildDicePool(
  records: readonly MemoryRecordLike[],
  at: number,
  settings: DiceSettings,
  strengthOf: StrengthProbe,
  includeArchived: boolean,
): DicePool {
  const candidates: DiceCandidate[] = []
  let shortTerm = 0
  let outOfBand = 0
  let recent = 0
  let sealed = 0
  let archived = 0

  for (const record of records) {
    // 封存永不参与回忆（手册 §2.4），且没有开关。
    if (record.sealed) {
      sealed += 1
      continue
    }
    if (record.archived && !includeArchived) {
      archived += 1
      continue
    }
    if (record.stabilityBaseHours < settings.longTermBaseHours) {
      shortTerm += 1
      continue
    }

    const view = strengthOf(record)
    const r = view.strength
    if (!Number.isFinite(r) || r < settings.minStrength || r > settings.maxStrength) {
      outOfBand += 1
      continue
    }

    // 「3 天内想过跳过」判据用 `lastHitAt`（真的被想起），**不用 `lastSeenAt`**：
    // 后者是「被注入带出」，八块装配里的常驻段每轮都会写，用它会让所有长期记忆
    // 都被判成「刚想过」，骰子池永远为空——而且不报错。
    if (record.lastHitAt !== null && at - record.lastHitAt < settings.recentSkipDays * DAY_MS) {
      recent += 1
      continue
    }

    const permanent = record.stabilityBaseHours >= settings.permanentBaseHours
    const weight = diceWeight(r, record.salience, permanent)
    if (weight <= 0) {
      outOfBand += 1
      continue
    }

    candidates.push({
      id: record.id,
      text: record.text,
      category: record.category,
      kind: record.kind,
      channel: record.channel,
      strength: r,
      importance: record.salience,
      permanent,
      weight,
    })
  }

  const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0)
  return Object.freeze({
    candidates: Object.freeze(candidates),
    skips: Object.freeze({ shortTerm, outOfBand, recent, sealed, archived }),
    totalWeight,
  })
}

/**
 * 按权重抽一条。
 *
 * 走一次随机数 + 累加游走。**不是排序取第一**——「越模糊越容易被想起」是概率，
 * 若改成排序，权重最高的那条会被每次抽中，池子里其余的记忆永远轮不到。
 * @param candidates 候选。
 * @param random 随机源，返回 [0,1)。
 */
export function pickWeighted(
  candidates: readonly DiceCandidate[],
  random: () => number,
): DiceCandidate | null {
  if (candidates.length === 0) return null
  const total = candidates.reduce((sum, item) => sum + item.weight, 0)
  if (!(total > 0)) return null

  // 随机源可能返回 1（非标准实现），夹一下避免游标越界。
  const raw = random()
  const roll = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0
  let cursor = roll * total
  for (const item of candidates) {
    cursor -= item.weight
    if (cursor < 0) return item
  }
  // 浮点累减可能残留极小的正数，落到最后一条而不是 `null`（`null` 会被读成「池是空的」）。
  const last = candidates.at(-1)
  return last === undefined ? null : last
}
