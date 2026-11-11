/**
 * 设置面板的表单原语。
 *
 * ## 为什么单独一个文件
 *
 * 合并之前有两套设置：独立窗口那份（主题、字号、声音）与主界面右栏那份
 * （1116 项插件参数）。它们各自写了一套「一行设置」「一组单选」「一段说明」，
 * 于是同一个应用里出现了两种行高、两种说明底色、两种选中态。合并成一个
 * 面板时先把这些原语抽出来——**七页共用一份实现**，样子就不会再各自漂开。
 *
 * ## 类名前缀为什么还叫 `pref__`
 *
 * 它取自上一版的「偏好设置」，而那个窗口已经不在了。改名要动四百行样式与
 * 三张自检网，换不来任何用户可见的收益；名字只是样式命名空间，语义由这里
 * 这段注释承担。`settings__*` 留给面板外壳（遮罩、导航、内容区），
 * 两者分工是「壳」与「料」。
 */

import { useRef } from 'react'

/**
 * 一组单选。
 *
 * ## 为什么不用原生 radio
 *
 * 主题要显示三档（跟随系统 / 浅色 / 深色）并带说明，字号要带像素值——
 * 原生 radio 接不进去。这里用 `role="radiogroup"` + `role="radio"`，
 * 语义与原生等价，样式完全可控。
 *
 * ## 键盘行为是手写的，所以必须真的写
 *
 * 换了 role 就等于承诺一套键盘语义：方向键在选项之间移动、Home/End 跳到
 * 首尾、Tab 只落在**当前选中**那一项上（roving tabindex）。上一版只写了
 * `role="radiogroup"` 而没有这些，读屏会念「单选组」，然后用户按方向键
 * 什么都不会发生——比不用 role 更糟。这里补齐。
 */
export function Choices<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string
  value: T
  options: Array<{ value: T; label: string; hint?: string }>
  onChange(next: T): void
}): React.JSX.Element {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  /**
   * 方向键移动。
   *
   * 上下左右都认：这一组在视觉上是竖排，但用户按左右也不会觉得错——
   * macOS 的系统设置里两种都有效。`Home` / `End` 是 radiogroup 的约定。
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = options.length - 1
    let next = -1
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next < 0) return

    event.preventDefault()
    const target = options[next]
    if (target === undefined) return
    onChange(target.value)
    buttons.current[next]?.focus()
  }

  return (
    <div className="pref__choices" role="radiogroup" aria-label={name}>
      {options.map((option, index) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            /*
             * roving tabindex：只有选中的那一项能被 Tab 命中。整组因此
             * 在 Tab 顺序里只占一格，与原生 radio 行为一致。
             */
            tabIndex={checked ? 0 : -1}
            className="pref__choice"
            ref={(node) => { buttons.current[index] = node }}
            onClick={() => { onChange(option.value) }}
            onKeyDown={(event) => { onKeyDown(event, index) }}
          >
            <span className="pref__choice-label">{option.label}</span>
            {option.hint === undefined ? null : (
              <span className="pref__choice-hint">{option.hint}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** 一段说明。七页都用同一种排版，避免各页各长一样又各差一点。 */
export function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="pref__note">{children}</p>
}

/**
 * 开关。
 *
 * 原生复选框的视觉由系统画，改不动尺寸与圆角，在设置面板里会显得比周围
 * 所有控件都"外来"。`role="switch"` + `aria-checked` 语义等价、样式可控。
 *
 * 禁用态用 `aria-disabled` 而不是原生 `disabled`：后者会把元素移出 Tab
 * 顺序，键盘用户就再也听不到"这一项现在不可用"。
 */
export function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange(next: boolean): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      {...(disabled === true ? { 'aria-disabled': 'true' } : {})}
      className="pref__switch control-switch"
      onClick={() => {
        if (disabled === true) return
        onChange(!checked)
      }}
    >
      <span className="pref__switch-knob control-switch-knob" />
    </button>
  )
}

/**
 * 一行设置：左边文字（标签 + 说明），右边控件。
 *
 * 说明是可选的一行小字——它回答的是「这一项到底改了什么」，只有真的
 * 需要解释时才给。每一行都配一句会变成噪音。
 */
export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="pref__row">
      <div className="pref__row-text">
        <span className="pref__row-label">{label}</span>
        {hint === undefined ? null : <span className="pref__row-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** 页内小节标题。 */
export function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="pref__heading">{children}</h2>
}
