/**
 * 排队区：等这一轮结束后依次发出的消息。
 *
 * ## 为什么它必须存在
 *
 * 生成中可以继续打字是刚需（她回一大段时要等十几秒）。这些字有两种去处：
 * 打断她立刻发，或者排在后面。选了「排队」就要看得见队里有什么——
 * 否则用户无法判断自己刚才那句话到底排上了没有，只能再打一遍。
 *
 * ## 能改、能挪、能删，缺一不可
 *
 * - 只有「删」：打错一个字就整条重打，而重打会排到队尾，顺序全乱。
 * - 不能挪：两句话依赖先后时（先问 A 再问 B）就要清空重排。
 * - 只有列表：用户看不出来哪条正在被发出去。
 *
 * 所以每一行都带「上移 / 下移 / 改 / 删」四个动作，并把它排在第几位。
 *
 * ## 为什么默认折叠
 *
 * 队里通常只有一两条。展开着的队列会一直占掉输入区上方两行高度，
 * 而它多半时候是空的。折叠成一行「2 条排队中」既报数又不占地方；
 * 需要动手时点开。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconChevronDown, IconChevronRight, IconClose } from './icons.ts'
import type { QueuedMessage } from '../lib/types.ts'

export interface QueueDockProps {
  /** 排队中的消息，按发送顺序。 */
  items: readonly QueuedMessage[]
  /** 移除一条。 */
  onDrop(id: string): void
  /** 改一条的正文。 */
  onEdit(id: string, text: string): void
  /** 上移 / 下移一条。 */
  onMove(id: string, direction: -1 | 1): void
}

/**
 * 渲染排队区。
 *
 * @param props 见 `QueueDockProps`。
 * @returns 一行汇总 + 展开后的条目列表。
 */
export function QueueDock({ items, onDrop, onEdit, onMove }: QueueDockProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** 正在编辑的那一条。同一时刻只编辑一条：两条输入框同时开，焦点听谁的都说不清。 */
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')

  const beginEdit = useCallback((item: QueuedMessage): void => {
    setEditing(item.id)
    setDraft(item.text)
    setOpen(true)
  }, [])

  const commit = useCallback((): void => {
    if (editing === undefined) return
    const text = draft.trim()
    /* 改空了就当作删除：留一条空消息在队里，发出去是一条空气泡。 */
    if (text === '') onDrop(editing)
    else onEdit(editing, text)
    setEditing(undefined)
    setDraft('')
  }, [editing, draft, onDrop, onEdit])

  const cancel = useCallback((): void => {
    setEditing(undefined)
    setDraft('')
  }, [])

  /*
   * 编辑框自动聚焦。
   *
   * 点「改」之后立刻能打字，否则用户还要再点一次输入框——而这中间
   * 队列可能已经自己发出了，改到一半消失是最差的体验。
   */
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editing === undefined) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  return (
    <div className="queue" data-open={open ? '' : undefined}>
      <div className="queue__head">
        <button
          type="button"
          className="queue__toggle"
          aria-expanded={open}
          onClick={() => { setOpen((previous) => !previous) }}
        >
          <Icon icon={open ? IconChevronDown : IconChevronRight} size={16} />
          <span className="queue__title">{items.length} 条排队中</span>
          <span className="queue__note">这一轮结束后依次发出</span>
        </button>
      </div>

      {open ? (
        <ol className="queue__list">
          {items.map((item, index) => (
            <li key={item.id} className="queue__item">
              <span className="queue__index" aria-hidden="true">{index + 1}</span>

              {editing === item.id ? (
                <>
                  <input
                    ref={inputRef}
                    className="queue__edit"
                    value={draft}
                    aria-label="修改排队消息"
                    onChange={(event) => { setDraft(event.target.value) }}
                    onKeyDown={(event) => {
                      /* 输入法组合中不提交：选词的回车不是"确认"。 */
                      if (event.nativeEvent.isComposing) return
                      if (event.key === 'Enter') { event.preventDefault(); commit() }
                      if (event.key === 'Escape') { event.preventDefault(); cancel() }
                    }}
                  />
                  <button type="button" className="queue__action" onClick={commit}>保存</button>
                  <button type="button" className="queue__action" onClick={cancel}>取消</button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="queue__text"
                    title="点击修改"
                    onClick={() => { beginEdit(item) }}
                  >
                    {item.text === '' ? '（只有附件）' : item.text}
                  </button>
                  <button
                    type="button"
                    className="queue__action"
                    aria-label="上移"
                    disabled={index === 0}
                    onClick={() => { onMove(item.id, -1) }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="queue__action"
                    aria-label="下移"
                    disabled={index === items.length - 1}
                    onClick={() => { onMove(item.id, 1) }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="queue__action queue__action--drop"
                    aria-label="从队列移除"
                    onClick={() => { onDrop(item.id) }}
                  >
                    <Icon icon={IconClose} size={16} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
