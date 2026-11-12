/**
 * 自绘 overlay 滚动区（§12.1）。
 *
 * ## 为什么不用原生滚动条
 *
 * macOS 的原生条是覆盖式（不占布局），Windows 的是占位式（吃掉 17px）。
 * 同一份布局在两端宽度不同，主列从 716 变成 699，正文居中位置跟着偏。
 * 自绘才能做到「两端主列恒为 716」（§13 有这条验收）。
 *
 * ## 尺寸与节奏
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 常态宽 | 3px |
 * | 悬停宽 | 5px |
 * | 离右缘 | 2px |
 * | 圆角 | 全圆（`--r-full`） |
 * | 颜色 | `rgb(115 122 138 / 26%)`，悬停 42% |
 * | 出现 | 滚动时 fast 淡入 |
 * | 消失 | 停止滚动 800ms 后 slow 淡出 |
 *
 * 3px 而不是 8：这是一条**压在中栏纸面上的 overlay 细条**，不是独立轨道。
 * 8px 的条在 820 宽的窗口里会明显切掉正文右侧的留白，两脊的对称也就
 * 跟着破掉——而自绘滚动条存在的唯一理由正是保住那份对称。
 *
 * 颜色直接写成半透明灰而不是语义令牌：它既不是文字也不是面，只是
 * 「这里可以滚」的一个提示，跟着底色走反而不稳（深底上要更亮、浅底上
 * 要更暗，而半透明灰叠在两种底上都自动成立）。
 *
 * 800ms 是**停留时长**而不是动效时长，因此不占用五档里的任何一档。
 *
 * ## 不做惯性回弹
 *
 * macOS 的原生回弹与 Windows 不一致，统一去掉。`overscroll-behavior: contain`
 * 由使用方在 viewport 上声明——这个组件不替使用方决定要不要向外传递滚动。
 *
 * ## 为什么 viewport 的 ref 由使用方持有
 *
 * 使用方通常要「滚到底」「记住是否贴底」。把 ref 藏起来，它们就得再
 * 从 DOM 里搜一遍节点，或者让本组件转发一堆方法。直接交出 ref 更省。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** 停止滚动多久后淡出（停留时长，不属动效五档）。 */
const FADE_DELAY = 800

/** 滑块最短高度。太短的滑块既难点也太难看出比例。 */
const MIN_THUMB = 24

export interface ScrollAreaProps {
  /** 滚动视口。使用方通常需要它来滚到底或读滚距。 */
  viewportRef?: React.RefObject<HTMLDivElement | null>
  /** 滚动时回调，用于「是否贴底」这类判断。 */
  onScroll?: () => void
  /** 视口类名。内边距、背景这类外观仍由使用方决定。 */
  className?: string
  /** 内容变化时用于重算滑块高度。传入任意会改变内容高度的值即可。 */
  remeasureKey?: unknown
  /**
   * 视口的键盘事件。
   *
   * 单开一个 prop 而不是让使用方自己在 viewport 上挂 `onKeyDown`：
   * viewport 的 ref 虽然交出去了，但挂事件还得再写一遍 `addEventListener`，
   * 而滚动区本来就是「滚」这件事的归属地，键盘滚屏放这里最自然。
   */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  /**
   * 用户在操作这个滚动区。
   *
   * 「用户在滚」这件事只有本组件知道全貌：滚轮与触屏在视口上，
   * 而拖动滑块发生在视口的**兄弟节点**上，事件根本不经过视口。
   * 让使用方去猜 DOM 结构（「找出滑块、判断 target」）是把封装漏出去，
   * 而且滑块的结构一改就静默失效。
   *
   * 所以由这里统一报告：`wheel` / `touchstart` 一次，滑块拖动期间
   * 每次 `pointerdown` 与 `pointermove` 各一次——拖动是连续动作，
   * 用户可能一路拖回底部，只报第一次会让后半段的变化被忽略。
   *
   * 使用方通常拿它来区分「用户想看别处」与「内容自己变高了」。
   */
  onGesture?: () => void
  /**
   * 视口的无障碍属性。
   *
   * `role` 不属 `React.AriaAttributes`（它在 `HTMLAttributes` 里），
   * 所以单独补一个字段，而不是让调用方传整个 `HTMLAttributes`——
   * 那会把 `className` / `onScroll` 也放进来，与本组件的同名字段打架。
   */
  viewportProps?: React.AriaAttributes & { role?: React.AriaRole; tabIndex?: number }
  children: React.ReactNode
}

/** 滑块几何。 */
interface Thumb {
  top: number
  height: number
}

/**
 * 渲染 overlay 滚动区。
 *
 * @param props 见 `ScrollAreaProps`。
 * @returns 视口 + 滑块。
 */
