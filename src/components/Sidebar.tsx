/**
 * 左栏：侧栏。
 *
 * ## 四段结构
 *
 * 1. 身份行 60px —— 鲸鱼标志 + 名称 + 在线点 + 新建会话
 * 2. 视图分段控件 38px —— 「对话 / 日志」
 * 3. 会话列表 —— 吃掉剩余高度
 * 4. 底部 —— 「更多」菜单与版本号
 *
 * 原版在 Windows 标题栏下还有一条 52px 的 topStrip 放窗口控件，
 * macOS 上不渲染：`[data-windows-titlebar]` 才会挂它。
 * 这一栏在 macOS 的首个子节点就是身份行（y=6），
 * 所以这里不做那条横条——加了会让三栏整体下移 52px。
 *
 * ## 关于底部
 *
 * 原版的 `footArea` 里是两个插件槽（`sidebar.footer.action` 与
 * `sidebar.settings`），没有插件投入内容时高度为 0，看起来是空白。
 * 新版没有那套槽机制，直接把设置入口放在这里，
 * 否则用户找不到设置。这是有意的结构差异，不是遗漏。
 *
 * ## 分段控件切换的是中栏，不是这一栏
 *
 * 「对话 / 日志」很容易被误读成"切换左栏显示什么"，但它切换的其实是
 * **中间那栏的读法**：对话是"她说了什么"，日志是"她怎么做的"。
 * 左栏在这两种读法下都是同一份会话列表——因为看的是同一个会话，
 * 只是换了个角度。
 *
 * 上一版我把它做成了两条带图标的行，而且是"左栏内容跟着换"，
 * 那是读错了旧版：实际结构是一个 38px 高的滑块分段器，
 * 且会话列表始终在场。这一版按旧版的实际结构改回来。
 *
 * ## 为什么做成滑块而不是两颗按钮
 *
 * 平移的白块表达"这是同一个开关的两个位置"；两颗各自变色的按钮
 * 表达的是"两个独立的开关"。前者才是这里的事实。
 */

import { useState } from 'react'
import {
  AboutIcon,
  ChatIcon,
  EllipsisIcon,
  FeedbackIcon,
  GearIcon,
  PlusIcon,
} from './icons.tsx'
import { ContextMenu, Menu } from './Menu.tsx'
import type { ContextMenuState } from './Menu.tsx'
import { WhaleMark } from './WhaleMark.tsx'
import { archiveSession } from '../lib/api.ts'
import type { SessionMeta } from '../lib/api.ts'

/**
 * 日志的类别。
 *
 * 五类对应五种不同的东西，与徽章文字一致：
 * - `rhythm` 节律：轮次的起止，是骨架；
 * - `channel` 通道：人在这一轮里投进去的东西（消息、附件）；
 * - `model` 模型：模型在这一轮里做了什么（思考、回复）；
 * - `tool` 工具：她动过手的操作（读文件、跑命令）；
 * - `error` 异常：中途出错。
 *
 * 分开的道理：用户看日志时想知道「她想了多久」和「我说了什么」，
 * 这两件事不该混在同一种条目里靠读文字去分辨。
 *
 * 后两类在当前版本还不会产生——工具调用与错误回执尚未接入。
 * 类型先留着，是为了让样式表与类型定义一次对齐，
 * 将来接上时不必再改一遍所有用到它的地方。
 */
export type LogChannel = 'rhythm' | 'channel' | 'model' | 'tool' | 'error'

/** 日志时间轴的一行。 */
export interface LogEntry {
  id: string
  /** 第几轮。同一轮的多条日志共享该值，渲染时按它分组。 */
  round: number
  /** 发生时间。 */
  at: number
  /** 类别。决定徽章文字与配色。 */
  channel: LogChannel
  /** 角色：系统 / 你 / 她。 */
  actor: 'system' | 'user' | 'assistant'
  /** 摘要文案。 */
  summary: string
  /** 可展开的完整内容。没有则不显示展开区。 */
  detail?: string
  /** 内容字数。单独存数字便于对齐成一列，拼进文字里就对齐不了了。 */
  chars?: number
  /** 耗时毫秒。思考与回复才有，用于显示「想了 1.2 秒」。 */
  ms?: number
}

/** 侧栏当前视图。它同时决定中栏显示对话还是运行日志。 */
export type SidebarView = 'chat' | 'log'

