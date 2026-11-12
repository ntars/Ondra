/**
 * 设置面板（唯一的一个）。
 *
 * ## 为什么只有一个设置
 *
 * 上一版有两个入口指向两处界面：Rail 齿轮与 `Cmd/Ctrl + ,` 打开**独立窗口**
 * （主题、语言、字号、声音、通知、发送方式、权限、更新、关于，九页），
 * 检查器底部的「全部设置」打开**主界面右栏的三层面板**（1116 项插件参数）。
 *
 * 两者的管辖范围确实不同，但用户看到的是「设置」两个字配两套界面、
 * 两种左侧导航、两种行高。他不知道自己该进哪一个，也没法知道——
 * 「改这个应用」与「改她」是我们内部的划分，不是他的。
 *
 * 现在只有一处：一个悬浮在主界面之上的面板，左侧一列分类，右侧一页内容。
 * 入口只剩两个，落页不同，且都不是「第二个设置按钮」：
 *
 * | 入口 | 落在 |
 * | --- | --- |
 * | `Cmd/Ctrl + ,`、Rail 齿轮 | 外观 |
 * | 扩展抽屉里某个包的「配置」 | 插件参数 · 模块（带上段 id） |
 *
 * 检查器底部那个「全部设置」删掉了：设置合并之后它和齿轮开的是同一个面板，
 * 站在右侧面板底部再摆一个「设置」，只会让人怀疑两处是不是同一处。
 * 插件参数仍然可达——齿轮进来点左侧导航的「插件参数」，或从扩展抽屉
 * 某个包的「配置」直接落到那一段（那是上下文入口，不是第二个总入口）。
 *
 * ## 为什么是悬浮而不是独立窗口
 *
 * 独立窗口是「另一个界面」：它有自己的任务栏项、自己的层级、关掉之后
 * 主窗口还在原处。设置看一眼就能关，它该像一张纸压在会话上，而不是
 * 另开一张桌子。悬浮层的另一个好处是**改完立刻能看见**——调字号、调主题
 * 时，背景就是正在用的界面（遮罩只压 18%，还看得见）。
 *
 * ## 为什么遮罩不盖标题栏
 *
 * 标题栏上有一整套自绘红绿灯与拖拽区。盖住它等于：设置打开时窗口既不能
 * 拖、也关不掉。所以面板与遮罩都从标题栏下沿开始——它仍然是一个
 * 「窗口里的浮层」，而不是一个假的全屏页面。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'
import { useModalFocus } from '../lib/useModalFocus.ts'
import { SettingsAbout } from './SettingsAbout.tsx'
import { SettingsAppearance } from './SettingsAppearance.tsx'
import { SettingsBackup } from './SettingsBackup.tsx'
import { SettingsData } from './SettingsData.tsx'
import { SettingsKnowledge } from './SettingsKnowledge.tsx'
import { SettingsNotify } from './SettingsNotify.tsx'
import { SettingsPermissions } from './SettingsPermissions.tsx'
import { SettingsPlugins } from './SettingsPlugins.tsx'
import { SettingsPrivacy } from './SettingsPrivacy.tsx'
import { SettingsSound } from './SettingsSound.tsx'
import { SettingsTalk } from './SettingsTalk.tsx'

/** 面板的分类。顺序即导航顺序：从「看得见」到「看不见」。 */
export type SettingsPage = 'appearance' | 'sound' | 'talk' | 'memory' | 'plugins' | 'about'

/**
 * 一页的注册项。
 *
 * ## 为什么把渲染函数放进表里
 *
 * 上一版是「一张 `PAGES` 数组写名字 + 十一行 `{page === 'xxx' ? <Page/> : null}`
 * 写内容」。加第十二页要改三处（类型、数组、那一串三元），漏一处就得到一个
 * 点得开但没有内容的页面——它不报错，只是空着。
 *
 * 现在一页只有一处：名字、类型、内容在同一个对象里。导航从这张表投影出来，
 * 内容也按同一张表查——两者不可能对不上。
 */
interface PageEntry {
  key: SettingsPage
  label: string
  /**
   * 这一页是否由外层提供「滚动 + 内边距」。
   *
   * 插件参数页自己管滚动（表头固定、只有列表滚），外层再套一层会得到
   * 两个滚动条。所以它显式 opt out，其余页保持默认。
   */
  scroll?: boolean
  /** 渲染这一页的主体。部分页面需要外部上下文，由下面传入。 */
  render(context: { sessionId: string | undefined; initialSection: string | undefined; onImported(): void }): React.JSX.Element
}

/**
 * 六个分类。
 *
 * ## 为什么从十一页压到六页
 *
 * 上一版是十一页：外观 / 声音 / 通知 / 对话 / 数据 / 备份 / 插件参数 /
 * 权限 / 隐私 / 知识库 / 关于。左导航在 380 高的面板里要滚动才看得全，
 * 而其中「通知」「备份」「隐私」三页各自只有一两个开关——用户为了关一条
 * 系统通知，得先在十一项里找到它。
 *
 * 合并的判据只有一个：**同一件事的不同侧面放在一起**。
 *
 * | 页 | 收进来的 | 它们回答的同一个问题 |
 * | --- | --- | --- |
 * | 外观 | 主题、字号 | 这个界面看起来什么样 |
 * | 声音 | 音效、朗读、口吻、节奏、规矩 | 她听起来什么样、怎么开口 |
 * | 对话 | 发送方式、系统通知、权限档 | 跟她说话时会发生什么 |
 * | 记忆 | 知识库、导出与恢复、备份 | 她记得什么、这些记忆怎么搬走 |
 * | 插件参数 | 场景 / 模块 / 原始三层 | 底层每个字段是什么 |
 * | 关于 | 版本、许可、数据处理说明 | 这是什么、数据去了哪 |
 *
 * `插件参数` 仍然独立：它管 619 个字段，与其余五页不是一个量级，
 * 混进任何一页都会让那页长到没法读；而且它自己管滚动（表头固定、
 * 只有列表滚），外层再套一层会得到两个滚动条。
 *
 * ## 合并页内部怎么分节
 *
 * 每个子组件顶层都是 `<section class="pref__section">`，直接并列即可：
 * `.pref__section` 自带 24 的下外边距，各段的 `<Heading>` 就是小标题。
 * 不需要包一层容器——包了反而要重新定义间距。
 */
