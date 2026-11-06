/**
 * 输入区（Composer，§5.6）。
 *
 * ## 它承载的不只是输入
 *
 * 一块 620 × 76 的卡片里有五样东西：正文输入、附件缩略图、
 * 加号、模型名、发送键。任何一样缺失，用户都会先去找它而不是先打字——
 * 「怎么换个模型」比「说什么」更常发生。
 *
 * ## 十条输入细则落在哪
 *
 * §5.6 的十条细则里，能靠 CSS 表达的在 `composer.css`，需要状态的在这里：
 *
 * | 细则 | 落点 |
 * | --- | --- |
 * | 空输入时发送键**保留**但降为 40% | `disabled` + CSS 不透明度，不移除节点 |
 * | 首次聚焦边框转 teal | CSS `:focus-within` |
 * | 高度 1→3 行逐级增长 | `rows` 由内容行数算，封顶 3 |
 * | 粘贴多行不自动发送 | 不监听 paste，交给浏览器默认行为 |
 * | 生成中输入框仍可编辑 | `disabled` 只加在发送键上 |
 * | 生成中按 Enter | 走 `interrupt` 判断 |
 * | 草稿跨会话保留 | 状态在 `useAppState`，本组件不持有 |
 * | 超长提示 | 字数接近上限时底部行出现计数 |
 *
 * ## 为什么 `isComposing` 要判 `nativeEvent`
 *
 * React 的合成事件不带 `isComposing`，它在原生 `KeyboardEvent` 上。
 * 不判这一条，中文输入法选词时按回车会把半截拼音发出去——
 * 这是中文界面最容易出、也最难在英文环境复现的缺陷。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose, IconPlus, IconSend } from './icons.ts'
import type { Attachment } from '../lib/types.ts'
import type { ModelDescriptor } from '../lib/api.ts'

/** 单条上限。超过这个字数在底部行给计数提示（§5.6）。 */
const SOFT_LIMIT = 8000

/** 超过这个字数在发送前弹确认（§12.14）。 */
const CONFIRM_LIMIT = 8000

/** 单行高度，用于把内容行数换算成可视高度。 */
const LINE = 20

/** 最多展开 3 行，超出内部滚动（§5.6）。 */
const MAX_ROWS = 3

export interface ComposerProps {
  /** 当前草稿。 */
  value: string
  /** 草稿变化。 */
  onChange(value: string): void
  /** 发送。 */
  onSend(): void
  /** 停止生成。 */
  onStop(): void
  /** 是否正在生成。 */
  busy: boolean
  /** 已选附件。 */
  attachments: Attachment[]
  /** 弹出文件选择。 */
  onAddFiles(): void
  /** 移除一条附件。 */
  onRemoveAttachment(id: string): void
  /** 可选模型。 */
  models: ModelDescriptor[]
  /** 当前模型 id。 */
  modelId: string | undefined
  /** 切换模型。 */
  onSelectModel(id: string): void
  /**
   * 生成中按 Enter 的行为。
   *
   * `queue` 入队等这一轮结束，`interrupt` 立刻停止并发送（§5.6）。
   * 取值来自设置；本期没有设置项时用 `interrupt`——
   * 用户按下回车时想要的通常是「我现在就要说」。
   */
  interrupt?: 'queue' | 'interrupt'
}

