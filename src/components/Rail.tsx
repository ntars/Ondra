/**
 * 左侧脊（Rail）。
 *
 * ## 职责
 *
 * 会话态常驻的 48px 竖条：四个入口 + 一个设置。点击入口就地展开抽屉，
 * 不改主列宽度、不重排正文（§5.2、§3.4）。
 *
 * ## 为什么设置不在抽屉之列
 *
 * §5.2 的交互细则明确「齿轮不展开抽屉，直接打开偏好设置窗口」。
 * 设置是独立窗口，若也走抽屉，用户在两个不同容器里看到同一组设置，
 * 会出现「改了这边那边没变」的猜疑。
 *
 * ## 为什么没有 logo 入口
 *
 * §3.3 写「点击 Rail 顶部的 logo 退出会话」，但 §5.2 把首图标定在
 * y = 64（标题栏 44 + 20），上面没有位置放 logo，且图标顺序里也没有它。
 * 组件级规范更具体，按 §5.2 落地：退出会话走 `Esc` 之外的
 * 「新建对话」（`Cmd/Ctrl + N`，§9.1 明写「已在会话中时清空并回到首页形态」）。
 * 两处文本的冲突记在当日记忆日志里，等设计文档统一后再补 logo 位。
 *
 * ## 快捷键编号只到 4
 *
 * §9.1 写「`Cmd/Ctrl + 1..5` 顺序为对话 / 记忆 / 关系 / 通道 / 设置」，
 * §5.2 的图标只有 今天 / 周 / 记忆 / 剧场 / 设置 四项加齿轮。两者条目不同，
 * 这里按 §5.2 发号：1–4 对应四个抽屉，设置走 `Cmd/Ctrl + ,`（§9.1 同表有定义）。
 */

import { useCallback, useEffect, useRef } from 'react'
import { Icon } from './Icon.tsx'
import { IconMemory, IconSettings, IconTheater, IconToday, IconWeek } from './icons.ts'
import { isTypingTarget, keyContext } from '../lib/shortcuts.ts'
import type { IconInput } from 'morphicons/react'

/**
 * 抽屉的四个入口。
 *
 * 类型即真源：`Drawer.tsx` 用它决定渲染什么内容，`App.tsx` 用它存状态。
 * 三处不各写一份字符串。
 */
export type DrawerKey = 'today' | 'week' | 'memory' | 'theater'

/** 一个入口的定义。 */
interface RailItem {
  key: DrawerKey
  icon: IconInput
  label: string
  /** 快捷键数字（`Cmd/Ctrl + n`）。 */
  shortcut: number
}

/** 四个入口，顺序即 §5.2 的「今天 / 周 / 记忆 / 剧场」。 */
const ITEMS: RailItem[] = [
  { key: 'today', icon: IconToday, label: '今天', shortcut: 1 },
  { key: 'week', icon: IconWeek, label: '本周', shortcut: 2 },
  { key: 'memory', icon: IconMemory, label: '记忆', shortcut: 3 },
  { key: 'theater', icon: IconTheater, label: '剧场', shortcut: 4 },
]

export interface RailProps {
  /** 当前展开的抽屉。undefined 表示都收起。 */
  active: DrawerKey | undefined
  /**
   * 点击入口。
   *
   * 由上层决定「点同一个是收起、点另一个是原地替换」——这个判断需要
   * 知道当前状态，放在上层就不必把状态在两层各存一份。
   */
  onToggle(key: DrawerKey): void
  /** 打开偏好设置窗口。 */
  onOpenSettings(): void
}

/**
 * 渲染左侧脊。
 *
 * ## 键盘模型
 *
 * 整条脊是一个 `toolbar`，内部用 roving tabindex：只有当前项可 Tab 进入，
 * 进入后用 `↑/↓` 在同组内移动（§9 要求「不用鼠标能做完」）。
 * 不这么做的话，五个按钮会各占一个 Tab 停靠点，用户要按五次才过得去。
 */
export function Rail({ active, onToggle, onOpenSettings }: RailProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)

  /** 当前应有焦点的位置：优先选中项，否则第一项。 */
  const focusIndex = active === undefined ? 0 : Math.max(0, ITEMS.findIndex((item) => item.key === active))

  /** 把焦点搬到第 index 项。用于方向键与快捷键。 */
  const focusItem = useCallback((index: number): void => {
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-item]')
    if (nodes === undefined) return
    const clamped = (index + nodes.length) % nodes.length
    nodes[clamped]?.focus()
  }, [])

  /*
   * `Cmd/Ctrl + 1..4` 直达。
   *
   * ## 为什么这一条留在 Rail 而不并进 `App` 的总入口
   *
   * 数字键的含义就是「第几个入口」，顺序表 `ITEMS` 在 Rail 里；
   * 挪到 `App` 就要把顺序表复制一份出去，两处迟早不一致。
   * 其余快捷键都在 `App` 统一分发，只有这一条按「谁拥有数据谁处理」留下。
   *
   * ## 输入框里有内容时不抢
   *
   * §9.2 第 1 条。`Ctrl+1` 在浏览器里是切标签页，但在输入框里
   * 用户可能正用输入法选第 1 个候选词——抢过来会打断他打字。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const context = keyContext(event)
      if (!context.mod || context.shift || context.alt) return

      if (isTypingTarget(event.target)) {
        const field = event.target as HTMLInputElement | HTMLTextAreaElement
        if (field.value !== '') return
      }

      const digit = Number(event.key)
      if (!Number.isInteger(digit) || digit < 1 || digit > ITEMS.length) return
      const item = ITEMS[digit - 1]
      if (item === undefined) return
      event.preventDefault()
      onToggle(item.key)
      focusItem(digit - 1)
    }

    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [onToggle, focusItem])

  /** 方向键在组内移动，并同步焦点。 */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const nodes = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-item]') ?? [])
    const current = nodes.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = (current + step + nodes.length) % nodes.length
    nodes[next]?.focus()
  }, [])

  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail__group" ref={listRef} role="toolbar" aria-orientation="vertical" onKeyDown={onKeyDown}>
        {ITEMS.map((item, index) => {
          const selected = item.key === active
          return (
            <button
              key={item.key}
              type="button"
              data-rail-item
              className="rail__item"
              aria-label={item.label}
              aria-expanded={selected}
              aria-pressed={selected}
              tabIndex={index === focusIndex || (active === undefined && index === 0) ? 0 : -1}
              onClick={() => { onToggle(item.key) }}
            >
              <Icon icon={item.icon} size={16} />
              <span className="rail__label" aria-hidden="true">{item.label}</span>
            </button>
          )
        })}
      </div>

      {/*
        设置固定在底部（y = 532 = 580 − 16 − 32，§5.2）。
        用 `margin-top: auto` 把它推到底而不是绝对定位：绝对定位在窗口
        变高时不会跟着移动，而这里应当始终贴底。
      */}
      <button
        type="button"
        className="rail__item rail__item--settings"
        aria-label="偏好设置"
        onClick={onOpenSettings}
      >
        <Icon icon={IconSettings} size={16} />
        <span className="rail__label" aria-hidden="true">设置</span>
      </button>
    </nav>
  )
}
