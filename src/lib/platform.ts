/**
 * 平台探测。
 *
 * ## 为什么用能力探测而不是 UA 字符串
 *
 * UA 字符串在桌面壳里并不可靠：Tauri 的 WebView 在三个平台上分别是
 * WKWebView / WebView2 / WebKitGTK，UA 里带 `Macintosh` / `Windows` /
 * `Linux` 但具体版本无意义，而我们要判断的只是「红绿灯在哪」这类
 * 与内核无关的事。
 *
 * 更关键的是：**同一份产物要能跑在三个平台上**。构建期注入平台常量
 * 会让一份产物只能跑一个平台，交叉编译时分不清。运行期读取壳提供的
 * 信息才是唯一正确的做法。
 *
 * ## 数据流向
 *
 * 壳通过 `host-ready` 事件带 `platform` 字段（见 `lib/shell.ts`）。
 * 该事件可能在 React 挂载前就到达，因此这里额外保留一条从
 * `navigator.userAgent` 推断的兜底路径，用于纯浏览器调试。
 * 兜底只区分三大桌面端，不猜版本。
 */

/** 界面，只认四个值。移动端不是本版范围，但类型先留好位置。 */
export type Platform = 'darwin' | 'win32' | 'linux' | 'unknown'

/**
 * 从 UA 推断平台。
 *
 * 顺序要紧：`iPhone`/`iPad` 的 UA 里也含 `Mac OS X`，若先判 `Mac`
 * 会把 iPad 认成 macOS。
 */
function guessFromUserAgent(): Platform {
  const ua = navigator.userAgent
  if (/android/i.test(ua)) return 'unknown'
  if (/iphone|ipad|ipod/i.test(ua)) return 'unknown'
  if (/win/i.test(ua)) return 'win32'
  if (/mac os x|macintosh/i.test(ua)) return 'darwin'
  if (/linux/i.test(ua)) return 'linux'
  return 'unknown'
}

let current: Platform = 'unknown'

/** 读取当前平台。首次调用会做一次推断并缓存。 */
export function getPlatform(): Platform {
  if (current === 'unknown') current = guessFromUserAgent()
  return current
}

/**
 * 平台标记是否已写入 DOM。
 *
 * 独立的布尔量而不是去查 `dataset`：`markPlatform` 会在每帧渲染前被
 * 多个组件调用，查 DOM 是同步读，比读变量慢一个量级。
 */
let marked = false

/**
 * 把平台写进 `<html data-platform>`。
 *
 * 必须**在首个样式计算之前**写好：它控制的规则里有左侧让位宽度
 * （macOS 76px / Windows 46px），晚一帧设置会先按另一套规则排一遍版，
 * 肉眼能看到标题栏跳一下。
 *
 * 幂等：重复调用直接返回。
 */
export function markPlatform(): void {
  if (marked) return
  marked = true
  const platform = getPlatform()
  document.documentElement.dataset.platform = platform
  // 输入方式标记。桌面三端都是精确指针，触屏端在未来版本才需要区分。
  document.documentElement.dataset.input =
    window.matchMedia('(hover: none) and (pointer: coarse)').matches ? 'touch' : 'pointer'
}

/** 是否 macOS。红绿灯由系统绘制，界面只需让位。 */
export function isMac(): boolean {
  return getPlatform() === 'darwin'
}

/** 是否 Windows。需要自绘三键。 */
export function isWindows(): boolean {
  return getPlatform() === 'win32'
}

/**
 * 是否触屏（粗指针）。
 *
 * 用于把「悬停才出现」的控件改为常驻（§5.0.8 规律一）。
 */
export function isTouch(): boolean {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches
}
