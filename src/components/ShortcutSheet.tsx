/**
 * 快捷键总表（Sheet，§9.4）。
 *
 * ## 为什么是 Sheet 不是 Dialog
 *
 * §9.4 明确：「快捷键总表用 Sheet 不用 Dialog：它是查阅，不是决策，不该阻断用户。」
 * 用户按 `Cmd+/` 时往往只是想确认某一个组合键，看完就按 Esc 回去继续打字。
 * 一个带遮罩、必须点按钮才能关的 Dialog 会打断他正在做的事。
 *
 * 所以这里**没有遮罩**、点空白处即关、`Esc` 即关。
 *
 * ## 为什么内容从 `SHORTCUTS` 读
 *
 * 表里手写一份键位，事件匹配另写一份，两者迟早不一致。这一份数据
 * 同时供 `App.tsx` 的按键分派与这里渲染，改键位只改 `shortcuts.ts` 一处。
 */

import { useCallback, useEffect, useRef } from 'react'
import { ScrollArea } from './ScrollArea.tsx'
import { SHORTCUTS, keycaps } from '../lib/shortcuts.ts'
import { isMac } from '../lib/platform.ts'
import { useRestoreFocus } from '../lib/useRestoreFocus.ts'

export interface ShortcutSheetProps {
  /** 关闭。Esc、点空白、点关闭键都走这里。 */
  onClose(): void
}

/**
 * 分组：把 15 条按用途分成四段。
 *
 * 不按 §9.1 表格的行序分，因为那个顺序是「定义顺序」——发送、换行、
 * 新建、搜索、切 Rail、设置……混着讲。用户查的时候是按场景想的
 * （「怎么发」/「怎么切到别处」/「怎么关」），所以按场景分。
 */
const GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  { title: '说话', ids: ['send', 'newline', 'sendAlt', 'editLast'] },
  { title: '走开', ids: ['newSession', 'rail', 'preferences', 'inspector', 'jumpLatest', 'searchMemory'] },
  { title: '收起来', ids: ['closeLayer', 'stop'] },
  { title: '看', ids: ['cycleTheme', 'copyLast', 'shortcutSheet'] },
]

/**
 * 渲染快捷键总表。
 *
 * @param props 见 `ShortcutSheetProps`。
 * @returns 贴顶的 Sheet 面板。
 */
export function ShortcutSheet({ onClose }: ShortcutSheetProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)

  /*
   * 关闭时把焦点还给触发它的元素（§9.5）。
   *
   * 必须先于下面那个「把焦点移进面板」的 effect 执行——React 按声明顺序
   * 跑 effect，顺序反了记到的就是面板本身。
   */
  useRestoreFocus(true)

  /**
   * Esc 关闭 + 焦点移进面板。
   *
   * 用 `capture` 阶段：`App.tsx` 的 Esc 分层也挂在 `window` 上，
   * 不抢在前面的话，按一次 Esc 会先关掉背后的抽屉再看要不要关这里。
   */
  useEffect(() => {
    const node = panelRef.current
    node?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    globalThis.addEventListener('keydown', onKeyDown, true)
    return () => { globalThis.removeEventListener('keydown', onKeyDown, true) }
  }, [onClose])

  /** 点面板外关闭。 */
  const onBackdrop = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }, [onClose])

  return (
    <div className="sheet" role="presentation" onMouseDown={onBackdrop}>
        <div className="sheet__panel" ref={panelRef} role="dialog" aria-modal="false" aria-labelledby="sheet-title" tabIndex={-1}>
          <header className="sheet__head">
            <h2 className="sheet__title" id="sheet-title">快捷键</h2>
            <p className="sheet__note">
              {isMac() ? '把 ⌘ 换成 Ctrl，就是 Windows 与 Linux 的键位。' : '把 Ctrl 换成 ⌘，就是 macOS 的键位。'}
            </p>
          </header>

          {/*
            内容区走自绘 overlay 滚动条。
            ## 为什么必须用它而不是原生 overflow
            15 条快捷键在 580 高的窗口里 **装不下**：实测内容 673px、
            70vh 上限只有 406px，溢出 267px。而全项目在 `base.css` 里
            把原生滚动条宽度设成了 0（§12.1 要求 overlay 自绘），
            于是「下面还有两块内容」这件事**在视觉上完全不存在**——
            用户看到列表在一行中间被切断，只会以为布局坏了。
          */}
          <ScrollArea className="sheet__scroll" remeasureKey={GROUPS.length}>
            <div className="sheet__body">
              {GROUPS.map((group) => (
                <section className="sheet__group" key={group.title}>
                  <h3 className="sheet__group-title">{group.title}</h3>
                  <dl className="sheet__list">
                    {group.ids.map((id) => {
                      const shortcut = SHORTCUTS.find((item) => item.id === id)
                      if (shortcut === undefined) return null
                      return (
                        <div className="sheet__row" key={id}>
                          <dt className="sheet__name">{shortcut.label}</dt>
                          <dd className="sheet__keys">
                            {keycaps(shortcut.hint).map((part, index) => (
                              <kbd className="sheet__key" key={`${id}-${String(index)}`}>{part}</kbd>
                            ))}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>
                </section>
              ))}
            </div>
          </ScrollArea>
        </div>
    </div>
  )
}
