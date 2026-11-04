/**
 * `ondra-browser-pane` 的对外契约。
 *
 * ## 定位
 *
 * 一个**只给内置插件用的**极简浏览器。它能做三件事：
 *
 * 1. 显示某个插件登记的页面（调试页、引导页）；
 * 2. 允许该页面在自己的容器内跳到一个**白名单域名**（北辰注册页就是这种）；
 * 3. 什么都不让用户改——没有地址栏、没有输入框、没有右键菜单。
 *
 * ## 为什么不做成通用浏览器
 *
 * 一个能打开任意 https 的容器，等于给应用开了一个「任意网页入口」。
 * 它会被用来干什么，取决于当时那个页面上有什么链接，而不取决于设计者想让它干什么。
 * Ondra 的隐私章承诺「出站清单可枚举」——通用浏览器让这句话无法兑现。
 *
 * 所以白名单是硬约束，不是默认值：
 *
 * - **首屏**只能是本机 `/pane/*` 或 `/beichen/*`；
 * - **跳转**只放行 `beichenapi.com`（含子域）；
 * - 其余一律拒绝，并在面板里说明原因（不是静默失败）。
 */

/** 本插件注册的服务键。 */
export const PANE_SERVICE_KEY = 'ondra-browser-pane'

/** 允许跳转的外部域名（含子域）。**只增不改**：删一条会静默影响在用的页面。 */
export const EXTERNAL_ALLOWLIST: readonly string[] = Object.freeze(['beichenapi.com'])

/** 本机路径前缀白名单。只在「同源、且是宿主端口」时才判为通过。 */
export const LOCAL_PATH_PREFIXES: readonly string[] = Object.freeze(['/pane/', '/beichen/'])

/** 一个登记到面板里的页面。 */
export interface PanePage {
  /** 页 id（小写连字符）。同时是 `/pane/view/<id>` 的路径段。 */
  readonly id: string
  /** 面板标题栏显示的名字。 */
  readonly title: string
  /** 登记方插件名，用于诊断与「谁开的」提示。 */
  readonly plugin: string
  /** 宿主内路径，必须以 `/` 开头。 */
  readonly path: string
}

/** 一次打开请求。 */
export interface PaneOpen {
  /** 页 id。 */
  readonly page: string
  /** 标题。 */
  readonly title: string
  /** 请求时刻（毫秒）。 */
  readonly at: number
}

/** 白名单判定结果。 */
export type AllowResult =
  | { readonly allowed: true; readonly kind: 'local' | 'external' }
  | { readonly allowed: false; readonly reason: 'scheme' | 'host' | 'path' }

/** 服务接口。 */
export interface BrowserPaneService {
  /** 登记一个页面。返回撤销函数。 */
  registerPage(page: PanePage): () => void
  /** 当前可用页清单。 */
  pages(): readonly PanePage[]
  /** 追加一次打开请求（界面轮询 `pending()` 取走）。 */
  open(pageId: string): PaneOpen
  /** 取走最近的打开请求（取走即清空，避免界面重启后重复弹窗）。 */
  consume(): PaneOpen | undefined
  /** 判断一个地址是否允许在本面板里加载 / 跳转。 */
  allow(url: string): AllowResult
}

/** 本插件自己产生的错误。 */
export class BrowserPaneError extends Error {
  /**
   * @param message 人话描述。
   * @param code 机器可读原因。
   */
  constructor(message: string, readonly code: 'bad-page' | 'duplicate' | 'unknown-page' | 'no-server') {
    super(message)
    this.name = 'BrowserPaneError'
  }
}
