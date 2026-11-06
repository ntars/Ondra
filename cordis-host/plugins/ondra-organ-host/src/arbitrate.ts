/**
 * 反馈仲裁（手册 §8.1「多器官 Δ **累加后一次性 apply 再 clamp**」）。
 *
 * ## 为什么必须累加后一次性应用
 *
 * 逐条 apply 的后果不是「慢一点」，是**结果取决于器官的注册顺序**：
 * 器官 A 先把 pleasure 推到 1.0，器官 B 再来 -0.3 时读到的已经是 A 的结果，
 * 于是「B 加了 -0.3」这件事在账上变成「从 1.0 掉到 0.7」，而实际应有的结果是
 * `0.5 + A + B` 再夹紧。同一批提议、同样的值，换个装载顺序得出不同的情绪——
 * 排查时永远查不出，因为每个器官单独看都是对的。
 *
 * ## 夹紧的顺序（这三步的顺序是唯一正确的顺序）
 *
 * 1. **先按目标累加**：同一目标的多条 Δ 相加，得到一个总和。
 * 2. **再夹步长**：`maxStep` 限制的是「这一次 flush 能改多少」，所以夹在总和上。
 *    若先夹每条再相加，N 条 -0.06 会变成 -0.6，步长闸形同虚设。
 * 3. **最后夹结果**：`before + delta` 夹到 `[min, max]`，再把**差值**交给持有者。
 *    持有者收到的永远是「合法的一步」，它不需要再夹一次，也不会因为自己没夹而越界。
 *
 * ## 没有 `read` 的目标怎么办
 *
 * 读不到当前值就夹不了结果，此时**只夹步长**，结果边界交给持有者。
 * 这不是遗漏：在别人家里立第二套边界比越界更危险（两套边界不一致时，
 * 谁最后写谁赢，且两边都认为自己合规）。
 */

import type { FeedbackApply, FeedbackDelta, FeedbackQueueResult, FeedbackRejectReason, FeedbackTarget } from './types.js'
import { KEY_RE } from './types.js'

/** 队列里的一条（带提交者）。 */
export interface PendingDelta {
  readonly organId: string
  readonly target: string
  readonly delta: number
}

/** 入队结果（`queued` 条 + 拒收明细）。 */
export interface EnqueueResult extends FeedbackQueueResult {
  /** 真正入队的条目（顺序与提交一致）。 */
  readonly accepted: readonly PendingDelta[]
}

/**
 * 校验并组装一批待提交提议。
 * @param organId 提交者。
 * @param deltas 提议。
 * @param room 队列剩余容量。
 */
export function enqueue(
  organId: string,
  deltas: readonly FeedbackDelta[],
  room: number,
): EnqueueResult {
  const accepted: PendingDelta[] = []
  const rejected: { target: string; reason: FeedbackRejectReason }[] = []

  for (const item of deltas) {
    const target = typeof item?.target === 'string' ? item.target : ''
    // 目标键先按 §8.4 校验：不合规的键在本地拦，绝不落进状态里再让下游猜。
    if (!KEY_RE.test(target)) {
      rejected.push({ target, reason: 'bad-target' })
      continue
    }
    if (typeof item.delta !== 'number' || !Number.isFinite(item.delta)) {
      rejected.push({ target, reason: 'bad-delta' })
      continue
    }
    if (accepted.length >= room) {
      rejected.push({ target, reason: 'queue-full' })
      continue
    }
    accepted.push({ organId, target, delta: item.delta })
  }

  return {
    queued: accepted.length,
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
  }
}

/** 一个目标的累加中间态。 */
interface Bucket {
  sum: number
  readonly by: Set<string>
}

/**
 * 按目标累加。
 * @param pending 待提交提议。
 */
export function bucketize(pending: readonly PendingDelta[]): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>()
  for (const item of pending) {
    const bucket = buckets.get(item.target)
    if (bucket === undefined) {
      buckets.set(item.target, { sum: item.delta, by: new Set([item.organId]) })
    } else {
      bucket.sum += item.delta
      bucket.by.add(item.organId)
    }
  }
  return buckets
}

