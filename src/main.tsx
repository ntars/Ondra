/**
 * 前端入口。
 *
 * 只做三件事：挂载根组件、引入全局样式、注册连接监听。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
/**
 * 样式顺序在这里定。
 *
 * 不用 `global.css` 里的 `@import` 是因为本项目的 postcss 会把相对
 * 路径当成从项目根解析，报 ENOENT。ES import 的求值顺序由书写次序
 * 决定，语义明确，产物同样只有一个 CSS 文件。
 *
 * 令牌必须最先——其余全部 `var()` 依赖它，晚一步就会有首帧回落。
 */
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/titlebar.css'
import './styles/rail.css'
import './styles/spine.css'
import './styles/drawer.css'
import './styles/timeline.css'
import { listenShell, markPlatform } from './lib/shell.ts'
import type { HostReadyPayload } from './lib/shell.ts'
import { adoptDevConnection, setConnection, setConnectionFailure } from './lib/host.ts'

// 平台标记必须在首个样式计算之前写好：它控制的规则里有网格列宽与边框，
// 晚一帧设置就会先按另一套规则排一遍版，肉眼能看到跳一下。
markPlatform()

// 在 React 挂载之前就开始监听：壳可能在页面脚本执行后立刻发出 ready，
// 若等到组件挂载才注册，就会错过这条消息，界面永远停在"正在连接"。
listenShell<HostReadyPayload>('host-ready', (payload) => { setConnection(payload) })
listenShell<string>('host-failed', (message) => { setConnectionFailure(message) })

// 开发态兜底：普通浏览器里没有桌面壳，连接信息改从查询串取。
// 生产构建下这个调用整段被摇掉（见函数注释）。
adoptDevConnection()

const container = document.getElementById('root')
if (container === null) {
  // 这是打包配置错误，不是运行期可恢复的异常。抛出比静默白屏更利于定位。
  throw new Error('找不到 #root 挂载点，index.html 可能被改动')
}

createRoot(container).render(
  // StrictMode 在开发态会双调用 effect，用于暴露副作用清理缺失。
  // 生产构建自动失效，不影响运行。
  <StrictMode>
    <App />
  </StrictMode>,
)
