/**
 * 设置面板（唯一的一个）。
 *
 * ## 分类的来历
 *
 * 2.2.x 的六个分类（外观 / 声音 / 对话 / 记忆 / 插件参数 / 关于）按
 * 「实现侧的组件边界」划分，用户摸不清「改这个设置该进哪一页」。
 * 2.3.0 按**用户的六类意图**重新归位（记为 2.3.0）：
 *
 * | 页 | 收进来的 | 回答的问题 |
 * | --- | --- | --- |
 * | 通用 | 主题、字号、语言、发送方式、系统通知、默认权限、音效、语音输入 | 这个应用用起来什么样 |
 * | 模型与 API | 模型来源说明、自定义提供商 | 她的大脑连在哪里 |
 * | 人物设定 | 朗读、口吻、节奏、规矩、知识库 | 她是什么样的人、记得什么 |
 * | 备份与还原 | 导出 / 导入、整库快照与回滚 | 数据怎么搬走、怎么回到过去 |
 * | 扩展功能 | 插件参数（场景 / 模块 / 原始三层） | 底层每个字段是什么 |
 * | 关于 | 版本、更新、隐私说明、应用权限 | 这是什么、数据去了哪 |
 *
 * 插件参数仍然独立成页：它管六百多个字段，与其余页不是一个量级，
 * 而且它自己管滚动（表头固定、只有列表滚）。
 *
 * ## 入口
 *
 * | 入口 | 落在 |
 * | --- | --- |
 * | `Cmd/Ctrl + ,`、Rail 齿轮 | 通用 |
 * | 扩展抽屉里某个包的「配置」 | 扩展功能 · 模块（带上段 id） |
 *
 * 面板是悬浮在主界面之上的一张纸：左导航 + 右内容。悬浮层的好处是
 * **改完立刻能看见**——调字号、调主题时，背景就是正在用的界面。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'
import { useModalFocus } from '../lib/useModalFocus.ts'
import { useT } from '../lib/i18n.ts'
import type { MessageKey } from '../lib/i18n.ts'
import { SettingsAbout } from './SettingsAbout.tsx'
import { SettingsBackup } from './SettingsBackup.tsx'
import { SettingsData } from './SettingsData.tsx'
import { SettingsGeneral } from './SettingsGeneral.tsx'
import { SettingsPermissions } from './SettingsPermissions.tsx'
import { SettingsPersona } from './SettingsPersona.tsx'
import { SettingsPlugins } from './SettingsPlugins.tsx'
import { SettingsPrivacy } from './SettingsPrivacy.tsx'
import { SettingsProviders } from './SettingsProviders.tsx'

/** 面板的分类。顺序即导航顺序：从「用起来」到「底层」。 */
export type SettingsPage = 'general' | 'models' | 'persona' | 'backup' | 'plugins' | 'about'

/**
 * 一页的注册项：名字、类型、内容在同一个对象里。
 *
 * 导航从这张表投影出来，内容也按同一张表查——两者不可能对不上。
 */
interface PageEntry {
  key: SettingsPage
  labelKey: MessageKey
  /**
   * 这一页是否由外层提供「滚动 + 内边距」。
   *
   * 扩展功能页自己管滚动（表头固定、只有列表滚），外层再套一层会得到
   * 两个滚动条。所以它显式 opt out，其余页保持默认。
   */
  scroll?: boolean
  /**
   * 渲染这一页的主体。部分页面需要外部上下文，由下面传入。
   *
   * `onModelsChanged` 只给「模型与 API」页用：供应商增删改之后，顶栏的
   * 模型选择器与当前选中项都得跟着变。让它自己改主界面状态是不可能的
   * （那是 `useAppState` 的地盘），所以这里把「变了，重拉一次」这个信号
   * 一路传出去。
   */
  render(context: {
    sessionId: string | undefined
    initialSection: string | undefined
    onImported(): void
    onModelsChanged(): void
  }): React.JSX.Element
}