/** 组件属性。 */
export interface SidebarProps {
  /** 身份名称。 */
  name: string
  /** 是否在线。 */
  online: boolean
  /** 会话列表，已按更新时间倒序。 */
  sessions: SessionMeta[]
  /** 当前会话 id。 */
  currentSessionId: string | undefined
  /**
   * 日志行。
   *
   * 左栏不用它渲染（左栏始终是会话列表），但它随 props 一起传下来，
   * 是为了让「有没有日志」能影响分段控件是否可用——没有会话时
   * 日志无从谈起，控件应当整体变灰。
   */
  logs: LogEntry[]
  /** 当前视图。 */
  view: SidebarView
  /** 切换视图。 */
  onViewChange(view: SidebarView): void
  onNewSession(): void
  onOpenSession(sessionId: string): void
  onOpenSettings(): void
  /** 版本号。 */
  version?: string
  /**
   * 上报一条提示。
   *
   * 左栏自己不做提示 UI：提示条必须盖住三栏，只能挂在根节点。
   * 这里向上抛，由 App 统一渲染。
   */
  onNotify(text: string, tone?: 'error' | 'info'): void
}

/**
 * 把时间戳转成列表里的相对时间。
 *
 * 文案照原版实测：`12分钟`、`26分钟`、`2小时`、`1天`、`5天`。
 * 注意是**全字**——不是「12 分」「2 时」。
 *
 * 我一开始按"这一栏只有 205px、多一个字会挤标题"的理由缩成单字，
 * 那是把自己的猜测当成了原版的事实。实测原版在 10px 字号下
 * 「26分钟」只占 33.9px，标题仍有 105px 可用，完全放得下。
 *
 * 分级：一分钟内「刚刚」，一小时内按分钟，一天内按小时，
 * 七天内按天，再久给日期（「7 天前」对定位没有帮助）。
 */
