/**
 * 主动开口的界面侧记账（§6.4 E、§7.4）。
 *
 * ## 它管什么，不管什么
 *
 * | 管 | 不管 |
 * | --- | --- |
 * | 「这次不用」的三秒撤回窗口 | 此刻能不能说（那是宿主的九道闸） |
 * | 连续拒绝 3 次 → 当日「安静」（§7.4） | 生成正文（那是内核 + 模型） |
 * | 那行可解释文字的措辞 | 额度的真实扣减（宿主 `gate()` 放行时已记） |
 *
 * ## 为什么拒绝计数必须落盘
 *
 * 计数说的是「今天她已经让用户烦了三次」。只放内存里的话，用户关掉应用
 * 再打开，那三次就忘了——而她当晚又会开口三次。这正是打扰预算要防的事：
 * 关了应用**不等于**原谅了那三次打扰。
 *
 * ## 为什么键里带日期
 *
 * 「连续拒绝 3 次」的边界是**当日**。带日期的键让跨零点自然归零，
 * 不需要任何定时清理。不带日期就得在每次读时判断「这条记录是不是今天的」，
 * 那等于把同一件事表达两遍。
 */

import { useSyncExternalStore } from 'react'

/** 计数落盘的键前缀。日期由 {@link dayKey} 拼在后面。 */
const KEY_PREFIX = 'ondra.proactive.declines.'

/**
 * 连续拒绝多少次后当日停止（§7.4 原话：「连续拒绝 3 次 → 当日停止主动消息」）。
 *
 * 注意是**连续**不是累计：中间只要有一次用户正常回了话，计数就清零。
 * 累计口径会让「今天点了三次这次不用，但聊了半小时」也变成安静一天，
 * 那不是节流，是记仇。
 */
export const DECLINE_LIMIT = 3

/** 撤回窗口：3 秒（§7.4「每条主动消息下方 3 秒内可点」）。 */
export const UNDO_WINDOW_MS = 3000

/** 撤回窗口结束时的通知。 */
const listeners = new Set<() => void>()

/** 通知订阅者。 */
function notify(): void {
  for (const listener of listeners) listener()
}

/** 当日键，形如 `2026-11-07`。用本地时区：用户感受到的「今天」是本地的。 */
export function dayKey(at: number = Date.now()): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * 读当日拒绝次数。
 *
 * 隐私模式下 `localStorage` 会抛。抛了就当 0：宁可少一次安静，
 * 也不要因为读不到计数就让整个界面卡住。
 */
export function declinesToday(at: number = Date.now()): number {
  try {
    const raw = globalThis.localStorage?.getItem(KEY_PREFIX + dayKey(at))
    if (raw === null || raw === undefined) return 0
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  } catch {
    return 0
  }
}

/** 记一次拒绝，返回新的连续次数。 */
export function noteDecline(at: number = Date.now()): number {
  const next = declinesToday(at) + 1
  try {
    globalThis.localStorage?.setItem(KEY_PREFIX + dayKey(at), String(next))
  } catch {
    // 写不进去只影响「重启后还记得」，本次仍然生效。
  }
  notify()
  return next
}

/**
 * 清零连续拒绝。
 *
 * 用户正常说话时调用。语义是「她不再是被拒绝的状态」——一次正常对话
 * 就把「连续」打断了，这是「连续」这个词唯一说得通的解释。
 */
export function clearDeclines(): void {
  if (declinesToday() === 0) return
  try {
    globalThis.localStorage?.removeItem(KEY_PREFIX + dayKey())
  } catch { /* 同上 */ }
  notify()
}

/**
 * 今天是否已经进入「安静」。
 *
 * 注意与一键静音（`lib/mute.ts`）不是一件事：静音是用户主动按下的、
 * 有明确截止时刻的开关；安静是她自己因为被拒绝三次而退场。
 * 两者在 Spine 上都显示「安静」二字，但原因不同，所以**不共用一个状态**。
 */
export function isQuietToday(at: number = Date.now()): boolean {
  return declinesToday(at) >= DECLINE_LIMIT
}

/** 订阅拒绝计数的变化。 */
export function subscribeDeclines(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 读「今天是否已经安静」的 React 钩子。
 *
 * 快照是布尔值而不是数字：`useSyncExternalStore` 每帧比引用，
 * 返回新对象会一直判「变了」。布尔在值不变时是同一个原始值，天然稳定。
 * 代价是 0→1→2 这三次变化都不会触发重渲染——但界面上只有
 * 「达到 3」才有可见差异，这正是要的那个粒度。
 */
export function useQuietToday(): boolean {
  return useSyncExternalStore(subscribeDeclines, isQuietToday, () => false)
}
