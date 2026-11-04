/**
 * 弥散的纯算术。**不碰 ctx、不碰存储、不碰时钟**——传进来的都是数，出去的都是数。
 *
 * 原式（手册 §9.1）：
 *
 * ```
 * 残留 = (mood − baseline) × 0.4 × (1 − familiarity × 0.5)
 * ```
 *
 * 拆成两个可单独验算的量：
 *
 * ```
 * 保留比例 retain = 0.4 × (1 − familiarity × 0.5)     // 0.2 ~ 0.4
 * 目标心情 target = baseline + (mood − baseline) × retain
 * ```
 *
 * 三个边界情形（写在这里，省得后人拿计算器试）：
 *
 * | mood | familiarity | retain | target | 说明 |
 * |---|---|---|---|---|
 * | 0.5 | 任意 | 任意 | 0.5 | 本来就在基线上，弥散是空操作 |
 * | 1.0 | 0 | 0.40 | 0.70 | 最满的心情带走四成，回落三成 |
 * | 1.0 | 1 | 0.20 | 0.60 | 极熟的人带走两成，回落四成 |
 * | 0.1 | 0 | 0.40 | 0.34 | 低谷也会被抬回来一点（往基线走，不是只往下降） |
 *
 * 注意 `|delta|` 最大是 0.3（`0.5 × (1 − 0.4)`），**大于 O-026 的 0.12 单条上限**。
 * 这不是越权：0.12 是「一句话能推动多少」，弥散是「换一场会话结算多少」，
 * 两者不是同一类事件。也正因如此，落笔必须走 `setAxis` 而不是 `feel`。
 */

import { DIFFUSE_COEFF, FAMILIARITY_DAMP, MOOD_BASELINE, MOOD_MAX, MOOD_MIN } from './types.js'
import type { DiffusePreview } from './types.js'

/** 首次提领时 `gapMinutes` 的哨兵值（还没有上一次）。 */
export const FIRST_RUN_GAP = -1

/** 一分钟的毫秒数。 */
const MS_PER_MINUTE = 60_000

/**
 * 夹到 0–1。
 * @param value 任意数。
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 把外部传来的熟悉度规整成 0–1 的有限数。
 *
 * `undefined`、`NaN`、字符串都给 0——**0 是出厂值**（master-plan §9.1
 * 按人维度 `familiarity` 初值 0），也是最保守的那一端：保留最多、带走最多，
 * 「她还在上次的情绪里」。反过来默认 1 会让第一次见面就像老夫老妻，更不像人。
 * @param value 外部值。
 */
export function normalizeFamiliarity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return clamp01(value)
}

/**
 * 保留比例：`0.4 × (1 − familiarity × 0.5)`。
 * @param familiarity 熟悉度，内部会先规整。
 */
export function retainOf(familiarity: number): number {
  return DIFFUSE_COEFF * (1 - normalizeFamiliarity(familiarity) * FAMILIARITY_DAMP)
}

/**
 * 目标心情：`baseline + (mood − baseline) × retain`，夹到 0–1。
 *
 * 夹紧在正常输入下不会触发（`baseline ± 0.5 × 0.4` 永远在 0–1 内），
 * 留着是为了挡住「mood 被别处写成 1.4」这种脏数据。
 * @param mood 当前心情。
 * @param familiarity 熟悉度。
 */
export function targetOf(mood: number, familiarity: number): number {
  const from = Number.isFinite(mood) ? Math.min(MOOD_MAX, Math.max(MOOD_MIN, mood)) : MOOD_BASELINE
  const target = MOOD_BASELINE + (from - MOOD_BASELINE) * retainOf(familiarity)
  return Math.min(MOOD_MAX, Math.max(MOOD_MIN, target))
}

/**
 * 纯计算一次弥散。不读状态、不写状态。
 * @param mood 当前心情。
 * @param familiarity 熟悉度。
 * @param at 计算时刻。
 */
export function previewOf(mood: number, familiarity: number, at: number): DiffusePreview {
  const fam = normalizeFamiliarity(familiarity)
  const from = Number.isFinite(mood) ? Math.min(MOOD_MAX, Math.max(MOOD_MIN, mood)) : MOOD_BASELINE
  const target = targetOf(from, fam)
  return Object.freeze({
    at,
    familiarity: fam,
    retain: retainOf(fam),
    moodBefore: from,
    baseline: MOOD_BASELINE,
    target,
    delta: target - from,
  })
}

/**
 * 两个时刻相差多少分钟（永远非负；时钟回拨按 0 处理）。
 * @param from 较早时刻（毫秒）。
 * @param to 较晚时刻（毫秒）。
 */
export function gapMinutesOf(from: number, to: number): number {
  const diff = to - from
  if (!Number.isFinite(diff) || diff <= 0) return 0
  return diff / MS_PER_MINUTE
}

/**
 * 给日志与面板的一句人话。**不进提示词**（内感受铁律 §4.3 禁止报数）。
 * @param preview 计算结果。
 * @param status 状态码。
 */
export function noteOf(preview: DiffusePreview, status: string): string {
  if (status === 'already') return '这一场已经弥散过，不再重复衰减'
  if (status === 'no-gap') return '距上次弥散不足判定间隔，按同一场会话处理'
  if (status === 'no-emotion') return '情绪内核不可用，本次不弥散'
  if (status === 'disabled') return '弥散被配置关闭'
  if (status === 'bad-request') return '入参不合法，本次不弥散'
  const percent = Math.round(preview.retain * 100)
  const move = preview.delta < 0 ? '回落' : preview.delta > 0 ? '抬回' : '不动'
  return `带走 ${percent}%：心情 ${preview.moodBefore.toFixed(2)} → ${preview.target.toFixed(2)}（${move}）`
}
