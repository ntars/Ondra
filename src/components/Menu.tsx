/**
 * 菜单。左栏账号菜单、工作区选择、会话行右键都用它。
 *
 * ## 为什么必须走 portal
 *
 * 菜单必须画在触发它的容器外面。侧栏是一个 `overflow: hidden` 的滚动列，
 * 菜单若挂在里面，超出列宽的部分会被裁掉——底部「更多」的菜单往上弹，
 * 顶部那几项就没了。原版的做法也是 portal（`_portal_7vkjn_46`），
 * 定位到 `document.body`，按触发元素的位置算坐标。
 *
 * ## 为什么不用 `<dialog>` 或原生 popover
 *
 * 原生 popover 的定位与层级受浏览器实现影响，遮罩行为也要额外处理。
 * 这里只需要「绝对定位 + 点外面关闭 + Esc 关闭 + 键盘上下选」四件事，
 * 自己实现不到 100 行，且行为完全可控。
 *
 * ## 几何取的是原版实测值
 *
 * 外层：圆角 16px、内边距 4px、z-index 1100
 * 阴影：`0 0 0 0.5px rgba(0,0,0,.04), 0 3px 8px rgba(0,0,0,.04), 0 0 20px rgba(0,0,0,.05)`
 * 菜单项：圆角 12px，字号与内边距由使用方给出（两处不同：
 * 账号菜单 14px/8px 10px，工作区菜单 13px/6px 8px）。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 菜单项。 */
export interface MenuItem {
  /** 稳定的键。菜单项可能重复文案，不能用文案当 key。 */
  id: string
  /** 显示文案。 */
  label: string
  /** 左侧图标。 */
  icon?: React.ReactNode
  /** 危险操作（删除等）用红色。 */
  danger?: boolean
  /** 禁用时点击无效，视觉变浅。 */
  disabled?: boolean
  /** 选中态（单选项用）。 */
  checked?: boolean
  /** 点击回调。菜单会自动关闭。 */
  onSelect(): void
}

/** 组件属性。 */
export interface MenuProps {
  /** 触发按钮。菜单按它的位置定位。 */
  anchor: React.ReactNode
  /** 菜单项。 */
  items: MenuItem[]
  /** 菜单在触发元素哪一侧展开。 */
  side?: 'top' | 'bottom'
  /** 菜单最小宽度。默认 124px（原版账号菜单实测）。 */
  minWidth?: number
  /** 菜单标题（无障碍用）。 */
  label?: string
  /** 每一项的字号。 */
  fontSize?: number
  /** 每一项的内边距。 */
  itemPadding?: string
  /** 是否撑满触发元素宽度。 */
  stretch?: boolean
}

/** 菜单与触发元素之间的间隙。原版实测 8px。 */
const GAP = 8
/** 视口边缘留白。 */
const EDGE = 8

/**
 * 取触发元素的真实位置。
 *
 * ## 为什么不能直接用锚点 ref 的 rect
 *
 * 锚点 `<span class="menu__anchor">` 是 `display: contents`——它自己
 * **不生成盒子**。这种元素的 `getBoundingClientRect()` 返回全 0，
 * 于是所有基于它的定位都会算到屏幕左上角去。
 *
 * 这正是上一版菜单"明明算对了却弹在 y=8"的原因：
 * 锚点 rect 全零 → 上方放不下 → 翻到下方 → `below = 0 + 8 = 8`，
 * 菜单就被钉在了视口顶部。
 *
 * 解法是量**里面那个真实按钮**。`display: contents` 的用途只是
 * 不改变调用方的布局，量测必须落到它的第一个元素子节点上。
 */
function anchorRect(anchor: HTMLElement | null): DOMRect | undefined {
  if (anchor === null) return undefined
  const own = anchor.getBoundingClientRect()
  if (own.width > 0 || own.height > 0) return own
  const child = anchor.firstElementChild
  if (child === null) return undefined
  const rect = child.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0 ? rect : undefined
}

/**
 * 渲染一个带菜单的触发按钮。
 *
 * 触发按钮的样式由调用方通过 className 控制，这里不改它的外观——
 * 侧栏的账号按钮、工作区的输入框外形差异太大，硬统一会两边都不像。
 */
