/**
 * 窗口此刻对用户来不来得及看见（§7.4 三态）。
 *
 * ## 为什么要问壳，而不是自己看 `document.hidden`
 *
 * 见 `src-tauri/src/window.rs` 里 `VISIBILITY_EVENT` 的长注释。一句话：
 * `window.hide()` 之后 WebView 是否把 `document.hidden` 置真**不保证**——
 * macOS 的 WKWebView 被 `orderOut` 之后可能既不触发事件也不改这个值。
 * 用它当判据会得到一个安静的缺陷：用户关了窗口，她永远不说话。
 *
 * 而隐藏与唤回都发生在壳自己的代码里，在那里发一条事件是唯一确定的答案。
 *
 * ## 为什么「聚焦」还要自己判
 *
 * 壳只能告诉我们「窗口显示 / 看不见」。「窗口可见但焦点在别的应用」
 * 这一档壳不知道——它没有失焦事件的钩子，而且这种状态变化极频繁
 * （用户每点一下别的窗口都变），为它跑一趟 IPC 不值得。
 * 而浏览器原生就有 `focus` / `blur`，直接用最省。
 *
 * 两路合起来才是完整三态：
 *
 * | 壳说 | `hasFocus()` | 结论 |
 * | --- | --- | --- |
 * | 看不见 | — | `hidden`（优先级最高，隐藏时必然无焦点） |
 * | 可见 | true | `visible` |
 * | 可见 | false | `unfocused` |
 */

import { useEffect, useState } from 'react'
import { isDesktopShell, listenShell } from './shell.ts'
import type { WindowVisibility } from './useProactiveTick.ts'

/**
 * 现算当前三态。
 *
 * 每次调用都读一次实时状态，不缓存：这个判断的代价是两次属性读取，
 * 而缓存一个「会过期的事实」要写失效逻辑，不划算。
 */
export function readVisibility(): WindowVisibility {
  /*
   * 先看壳说的。`hidden` 一旦成立就返回，不再看焦点——
   * 隐藏的窗口在 macOS 上 `hasFocus()` 有时仍返回 true（焦点还挂在
   * 那个已经不可见的窗口上），这时若按焦点判就会得出 `visible`，
   * 于是「用户关了窗口」变成「窗口好好开着，不用发通知」。
   */
  if (shellHidden) return 'hidden'
  if (typeof document !== 'undefined' && !document.hasFocus()) return 'unfocused'
  return 'visible'
}

/**
 * 壳报告的最后一次可见性。
 *
 * 初始值 `false`（不隐藏）而不是 `undefined`：页面刚加载时窗口一定是
 * 显示的，这是唯一合理的默认。若初始成 `undefined` 再等事件，
 * 第一秒内的判断会落进一个「什么都不知道」的分支。
 */
let shellHidden = false

/** 订阅者。 */
const listeners = new Set<() => void>()

/** 通知订阅者。 */
function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * 装壳的可见性事件与浏览器焦点事件。应用启动时调一次。
 *
 * 幂等：重复调用只会有一次生效（用模块级标记挡住）。
 */
let installed = false
export function installVisibilityTracking(): void {
  if (installed) return
  installed = true

  if (isDesktopShell()) {
    void listenShell<boolean>('window-visibility', (payload) => {
      /*
       * `hidden` 就是「壳说看不见」。事件来自 `window.rs` 的
       * `emit_visibility`，三处触发：hide()、reveal()、最小化/恢复。
       */
      const next = payload !== true
      if (next === shellHidden) return
      shellHidden = next
      notify()
    })
  }

  if (typeof globalThis.addEventListener !== 'function') return
  /* 焦点变化只影响 `visible` 与 `unfocused` 之间的切换，通知一次即可。 */
  globalThis.addEventListener('focus', notify)
  globalThis.addEventListener('blur', notify)
}

/**
 * 读三态的 React 钩子。
 *
 * 用轮询而不是 `useSyncExternalStore`：`readVisibility()` 依赖
 * `document.hasFocus()` 这个**命令式**的实时查询，它不是可订阅的状态。
 * 挂一个 1 秒的轻轮询，代价是每秒一次属性读取——但只在需要它的地方
 * （主动开口的定时器里）才挂，且用户感知不到任何延迟。
 *
 * 不用 `useSyncExternalStore` 的另一个原因：它的快照函数会在每次渲染时
 * 被调用两次做一致性检查，而 `hasFocus()` 在这两次之间理论上可以变化，
 * 会触发 React 的「快照不稳定」告警。
 */
export function useWindowVisibility(): WindowVisibility {
  const [visibility, setVisibility] = useState<WindowVisibility>(readVisibility)

  useEffect(() => {
    const sync = (): void => {
      const next = readVisibility()
      setVisibility((previous) => (previous === next ? previous : next))
    }
    sync()
    const timer = globalThis.setInterval(sync, 1000)
    return () => { globalThis.clearInterval(timer) }
  }, [])

  return visibility
}
