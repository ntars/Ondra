/**
 * 模态浮层的键盘与焦点约定（§9.3、§9.5、§13）。
 *
 * ## 三件必须一起做的事
 *
 * 1. **关闭时把焦点还回去**——否则键盘用户关掉浮层后焦点落到 `body`，
 *    下一个 `Tab` 从文档最开头重来。
 * 2. **把 Tab 锁在框内**——不锁的话焦点会跑到被遮住的界面上，
 *    用户看不见自己按在哪。
 * 3. **Esc 只关自己这一层**——用 capture 阶段 + `stopPropagation`：
 *    背景的业务快捷键也挂在 `window` 上，不抢在它们前面，随便按一下
 *    Esc 会连带关掉两层。
 *
 * ## 为什么要抽出来
 *
 * 项目里现在有两个模态：关闭确认框、设置面板。两处各写一遍的结果是
 * 迟早有一处漏掉 `isConnected` 判断，或者忘了 `capture`——而这两种失误
 * 都不会报错，只在特定关闭顺序下表现为「偶尔不灵」。
 *
 * 初始焦点**不在这里**：该落在哪个元素由调用方决定（确认框落在主按钮，
 * 设置面板落在第一个导航项），钩子无从推断。
 */

import { useEffect } from 'react'
import { useRestoreFocus } from './useRestoreFocus.ts'

/** 可聚焦元素的选择器（与 Drawer 保持一致）。 */
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * @param panelRef 浮层本体。Tab 循环以它为边界。
 * @param onDismiss Esc 时做什么。调用方自己决定关哪一层。
 */
export function useModalFocus(
  panelRef: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  /*
   * 先记来处，再拦键盘。
   *
   * 顺序有意义：`useRestoreFocus` 记的是**此刻**的 `document.activeElement`，
   * 而调用方紧接着会把焦点搬进浮层。反过来的话记到的就是浮层内部元素，
   * 关闭时焦点原地不动——看起来像"还原失败了"。
   */
  useRestoreFocus(true)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onDismiss()
        return
      }
      if (event.key !== 'Tab') return

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (nodes === undefined || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]

      // 焦点在框外（刚打开还没定位、或用户点了遮罩）时，Tab 拉回框内。
      if (!panelRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        first?.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    globalThis.addEventListener('keydown', onKeyDown, true)
    return () => { globalThis.removeEventListener('keydown', onKeyDown, true) }
  }, [panelRef, onDismiss])
}
