/**
 * 前端入口。
 *
 * ## 一份产物，两个窗口
 *
 * 壳用 `index.html#preferences` 打开偏好设置窗口（`src-tauri/src/preferences.rs`），
 * 这里按 hash 决定渲染哪一棵树。**不建第二个 HTML 入口**：那会让
 * `vite` 多一个 `rollupOptions.input`、Tauri 多一处 `frontendDist` 配置，
 * 而两个入口各自引一遍样式——令牌就成了两份，深色模式必然不同步。
 *
 * ## 初始化顺序
 *
 * 令牌最先（其余全部 `var()` 依赖它）→ 平台标记（它控制网格列宽与边框，
 * 晚一帧会先按另一套规则排一遍版）→ 偏好层（要在首帧前写好 `data-theme`
 * 与字号）→ 挂载。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { Preferences } from './components/Preferences.tsx'
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
import './styles/richtext.css'
import './styles/scrollarea.css'
import './styles/composer.css'
import './styles/settings.css'
import './styles/controls.css'
import './styles/dialog.css'
import './styles/preferences.css'
/*
 * 移动端与触屏必须排在最后：它改的是上面这些文件定下的列宽、定位与
 * 字号。写在前面会被组件样式盖住——同特异度下后者胜。
 */
import './styles/compact.css'
import { listenShell } from './lib/shell.ts'
import type { HostReadyPayload } from './lib/shell.ts'
/*
 * 平台标记只有这一个真源（`lib/platform.ts`）。
 *
 * 这里原先从 `shell.ts` 引，那份副本不认 `linux`，把它们一律写成
 * `other`——于是 §10.5 要求 Linux 走的字重补偿与 0.5px 降级全部落空。
 * 两份实现并存时，谁被 import 就成了隐形的「哪份算数」，比写错更难发现。
 */
import { markPlatform } from './lib/platform.ts'
import { adoptDevConnection, setConnection, setConnectionFailure } from './lib/host.ts'
import { startPreferences } from './lib/preferences.ts'
import { loadMute } from './lib/mute.ts'
import { installVisibilityTracking } from './lib/visibility.ts'
import { installViewportTracking } from './lib/viewport.ts'

// 平台标记必须在首个样式计算之前写好：它控制的规则里有网格列宽与边框，
// 晚一帧设置就会先按另一套规则排一遍版，肉眼能看到跳一下。
markPlatform()

/*
 * 偏好层（主题与字号）也要在挂载前落地。
 *
 * `index.html` 的内联脚本只处理主题：它必须早于样式表，只能内联一小段。
 * 字号与「跨窗口同步」两条只能在模块里接——把内联脚本撑大到能读三份
 * 存储、还要注册广播监听，会变成一段没人愿意维护的第二实现。
 */
startPreferences()

/*
 * 静音状态也要在挂载前落定。
 *
 * 它只影响 Spine 的一行字与托盘菜单文案，不像主题那样会闪一帧颜色，
 * 但仍必须在首帧前读：`loadMute()` 会顺手挂上到期定时器，晚一步挂
 * 就等于「静音期内重启应用，界面要等到下一次操作才知道该解除」。
 */
loadMute()

/*
 * 窗口可见性跟踪（§7.4 系统通知的判据）。
 *
 * 装在这里而不是组件里：主动开口的定时器在 `App` 里，但通知的判定
 * （`lib/notify.ts`）可能从任何地方被调用。模块级装一次，谁都能读。
 *
 * 它第一时间订阅壳的 `window-visibility` 事件。窗口在页面加载后立刻
 * 被隐藏的情况（用户把应用启动项藏在后台）也要收得到，所以不能等
 * 组件挂载。
 */
installVisibilityTracking()

/*
 * 软键盘遮挡高度（§10.8）。
 *
 * 与可见性跟踪同理：它写的是根节点上的 CSS 变量，谁都能读，
 * 所以模块级装一次就够，不必等某个组件挂载。iOS 上键盘可以在
 * 任何时刻弹出（包括偏好窗口），装在组件里会漏掉一半场景。
 */
installViewportTracking()

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

/**
 * 当前窗口是不是偏好设置窗口。
 *
 * 用 hash 判而不是查窗口 label：后者要等壳注入 `__TAURI__` 才有，
 * 而首帧就该决定渲染哪棵树。hash 在解析 HTML 时就已确定。
 *
 * ## 为什么要订阅 `hashchange`
 *
 * 壳内的偏好窗口是**独立的 WebView 文档**，hash 从一开始就是
 * `#preferences`，永远不变。但在浏览器里（`pnpm dev:web`）只有一个
 * 文档，「开偏好设置」只能靠改 hash。若不监听，按 `Cmd/Ctrl + ,`
 * 会得到「什么都没发生」——比报错更让人困惑。
 *
 * 订阅之后，浏览器里的表现与壳内一致：同一份组件、同一套样式，
 * 只是从第二窗口搬到了整页。`check:ui` 也靠这条路径验它。
 */
let isPreferences = globalThis.location.hash === '#preferences'

/** 挂载点。两棵树共用，切换时整棵替换。 */
const root = createRoot(container)

/** 按当前 hash 渲染对应的树。 */
function renderRoot(): void {
  root.render(
    // StrictMode 在开发态会双调用 effect，用于暴露副作用清理缺失。
    // 生产构建自动失效，不影响运行。
    <StrictMode>
      {isPreferences ? <Preferences /> : <App />}
    </StrictMode>,
  )
}

globalThis.addEventListener('hashchange', () => {
  const next = globalThis.location.hash === '#preferences'
  if (next === isPreferences) return
  isPreferences = next
  renderRoot()
})

renderRoot()
