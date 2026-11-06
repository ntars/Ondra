/**
 * 顶部提示条（toast）。
 *
 * ## 为什么必须做这个
 *
 * 上一版所有失败都是静默的：点「新建会话」失败了，界面什么都不说，
 * 用户只会觉得"点了没反应"。原版在顶栏下方浮一条深色提示，
 * 带警告图标和完整错误文案——这是用户唯一能知道"发生了什么"的通道。
 *
 * ## 几何取自原版实测
 *
 * 位置：窗口顶部居中，距顶 56px
 * 外形：圆角 12px、深色底 `#2b2b2b` 一类、白字、字号 13px
 * 图标：三角警告，与文字同行
 *
 * ## 为什么不自动消失
 *
 * 错误信息往往很长（"agent-preset/invalid: persona … never started"），
 * 3 秒内读不完。原版也是常驻到用户主动关掉或下一次操作覆盖。
 * 这里给一个 8 秒的宽限：够读完，又不会永久占住窗口。
 */

import { useEffect, useState } from 'react'
import { AlertIcon, CloseIcon } from './icons.tsx'

/** 一条提示。 */
export interface ToastMessage {
  /** 唯一 id。同一条文案重复出现时也要能区分。 */
  id: number
  /** 文案。 */
  text: string
  /** 语气。错误用警告图标，成功用对勾。 */
  tone: 'error' | 'info'
}

/** 自动消失的时间（毫秒）。 */
const AUTO_DISMISS_MS = 8_000

/** 渲染一条提示条。 */
export function Toast(props: {
  message: ToastMessage
  onDismiss(): void
}): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(props.onDismiss, AUTO_DISMISS_MS)
    return () => { clearTimeout(timer) }
  }, [props])

  return (
    <div className={`toast toast--${props.message.tone}`} role="status" aria-live="polite">
      <span className="toast__icon" aria-hidden>
        <AlertIcon size={16} />
      </span>
      <span className="toast__text">{props.message.text}</span>
      <button type="button" className="toast__close" onClick={props.onDismiss} aria-label="关闭提示">
        <CloseIcon size={13} />
      </button>
    </div>
  )
}

/**
 * 管理提示队列的钩子。
 *
 * 只显示最新一条：多条同时堆叠会把中栏顶部盖住，而这时的重点
 * 是"让用户看清最近这次失败的原因"，不是回顾历史。
 */
export function useToast(): {
  toast: ToastMessage | undefined
  show(text: string, tone?: 'error' | 'info'): void
  dismiss(): void
} {
  const [toast, setToast] = useState<ToastMessage | undefined>(undefined)

  const show = (text: string, tone: 'error' | 'info' = 'error'): void => {
    setToast({ id: Date.now(), text, tone })
  }
  const dismiss = (): void => { setToast(undefined) }

  return { toast, show, dismiss }
}