/**
 * 夹一个值到区间。
 * @param value 值。
 * @param min 下界（可选）。
 * @param max 上界（可选）。
 */
function clampTo(value: number, min: number | undefined, max: number | undefined): number {
  let out = value
  if (min !== undefined) out = Math.max(min, out)
  if (max !== undefined) out = Math.min(max, out)
  return out
}

/**
 * 把一个目标的总和夹成「合法的一步」。
 *
 * **纯函数**：不调 `apply`，不改任何状态，便于对拍。
 * @param target 目标声明。
 * @param sum 累加后的总和。
 * @returns `delta` 是最终要交给持有者的一步；`outcome` 说清有没有被夹。
 */
export function shapeDelta(
  target: FeedbackTarget,
  sum: number,
): { readonly delta: number; readonly before?: number; readonly after?: number; readonly clamped: boolean } {
  let delta = sum
  let clamped = false

  // ① 步长闸：夹的是「这一批的总变化量」，不是每条。
  if (target.maxStep !== undefined && Number.isFinite(target.maxStep) && target.maxStep >= 0) {
    if (delta > target.maxStep) {
      delta = target.maxStep
      clamped = true
    } else if (delta < -target.maxStep) {
      delta = -target.maxStep
      clamped = true
    }
  }

  // ② 结果闸：只有在能读到当前值时才夹（见文件头末段）。
  const before = target.read === undefined ? undefined : target.read()
  if (before === undefined || !Number.isFinite(before)) return { delta, clamped }

  const after = clampTo(before + delta, target.min, target.max)
  const shaped = after - before
  if (shaped !== delta) clamped = true
  return { delta: shaped, before, after, clamped }
}

/**
 * 应用一批已经分好桶的提议。
 *
 * **每个目标只调一次 `apply`**；一个目标抛错不影响其它目标（`sink-error`）。
 * 「一个目标坏了就把整批回滚」听起来更安全，实际是把一次局部故障放大成一次全局丢更新。
 * @param buckets 分桶结果。
 * @param targets 已登记目标表。
 */
export function applyBuckets(
  buckets: ReadonlyMap<string, Bucket>,
  targets: ReadonlyMap<string, FeedbackTarget>,
): {
  readonly items: readonly FeedbackApply[]
  readonly applied: number
  readonly clamped: number
  readonly dropped: number
  readonly sinkErrors: number
} {
  const items: FeedbackApply[] = []
  let applied = 0
  let clamped = 0
  let dropped = 0
  let sinkErrors = 0

  // 目标键升序，结果可复现（同批数据两次 flush 输出顺序一致，便于对拍）。
  const keys = [...buckets.keys()].sort()

  for (const key of keys) {
    const bucket = buckets.get(key)!
    const target = targets.get(key)
    const by = Object.freeze([...bucket.by].sort())

    if (target === undefined) {
      items.push({ target: key, sum: bucket.sum, delta: 0, outcome: 'no-sink', by })
      dropped += 1
      continue
    }

    const shaped = shapeDelta(target, bucket.sum)
    if (shaped.delta === 0) {
      // 夹到 0 也算「处理过」：它确实到了边界，不是没提交。
      items.push({
        target: key,
        sum: bucket.sum,
        delta: 0,
        before: shaped.before,
        after: shaped.after,
        outcome: shaped.clamped ? 'clamped' : 'applied',
        by,
      })
      if (shaped.clamped) clamped += 1
      else applied += 1
      continue
    }

    try {
      target.apply(shaped.delta)
      items.push({
        target: key,
        sum: bucket.sum,
        delta: shaped.delta,
        before: shaped.before,
        after: shaped.after,
        outcome: shaped.clamped ? 'clamped' : 'applied',
        by,
      })
      if (shaped.clamped) clamped += 1
      else applied += 1
    } catch {
      // 持有者抛错：丢弃本条并计数，**不重试**（重试会把一次确定性失败变成两次）。
      items.push({ target: key, sum: bucket.sum, delta: 0, outcome: 'sink-error', by })
      dropped += 1
      sinkErrors += 1
    }
  }

  return { items: Object.freeze(items), applied, clamped, dropped, sinkErrors }
}
