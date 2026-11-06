/**
 * 对话框（Dialog，§5.12）。
 *
 * ## 它与 Sheet 的分工
 *
 * Dialog：宽 400、居中、**有遮罩**、必须做决定才能继续。
 * Sheet：贴顶部、无遮罩、下方圆角，用于「看一眼再走」。
 *
 * 这里只实现 Dialog，因为目前唯一的用处是关闭窗口时问一次。
 * Sheet 等到真的需要确认类操作（删记忆、切人格）再写——
 * 提前写一个没人调用的组件，等于把未验证的假设放进代码库。
 *
 * ## 三个容易漏的点
 *
 * 1. **焦点必须锁在框内**。`Tab` 到最后一个按钮后再按一次要回到第一个。
 *    不锁的话焦点会跑到背后界面上，用户看不见自己按在哪。
 * 2. **关闭后焦点要还原**。打开前记下 `activeElement`，关闭时还回去。
 *    不还原的话键盘用户的焦点会掉到 `body`，得从头 Tab。
 * 3. **Esc 只关自己这一层**。父组件通过 `onCancel` 决定关什么，
 *    组件内部不去翻别人的状态。
 */

import { useCallback, useEffect, useRef } from 'react'

export interface DialogProps {
  /** 标题。一句话，不带句号。 */
  title: string
  /** 正文。可以是一段解释，也可以省略。 */
  children?: React.ReactNode
  /** 主按钮文字。 */
  confirmLabel: string
  /** 次按钮文字。不给则只有一个按钮。 */
  cancelLabel?: string
  /**
   * 主按钮是否用警示色。
   *
   * 用于「退出应用」这类不可逆动作。不改变按钮形状——
   * 红色只是语气，不该让按钮看起来像另一种东西。
   */
  danger?: boolean
  /** 按下主按钮。 */
  onConfirm(): void
  /**
   * 按下次按钮。
   *
   * 与 `onDismiss` 分开：次按钮是**一个明确的选择**（比如「退出应用」），
   * 而 Esc 与点遮罩是「我还没想好，先别管我」。合成一个回调会让
   * 「按 Esc 想取消」变成「按 Esc 直接退出应用」——这是不可逆的误操作。
   */
  onCancel?(): void
  /** Esc、点遮罩。不给时退回 `onCancel`（简单的确认框两者等价）。 */
  onDismiss?(): void
  /**
   * 主按钮下方的一段可选内容。
   *
   * 关闭窗口的「以后直接退出」勾选框放在这里。做成插槽而不是加一个
   * `remember` 布尔 prop：勾选框的文字、默认值、语义都只属于调用方，
   * 组件没有立场替它决定。
   */
  extra?: React.ReactNode
}

/** 可聚焦元素的选择器（与 Drawer 保持一致）。 */
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * 渲染一个居中对话框。
 *
 * @param props 见 `DialogProps`。
 * @returns 遮罩 + 对话框本体。
 */
export function Dialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
  onDismiss,
  extra,
}: DialogProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** 主按钮。初始焦点落在这里。 */
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  /** 打开前的焦点。关闭时还回去。 */
  const restoreTo = useRef<Element | null>(null)

  /** 退出本层：优先用 `onDismiss`，没给就退回 `onCancel`。 */
  const dismiss = useCallback((): void => {
    if (onDismiss !== undefined) onDismiss()
    else onCancel?.()
  }, [onCancel, onDismiss])

  /**
   * 键盘：Esc 取消、Tab 循环。
   *
   * 用 `capture` 阶段监听：背后的业务快捷键（比如 Esc 关抽屉）
   * 也挂在 `window` 上，不抢在它们前面，随便按一下 Esc 会连带关掉两层。
   */
  useEffect(() => {
    restoreTo.current = document.activeElement

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        dismiss()
        return
      }
      if (event.key !== 'Tab') return

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (nodes === undefined || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]

      // 焦点在框外（比如刚打开还没定位）时，Tab 一律拉回框内第一个。
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
    /*
     * 初始焦点落在主按钮上。
     *
     * 不能用 `querySelector(FOCUSABLE)`——那取到的是 DOM 顺序里的第一个，
     * 也就是 `extra` 插槽里的勾选框。用户打开这个框是要做决定，
     * 焦点停在一个可选项上，按 Enter 什么都不会发生。
     */
    confirmRef.current?.focus()

    return () => {
      globalThis.removeEventListener('keydown', onKeyDown, true)
      // 还原焦点。只在原元素还挂在文档上时还——否则会把焦点丢给一个
      // 已经被卸载的节点，浏览器会把焦点重置到 body。
      const target = restoreTo.current
      if (target instanceof HTMLElement && target.isConnected) target.focus()
    }
  }, [dismiss])

  /** 点遮罩取消，点框内不取消。 */
  const onScrimClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) dismiss()
  }, [dismiss])

  return (
    <div className="dialog" role="presentation" onMouseDown={onScrimClick}>
      <div
        className="dialog__panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <h2 className="dialog__title" id="dialog-title">{title}</h2>
        {children === undefined ? null : <div className="dialog__body">{children}</div>}
        {extra === undefined ? null : <div className="dialog__extra">{extra}</div>}

        {/*
          按钮右对齐，主按钮在右。macOS 的按钮顺序是「取消 在左、确认 在右」，
          Windows 也是这样——两端一致，不需要平台分支。
        */}
        <div className="dialog__actions">
          {cancelLabel === undefined ? null : (
            <button type="button" className="button button--ghost" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            ref={confirmRef}
            className={danger ? 'button button--danger' : 'button button--primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
