/**
 * 抽屉（Drawer）。
 *
 * ## 一个容器，三种内容
 *
 * 三个入口（会话 / 日志 / 扩展）共用同一个容器：左贴、宽 320、覆盖主列左半。
 * 点另一个入口时内容**原地替换**，不先收起再展开——那样是两次 180ms，
 * 用户会感到一顿（§5.2 交互细则）。
 *
 * 所以这里的做法是：容器常挂，`data-open` 控制进出场，内容按键切换。
 * React 侧不需要卸载重挂，也就没有「收起动画没跑完就换内容」的中间态。
 *
 * ## 为什么搜索框不在容器里了
 *
 * 原来的搜索框服务的是「会话列表 / 记忆」那种几百项的长列表。现在三个抽屉
 * 里只有扩展是多条目的，而它按包名、描述、配置段名三种字段过滤——那套规则
 * 属于扩展抽屉自己。容器保留一个「通用搜索框」只会让两种过滤规则混在一起。
 *
 * ## 为什么宽度写死在 CSS 而不是内联
 *
 * 宽度由 `tokens.css` 的 `--w-drawer`（320）定值，写内联会让「窄屏时改 100%」这类断点规则
 * 无法覆盖（内联优先级最高），而移动端恰恰要把抽屉改成全屏 Sheet。
 *
 * ## 焦点
 *
 * 打开时把焦点移进抽屉（§9.5「抽屉内第一个可聚焦项」），关闭时由上层
 * 还原到触发元素。这里只负责「进来」，因为「回到哪」只有上层知道。
 */

import { useEffect, useRef } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'
import { SessionPanel } from './SessionStats.tsx'
import { LogDrawer } from './LogDrawer.tsx'
import { ExtensionDrawer } from './ExtensionDrawer.tsx'
import { useRestoreFocus } from '../lib/useRestoreFocus.ts'
import type { DrawerKey } from './Rail.tsx'
import type { SessionStats } from '../lib/api.ts'
import type { LogEntry } from '../lib/types.ts'

/** 抽屉标题。与 Rail 的 aria-label 一致，不另起说法。 */
const TITLES: Record<DrawerKey, string> = {
  session: '会话',
  log: '日志',
  extension: '扩展',
}

export interface DrawerProps {
  /** 当前内容。undefined 表示收起。 */
  view: DrawerKey | undefined
  /** 会话统计（会话抽屉）。 */
  stats: SessionStats | undefined
  /** 当前会话 id。 */
  sessionId: string | undefined
  /** 当前会话标题。 */
  title: string
  /** 当前会话日志（日志抽屉）。含本轮实时条目。 */
  logs: LogEntry[]
  /** 是否正在生成。生成中不允许清空——那一轮还会写回去。 */
  busy: boolean
  /** 清空全部。 */
  onClearAll(): void
  /** 打开某个配置段（扩展抽屉的「配置」）。 */
  onConfigure(sectionId: string): void
  /** 一句提示。 */
  onNote(text: string): void
  /** 关闭。 */
  onClose(): void
}

/**
 * 渲染抽屉。
 *
 * 收起时用 `inert` 而不是 `display: none`：`display: none` 会让退场动画
 * 直接被裁掉（元素立刻消失，没有 180ms 的位移），而 `inert` 只是禁止
 * 交互与读屏访问，视觉上仍能播完退场。
 */
export function Drawer({
  view,
  stats,
  sessionId,
  title,
  logs,
  busy,
  onClearAll,
  onConfigure,
  onNote,
  onClose,
}: DrawerProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const open = view !== undefined

  /*
   * 关闭时把焦点还给触发它的图标（§9.5）。
   *
   * 必须写在下面那个「把焦点移进来」的 effect **之前**：先记住来处，
   * 再把焦点搬进抽屉。顺序反了记到的就是抽屉内部元素，关闭时焦点原地不动。
   */
  useRestoreFocus(open)

  /**
   * 打开时把焦点移进面板本体。
   *
   * ## 为什么不落在「第一个可聚焦项」
   *
   * 上一版取的是面板里第一个按钮。视觉后果很具体：抽屉一打开，关闭键上
   * 就挂着一圈 2px 焦点环——它比抽屉标题还显眼，读起来像"这个叉被选中了"。
   * 而用户此刻并没有聚焦到叉上，他只是刚点开了抽屉。
   *
   * 落在面板（`tabIndex=-1`）上是抽屉的标准做法：读屏念标题、焦点确实
   * 进了抽屉，画面上不多一圈假高亮；要操作的话按一次 Tab 就到第一个控件。
   */
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus({ preventScroll: true })
  }, [open, view])

  return (
    <div className="drawer" data-open={open ? '' : undefined}>
      <div
        className="drawer__panel"
        ref={panelRef}
        role="dialog"
        aria-label={view === undefined ? '抽屉' : TITLES[view]}
        tabIndex={-1}
      >
        <header className="drawer__head">
          <h2 className="drawer__title">{view === undefined ? '' : TITLES[view]}</h2>
          <button type="button" className="drawer__close" aria-label="关闭" onClick={onClose}>
            <Icon icon={IconClose} size={16} />
          </button>
        </header>

        <div className="drawer__body">
          {view === 'session' ? (
            <SessionPanel
              stats={stats}
              title={title}
              busy={busy}
              onClearAll={onClearAll}
            />
          ) : null}

          {view === 'log' ? <LogDrawer sessionId={sessionId} logs={logs} /> : null}

          {view === 'extension' ? (
            <ExtensionDrawer onConfigure={onConfigure} onNote={onNote} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
