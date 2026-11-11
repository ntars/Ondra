/**
 * 标题栏。
 *
 * 高度固定 44px，横跨全宽。三个平台上它长得不一样，但语义一致：
 * 左边是窗口控制或菜单入口，中间是**固定的应用名与版本号**，右边是窗口三键。
 *
 * ## 三个平台的差异
 *
 * | 平台 | 左侧 | 右侧 |
 * | --- | --- | --- |
 * | macOS | 自绘红绿灯浮在内容上，留 84px 让位 | 无 |
 * | Windows | 自绘菜单按钮 32×32 | 自绘三键 138×32 |
 * | Linux | 系统装饰 | 系统装饰 |
 *
 * ## 为什么这里不放会话标题
 *
 * 上一版把当前会话标题放在标题栏正中。两个问题：
 *
 * 1. 会话标题是**内容**，不是窗口身份。它随对话变，而窗口身份是恒定的
 *    ——用户扫一眼标题栏是想确认"我现在在哪个应用里"。
 * 2. 它在 820 宽的窗口里还要和两端控件抢位置，长标题必然省略号，
 *    而用户真正需要完整标题的地方是会话抽屉（那里有全文与时间）。
 *
 * 所以这里固定成「空谷 Ondra + 版本号」。版本号放在这里也是有用的：
 * 报问题、对更新日志、比对安装包，都要读它，而它原来藏在设置的第二层。
 */

import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconChevronDown } from './icons.ts'
import { invokeShell } from '../lib/shell.ts'
import { isMac, isWindows } from '../lib/platform.ts'

export interface TitleBarProps {
  /** 打开浮层菜单（Windows 左上的菜单按钮）。 */
  onOpenMenu?: () => void
}

/**
 * 调用窗口命令。
 *
 * 统一包一层的原因：窗口命令在浏览器调试环境里必然失败，而
 * 失败不该打断任何事——用户点了最小化，最坏情况是什么都没发生，
 * 不该弹一个错误提示。
 */
function windowCommand(command: string): void {
  void invokeShell(command).catch(() => {
    /* 不在壳内或被拒绝。静默忽略：窗口操作失败不影响应用状态。 */
  })
}

/**
 * 三个窗口键的图标。
 *
 * 用 path 直接画而不是复用 `icons.ts`：这三个是**平台约定图形**，
 * 与界面图标不是一套语言（10px 网格、1px 线宽，比界面图标细）。
 * 混进 `icons.ts` 会诱导后续有人在别处用它们。
 */
