/**
 * 与 Tauri 壳通信的薄封装。
 *
 * ## 为什么要在浏览器里也判空
 *
 * 前端既在 Tauri 窗口里跑，也在 `vite dev` 的普通浏览器里跑（开发时改样式更快）。
 * 普通浏览器没有 `window.__TAURI__`，此时所有壳能力都应优雅降级，
 * 而不是抛错把整个页面打挂。
 */

/** 壳的事件载荷：宿主就绪。 */
export interface HostReadyPayload {
  url: string
  token: string
  port: number
}

/**
 * 壳报告的宿主状态。
 *
 * 与 Rust 侧 `HostState` 的 `#[serde(tag = "state", rename_all = "kebab-case")]`
 * 一一对应，因此是**带判别字段的联合**而不是 `{ state, message? }`：
 * 只有 `ready` 才有 `url`/`token`/`port`，只有 `failed` 才有 `message`。
 * 写成可选字段会让调用方写出 `snapshot.url!` 这种没根据的断言。
 */
export type ShellHostState =
  | { state: 'idle' }
  | { state: 'starting' }
  | ({ state: 'ready' } & HostReadyPayload)
  | { state: 'failed'; message: string }

/** Tauri 注入到全局的对象的最小形状。只声明用到的部分。 */
interface TauriGlobal {
  core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> }
  event?: {
    listen<T>(event: string, handler: (payload: { payload: T }) => void): Promise<() => void>
  }
}

/** 取 Tauri 全局对象。不存在时返回 undefined。 */
function tauri(): TauriGlobal | undefined {
  return (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__
}

/** 当前是否运行在 Tauri 壳内。 */
export function isDesktopShell(): boolean {
  return tauri() !== undefined
}

/**
 * 在 `<html>` 上标注运行平台，供样式做平台分支。
 *
 * ## 为什么需要它
 *
 * 原版大量规则挂在 `html[data-platform="darwin"]` 下，比如
 * 「macOS 不画侧栏右边框」「卡片背景 55% 半透明」。新版要照抄这些分支，
 * 就必须真的把属性写上去——只写 CSS 选择器而不设属性，
 * 那条规则永远不会命中，等于写了个死规则。
 *
 * ## 平台怎么判
 *
 * 壳内由 UA 判：Tauri 的 WebView 在 macOS 上是 WKWebView、
 * 在 Windows 上是 WebView2，两者的 UA 分别含 `Macintosh` 与 `Windows`。
 * 这比在 Rust 侧再开一条 IPC 通道传平台名要轻，且足够准确——
 * 这两个字符串不会在同一个系统里出现。
 *
 * 其余平台统一写 `other`，样式里需要区分的分支目前只有 darwin 一条。
 */
export function markPlatform(): void {
  if (typeof document === 'undefined') return
  const ua = navigator.userAgent
  const platform = ua.includes('Macintosh') || ua.includes('Mac OS X')
    ? 'darwin'
    : ua.includes('Windows')
      ? 'win32'
      : 'other'
  document.documentElement.dataset.platform = platform
}

/**
 * 注册一个壳事件的监听。
 *
 * @param event 事件名。
 * @param handler 收到事件时的回调。
 * @returns 取消监听的函数。在浏览器环境下返回一个空函数，调用方不必分支。
 */
export function listenShell<T>(event: string, handler: (payload: T) => void): () => void {
  const api = tauri()
  if (api?.event === undefined) {
    // 浏览器环境下没有壳，返回空取消函数让调用方的清理逻辑保持统一。
    return () => {}
  }
  let unlisten: (() => void) | undefined
  let cancelled = false
  // listen 是异步的，而调用方可能在这之前就要求取消。
  // 用 cancelled 标记兜住这个竞态，否则会留下一个无人取消的监听。
  void api.event.listen<T>(event, (received) => { handler(received.payload) }).then((fn) => {
    if (cancelled) fn()
    else unlisten = fn
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

/**
 * 调用壳命令。
 *
 * @param command 命令名，须与 Rust 侧 `generate_handler!` 注册的一致。
 * @param args 参数。
 * @returns 命令返回值。
 * @throws 不在壳内或命令失败时抛出。
 */
export async function invokeShell<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = tauri()
  if (api?.core === undefined) {
    throw new Error(`桌面能力不可用：不在壳内运行（命令 ${command}）`)
  }
  return await api.core.invoke<T>(command, args)
}
