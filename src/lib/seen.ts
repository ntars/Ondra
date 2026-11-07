/**
 * 「第一次」与「之后为空」的区分（§12.15）。
 *
 * ## 它回答的问题
 *
 * 「空状态」和「第一次」是两件事：
 *
 * | | 含义 | 该给什么 |
 * | --- | --- | --- |
 * | 第一次 | 你还不知道这里能做什么 | 一条能照着做的路径 |
 * | 之后为空 | 你知道这里会有什么，只是现在没有 | 一句引导语 |
 *
 * 两者共用一句「暂无数据」，等于把「第一次」那一次唯一的教学机会浪费掉。
 *
 * ## 为什么一个功能一个键
 *
 * 规范明确禁止全局单一标记。理由很实在：用户可能在第一天就点开过
 * 记忆抽屉，一年后才第一次点开剧场。用全局标记的话，剧场那次会被
 * 当成「早就看过了」，而那才是它唯一该被教一次的时机。
 *
 * 所以键是 `ondra.seen.{feature}`，一个功能一格，互不影响。
 *
 * ## 为什么在「打开时」写，而不是「看完后」
 *
 * 没有「看完」这个事件。用户不会点「我知道了」，他只会关掉抽屉。
 * 若等关闭时再写，中途切到别的视图、窗口被托盘收起、应用直接退出，
 * 这几种情况都会漏写，于是同一段引导会反复出现——反复出现比不给更烦。
 *
 * 代价是：用户打开看一眼立刻关掉，也算看过了。这是可接受的，因为
 * 他把这段文字显示在屏幕上了，而他随时可以再打开。
 *
 * ## 为什么读盘失败一律当「第一次」
 *
 * 隐私模式下 `localStorage` 会抛。此时当「已看过」会让引导永久消失，
 * 当「第一次」只是可能多看一遍。两害相权，选后者。
 */

import { useEffect, useRef } from 'react'

/** 键前缀。与 `ondra.theme` / `ondra.mutedUntil` 并列同一命名空间。 */
const PREFIX = 'ondra.seen.'

/**
 * 这个功能是否已经露过面。
 *
 * @param feature 功能标识，如 `'memory'`。用稳定的短名，不要写界面文案
 * ——文案改了不该让所有用户重新看一遍引导。
 */
export function hasSeen(feature: string): boolean {
  try {
    return globalThis.localStorage?.getItem(PREFIX + feature) === '1'
  } catch {
    return false
  }
}

/**
 * 记为已露面。
 *
 * 写失败只影响「下次还当第一次」，不影响本次渲染，所以静默吞掉。
 */
export function markSeen(feature: string): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + feature, '1')
  } catch { /* 隐私模式：本次照常显示，只是下次还会再显示一次 */ }
}

/**
 * 判定「这次打开是不是第一次」，并在本次停留期间锁定结果。
 *
 * ## 为什么不直接在每个组件里调 `hasSeen()`
 *
 * 两个坑，都会让引导一闪就没：
 *
 * 1. **写盘与读盘同一次渲染**。若渲染里既 `hasSeen()` 又 `markSeen()`，
 *    紧接着任何一次重渲染（父组件刷新、动画帧、主题变化）都会读到
 *    `true`，引导当场消失。用户还没看清那三张示例。
 * 2. **每次渲染都读盘**。`localStorage` 是同步 IO，挂在渲染路径上
 *    会让每帧都摸一次磁盘。
 *
 * 所以结果按 `feature` 缓存在 ref 里：首次进入某个功能时算一次，
 * 之后同一次停留内不再重算。切走再切回会重算——那时 `markSeen`
 * 已经写过盘，自然变成「之后为空」，正是要的语义。
 *
 * **缓存在界面收起时必须清掉**。若不清，用户关掉抽屉再打开，
 * 缓存里还是「第一次」，于是那段引导在每次打开时都重演一遍——
 * 而那正是「第一次」这个概念要避免的事。
 *
 * ## 为什么写盘放 effect 而不是渲染里
 *
 * 渲染函数必须是纯的。严格模式下渲染会跑两遍，副作用会跟着跑两遍；
 * `markSeen` 幂等所以不会出错，但把 IO 塞进渲染路径仍然是坏习惯。
 *
 * @param feature 功能标识；`undefined` 表示界面未打开，不判定也不写盘。
 * @param active  界面是否处于打开状态。收起时不结算，避免用户根本没看见
 *                就被记成「已看过」。
 */
export function useFirstVisit(feature: string | undefined, active: boolean): boolean {
  const cache = useRef<{ feature: string; first: boolean } | undefined>(undefined)

  // 收起即失效：下一次打开要重新问磁盘。
  if (feature === undefined) {
    cache.current = undefined
  } else if (cache.current?.feature !== feature) {
    // 进入某个功能（或其内容被原地替换）：只算一次，本段停留内不再读盘。
    cache.current = { feature, first: !hasSeen(feature) }
  }

  const first = feature !== undefined && cache.current?.first === true

  useEffect(() => {
    if (!active || feature === undefined || !first) return
    markSeen(feature)
  }, [active, feature, first])

  return active && feature !== undefined && first
}
