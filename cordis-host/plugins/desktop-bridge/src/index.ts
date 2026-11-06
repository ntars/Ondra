/**
 * `desktop-bridge` 插件入口。
 *
 * 把桌面能力挂成上下文服务 `ctx.desktop`。
 *
 * ## 为什么这一层要由宿主提供、而不是让前端直接调壳
 *
 * 前端直接调壳意味着**每一个需要的原生能力都要在前端写一次调用**，而前端是
 * 可被远程页面替换的（内置浏览器面板、未来的插件页面）。让前端直接拥有
 * "选文件、开链接"的权力，等于把这权力交给了任何能加载进页面的代码。
 *
 * 走宿主中转后，权限收敛在宿主一处：宿主可以按会话、按插件、按工具白名单
 * 决定放不放行，而前端只看到"宿主允许的操作"。
 */

import type { Context } from '@ntars/cordis'
import { createDesktopBridge, type DesktopBridge } from './bridge.js'

/** 服务键。 */
export const DESKTOP_SERVICE_KEY = 'desktop'

/** 插件名。 */
export const name = 'desktop-bridge'

/** 插件配置。 */
export interface Config {
  /**
   * 向壳发送命令的函数。
   *
   * 由宿主入口注入：开发态可以直接用 HTTP 打壳的命令端点，
   * 生产态走 Tauri 的 IPC。做成注入点而不是写死，是因为宿主不知道自己
   * 跑在哪种壳里，也不该知道。
   */
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

/** 声明本插件提供的服务。 */
export const provide = [DESKTOP_SERVICE_KEY]

/**
 * 装载插件。
 *
 * @param ctx Cordis 上下文。
 * @param config 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  // 未注入 invoke 时提供一个明确失败的实现，而不是静默返回空值：
  // 静默返回会让"点选文件没反应"变成无法定位的问题。
  const invoke = config.invoke ?? (async (command: string): Promise<unknown> => {
    throw new Error(`桌面能力不可用：未注入壳命令通道（命令 ${command}）`)
  })

  const bridge: DesktopBridge = createDesktopBridge(invoke)
  // 经 provide 注册服务：Cordis 4 不接受直接给上下文赋属性。
  ctx.provide(DESKTOP_SERVICE_KEY, bridge)
}