function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${String(Math.floor(diff / minute))}分钟`
  if (diff < day) return `${String(Math.floor(diff / hour))}小时`
  if (diff < 2 * day) return '1天'
  if (diff < 7 * day) return `${String(Math.floor(diff / day))}天`

  const date = new Date(timestamp)
  return `${String(date.getMonth() + 1)}月${String(date.getDate())}日`
}

/** 渲染左栏。 */
export function Sidebar(props: SidebarProps): React.JSX.Element {
  /** 会话行右键菜单。放这里而不是每行各自持有，同一时刻只可能有一个。 */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | undefined>(undefined)

  /**
   * 是否 macOS 桌面。
   *
   * 判据与 `markPlatform()` 一致：读文档根节点上的平台标记。
   * 只有 macOS 需要那条 52px 的拖拽条——Windows 上红绿灯不存在，
   * 那条横条会让三栏整体凭空下移。
   */
  const darwin = typeof document !== 'undefined'
    && document.documentElement.dataset.platform === 'darwin'

  /**
   * 分段控件是否可用。
   *
   * 没有打开任何会话时，中栏是空的首页，"切到日志"没有意义。
   * 此时控件整体变灰、两个格子都不可点，滑块隐藏——
   * 与旧版一致：`enabled` 为假时滑块透明度归零。
   */
  const switchable = props.currentSessionId !== undefined

  /**
   * 会话行的右键菜单项。
   *
   * 原版的行操作入口是「⋯」与右键两条路，做同一组动作。
   * 当前宿主只支持归档，所以这里只放真实可执行的那些；
   * 重命名与删除尚未有对应接口，不摆出来当摆设。
   */
  const sessionMenuItems = (session: SessionMeta): ContextMenuState['items'] => [
    {
      id: 'open',
      label: '打开',
      onSelect: () => { props.onOpenSession(session.id) },
    },
    {
      id: 'archive',
      label: '归档',
      danger: false,
      onSelect: () => {
        void (async () => {
          try {
            await archiveSession(session.id)
            props.onNotify('已归档', 'info')
            // 归档后列表要刷新：宿主不主动推，这里重新拉一次。
            globalThis.location.reload()
          } catch (error) {
            props.onNotify(`归档失败：${error instanceof Error ? error.message : String(error)}`, 'error')
          }
        })()
      },
    },
  ]

  return (
    <aside className="sidebar">
      {/* --- 1. 身份行 ------------------------------------------ */}
      {/*
        顶部 52px 拖拽条。**这条必须留着**。

        我上一版把它删了，理由是"原版只在 Windows 标题栏下才渲染它"。
        那是把浏览器里的测量结果当成了事实：`isDarwinDesktop()` 的判断是
        `document.documentElement.dataset.platform === 'darwin'`，而普通
        浏览器里这个属性会被原版自己覆盖掉，于是 `topStrip` 不渲染。
        在真正的桌面壳里它是渲染的。

        它的作用不是"放 Windows 按钮"，而是**用垂直方向把身份行推下去**，
        给 macOS 左上角那三个红绿灯让出位置：
        - 红绿灯实测占 y 22–34（三个灯横排，宽 60.667px）
        - topStrip 占 y 0–52
        - 身份行被 `margin-top: -12px` 拉到 y 40 起
        三者因此互不重叠。删掉它，身份行的头像就直接落在红灯上。

        它同时是拖拽区：整条 52px 空条没有任何子元素，
        按在这里一定能拖窗口。用 `data-tauri-drag-region="deep"`
        而不是裸属性——裸属性只认"事件目标就是这个元素本身"。
      */}
      {darwin ? (
        <div className="sidebar__topStrip" data-tauri-drag-region="deep" aria-hidden />
      ) : null}

      {/*
        身份行也是拖拽区。

        这里不能用裸的 `data-tauri-drag-region`：Tauri 的脚本里写得很清楚，
        裸值（或 `"true"`）对应的是
        `return el === composedPath[0]` ——**只认直接点在元素本身上的按下**。
        按在头像、名字、在线点这些子元素上时，事件目标是子元素，
        判定立刻失败，表现就是"按着一点反应都没有"。

        `"deep"` 表示"子树里任何位置按下都算"。按钮不会被误吞：
        同一段脚本里 `isClickableElement()` 会在遇到 BUTTON 时先返回 false，
        所以「新建会话」按钮仍然可以正常点击。
      */}
      <div className="sidebar__logoRow" data-tauri-drag-region="deep">
        <span className="sidebar__brand">
          <span className="sidebar__brandIdentity" aria-hidden>
            <span className="sidebar__personaAvatar">
              <WhaleMark height={12.5} />
            </span>
            <span className="sidebar__persona">
              <span className="sidebar__personaName">{props.name}</span>
              <span className="sidebar__personaPresence">
                <span
                  className={
                    props.online
                      ? 'sidebar__presenceDot sidebar__presenceDot--online'
                      : 'sidebar__presenceDot'
                  }
                  aria-hidden
                />
                {props.online ? '在线' : '离线'}
              </span>
            </span>
          </span>
        </span>

        <button
          type="button"
          className="sidebar__newSessionIcon"
          onClick={props.onNewSession}
          title="新建会话"
          aria-label="新建会话"
        >
          <PlusIcon size={15} />
        </button>
      </div>

      {/* --- 3. 视图分段控件 -------------------------------- */}
      <div
        className="sidebar__viewSwitch"
        role="radiogroup"
        aria-label="会话视图"
        {...(switchable ? { 'data-active': props.view } : {})}
      >
        <button
          type="button"
          role="radio"
          aria-checked={switchable && props.view === 'chat'}
          disabled={!switchable}
          className={
            switchable && props.view === 'chat'
              ? 'sidebar__viewHalf sidebar__viewHalf--active'
              : 'sidebar__viewHalf'
          }
          onClick={() => { props.onViewChange('chat') }}
        >
          对话
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={switchable && props.view === 'log'}
          disabled={!switchable}
          className={
            switchable && props.view === 'log'
              ? 'sidebar__viewHalf sidebar__viewHalf--active'
              : 'sidebar__viewHalf'
          }
          onClick={() => { props.onViewChange('log') }}
        >
          日志
        </button>
      </div>

      {/* 只读的无障碍说明：告诉屏幕阅读器这两个格子切换的是哪一栏。
          视觉上不占位，因为"中栏会变"这件事看见一次就懂了。 */}
      <span className="sidebar__visuallyHidden">
        切换中间那栏的显示内容：对话或运行日志
      </span>

      {/* --- 4. 会话列表 ---------------------------------------- */}
      {/*
        列表区没有顶部操作条。
        原版的 `.n48hAq_sectionHeader`（36px）只在一个会话列表具备搜索
        能力时才渲染——它的内容就是"搜索框 + 视图选项"。当前版本没有搜索，
        补一条空的操作条只会在列表上方凭空多占 36px 并把首行推下去。
        实测原版有会话时侧栏第三段就是 regionArea（y=114），没有这一条。
      */}
      <div className="sidebar__regionArea">
        <div className="sidebar__list scroller">
          <SessionList
            {...props}
            onContextMenu={(event, session) => {
              event.preventDefault()
              setContextMenu({ x: event.clientX, y: event.clientY, items: sessionMenuItems(session) })
            }}
          />
        </div>
      </div>

      {/* --- 5. 底部账号菜单 ------------------------------------ */}
      {/*
        原版底部是 `aria-label="账号菜单"` 的按钮，点开是一个 124×128
        的浮层，三项：设置 / 意见反馈 / 关于。
        我此前把后两项当成"假按钮"删掉了——那是误判：它们在原版里
        真实存在，是产品给自己留的反馈与版本信息入口。
        即便当前版本不弹出内容，也不能让菜单少两项：
        少一项就是菜单结构和原版对不上。
      */}
      <div className="sidebar__footArea">
        <Menu
          label="账号菜单"
          side="top"
          minWidth={124}
          fontSize={14}
          itemPadding="8px 10px"
          anchor={
            <button
              type="button"
              className="sidebar__more"
              aria-label="账号菜单"
            >
              <span className="sidebar__glyph" aria-hidden>
                <EllipsisIcon size={15} />
              </span>
              <span className="sidebar__moreLabel">更多</span>
            </button>
          }
          items={[
            {
              id: 'settings',
              label: '设置',
              icon: <GearIcon size={14} />,
              onSelect: props.onOpenSettings,
            },
            {
              id: 'feedback',
              label: '意见反馈',
              icon: <FeedbackIcon size={14} />,
              onSelect: () => {
                props.onNotify('意见反馈入口尚未接入，可在项目仓库提 issue', 'info')
              },
            },
            {
              id: 'about',
              label: '关于',
              icon: <AboutIcon size={14} />,
              onSelect: () => {
                props.onNotify(`空谷 Ondra ${props.version ?? ''} · 本地优先的陪伴式桌面助手`, 'info')
              },
            },
          ]}
        />
      </div>

      {/* 右键菜单 portal 到 body，所以挂在这里只是个出口，不影响布局。 */}
      <ContextMenu state={contextMenu} onClose={() => { setContextMenu(undefined) }} minWidth={160} />
    </aside>
  )
}

/**
 * 会话列表。
 *
 * 行内只有三件事：图标槽、标题、时间。
 *
 * ## 图标槽是空的
 *
 * 原版每行左侧确实有 16×20 的槽，但**槽里没有图形**——它是一个纯占位，
 * 存在的意义是让标题统一从同一处起排，无论将来是否放进状态点。
 * 我此前在槽里塞了一个对话气泡图标，那是我自己加的装饰，原版没有。
 *
 * ## 时间与「⋯」互斥
 *
 * 静止时右端显示相对时间；鼠标悬停时时间隐藏、换成「⋯」按钮。
 * 这是原版的实现（`.gnibzq_rowResting` 与 `.gnibzq_rowActions` 二选一显示），
 * 好处是同样的位置只承担一个功能，不需要为「⋯」再挤出一列宽度。
 *
 * 当前会话这一行**常驻「⋯」**，不显示时间。原版如此：
 * 选中行的右端一直是操作入口。这一条容易漏——只做 hover 的版本里，
 * 选中的那一行看起来与其余行没有区别。
 */
function SessionList(
  props: SidebarProps & {
    onContextMenu(event: React.MouseEvent, session: SessionMeta): void
  },
): React.JSX.Element {
  if (props.sessions.length === 0) {
    return (
      <div className="sidebar__emptyState">
        <ChatIcon size={24} />
        <span>暂无会话</span>
        <button type="button" className="sidebar__emptyAction" onClick={props.onNewSession}>
          新建会话
        </button>
      </div>
    )
  }

  return (
    <>
      {props.sessions.map((session) => {
        const active = session.id === props.currentSessionId
        return (
          <button
            key={session.id}
            type="button"
            role="treeitem"
            aria-selected={active}
            className={
              active ? 'sidebar__sessionRow sidebar__sessionRow--active' : 'sidebar__sessionRow'
            }
            onClick={() => { props.onOpenSession(session.id) }}
            onContextMenu={(event) => { props.onContextMenu(event, session) }}
            title={session.title}
          >
            {/* 空的 16×20 占位槽。原版如此，不是漏了图标。 */}
            <span className="sidebar__rowSlot" aria-hidden />
            <span className="sidebar__sessionTitle">{session.title}</span>
            <span className="sidebar__rowResting">
              <span className="sidebar__sessionTime">{relativeTime(session.updatedAt)}</span>
            </span>
            {/* 与上面的时间占同一格：CSS 里二者互斥显示。
                选中行不靠 hover 也显示「⋯」，见文件头注释。
                这个「⋯」现在是真的按钮：点它和右键出同一个菜单。 */}
            <span
              className="sidebar__rowActions"
              onClick={(event) => {
                // 别让点击冒泡到行上——那会同时打开会话。
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                props.onContextMenu(
                  { clientX: rect.right, clientY: rect.bottom, preventDefault: () => {} } as React.MouseEvent,
                  session,
                )
              }}
              role="presentation"
            >
              <span className="sidebar__rowAction" aria-hidden>
                <EllipsisIcon size={15} />
              </span>
            </span>
          </button>
        )
      })}
    </>
  )
}