function MinimizeGlyph(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function MaximizeGlyph(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function CloseGlyph(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/**
 * Windows 自绘三键。
 *
 * 尺寸严格按 §2.3：单键 46×32，三键无间距共 138，右对齐、top 6。
 * 关闭键悬停变红——这个红色取自 HIG 的 destructive 语义，
 * **不是 Windows 平台约定**（Windows 原生是纯灰。这里选红色是因为
 * 它在本应用的暖纸配色里更清晰，且与全局 `--static-danger` 一致）。
 */
function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  /**
   * 读取当前是否最大化。
   *
   * 用 `is_maximized` 向系统查询，**不在本地推断**。曾经的做法是点一下翻转
   * 本地布尔量，但双击标题栏、系统快捷键、窗口管理器的贴边吸附都会改变
   * 最大化状态，而这些都不经过这个按钮——本地推断会与真实状态脱节，
   * 表现是图标显示「最大化」但窗口其实已经最大。
   */
  const syncMaximized = useCallback((): void => {
    void invokeShell<boolean>('plugin:window|is_maximized')
      .then(setMaximized)
      .catch(() => {
        /* 不在壳内。保持 false。 */
      })
  }, [])

  useEffect(syncMaximized, [syncMaximized])

  /**
   * 切换最大化。
   *
   * 用系统的 `toggle_maximize` 而不是 `maximize` / `unmaximize` 两个命令：
   * 那样要先知道当前状态再选一个，一旦状态读错就会「点最大化反而还原」。
   * 交给系统判断不存在这个中间态。
   *
   * 切换后重新查询而不是直接取反本地值——原因同上，以系统为准。
   * 等待一帧再查：命令是异步的，立即查可能拿到切换前的值。
   */
  const toggleMaximize = useCallback((): void => {
    void invokeShell('plugin:window|toggle_maximize')
      .then(() => {
        requestAnimationFrame(syncMaximized)
      })
      .catch(() => {
        /* 不在壳内或被拒绝。 */
      })
  }, [syncMaximized])

  return (
    <div className="titlebar__controls">
      <button
        type="button"
        className="titlebar__control"
        aria-label="最小化"
        onClick={() => { windowCommand('plugin:window|minimize') }}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="titlebar__control"
        aria-label={maximized ? '还原' : '最大化'}
        onClick={toggleMaximize}
      >
        <MaximizeGlyph />
      </button>
      <button
        type="button"
        className="titlebar__control titlebar__control--close"
        aria-label="关闭"
        onClick={() => { windowCommand('plugin:window|close') }}
      >
        <CloseGlyph />
      </button>
    </div>
  )
}

/**
 * 红绿灯 hover 时浮出的符号。
 *
 * × − + 是平台约定图形，与界面图标不是一套语言，所以直接在 8px 网格里
 * 画，不进 `icons.ts`。线宽 1.2 配 12px 圆点：系统原生用 1px，但系统
 * 按钮有一圈描边分担视觉重量，自绘的纯色圆点需要稍粗一点才压得住。
 */
function TrafficGlyph({ kind }: { kind: 'close' | 'min' | 'zoom' }): React.JSX.Element {
  return (
    <svg className="traffic-lights__glyph" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      {kind === 'close' ? <path d="M2 2l4 4M6 2L2 6" /> : null}
      {kind === 'min' ? <path d="M2 4h4" /> : null}
      {kind === 'zoom' ? <path d="M4 2v4M2 4h4" /> : null}
    </svg>
  )
}

/**
 * macOS 自绘红绿灯。
 *
 * 系统那三个按钮已在 `src-tauri/src/window.rs` 里 `setHidden(true)`，
 * 这里补上「看得见、点得动」的一层。点击仍走 `plugin:window|*` 命令：
 * 关闭会经过壳里的 `intercept_close`，最小化与缩放交给系统，行为与
 * 改版前一致。
 *
 * 整条标题栏是拖拽区，按钮必须显式退出，否则按下会变成拖窗口。
 */
function TrafficLights(): React.JSX.Element {
  return (
    <div className="traffic-lights" data-tauri-drag-region={false}>
      <button
        type="button"
        className="traffic-lights__dot traffic-lights__dot--close"
        aria-label="关闭"
        onClick={() => { windowCommand('plugin:window|close') }}
        data-tauri-drag-region={false}
      >
        <TrafficGlyph kind="close" />
      </button>
      <button
        type="button"
        className="traffic-lights__dot traffic-lights__dot--min"
        aria-label="最小化"
        onClick={() => { windowCommand('plugin:window|minimize') }}
        data-tauri-drag-region={false}
      >
        <TrafficGlyph kind="min" />
      </button>
      <button
        type="button"
        className="traffic-lights__dot traffic-lights__dot--zoom"
        aria-label="最大化"
        onClick={() => { windowCommand('plugin:window|toggle_maximize') }}
        data-tauri-drag-region={false}
      >
        <TrafficGlyph kind="zoom" />
      </button>
    </div>
  )
}

/** 渲染标题栏。 */
export function TitleBar({ onOpenMenu }: TitleBarProps): React.JSX.Element {
  const windows = isWindows()
  const mac = isMac()

  return (
    <header className="titlebar" data-tauri-drag-region>
      {windows ? (
        /**
         * Windows 左上菜单按钮。
         *
         * 与 macOS 红绿灯对称：那里占 84px，这里 46px（8 左边距 + 32 + 6 余量）。
         * 没有它，Windows 用户只能靠快捷键发现功能——而快捷键不可发现，
         * 这是 Windows 端「功能像被藏起来了」的常见原因。
         */
        <button
          type="button"
          className="titlebar__menu"
          aria-label="菜单"
          onClick={onOpenMenu}
          data-tauri-drag-region={false}
        >
          <Icon icon={IconChevronDown} size={16} label="菜单" />
        </button>
      ) : null}

      {/*
        品牌牌：应用名 + 版本号。
        固定，不随会话变化（见文件头）。`aria-label` 把两者连读成一句，
        避免读屏念成「空谷 Ondra · v2.2.1」时中间那个点被念成"中点"。
      */}
      <div className="titlebar__brand" aria-label={`空谷 Ondra，版本 ${__APP_VERSION__}`}>
        <span className="titlebar__name">空谷 Ondra</span>
        <span className="titlebar__version">{__APP_VERSION__}</span>
      </div>

      {windows ? <WindowControls /> : null}
      {mac ? <TrafficLights /> : null}
    </header>
  )
}