const PAGES: PageEntry[] = [
  { key: 'appearance', label: '外观', render: () => <SettingsAppearance /> },
  { key: 'sound', label: '声音', render: () => <SettingsSound /> },
  {
    key: 'talk',
    label: '对话',
    render: () => (
      <>
        <SettingsTalk />
        <SettingsNotify />
        <SettingsPermissions />
      </>
    ),
  },
  {
    key: 'memory',
    label: '记忆',
    /*
     * 条件展开而不是传 undefined：项目开了 `exactOptionalPropertyTypes`，
     * 可选属性不接受显式 undefined。
     */
    render: ({ sessionId, onImported }) => (
      <>
        <SettingsKnowledge />
        <SettingsData {...(sessionId === undefined ? {} : { sessionId })} onImported={onImported} />
        <SettingsBackup />
      </>
    ),
  },
  {
    key: 'plugins',
    label: '插件参数',
    scroll: false,
    render: ({ initialSection }) => <SettingsPlugins {...(initialSection === undefined ? {} : { initialSection })} />,
  },
  {
    key: 'about',
    label: '关于',
    render: () => (
      <>
        <SettingsAbout />
        <SettingsPrivacy />
      </>
    ),
  },
]

export interface SettingsProps {
  /** 打开时落在哪一页。默认外观。 */
  initialPage?: SettingsPage
  /** 打开时直接定位到的配置段（只有插件参数页认）。 */
  initialSection?: string
  /** 当前会话 id。数据页的导出需要它。 */
  sessionId?: string
  /** 导入成功后让主界面重读当前会话。 */
  onImported(): void
  onClose(): void
}

export function Settings({
  initialPage = 'appearance',
  initialSection,
  sessionId,
  onImported,
  onClose,
}: SettingsProps): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const panelRef = useRef<HTMLDivElement | null>(null)

  /**
   * 外部落点变化时切页。
   *
   * `page` 是面板自己的状态（用户在左侧导航里点来点去），但有两种外部来源
   * 会改落点：深度链接（面板已开时再收到 `ondra://settings/xxx`）、扩展抽屉
   * 里换一个包的「配置」。只把 `initialPage` 当初始值的话，这两种情况都会
   * 表现为「什么也没发生」——面板开着，链接却像没生效。
   *
   * 只在 `initialPage` 真的变了才同步，因此不会抢掉用户自己的导航。
   */
  useEffect(() => {
    setPage(initialPage)
  }, [initialPage])

  /**
   * 点遮罩关闭。
   *
   * 用 `mousedown` 而不是 `click`：在遮罩上按下、拖到面板里松手，`click`
   * 会记在遮罩上（两个事件的 target 不同），于是「想选中面板里一段文字」
   * 会变成「把面板关了」。
   */
  const onScrimDown = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }, [onClose])

  useModalFocus(panelRef, onClose)

  /*
   * 初始焦点落在**面板**上，不落在导航项上。
   *
   * ## 为什么改了（上一版落在当前页导航项）
   *
   * 理由原本是「用户打开设置最可能的下一步是换一页」。但那样做的视觉代价
   * 是：面板一打开，当前导航项上就挂着一圈 2px 焦点环——它比选中态本身
   * 重得多，看起来像一颗被按住的按钮。而「选中」与「聚焦」本来就该是两件事。
   *
   * 落在面板（`tabIndex=-1`，role=dialog）上是对话框的标准做法：读屏会念
   * 标题，焦点确实进了对话框，而画面上不多一圈环。要换页的话按一次 Tab
   * 就进到第一个导航项——只多一次按键，换掉每次打开都多一圈假高亮。
   */
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])

  const entry = PAGES.find((item) => item.key === page)

  return (
    <div className="settings" role="presentation" onMouseDown={onScrimDown}>
      <div className="settings__pen" role="dialog" aria-modal="true" aria-label="设置" ref={panelRef} tabIndex={-1}>
        {/*
          左导航。160px 是与主界面 Rail 同一套秩序的一部分：细窄、纯文字、
          选中项用主色实底——整个应用只有这一处用主色铺整块底。
        */}
        <nav className="pref__nav" aria-label="设置分类">
          {PAGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className="pref__nav-item"
              aria-current={item.key === page ? 'page' : undefined}
              onClick={() => { setPage(item.key) }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings__main">
          <header className="settings__head">
            <h2 className="settings__title">{entry?.label ?? '设置'}</h2>
            <button type="button" className="settings__close" aria-label="关闭设置" onClick={onClose}>
              <Icon icon={IconClose} size={16} />
            </button>
          </header>

          {/*
            一张表查一处：导航与内容读的是同一份 `PAGES`。
            不能用 `entry?.render(...)` 的短路——`entry` 在类型上可能 undefined，
            而面板永远有当前页（`page` 只能在表里取值），所以这里断言后直接用。
          */}
          {entry === undefined ? null : entry.scroll === false ? (
            <div className="settings__plug-host" key={page}>
              {entry.render({ sessionId, initialSection, onImported })}
            </div>
          ) : (
            <div className="settings__scroll" key={page}>
              {entry.render({ sessionId, initialSection, onImported })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
