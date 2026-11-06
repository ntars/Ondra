/**
 * 输入框。
 *
 * ## 一张卡片，不是一条输入线
 *
 * 三个问题叠在一起：写字、切权限、切模型。做成一张卡片是承认它们
 * 属于同一件事——"这一轮怎么发出去"。拆成三行独立控件会让用户
 * 每次发送前都要在三个地方做决定，而它们其实是一次决定。
 *
 * ## 底部一行的顺序
 *
 * 左：加号 → 权限档位
 * 右：模型 → 麦克风 → 发送
 *
 * 权限在左、模型在右是刻意的：权限是"能做什么"（约束），
 * 模型是"用谁来想"（选择）。约束放在远离主操作的一侧，
 * 避免用户在按发送前先被"完全访问"这类文字干扰注意力。
 *
 * ## 快捷键
 *
 * `Enter` 发送、`Shift+Enter` 换行。这与所有主流对话应用一致，
 * 不采用"Enter 换行"那种反直觉的设定。
 * 输入法正在组字时（`compositionstart` 之后）按 Enter 不能发送——
 * 中文用户选词时按的那一下回车不该把半句话发出去。
 */

import { useEffect, useRef, useState } from 'react'
import {
  ChevronDownIcon,
  DatabaseIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SendArrowIcon,
  ShieldIcon,
  StopIcon,
} from './icons.tsx'
import type { ModelDescriptor, PermissionLevel } from '../lib/api.ts'

/** 已选附件。 */
export interface Attachment {
  id: string
  name: string
}

/** 权限档位的展示文案。 */
export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  full: '完全访问',
  workspace: '仅工作区',
  chat: '仅对话',
}

/** 权限档位的说明，用于设置面板与悬停提示。 */
export const PERMISSION_HINTS: Record<PermissionLevel, string> = {
  full: '可以读写文件、执行命令，并访问网络。',
  workspace: '只能读写空谷的工作目录，无法访问其他位置。',
  chat: '只能对话。不读写任何文件，也不执行命令。',
}

/** 组件属性。 */
export interface ComposerProps {
  value: string
  onChange(value: string): void
  onSend(): void
  /** 生成中。此时发送键变为停止键。 */
  busy?: boolean
  onStop?(): void
  /** 当前权限档位。 */
  permission: PermissionLevel
  /** 点击权限区。不传则不显示下拉箭头（表示不可切换）。 */
  onPermissionClick?(): void
  placeholder?: string
  /** 自动聚焦。首页与对话态都需要打开就聚焦。 */
  autoFocus?: boolean
  /** 禁用（启动失败时）。 */
  disabled?: boolean

  /** 可选模型列表。空数组时模型选择器不显示。 */
  models: ModelDescriptor[]
  /** 当前模型 id。 */
  modelId: string | undefined
  /** 切换模型。 */
  onModelChange(id: string): void

  /** 点击圆圈加号（附加文件）。 */
  onAddFile?(): void
  /** 已选附件。 */
  attachments: Attachment[]
  /** 移除某条附件。 */
  onRemoveAttachment(id: string): void

  /** 点击语音输入。 */
  onVoice?(): void
  /** 是否正在录音。 */
  voiceActive?: boolean

  /** 本轮用量。没有时不显示底部用量行。 */
  usage?: ComposerUsage
}

/** 输入框底部的用量信息。 */
export interface ComposerUsage {
  /** 本轮消耗的 token 数。 */
  tokens: number
  /** 缓存命中率，0–100。 */
  cacheHit: number
  /** 上下文占用，0–100。 */
  context: number
}

/**
 * 渲染输入框。
 */
