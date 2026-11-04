/**
 * 两个「与时间有关」的判定：**48 小时窗口** 与 **5 秒预算**，外加去重表。
 *
 * 全部纯函数（除了 `withinBudget` 用了一个定时器），不碰网络、不读文件。
 *
 * ## 5 秒预算为什么用 `race` 而不是 `abort`
 *
 * O-056 立过一条规矩：超时用 `abort()` 不用 `Promise.race`，因为 race 只是「不再等」，
 * 请求还在跑、token 还在烧、那一轮还会写进历史。
 *
 * 这里**刻意违反**那条规矩，理由完全不同：那一轮**不该被放弃**。
 * 5 秒一到我们只是**交棒**——先把降级话术回给微信，让同一个人物的回答继续跑完，
 * 再走客服消息把真话发出去。规则的目的（别让半途而废的一轮占着资源）在这里不成立，
 * 因为这一轮不是「废了」，是「换了个出口」。
 *
 * 但 race 有两个必须自己兜住的坑：
 * ① 原 promise 后来 reject 时，若没人接，就是 unhandledRejection（进程级告警）；
 * ② 定时器必须清掉，否则每一条超时消息都留一个 5 秒的定时器。
 */

import { sha1Hex } from './wire.js'

/** 窗口与去重状态（可落盘）。 */
export interface WindowState {
  /** openid → 最后一次来信时刻（毫秒）。 */
  lastSeen: Record<string, number>
  /** 去重键 → 见到它的时刻（毫秒）。 */
  seen: Record<string, number>
}

/** 去重表上限：再多也只是内存里的垃圾。 */
export const SEEN_LIMIT = 512

/** 窗口表上限：公众号的关注者可能上万，只留最近活跃的。 */
export const WINDOW_LIMIT = 2_048

/** 空状态。 */
export function emptyWindowState(): WindowState {
  return { lastSeen: {}, seen: {} }
}

/**
 * 解析落盘状态。坏字段逐个丢，不整份丢弃。
 * @param value 原始值。
 */
export function parseWindowState(value: unknown): WindowState {
  const base = emptyWindowState()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return base
  const raw = value as Record<string, unknown>

  const readMap = (key: string, limit: number): Record<string, number> => {
    const given = raw[key]
    if (typeof given !== 'object' || given === null) return {}
    const entries: [string, number][] = []
    for (const [itemKey, itemValue] of Object.entries(given as Record<string, unknown>)) {
      if (typeof itemValue !== 'number' || !Number.isFinite(itemValue)) continue
      entries.push([itemKey, itemValue])
    }
    // 只留最近 N 条：状态文件不该随着关注者数量无限长。
    entries.sort((left, right) => right[1] - left[1])
    return Object.fromEntries(entries.slice(0, limit))
  }

  return { lastSeen: readMap('lastSeen', WINDOW_LIMIT), seen: readMap('seen', SEEN_LIMIT) }
}

/**
 * 是否还在窗口内。
 *
 * 边界取**闭区间**：恰好 48 小时整算「还在」。理由是这个判定错了的代价不对称——
 * 多放一条会被平台拒（可观测、可记录），少放一条是「她明明想回却没回」（用户只看到沉默）。
 * @param lastSeenAt 最后一次来信时刻（毫秒）；`undefined` 表示没记录。
 * @param now 现在。
 * @param hours 窗口小时数。
 */
export function withinWindow(lastSeenAt: number | undefined, now: number, hours: number): boolean {
  if (lastSeenAt === undefined) return false
  if (lastSeenAt > now) return false
  return now - lastSeenAt <= hours * 3_600_000
}

/**
 * 去重键。
 *
 * 优先用平台 `MsgId`；事件消息没有 `MsgId`，就退回「发信人 + 时间 + 正文指纹」。
 * 退回键必须带指纹：同一秒里同一个人发两条不同的消息是常事，
 * 只用「人 + 时间」会把第二条吃掉。
 * @param openId 发信人。
 * @param msgId 平台消息 id。
 * @param createdAt 平台时间（毫秒）。
 * @param text 正文。
 * @param event 事件名。
 */
export function dedupeKey(openId: string, msgId: string, createdAt: number, text: string, event: string): string {
  if (msgId !== '') return 'm:' + msgId
  return 'e:' + openId + ':' + createdAt + ':' + sha1Hex(text + '|' + event).slice(0, 8)
}

/**
 * 记一次「见过」。
 *
 * 就地改状态（状态归调用方所有），并按时间裁到上限。
 * @param state 状态。
 * @param key 去重键。
 * @param at 时刻。
 */
export function markSeen(state: WindowState, key: string, at: number): void {
  state.seen[key] = at
  const keys = Object.keys(state.seen)
  if (keys.length <= SEEN_LIMIT) return
  const sorted = keys.sort((left, right) => (state.seen[right] ?? 0) - (state.seen[left] ?? 0))
  for (const stale of sorted.slice(SEEN_LIMIT)) delete state.seen[stale]
}

/**
 * 清掉过期的去重记录与窗口记录。
 * @param state 状态。
 * @param now 现在。
 * @param dedupeWindowMs 去重窗口。
 * @param windowHours 会话窗口。
 */
export function prune(state: WindowState, now: number, dedupeWindowMs: number, windowHours: number): void {
  for (const [key, at] of Object.entries(state.seen)) {
    if (now - at > dedupeWindowMs) delete state.seen[key]
  }
  const limit = windowHours * 3_600_000
  for (const [key, at] of Object.entries(state.lastSeen)) {
    if (now - at > limit) delete state.lastSeen[key]
  }
}

/** 预算竞速结果。 */
export type BudgetResult<T> = { readonly settled: true; readonly value: T } | { readonly settled: false }

/**
 * 在预算内等一个 promise；超时就先走，原 promise 继续跑。
 *
 * @param work 要等的工作。
 * @param ms 预算（毫秒）。
 */
export function withinBudget<T>(work: Promise<T>, ms: number): Promise<BudgetResult<T>> {
  return new Promise<BudgetResult<T>>(resolve => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: BudgetResult<T>): void => {
      if (done) return
      done = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      resolve(result)
    }

    if (ms <= 0) {
      // 预算为零也要把 work 的错误接住，否则会变成 unhandledRejection。
      work.then(
        () => undefined,
        () => undefined,
      )
      finish({ settled: false })
      return
    }

    timer = setTimeout(() => finish({ settled: false }), ms)
    const maybe = timer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()

    work.then(
      value => finish({ settled: true, value }),
      () => finish({ settled: false }),
    )
  })
}