export function Menu(props: MenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | undefined>(undefined)

  const fontSize = props.fontSize ?? 14
  const itemPadding = props.itemPadding ?? '8px 10px'
  const minWidth = props.minWidth ?? 124

  // 算位置。必须在浏览器绘制前定好坐标，否则菜单会先在错误位置闪一帧。
  //
  // 向上弹时不能只算 top：菜单高度要等挂载后才量得到，
  // 所以第一帧先给一个"底边贴在触发元素上方"的近似值，
  // 挂载后由下面那个 effect 用实测高度修正。
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return }
    const rect = anchorRect(anchorRef.current)
    if (rect === undefined) return
    const width = Math.max(props.stretch === true ? rect.width : minWidth, minWidth)
    // 先按"靠左对齐触发元素"算，再夹到视口内。
    let left = rect.left
    if (left + width > window.innerWidth - EDGE) left = window.innerWidth - EDGE - width
    if (left < EDGE) left = EDGE

    const top = props.side === 'top' ? rect.top - GAP : rect.bottom + GAP
    setPosition({ left, top, width })
  }, [open, minWidth, props.side, props.stretch])

  /**
   * 向上弹时按实测高度重定位。
   *
   * ## 为什么必须写进 state 而不是改 DOM
   *
   * 直接 `list.style.top = …` 在这里无效：菜单的 `top` 同时由 React
   * 的 `style={{ top: position.top }}` 管着，任何一次重渲染都会把它
   * 覆盖回第一帧的近似值。上一版就是这样——effect 里算对了，
   * 但下一帧被 React 抹掉，菜单仍然停在"底边贴住触发元素"的位置，
   * 表现为一大块从底部一直盖到顶部。
   *
   * ## 为什么不用 Math.max 硬夹
   *
   * 触发点在底部时菜单上沿本来就接近顶部。放不下时的正确做法是
   * 翻到触发元素下方，而不是压到 y=8 之后任其盖满整个侧栏。
   */
  useLayoutEffect(() => {
    if (!open || props.side !== 'top') return
    const list = listRef.current
    if (list === null) return
    const rect = anchorRect(anchorRef.current)
    if (rect === undefined) return
    const height = list.offsetHeight
    const desiredTop = rect.top - GAP - height
    if (desiredTop >= EDGE) {
      setPosition((prev) => (prev === undefined ? prev : { ...prev, top: desiredTop }))
      return
    }
    // 上方放不下：翻到下方，并保证不越过视口底边。
    const below = rect.bottom + GAP
    const maxTop = window.innerHeight - EDGE - height
    const next = Math.min(below, Math.max(EDGE, maxTop))
    setPosition((prev) => (prev === undefined ? prev : { ...prev, top: next }))
  }, [open, props.side, position?.top])

  // 点外面关闭、Esc 关闭。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (listRef.current?.contains(target) === true) return
      if (anchorRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // 打开后把焦点移到菜单上，让方向键可用。
  useEffect(() => {
    if (!open) return
    const first = listRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')
    first?.focus()
  }, [open])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    if (buttons.length === 0) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown'
      ? (index + 1) % buttons.length
      : (index - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <>
      <span
        ref={anchorRef}
        className="menu__anchor"
        onClick={() => { setOpen((value) => !value) }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {props.anchor}
      </span>

      {open && position !== undefined
        ? createPortal(
            <div
              ref={listRef}
              className="menu"
              role="menu"
              aria-label={props.label ?? '菜单'}
              style={{
                left: position.left,
                top: position.top,
                minWidth: position.width,
                ...(props.stretch === true ? { width: position.width } : {}),
              }}
              onKeyDown={handleKeyDown}
            >
              {props.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={`menu__item${item.danger === true ? ' menu__item--danger' : ''}${item.checked === true ? ' menu__item--checked' : ''}`}
                  style={{ fontSize, padding: itemPadding }}
                  disabled={item.disabled === true}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  {item.icon === undefined ? null : <span className="menu__icon" aria-hidden>{item.icon}</span>}
                  <span className="menu__label">{item.label}</span>
                  {item.checked === true ? <span className="menu__check" aria-hidden>✓</span> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/**
 * 右键上下文菜单。
 *
 * 与 `Menu` 分开是因为触发方式完全不同：这个由坐标唤起，
 * 没有锚点元素，菜单直接落在指针位置，并且需要夹在视口内。
 */
export interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** 渲染右键菜单。传 undefined 表示不显示。 */
export function ContextMenu(props: {
  state: ContextMenuState | undefined
  onClose(): void
  minWidth?: number
}): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined)

  useLayoutEffect(() => {
    if (props.state === undefined) { setPosition(undefined); return }
    const list = listRef.current
    const width = props.minWidth ?? 160
    const height = list?.offsetHeight ?? 0
    // 右/下边缘放不下时翻到另一侧，这是右键菜单的通用做法。
    const left = props.state.x + width > window.innerWidth - EDGE
      ? Math.max(EDGE, props.state.x - width)
      : props.state.x
    const top = props.state.y + height > window.innerHeight - EDGE
      ? Math.max(EDGE, props.state.y - height)
      : props.state.y
    setPosition({ left, top })
  }, [props.state, props.minWidth])

  useEffect(() => {
    if (props.state === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (listRef.current?.contains(event.target as Node) === true) return
      props.onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [props])

  if (props.state === undefined) return null

  return createPortal(
    <div
      ref={listRef}
      className="menu"
      role="menu"
      style={{
        left: position?.left ?? props.state.x,
        top: position?.top ?? props.state.y,
        minWidth: props.minWidth ?? 160,
      }}
    >
      {props.state.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`menu__item${item.danger === true ? ' menu__item--danger' : ''}`}
          disabled={item.disabled === true}
          onClick={() => {
            props.onClose()
            item.onSelect()
          }}
        >
          {item.icon === undefined ? null : <span className="menu__icon" aria-hidden>{item.icon}</span>}
          <span className="menu__label">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
