/**
 * 提示条（Toast，§5.10）。
 *
 * ## 同一时刻只存一条
 *
 * 队列会让「改了三个设置」连弹三条，每条 2.4 秒，用户要等七秒才能继续。
 * 新条替换旧条，旧条不计入任何历史——提示条不是日志，日志在设置页。
 *
 * ## 悬停暂停消失计时
 *
 * 用户把鼠标移上去，说明他正在读。这时计时继续走，读一半就没了，
 * 他会怀疑自己看错了。离开后重新给一个完整时长，而不是「剩下的时间」——
 * 剩下 0.3 秒等于还是没得读。
 *
 * ## 为什么用 context 而不是把 state 提到 App
 *
 * 发提示的地方分散在消息操作、设置保存、复制反馈等多处。逐层透传
 * 一个 `showToast` 会让中间组件的 Props 里出现一堆与它无关的回调。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'

/** 提示的语气。错误态多一条红色竖条，且停留更久。 */
export type ToastTone = 'plain' | 'error'

/** 一条提示。 */
export interface ToastSpec {
  /** 正文。一句话，不带标点结尾的句号。 */
  text: string
  /** 语气。默认 `plain`。 */
  tone?: ToastTone
}

/** 提示条上下文。 */
interface ToastApi {
  /** 弹一条。会替换当前那条。 */
  show(spec: ToastSpec | string): void
}

const ToastContext = createContext<ToastApi | undefined>(undefined)

/** 成功态停留 2.4s，错误态 4.0s（§5.10）。这是停留时长，不属动效五档。 */
const DURATION: Record<ToastTone, number> = {
  plain: 2400,
  error: 4000,
}

/** 当前那条的内部状态。`id` 用于重置进场动画。 */
interface Active {
  id: number
  text: string
  tone: ToastTone
}

export interface ToastProviderProps {
  children: React.ReactNode
}

/**
 * 提示条的提供者。挂在根组件外层，内部同时渲染那唯一一条提示。
 *
 * @param props 见 `ToastProviderProps`。
 * @returns 包住子树的容器与提示条本体。
 */
export function ToastProvider({ children }: ToastProviderProps): React.JSX.Element {
  const [active, setActive] = useState<Active | undefined>(undefined)
  const [paused, setPaused] = useState(false)
  /** 逐条自增，用作 React key：同文案连续弹两次时也能重播进场。 */
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  const show = useCallback((spec: ToastSpec | string): void => {
    seq.current += 1
    const next: Active = typeof spec === 'string'
      ? { id: seq.current, text: spec, tone: 'plain' }
      : { id: seq.current, text: spec.text, tone: spec.tone ?? 'plain' }
    setActive(next)
  }, [])

  const close = useCallback((): void => { setActive(undefined) }, [])

  /**
   * 消失计时。
   *
   * 依赖里同时放 `active` 与 `paused`：`active` 变化时重新计时（换了一条），
   * `paused` 变化时清除或重新开始。合并成一个 effect 而不是两个，
   * 是为了避免「暂停时旧计时器没清干净」这类只在快速交互下复现的问题。
   */
  useEffect(() => {
    if (active === undefined || paused) {
      globalThis.clearTimeout(timer.current)
      return
    }
    timer.current = globalThis.setTimeout(() => { setActive(undefined) }, DURATION[active.tone])
    return () => { globalThis.clearTimeout(timer.current) }
  }, [active, paused])

  const api = useMemo<ToastApi>(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        提示条容器常驻，`data-open` 控制进出场。
        不按 `active` 有无来挂载卸载：卸载会让退场动画直接消失，
        用户看到的是「闪一下就没」，比没有动画更廉价。

        `role="status"` 而不是 `alert`：提示条承载的是「已复制」这类
        不需要打断读屏的消息。错误态也用 status——它不要求用户立刻
        做什么，阻塞读屏反而是打扰。
      */}
      <div className="toast" data-open={active === undefined ? undefined : ''} aria-live="polite">
        {active === undefined ? null : (
          <div
            key={active.id}
            className="toast__body"
            data-tone={active.tone}
            role="status"
            onPointerEnter={() => { setPaused(true) }}
            onPointerLeave={() => { setPaused(false) }}
          >
            <span className="toast__text">{active.text}</span>
            <button type="button" className="toast__close" aria-label="关闭提示" onClick={close}>
              <Icon icon={IconClose} size={16} />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  )
}

/**
 * 取提示条的 `show`。
 *
 * 不在 Provider 内调用时抛错而不是返回空函数：静默无操作会让
 * 「点了复制没反应」这类缺陷一直查不到。
 *
 * @returns `show`。
 */
export function useToast(): ToastApi['show'] {
  const api = useContext(ToastContext)
  if (api === undefined) throw new Error('useToast 必须在 ToastProvider 内使用')
  return api.show
}
