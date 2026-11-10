/**
 * 桌面能力桥：把壳（Tauri/Rust）提供的本机能力整理成宿主可调用的形式。
 *
 * ## 为什么需要这一层
 *
 * 宿主与壳是两个进程，壳拥有"操作系统层面的权力"（选文件、开文件夹、读系统主题、
 * 控制窗口），宿主拥有"业务层面的权力"（会话、模型、工具）。两边都要用对方的能力时，
 * 若互相直接调用，宿主代码里就会散落大量进程通信细节，无法单独测试。
 *
 * 这一层把"要用壳的能力"收敛成一组具名方法，宿主其余代码只调这些方法，
 * 不关心它背后是进程通信还是本地实现。测试时可替换为内存实现。
 *
 * ## 为什么不叫 tauri-bridge
 *
 * 壳今天是 Tauri，明天可能换。名字绑定具体框架会把"桥接桌面能力"这件事
 * 和"使用某个框架"绑死，换框架时要改的不只是实现，还有所有引用点。
 */

/**
 * 桌面能力接口。
 *
 * 全部方法允许失败：用户可能拒绝授权、系统可能不允许。
 * 失败统一抛 {@link DesktopBridgeError}，让调用方能按原因分支而不是猜。
 */
export interface DesktopBridge {
  /** 弹出系统文件选择对话框，返回选中路径。用户取消时返回空数组（不是错误）。 */
  pickFiles(options: PickFilesOptions): Promise<string[]>
  /** 在系统文件管理器中显示某个路径。 */
  revealInFolder(path: string): Promise<void>
  /** 读取当前系统主题偏好。 */
  getTheme(): Promise<'light' | 'dark'>
  /** 设置窗口标题。 */
  setWindowTitle(title: string): Promise<void>
  /** 打开外部链接（交给系统默认浏览器）。 */
  openExternal(url: string): Promise<void>
}

/** 文件选择参数。 */
export interface PickFilesOptions {
  /** 是否允许多选。 */
  multiple?: boolean
  /** 是否只选目录。 */
  directory?: boolean
  /**
   * 允许的扩展名，不带点，例如 `['png', 'jpg']`。
   * 空数组或不传表示不限。限制类型比让用户选错再报错体验更好。
   */
  extensions?: string[]
  /** 对话框标题。 */
  title?: string
}

/** 桌面能力调用失败。 */
export class DesktopBridgeError extends Error {
  /** 失败原因分类，便于上层给出不同提示。 */
  readonly reason: 'unsupported' | 'denied' | 'failed' | 'invalid-argument'

  constructor(reason: DesktopBridgeError['reason'], message: string) {
    super(message)
    this.name = 'DesktopBridgeError'
    this.reason = reason
  }
}

/**
 * 创建桌面能力桥。
 *
 * @param invoke 把命令发给壳并等待结果。由宿主适配层注入，
 *               这样本模块不依赖 Tauri 的 API，可在纯 Node 环境下测试。
 * @returns 桌面能力实现。
 */
export function createDesktopBridge(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): DesktopBridge {
  return {
    async pickFiles(options: PickFilesOptions): Promise<string[]> {
      // 逻辑与目录互斥：目录不是文件，允许两者同时为真会让壳侧不知道怎么弹。
      if (options.multiple === true && options.directory === true) {
        throw new DesktopBridgeError('invalid-argument', '不能同时要求"多选"和"仅目录"')
      }
      const result = await invoke('pick_files', {
        multiple: options.multiple ?? false,
        directory: options.directory ?? false,
        extensions: options.extensions ?? [],
        ...(options.title === undefined ? {} : { title: options.title }),
      })
      // 壳返回的也是外部数据，逐项校验：非字符串混进来会在下游当路径用时才炸。
      if (!Array.isArray(result)) {
        throw new DesktopBridgeError('failed', '文件选择返回格式不正确')
      }
      return result.filter((item): item is string => typeof item === 'string')
    },

    async revealInFolder(path: string): Promise<void> {
      if (path.trim() === '') {
        throw new DesktopBridgeError('invalid-argument', '路径不能为空')
      }
      await invoke('reveal_in_folder', { path })
    },

    async getTheme(): Promise<'light' | 'dark'> {
      const result = await invoke('get_theme')
      // 未知取值按浅色处理：深色主题在浅色下仍可读，反过来会白底白字。
      return result === 'dark' ? 'dark' : 'light'
    },

    async setWindowTitle(title: string): Promise<void> {
      await invoke('set_window_title', { title })
    },

    async openExternal(url: string): Promise<void> {
      // 只允许 http/https：直接放行 file:// 或自定义协议会让界面上的一个链接
      // 变成执行本机程序的入口。
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new DesktopBridgeError('invalid-argument', `不是合法链接：${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new DesktopBridgeError('invalid-argument', `只允许 http/https 链接，收到 ${parsed.protocol}`)
      }
      await invoke('open_external', { url })
    },
  }
}
