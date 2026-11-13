/**
 * 关闭浮层后把焦点还回去（§9.5、§13）。
 *
 * ## 为什么必须还
 *
 * 焦点是键盘用户唯一的「当前位置」。浮层关掉后焦点若落到 `body`，
 * 下一个 `Tab` 会从文档最开头重新走一遍——用户刚在 Rail 第四个图标上
 * 打开的抽屉，关掉后又被送回了第一个图标。四十条消息的会话里，
 * 这个代价是几十次按键。
 *
 * ## 为什么要抽成一个钩子
 *
 * 项目里有三种浮层：抽屉、检查器、设置。它们的显隐方式不同
 * （抽屉常挂、其余条件渲染），但「记住来处、还回去」这件事完全一样。
 * 三处各写一遍，迟早有一处只写了 `focus()` 没写 `isConnected` 判断，
 * 于是焦点被扔进一个已经卸载的节点，浏览器静默把它重置到 `body`——
 * 表现就是「偶尔不灵」，且只在特定关闭顺序下复现。
 *
 * ## `isConnected` 判断为什么不能省
 *
 * 触发元素可能在浮层打开期间消失（比如点了抽屉里的某条会话，
 * 上层顺带重渲染了 Rail）。往一个脱离文档的节点上 `focus()` 不会抛错，
 * 也不会有任何效果，焦点停在原地——看起来像「还原失败了」。
 *
 * @param active 浮层是否处于打开状态。常挂组件传开关值，条件渲染组件传 `true`。
 */
import { useEffect, useRef } from 'react'

export function useRestoreFocus(active: boolean): void {
  /** 浮层打开前的焦点。用 ref：它只在关闭时被读，不参与渲染。 */
  const previous = useRef<Element | null>(null)

  useEffect(() => {
    if (!active) return
    /*
     * 必须在「焦点进入浮层」之前记下来。React 的 effect 按声明顺序执行，
     * 所以调用方要把本钩子写在聚焦 effect 之前——写反了记到的就是
     * 浮层内部的第一个元素，关闭时焦点原地不动。
     */
    previous.current = document.activeElement
    return () => {
      const target = previous.current
      if (target instanceof HTMLElement && target.isConnected) target.focus()
      previous.current = null
    }
  }, [active])
}
