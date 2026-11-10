/**
 * 读取当前已解析的主题。
 *
 * ## 为什么不能直接读 `state.theme`
 *
 * `state.theme` 是**用户的选择**，三个值：`system` / `light` / `dark`。
 * 而界面真正呈现的是**解析结果**——用户选 `system` 时，到底是浅还是深
 * 取决于系统偏好，这个结果由 `index.html` 的内联脚本写进
 * `<html data-theme>`。
 *
 * 需要判断「现在是深色吗」的地方（水位插值取哪一组端点）必须读后者，
 * 否则在「跟随系统 + 系统是深色」时会把浅色端点用上去。
 *
 * ## 为什么要监听
 *
 * `data-theme` 是 DOM 属性，不是 React 状态。用户切换主题时 React 未必
 * 重渲染（`useAppState` 的 `theme` 变了，但水位组件的 props 未必变），
 * 不监听就会出现「主题切了、水位还是旧颜色」。
 *
 * 用 `MutationObserver` 而不是定时轮询：属性变化是离散事件，
 * 观察者零开销；轮询要么漏、要么空转。
 */

import { useEffect, useState } from 'react'

/** 读当前主题。SSR 或属性缺失时按浅色处理。 */
function read(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/**
 * 当前解析后的主题。
 *
 * @returns `'light'` 或 `'dark'`。属性变化时自动更新。
 */
export function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(read)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setTheme(read())
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    // 订阅之前可能已经变过一次，补读一遍。
    setTheme(read())
    return () => { observer.disconnect() }
  }, [])

  return theme
}
