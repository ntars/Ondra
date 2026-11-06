/**
 * 标题栏。
 *
 * 高度固定 44px，横跨全宽。三个平台上它长得不一样，但语义一致：
 * 左边是窗口控制或菜单入口，中间是当前会话标题，右边是窗口三键。
 *
 * ## 三个平台的差异
 *
 * | 平台 | 左侧 | 右侧 | 标题位置 |
 * | --- | --- | --- | --- |
 * | macOS | 系统红绿灯浮在内容上，留 76px 让位 | 无（系统提供） | 全窗水平居中 |
 * | Windows | 自绘菜单按钮 32×32 | 自绘三键 138×32 | 全窗水平居中 |
 * | Linux | 系统装饰 | 系统装饰 | 全窗水平居中 |
 *
 * ## 为什么标题是全窗居中而不是主列居中
 *
 * 规范 §2.4 的答案：主列居中需要知道 Rail 与 Spine 的宽度，而首页
 * 没有双脊。同一份标题栏在两种形态下居中于不同位置，切换时标题会
 * 横向跳一次。全窗居中在两个形态下位置一致。
 *
 * 代价是标题的可用宽度只有全宽的 40%——超出就省略号。这是可接受的：
 * 会话标题是用户自己起的，太长本来也读不完。
 *
 * ## 为什么拖拽区不单独做一个条
 *
 * `data-tauri-drag-region` 可以直接标在标题栏容器上。单独做一条
 * 38px 的横条会让三栏整体下移，顶部凭空多一块空白，而那块空白
 * 又不能放任何东西。
 */

import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconChevronDown } from './icons.tsx'
import { invokeShell } from '../lib/shell.ts'
import { isWindows } from '../lib/platform.ts'

export interface TitleBarProps {
  /** 会话标题。首页传空串，此时不显示标题。 */
  title: string
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
 * 用 path 直接画而不是复用 `icons.tsx`：这三个是**平台约定图形**，
 * 与界面图标不是一套语言（10px 网格、1px 线宽，比界面图标细）。
 * 混进 `icons.tsx` 会诱导后续有人在别处用它们。
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

/** 渲染标题栏。 */
export function TitleBar({ title, onOpenMenu }: TitleBarProps): React.JSX.Element {
  const windows = isWindows()

  return (
    <header className="titlebar" data-tauri-drag-region>
      {windows ? (
        /**
         * Windows 左上菜单按钮。
         *
         * 与 macOS 红绿灯对称：那里占 76px，这里 46px（8 左边距 + 32 + 6 余量）。
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

      {title === '' ? null : (
        <h1 className="titlebar__title" data-tauri-drag-region>
          {title}
        </h1>
      )}

      {windows ? <WindowControls /> : null}
    </header>
  )
}