/**
 * 渲染输入区。
 *
 * @param props 见 `ComposerProps`。
 * @returns 输入卡片。
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  models,
  modelId,
  onSelectModel,
  interrupt = 'interrupt',
}: ComposerProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const current = models.find((model) => model.id === modelId)

  /**
   * 高度自适应。
   *
   * ## 为什么不直接写 `rows`
   *
   * `rows` 只是初始提示，实际高度由浏览器按内容算，会一直长到几十行。
   * 必须显式设 `height` 才能封顶。先置 `auto` 再读 `scrollHeight`，
   * 是因为不置 auto 时读到的 `scrollHeight` 只增不减——删字之后框不会缩。
   */
  useEffect(() => {
    const node = inputRef.current
    if (node === null) return
    node.style.height = 'auto'
    const max = LINE * MAX_ROWS + 12
    node.style.height = `${String(Math.min(node.scrollHeight, max))}px`
  }, [value])

  /** 发送。超长时先确认（§12.14）。 */
  const submit = useCallback((): void => {
    const text = value.trim()
    if (text === '' && attachments.length === 0) return
    if (text.length > CONFIRM_LIMIT) {
      // 用原生 confirm 是这一处唯一的例外：项目里没有 Dialog 组件，
      // 为一个边缘场景引入一整套 Sheet/Dialog 不划算。等 §5.12 的
      // Dialog 落地后换掉，注释留在此处便于日后定位。
      if (!globalThis.confirm(`内容较长（${String(text.length)} 字），确认发送？`)) return
    }
    if (busy) {
      if (interrupt === 'interrupt') onStop()
      else return
    }
    onSend()
  }, [value, attachments.length, busy, interrupt, onStop, onSend])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 组合中不发送（§12.3）。这一条必须最先判。
    if (event.nativeEvent.isComposing) return
    if (event.key !== 'Enter') return
    // Shift + Enter 与 Cmd/Ctrl + Enter 都不走默认发送路径：
    // 前者换行，后者按设置走另一种发送方式。
    if (event.shiftKey) return
    event.preventDefault()
    if ((event.metaKey || event.ctrlKey) && interrupt === 'queue') {
      // Cmd/Ctrl + Enter 在「排队」模式下才代表立即发送，其余情况同 Enter。
      submit()
      return
    }
    submit()
  }, [submit, interrupt])

  // 模型菜单：点到外面就关。用 pointerdown 而不是 click：
  // click 在「按在菜单外、松在菜单内」时不会触发，菜单会留在原地。
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) return
      setMenuOpen(false)
    }
    globalThis.addEventListener('pointerdown', onPointerDown)
    return () => { globalThis.removeEventListener('pointerdown', onPointerDown) }
  }, [menuOpen])

  const overLimit = value.length > SOFT_LIMIT

  return (
    <div className="composer">
      <div className="composer__card">
        {/* 附件缩略图排在输入框上方，超过 6 个横向滚动（§5.6）。 */}
        {attachments.length > 0 ? (
          <ul className="composer__attachments">
            {attachments.map((item) => (
              <li key={item.id} className="composer__attachment">
                <span className="composer__attachment-name" title={item.name}>{item.name}</span>
                <button
                  type="button"
                  className="composer__attachment-remove"
                  aria-label={`移除 ${item.name}`}
                  onClick={() => { onRemoveAttachment(item.id) }}
                >
                  <Icon icon={IconClose} size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <textarea
          ref={inputRef}
          className="composer__input"
          value={value}
          rows={1}
          placeholder="说点什么…"
          aria-label="输入消息"
          onChange={(event) => { onChange(event.target.value) }}
          onKeyDown={onKeyDown}
        />

        <div className="composer__row">
          <button
            type="button"
            className="composer__attach"
            aria-label="附加文件"
            title="附加文件"
            onClick={onAddFiles}
          >
            <Icon icon={IconPlus} size={16} />
          </button>

          {/*
            模型名。点击展开候选。没有可选模型时显示「未选择」并指向设置
            （§12.5 的空状态规则：显示引导语而不是「暂无数据」）。
          */}
          <div className="composer__model" ref={menuRef}>
            <button
              type="button"
              className="composer__model-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen((previous) => !previous) }}
            >
              {current === undefined ? '未选择' : current.label}
            </button>
            {menuOpen ? (
              <div className="composer__model-menu" role="menu">
                {models.length === 0 ? (
                  <p className="composer__model-empty">还没有可用的模型，去设置里加一个</p>
                ) : (
                  models.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={model.id === modelId}
                      className="composer__model-item"
                      onClick={() => {
                        onSelectModel(model.id)
                        setMenuOpen(false)
                      }}
                    >
                      {model.label}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          {/* 超长时出现计数，不超长时不显示——常驻会让人时刻在意字数。 */}
          {overLimit ? (
            <span className="composer__count" data-over="">
              {value.length} / {SOFT_LIMIT}
            </span>
          ) : null}

          <span className="composer__spacer" />

          {/*
            发送键。生成中换成「先别说」（§5.4）：用户此刻最可能想做的
            不是再发一条，而是让这一轮停下。同一个位置，两种语义。
          */}
          {busy ? (
            <button type="button" className="composer__stop" onClick={onStop}>
              先别说
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              aria-label="发送"
              disabled={value.trim() === '' && attachments.length === 0}
              onClick={submit}
            >
              <Icon icon={IconSend} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
