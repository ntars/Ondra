/**
 * 软键盘遮挡高度（§10.8、§10.7.3）。
 *
 * ## 为什么不能用 `window.innerHeight`
 *
 * iOS 上键盘弹出时**布局视口不变**：`window.innerHeight` 仍是整屏高，
 * 整页也不重排。于是 `height: 100%` 的容器照样铺满全屏，输入框落在
 * 键盘下面，用户看不见自己在打什么。
 *
 * `visualViewport` 才是被键盘挤小的那个：`visualViewport.height` 变矮，
 * 两者的差就是被遮挡的高度。
 *
 * ## 为什么写进 CSS 变量而不是让 React 重排
 *
 * 键盘高度在弹出/收起过程中连续变化（iPad 的悬浮键盘还会拖动）。
 * 走 React state 会让整个应用每帧重渲染一次。写变量只触发一次样式重算。
 *
 * ## 为什么 `offsetTop` 也要算进去
 *
 * iOS 在输入框被顶到导航栏下方时会平移可视区，此时 `offsetTop > 0`，
 * 遮挡高度不等于 `innerHeight − visualViewport.height`。少算这一项，
 * 输入框会被多顶一段，上方的消息被推出屏幕。
 */

/** 写进根节点的变量名。`compact.css` 读它。 */
const VAR = '--kb-h'

/**
 * 当前可视区对象。`undefined` 表示走不了这条路（桌面浏览器、老 WebView）。
 *
 * 用模块级常量而不是每次 `globalThis.visualViewport`：`lib.dom` 把它
 * 声明成 `VisualViewport | null`，每次读都要重新窄化一遍，读三处就写
 * 三个守卫。窄化一次、留一个 `undefined` 之外的返回值，后面直接用。
 */
const view: VisualViewport | undefined = globalThis.visualViewport ?? undefined

/**
 * 计算并写入遮挡高度，单位 px。
 *
 * 没有 `visualViewport` 时写 0——那里的键盘由系统自己处理布局，
 * 界面不该再让位。
 */
function sync(): void {
  const root = document.documentElement
  if (view === undefined) {
    root.style.removeProperty(VAR)
    return
  }
  /*
   * 只在「可视区明显比布局视口矮」时认为键盘在场。
   *
   * 阈值 80 而不是 0：iOS 的地址栏收放、Android 的滚动条渐隐都会
   * 让这个差在 0–60 之间跳。按 0 判会让底部凭空多出几十像素，
   * 输入区一上一下地抖。
   */
  const occluded = globalThis.innerHeight - view.height - view.offsetTop
  root.style.setProperty(VAR, `${String(Math.max(0, occluded) > 80 ? Math.round(occluded) : 0)}px`)
}

/**
 * 装上监听。模块级只装一次，返回卸载函数。
 *
 * 三条事件都要听：`resize` 管键盘弹出收起，`scroll` 管可视区平移
 * （iOS 聚焦时的自动滚动只发这个），`orientationchange` 管横竖屏切换
 * （切换后 `innerHeight` 要等一帧才对，所以统一走 `requestAnimationFrame` 合并）。
 */
export function installViewportTracking(): () => void {
  if (view === undefined) return () => {}

  let frame = 0
  const schedule = (): void => {
    globalThis.cancelAnimationFrame(frame)
    frame = globalThis.requestAnimationFrame(sync)
  }

  sync()
  view.addEventListener('resize', schedule)
  view.addEventListener('scroll', schedule)
  globalThis.addEventListener('orientationchange', schedule)

  return () => {
    globalThis.cancelAnimationFrame(frame)
    view.removeEventListener('resize', schedule)
    view.removeEventListener('scroll', schedule)
    globalThis.removeEventListener('orientationchange', schedule)
  }
}
