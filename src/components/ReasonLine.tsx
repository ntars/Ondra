/**
 * 主动开口的可解释行（§6.4 E、§5.4 异常态「被撤回」）。
 *
 * ## 它解决什么
 *
 * 她突然说话，用户第一反应是「你怎么突然开口」。这一行回答的就是这个：
 * `她主动开口 · {判据摘要}`，行首一个沙色点，右侧三秒内可以点「这次不用」。
 *
 * ## 三个容易做错的点
 *
 * 1. **沙色点不能单独承载信息**（§5.7 的同一条规矩）。颜色只用来「一眼
 *    扫到」，语义由文字给。所以点旁边必须有「她主动开口」四个字，
 *    不能只画一个点。
 * 2. **三秒是从消息出现算起，不是从悬停算起**。§7.4 写的是「下方 3 秒内
 *    可点」。若做成悬停才计时，用户慢慢读两分钟后仍可撤回，那时消息早就
 *    沉进历史了，撤回的语义变成「删除历史消息」——那是另一个操作。
 * 3. **撤回不是删除**。点完之后消息淡出 180ms 再移除，同时记账一次拒绝。
 *    直接 `display:none` 会让它像从没说过，而事实是「说过，用户不要」。
 *    这个区别决定了「连续三次 → 今天安静」能不能被用户理解。
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconX } from './icons.ts'

export interface ReasonLineProps {
  /**
   * 判据摘要。一句人话，来自宿主的门控说明（不是原因码）。
   *
   * 空串时不显示「· 摘要」那半截——只有「她主动开口」五个字加一个点，
   * 仍然是完整的意思。若强行填「无」，那是把「没有原因」说成了一件事。
   */
  reason: string
  /**
   * 撤回窗口还剩多少毫秒。
   *
   * 由上层用倒计时递减而不是这里自己 `setTimeout`：撤回窗口的**记账**
   * 在上层（宿主请求 + 拒绝计数），计时器放在这里会让「组件被重渲染
   * 就重置计时」变成一个偶发缺陷。上层持有唯一的时间真源。
   */
  undoLeft: number
  /** 点「这次不用」。 */
  onDecline(): void
}

/**
 * 渲染可解释行。
 *
 * 整行 `user-select: none`：它不是正文，选中一半再复制会得到
 * 「她主动开口 · 想你」这种断句奇怪的东西（§12.2 的不可选区域）。
 */
/**
 * 淡出时长。
 *
 * 与 `--motion-base`（180ms）对齐。这里必须有一份数字，因为要排一个
 * 定时器；而 `transitionend` 不能独自承担——用户在系统里开了「减弱动态
 * 效果」时，CSS 会把过渡时长压到 0 甚至 `none`，那个事件就不会来，
 * 消息便再也撤不掉。
 *
 * 两处对齐这件事由验收盯着：`check-ui` 里那条「三秒后消息仍在、按钮已收」
 * 会在任何一边改错时报红。
 */
const FADE_MS = 180

export function ReasonLine({ reason, undoLeft, onDecline }: ReasonLineProps): React.JSX.Element {
  /*
   * 淡出态。
   *
   * ## 为什么 `onDecline` 要延后，而不是点击即撤
   *
   * §6.4 E 的原话是「点击后本条淡出 180ms」。移除消息是上层做的事，
   * 它一执行节点就没了——CSS 的 `transition` 没有机会播放，视觉上是
   * 「啪」地消失。所以先切 `data-leaving` 让过渡跑起来，等它跑完再
   * 通知上层真正移除。
   *
   * 延时器在卸载时清掉：用户点了之后立刻切走会话，上层已经把节点
   * 连同组件一起摘了，再回调就是往一个不存在的会话里写账。
   */
  const [leaving, setLeaving] = useState(false)
  const fadeRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (fadeRef.current !== undefined) globalThis.clearTimeout(fadeRef.current)
  }, [])

  /* 撤回窗口内才显示那个按钮。到点自动收起，不需要用户做什么。 */
  const canUndo = undoLeft > 0 && !leaving

  return (
    <div className="reasonline" data-leaving={leaving ? '' : undefined}>
      <span className="reasonline__dot" aria-hidden="true" />
      <span className="reasonline__text">
        她主动开口
        {reason === '' ? null : <span className="reasonline__why"> · {reason}</span>}
      </span>
      {canUndo ? (
        <button
          type="button"
          className="reasonline__undo"
          onClick={() => {
            if (leaving) return
            setLeaving(true)
            fadeRef.current = globalThis.setTimeout(() => {
              fadeRef.current = undefined
              onDecline()
            }, FADE_MS)
          }}
        >
          这次不用
          {/*
            按钮里带一个 16px 的叉。§7.4 只说了「可点」，但「这次不用」
            四个字在一条灰字行里很容易被当成装饰文字——加一个图标后
            它有了按钮的样子。图标走 `Icon.tsx`（全项目唯一出口）。
          */}
          <Icon icon={IconX} size={16} />
        </button>
      ) : null}
    </div>
  )
}
