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
 * | 常态宽 | 8px |
 * | 悬停宽 | 12px |
 * | 轨道 | 透明 |
 * | 滑块 | `--alias-scrollbar-thumb`，圆角 4，两端各内缩 8 |
 * | 出现 | 滚动时 fast 淡入 |
 * | 消失 | 停止滚动 800ms 后 slow 淡出 |
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
  }, [node])

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
    element.scrollTop = ratio * (scrollHeight - clientHeight)
  }, [node])

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
    >
      <div
        ref={node}
        className={className === undefined ? 'scrollarea__viewport' : `scrollarea__viewport ${className}`}
        onScroll={handleScroll}
      >
        {children}
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