export function ScrollArea({
  viewportRef,
  onScroll,
  className,
  remeasureKey,
  onKeyDown,
  onGesture,
  viewportProps,
  children,
}: ScrollAreaProps): React.JSX.Element {
  const localRef = useRef<HTMLDivElement | null>(null)
  /** 使用方给了就用它的，没给就用内部的。两处必须有同一个节点。 */
  const node = viewportRef ?? localRef

  const [thumb, setThumb] = useState<Thumb>({ top: 0, height: 0 })
  const [visible, setVisible] = useState(false)
  const [hover, setHover] = useState(false)
  /** 拖动中的偏移比例，0–1。 */
  const dragRef = useRef<number | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  /**
   * 重算滑块位置与高度。
   *
   * 内容不足一屏时高度置 0，滑块整个不出现——留一个占满全高的块
   * 会让人以为「已经到底了但还能滚」。
   */
  const measure = useCallback((): void => {
    const element = node.current
    if (element === null) return
    const { scrollTop, scrollHeight, clientHeight } = element
    if (scrollHeight <= clientHeight + 1) {
      setThumb({ top: 0, height: 0 })
      return
    }
    const height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight)
    const maxTop = clientHeight - height
    // 可滚距离为 0 时（内容刚好一屏）比例按 0 处理，避免除零。
    const usable = scrollHeight - clientHeight
    const top = usable <= 0 ? 0 : (scrollTop / usable) * maxTop
    setThumb({ top, height })
  }, [node])

  /** 滚动时：重算 + 显形 + 重置淡出计时。 */
  const handleScroll = useCallback((): void => {
    measure()
    setVisible(true)
    globalThis.clearTimeout(timerRef.current)
    timerRef.current = globalThis.setTimeout(() => { setVisible(false) }, FADE_DELAY)
    onScroll?.()
  }, [measure, onScroll])

  // 首次挂载与内容变化时重算。用 ResizeObserver 观察视口本身不够——
  // 内容长高不会改变视口的 clientHeight，必须观察内容节点。
  useEffect(() => {
    measure()
    const element = node.current
    if (element === null) return
    const observer = new ResizeObserver(() => { measure() })
    observer.observe(element)
    // 第一个子节点是内容容器，它的高度变化才是「内容变长」。
    const content = element.firstElementChild
    if (content !== null) observer.observe(content)
    return () => { observer.disconnect() }
  }, [measure, node, remeasureKey])

  // 卸载时清掉淡出计时，否则会在组件消失后 setState。
  useEffect(() => {
    return () => { globalThis.clearTimeout(timerRef.current) }
  }, [])

  /**
   * 拖动滑块。
   *
   * 用 pointer capture 而不是挂 window 监听：捕获后指针移出窗口
   * 仍会继续派发事件，松手在窗口外也不会留下「粘住的滑块」。
   */
  const onThumbPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const element = node.current
    if (element === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = 0
    setHover(true)
    onGesture?.()
  }, [node, onGesture])

  const onThumbPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === undefined) return
    const element = node.current
    if (element === null) return
    const { scrollHeight, clientHeight } = element
    const height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight)
    const maxTop = clientHeight - height
    if (maxTop <= 0) return
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (rect === undefined) return
    const relative = event.clientY - rect.top - height / 2
    const ratio = Math.min(1, Math.max(0, relative / maxTop))
    onGesture?.()
    element.scrollTop = ratio * (scrollHeight - clientHeight)
  }, [node, onGesture])

  const onThumbPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setHover(false)
  }, [])

  return (
    <div
      className="scrollarea"
      data-hover={hover ? '' : undefined}
      onPointerEnter={() => { setHover(true) }}
      onPointerLeave={() => { setHover(false) }}
      /*
       * 手势监听挂在最外层，而不是视口上。
       *
       * 拖滑块时 `pointerdown` 落在滑块（视口的兄弟节点），事件不会
       * 冒泡进视口。这一层下面只有视口与滑块两样，挂在这里两种入口
       * 都收得到，也不会误收侧栏或抽屉的滚动。
       */
      onWheel={onGesture}
      onTouchStart={onGesture}
    >
      <div
        ref={node}
        className={className === undefined ? 'scrollarea__viewport' : `scrollarea__viewport ${className}`}
        onScroll={handleScroll}
        onKeyDown={onKeyDown}
        {...viewportProps}
      >        {children}
      </div>

      {/*
        滑块。`height <= 0` 表示内容不需要滚动，整个不渲染——
        渲染一个 0 高度元素仍会参与命中测试，会莫名挡住右下角的点击。
      */}
      {thumb.height > 0 ? (
        <div
          className="scrollarea__thumb"
          data-visible={visible || hover ? '' : undefined}
          style={{ top: `${String(thumb.top)}px`, height: `${String(thumb.height)}px` }}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          onPointerCancel={onThumbPointerUp}
          aria-hidden="true"
        />
      ) : null}
    </div>
  )
}
