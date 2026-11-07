/**
 * 主动开口的时机（§7.4）。
 *
 * ## 它只做一件事：决定「什么时候去问一次门控」
 *
 * 判据（静默时段、额度、冷却、内容红线）全在宿主。这里负责的是另一半：
 * **什么时候值得问**。而这件事界面比宿主清楚——它知道窗口在不在前台、
 * 用户是不是正在打字、上一次说话过了多久。
 *
 * ## 为什么是单次定时器，不是轮询
 *
 * 轮询（每 60 秒问一次）的代价不是 CPU，而是**额度**：每次问都可能在
 * 门控里放行并记一次账。一个每小时白问 60 次的循环，会把「今天还能说 3 句」
 * 变成一个说不上来的数字。
 *
 * 所以这里算一个**到期时刻**，只挂一个 `setTimeout`：会话安静到
 * `IDLE_MINUTES` 之后才醒来问一次。醒来若被拦且给了 `deferMs`，
 * 就按它再挂一次（那是插件算好的「再来问我」的时间点，不是我猜的）。
 *
 * ## 为什么窗口不在前台时不问
 *
 * §7.4 明文：「应用已开但不在前台」**不发系统通知**，只在 Rail 加圆点。
 * 同一条道理也适用于「要不要在这个时候让她说话」——用户正在别处做事，
 * 此刻她开口只会变成一条要等他回来的消息，那比不说更差。
 * 所以隐藏的窗口**不消耗额度**，等他回来再问。
 *
 * ## 为什么用户正在打字时不问
 *
 * 输入框有草稿说明他正准备说话。这时她抢在前面开口，是最典型的
 * 「打断」。等他按下发送或清空草稿，会话自然重新计时。
 */

import { useEffect, useRef } from 'react'

/**
 * 会话安静多少分钟后才值得问她要不要开口。
 *
 * ## 为什么取 25 而不是更短
 *
 * 这个数要与 `ondra-proactive-gate` 的 `idle-minutes` 默认值（25）对齐。
 * 若界面按 5 分钟就醒来问，门控会每次都答「还没到 25 分钟」——
 * 十几次白问，全部走一遍九道闸。
 *
 * 对齐之后，醒来那一次几乎必定通过空闲闸，问得才有意义。这个数**不是**
 * 判据，判据仍在插件；它只是「值得问的时刻」的估计。
 */
export const IDLE_MINUTES = 25

/**
 * 被拦下之后的默认重试间隔。
 *
 * 只在插件没给 `deferMs` 时用。`deferMs` 是它自己算的精确时刻，
 * 有它就用它——猜一个数去覆盖上游的算术，是两处判据的开始。
 */
const RETRY_MS = 15 * 60 * 1000

/** 到期后的抖动：避免「每次都是整 25 分钟」的机械感。 */
const JITTER_MS = 90 * 1000

export interface ProactiveTickOptions {
  /** 是否该考虑开口。`false` 时拆掉定时器（首页、生成中、有草稿都算 false）。 */
  armed: boolean
  /** 最后一条消息的时刻。它变了就重新计时。 */
  lastAt: number
  /** 去问一次门控并尝试开口。返回 `false` 表示这次没成。 */
  onSpeak(): Promise<boolean>
  /** 被拦下时插件给的建议等待。`0` 表示没说。 */
  deferMsOf?(): number
}

/**
 * 挂一个「到点问一次」的定时器。
 *
 * 依赖只有 `armed` 与 `lastAt`：这两样变化意味着「场景换了」，
 * 其余输入（`onSpeak`）用 ref 拿最新值，避免每次渲染都拆挂定时器。
 */
export function useProactiveTick(options: ProactiveTickOptions): void {
  const { armed, lastAt } = options
  const speakRef = useRef(options.onSpeak)
  speakRef.current = options.onSpeak
  const deferRef = useRef(options.deferMsOf)
  deferRef.current = options.deferMsOf

  useEffect(() => {
    if (!armed) return

    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    let cancelled = false

    const armFor = (delay: number): void => {
      if (cancelled) return
      timer = globalThis.setTimeout(() => {
        void (async () => {
          if (cancelled) return
          /*
           * 窗口在后台、或页面不可见：不消耗额度，等他回来。
           *
           * `document.hidden` 覆盖「最小化 / 切到别的 Space」；
           * `hasFocus()` 覆盖「窗口在但焦点在别的窗口」。两者都要，
           * 因为 macOS 上切到全屏的另一个应用时 `hidden` 仍是 false。
           */
          if (document.hidden || !document.hasFocus()) {
            /*
             * 回来时不靠事件补一次——`visibilitychange` 与 `focus`
             * 会重新挂定时器（`lastAt` 没变，但 effect 的依赖里有
             * 一个 tick 计数器，见下方 `bump`）。这里只等下一次。
             */
            armFor(RETRY_MS)
            return
          }

          const ok = await speakRef.current()
          if (cancelled) return
          if (!ok) {
            /*
             * 没成。按插件给的建议等待再问一次；它没给就用默认间隔。
             *
             * 注意这里**不清 `cancelled`**：effect 被拆时定时器该停。
             */
            const defer = deferRef.current?.() ?? 0
            armFor(defer > 0 ? defer : RETRY_MS)
          }
          /*
           * 成了就什么都不做：`lastAt` 会因为新消息而变，
           * effect 重挂，计时从她说完那一刻重新开始。
           */
        })()
      }, delay)
    }

    const due = lastAt + IDLE_MINUTES * 60 * 1000 - Date.now()
    armFor(Math.max(1_000, due) + Math.random() * JITTER_MS)

    return () => {
      cancelled = true
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [armed, lastAt])
}
