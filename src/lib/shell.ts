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

/*
 * 平台标记不在这里。
 *
 * 这里曾经有一份 `markPlatform` 的副本，只认 `darwin` / `win32` / `other`，
 * 于是 Linux 被写成 `other`——而 §10.5 要求 Linux 走字重补偿与 0.5px
 * 降级，两条规则都挂 `[data-platform='linux']`，永远命中不了。
 * 真源收敛到 `lib/platform.ts`（它认得 `linux`，也负责写 `data-input`）。
 */

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

/**
 * 判断一次失败是不是「壳能力缺席」。
 *
 * ## 为什么不判断 HTTP 状态码
 *
 * 401 是宿主对**所有**令牌不对的请求的统一回答，它既可能来自"不在壳内
 * 所以没拿到令牌"，也可能来自令牌真的过期。按状态码分支会把这两件事
 * 混成一件事——而只有前者是用户能自己解决的（回桌面端打开）。
 *
 * 判据取 `invokeShell` 自己写的那句前缀，因为那是**唯一**一处能确定
 * "这个错误来自壳层缺席"的地方。它变，这里跟着变，只有一个真源。
 */
export function isShellUnavailable(caught: unknown): boolean {
  return caught instanceof Error && caught.message.startsWith('桌面能力不可用')
}