const PAGES: PageEntry[] = [
  { key: 'general', labelKey: 'nav.general', render: () => <SettingsGeneral /> },
  { key: 'models', labelKey: 'nav.models', render: ({ onModelsChanged }) => <SettingsProviders onChanged={onModelsChanged} /> },
  { key: 'persona', labelKey: 'nav.persona', render: () => <SettingsPersona /> },
  {
    key: 'backup',
    labelKey: 'nav.backup',
    /*
     * 条件展开而不是传 undefined：项目开了 `exactOptionalPropertyTypes`，
     * 可选属性不接受显式 undefined。
     */
    render: ({ sessionId, onImported }) => (
      <>
        <SettingsData {...(sessionId === undefined ? {} : { sessionId })} onImported={onImported} />
        <SettingsBackup />
      </>
    ),
  },
  {
    key: 'plugins',
    labelKey: 'nav.plugins',
    scroll: false,
    render: ({ initialSection }) => <SettingsPlugins {...(initialSection === undefined ? {} : { initialSection })} />,
  },
  {
    key: 'about',
    labelKey: 'nav.about',
    render: () => (
      <>
        <SettingsAbout />
        <SettingsPrivacy />
        <SettingsPermissions />
      </>
    ),
  },
]

export interface SettingsProps {
  /** 打开时落在哪一页。默认通用。 */
  initialPage?: SettingsPage
  /** 打开时直接定位到的配置段（只有扩展功能页认）。 */
  initialSection?: string
  /** 当前会话 id。备份与还原页的导出需要它。 */
  sessionId?: string
  /** 导入成功后让主界面重读当前会话。 */
  onImported(): void
  /**
   * 供应商或当前模型变化后让主界面重拉模型列表。
   *
   * 可选：主界面若不关心（比如测试里单独挂这个面板）可以不传。
   */
  onModelsChanged?(): void
  onClose(): void
}

export function Settings({
  initialPage = 'general',
  initialSection,
  sessionId,
  onImported,
  onModelsChanged,
  onClose,
}: SettingsProps): React.JSX.Element {
  const t = useT()
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const panelRef = useRef<HTMLDivElement | null>(null)

  /**
   * 供应商变化后的通知。
   *
   * 包一层空实现而不是直接把可选的 `onModelsChanged` 传下去：`PAGES` 的
   * 渲染函数要求它是必填，而调用方可以不给。写成一个稳定的引用也避免
   * 每次渲染都产生新函数、把「模型与 API」页的 `useCallback` 依赖打穿。
   */
  const handleModelsChanged = useCallback((): void => {
    onModelsChanged?.()
  }, [onModelsChanged])

  /**
   * 外部落点变化时切页。
   *
   * `page` 是面板自己的状态（用户在左侧导航里点来点去），但有两种外部来源
   * 会改落点：深度链接（面板已开时再收到 `ondra://settings/xxx`）、扩展抽屉
   * 里换一个包的「配置」。只把 `initialPage` 当初始值的话，这两种情况都会
   * 表现为「什么也没发生」。只在 `initialPage` 真的变了才同步，因此不会
   * 抢掉用户自己的导航。
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
   * 初始焦点落在**面板**上，不落在导航项上：对话框的标准做法。读屏会念
   * 标题，焦点确实进了对话框，而画面上不多一圈焦点环。要换页的话按一次
   * Tab 就进到第一个导航项。
   */
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])

  const entry = PAGES.find((item) => item.key === page)
  const entryLabel = entry === undefined ? t('settings.title') : t(entry.labelKey)

  return (
    <div className="settings" role="presentation" onMouseDown={onScrimDown}>
      <div className="settings__pen" role="dialog" aria-modal="true" aria-label={t('settings.title')} ref={panelRef} tabIndex={-1}>
        {/*
          左导航。168px 与主界面 Rail 同一套秩序的一部分：细窄、纯文字、
          选中项用一档浅实底——导航应当安静，它只是「你现在在哪儿」。
        */}
        <nav className="pref__nav" aria-label={t('settings.navLabel')}>
          {PAGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className="pref__nav-item"
              aria-current={item.key === page ? 'page' : undefined}
              onClick={() => { setPage(item.key) }}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        <div className="settings__main">
          <header className="settings__head">
            <h2 className="settings__title">{entryLabel}</h2>
            <button type="button" className="settings__close" aria-label={t('settings.close')} onClick={onClose}>
              <Icon icon={IconClose} size={16} />
            </button>
          </header>

          {/*
            一张表查一处：导航与内容读的是同一份 `PAGES`。
            面板永远有当前页（`page` 只能在表里取值），所以这里断言后直接用。
          */}
          {entry === undefined ? null : entry.scroll === false ? (
            <div className="settings__plug-host" key={page}>
              {entry.render({ sessionId, initialSection, onImported, onModelsChanged: handleModelsChanged })}
            </div>
          ) : (
            <div className="settings__scroll" key={page}>
              {entry.render({ sessionId, initialSection, onImported, onModelsChanged: handleModelsChanged })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
