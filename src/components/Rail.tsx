/**
 * 左侧脊（Rail）。
 *
 * ## 职责
 *
 * 56px 竖条：三个抽屉入口 + 一个设置。点击入口就地展开抽屉，不改主列宽度、
 * 不重排正文（§3.4）。
 *
 * ## 三个抽屉，不是一个列表
 *
 * 单会话制之后，左栏不再需要「会话列表」——全应用只有一段对话。于是原来
 * 按时间切分的三个入口（今天 / 本周 / 记忆）换成了按**职能**切分的三个：
 *
 * | 入口 | 回答的问题 | 内容来源 |
 * | --- | --- | --- |
 * | 会话 | 这一段聊了多少、从什么时候开始 | `/api/sessions/:id/stats` |
 * | 日志 | 她这几轮做了什么、后台发生了什么 | `/api/logs/*` |
 * | 扩展 | 装了哪些包、哪些在跑、去哪儿改配置 | `/api/plugins` |
 *
 * 三者互不重叠：会话是**这一段**的账，日志是**过程**，扩展是**能力清单**。
 *
 * ## 为什么设置不在抽屉之列
 *
 * §5.2 的交互细则明确「齿轮不展开抽屉，直接打开偏好设置窗口」。
 * 设置是独立窗口，若也走抽屉，用户在两个不同容器里看到同一组偏好，
 * 会出现「改了这边那边没变」的猜疑。
 *
 * ## 快捷键编号只到 3
 *
 * `Cmd/Ctrl + 1..3` 对应三个抽屉，设置走 `Cmd/Ctrl + ,`（§9.1 同表有定义）。
 * 第四项没有数字键：它不是抽屉，给它发一个号会让人以为 `Cmd+4` 也展开点什么。
 */

import { useCallback, useEffect, useRef } from 'react'
import { Icon } from './Icon.tsx'
import { IconExtension, IconLog, IconSession, IconSettings } from './icons.ts'
import { isTypingTarget, keyContext } from '../lib/shortcuts.ts'
import type { IconInput } from 'morphicons/react'

/**
 * 抽屉的三个入口。
 *
 * 类型即真源：`Drawer.tsx` 用它决定渲染什么内容，`App.tsx` 用它存状态。
 * 三处不各写一份字符串。
 */
export type DrawerKey = 'session' | 'log' | 'extension'

/** 一个入口的定义。 */
interface RailItem {
  key: DrawerKey
  icon: IconInput
  label: string
  /** 快捷键数字（`Cmd/Ctrl + n`）。 */
  shortcut: number
}

/** 三个入口，顺序即「这一段 → 过程 → 能力」。 */
const ITEMS: RailItem[] = [
  { key: 'session', icon: IconSession, label: '会话', shortcut: 1 },
  { key: 'log', icon: IconLog, label: '日志', shortcut: 2 },
  { key: 'extension', icon: IconExtension, label: '扩展', shortcut: 3 },
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
 * 不这么做的话，四个按钮会各占一个 Tab 停靠点，用户要按四次才过得去。
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
   * `Cmd/Ctrl + 1..3` 直达。
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
              /* 悬停即有系统原生提示（U3）：自绘标签要等动画，原生提示是即时的。 */
              title={item.label}
              aria-expanded={selected}
              aria-pressed={selected}
              tabIndex={index === focusIndex || (active === undefined && index === 0) ? 0 : -1}
              onClick={() => { onToggle(item.key) }}
            >
              <Icon icon={item.icon} size={20} />
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
        title="偏好设置"
        onClick={onOpenSettings}
      >
        <Icon icon={IconSettings} size={20} />
        <span className="rail__label" aria-hidden="true">设置</span>
      </button>
    </nav>
  )
}