export function Composer(props: ComposerProps): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  /** 输入法是否正在组字。 */
  const composing = useRef(false)

  // 高度随内容增长，但有上限。上限由 CSS 的 max-height 控制，
  // 这里只负责把 scrollHeight 同步到 height。
  useEffect(() => {
    const node = ref.current
    if (node === null) return
    // 先归零再读 scrollHeight：不归零的话，删除文字后高度不会跟着缩小。
    node.style.height = 'auto'
    node.style.height = `${String(node.scrollHeight)}px`
  }, [props.value])

  useEffect(() => {
    if (props.autoFocus === true) ref.current?.focus()
  }, [props.autoFocus])

  const canSend = props.value.trim() !== '' && props.disabled !== true

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter') return
    // Shift+Enter 换行；输入法组字中的 Enter 让输入法自己处理。
    if (event.shiftKey) return
    if (composing.current) return
    event.preventDefault()
    if (props.busy === true) return
    if (canSend) props.onSend()
  }

  return (
    <div className="composer">
      <div className="composer__card">
        {props.attachments.length > 0 ? (
          <div className="composer__attachments">
            {props.attachments.map((file) => (
              <span key={file.id} className="attachment">
                <PaperclipIcon />
                <span className="attachment__name" title={file.name}>{file.name}</span>
                <button
                  type="button"
                  className="attachment__remove"
                  onClick={() => { props.onRemoveAttachment(file.id) }}
                  aria-label={`移除 ${file.name}`}
                  title="移除"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={ref}
          className="composer__input scroller"
          value={props.value}
          placeholder={props.placeholder ?? '在这里书写我们的故事…'}
          rows={1}
          disabled={props.disabled}
          onChange={(event) => { props.onChange(event.target.value) }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          aria-label="输入内容"
        />

        {/* 发送键固定在卡片内右下角。原版 OQYONa_sendColumn 就是这个位置：
            42×36 的一列，右内边距与卡片对齐，垂直贴底。 */}
        <div className="composer__sendColumn">
          {props.busy === true ? (
            <button
              type="button"
              className="send send--stop"
              onClick={props.onStop}
              aria-label="停止生成"
              title="停止生成"
            >
              <StopIcon size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              onClick={props.onSend}
              disabled={!canSend}
              aria-label="发送"
              title="发送（Enter）"
            >
              <SendArrowIcon size={15} />
            </button>
          )}
        </div>
      </div>

      {/*
        卡片下方的一行附属控件。
        原版把它们放在卡片之外（OQYONa_row 在 card 之后）：
        加号与权限在左、模型与语音在右。放在卡片里会让卡片高度
        从 76px 涨到 110px，输入区从此占掉中栏五分之一。
      */}
      <div className="composer__row">
        <div className="composer__left">
          {props.onAddFile === undefined ? null : (
            <button
              type="button"
              className="composer__add"
              onClick={props.onAddFile}
              aria-label="附加文件"
              title="附加文件"
            >
              <PlusIcon size={15} />
            </button>
          )}

          <PermissionChip
            permission={props.permission}
            {...(props.onPermissionClick === undefined ? {} : { onClick: props.onPermissionClick })}
          />
        </div>

        <div className="composer__right">
          <ModelSelect
            models={props.models}
            modelId={props.modelId}
            onSelect={props.onModelChange}
          />

          {props.onVoice === undefined ? null : (
            <button
              type="button"
              className={`icon-button${props.voiceActive === true ? ' icon-button--active' : ''}`}
              onClick={props.onVoice}
              aria-label={props.voiceActive === true ? '停止语音输入' : '语音输入'}
              title={props.voiceActive === true ? '停止语音输入' : '语音输入'}
            >
              <MicIcon size={15} />
            </button>
          )}
        </div>
      </div>

      {props.usage === undefined ? null : (
        <div className="composer__usage">
          <span className="usage-chip" title="本轮消耗的 token 数">
            <DatabaseIcon size={11} />
            {formatTokens(props.usage.tokens)} tok · 缓存命中 {props.usage.cacheHit}%
          </span>
          <span className="usage-chip" title="上下文窗口占用">
            <span className="usage-ring" aria-hidden>
              <svg viewBox="0 0 24 24" width="11" height="11">
                <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.22" />
                <circle
                  cx="12"
                  cy="12"
                  r="8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${String((props.usage.context / 100) * 50.3)} 50.3`}
                  transform="rotate(-90 12 12)"
                />
              </svg>
            </span>
            {props.usage.context}%
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * 把 token 数格式化成短形式。
 *
 * 1234 → 1.2K、1234567 → 1.2M。界面上不需要精确到个位——
 * 用户看这个数字是为了判断"这轮聊了多少"，不是要对账。
 */
function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** 权限选择器。
 *
 * 图标用盾牌而不是锁：锁容易和"加密"混淆，而这里说的是"能访问什么"。
 */
function PermissionChip(
  { permission, onClick }: { permission: PermissionLevel; onClick?: () => void },
): React.JSX.Element {
  const restricted = permission !== 'full'
  const className = `permission${restricted ? ' permission--restricted' : ''}`
  const content = (
    <>
      <ShieldIcon size={13} />
      <span>{PERMISSION_LABELS[permission]}</span>
      {onClick === undefined ? null : <ChevronDownIcon size={10} />}
    </>
  )

  // 不可切换时渲染成静态元素而不是禁用按钮：禁用按钮仍然占键盘焦点，
  // 而这里本来就没有可执行的动作。
  if (onClick === undefined) {
    return <span className={className} title={PERMISSION_HINTS[permission]}>{content}</span>
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      title={PERMISSION_HINTS[permission]}
    >
      {content}
    </button>
  )
}

/** 模型选择器。当前模型 + 展开菜单。 */
function ModelSelect(
  { models, modelId, onSelect }: { models: ModelDescriptor[]; modelId: string | undefined; onSelect(id: string): void },
): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点开后在外部点击要收起：否则菜单会一直挂着。
  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => { document.removeEventListener('mousedown', onDocClick) }
  }, [open])

  // 没有可选模型时整个选择器不渲染——避免显示一个空的、点不开的下拉。
  if (models.length === 0) return null

  const current = models.find((item) => item.id === modelId) ?? models[0]

  return (
    <div className="model-select" ref={ref}>
      <button
        type="button"
        className="model-select__trigger"
        onClick={() => { setOpen((value) => !value) }}
        title={current?.label ?? '选择模型'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="model-select__label">{current?.label ?? '选择模型'}</span>
        <ChevronDownIcon size={10} />
      </button>
      {open ? (
        <div className="model-select__menu" role="menu">
          {models.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={
                item.id === current?.id
                  ? 'model-select__item model-select__item--current'
                  : 'model-select__item'
              }
              onClick={() => {
                onSelect(item.id)
                setOpen(false)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
