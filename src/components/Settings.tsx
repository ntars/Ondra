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
export type SettingsPage = 'appearance' | 'sound' | 'notify' | 'talk' | 'data' | 'backup' | 'plugins' | 'permissions' | 'privacy' | 'knowledge' | 'about'

interface PageEntry {
  key: SettingsPage
  label: string
}

/**
 * 七个分类。
 *
 * 合并时把原来的九页压成七页：「主题」「字号」「语言」三页合成「外观」，
 * 因为它们回答的是同一个问题（这个界面看起来什么样），而分三页只会让
 * 想调大字号的人先点两次才发现入口。「更新」并进「关于」——它本来就是
 * 关于页最后那一条。
 *
 * `插件参数` 保持独立：它管的是 1116 项插件字段，与其余六页不是一个量级，
 * 混进「对话」或「外观」里会让那一页长到没法读。
 */
const PAGES: PageEntry[] = [
  { key: 'appearance', label: '外观' },
  { key: 'sound', label: '声音' },
  { key: 'notify', label: '通知' },
  { key: 'talk', label: '对话' },
  { key: 'data', label: '数据' },
  { key: 'backup', label: '备份' },
  { key: 'plugins', label: '插件参数' },
  { key: 'permissions', label: '权限' },
  { key: 'privacy', label: '隐私' },
  { key: 'knowledge', label: '知识库' },
  { key: 'about', label: '关于' },
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
   * 初始焦点落在**当前页**的导航项上。
   *
   * 不是第一个，也不是关闭键：用户打开设置时最可能的下一步是换一页，
   * 焦点落在导航里，方向键与回车立刻可用。落在关闭键上会让人误以为
   * 打开它只是为了关掉。
   */
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('.pref__nav-item[aria-current="page"]')?.focus()
  }, [])

  const entry = PAGES.find((item) => item.key === page)

  return (
    <div className="settings" role="presentation" onMouseDown={onScrimDown}>
      <div className="settings__pen" role="dialog" aria-modal="true" aria-label="设置" ref={panelRef}>
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

          {page === 'appearance' ? <div className="settings__scroll"><SettingsAppearance /></div> : null}
          {page === 'sound' ? <div className="settings__scroll"><SettingsSound /></div> : null}
          {page === 'notify' ? <div className="settings__scroll"><SettingsNotify /></div> : null}
          {page === 'talk' ? <div className="settings__scroll"><SettingsTalk /></div> : null}
          {page === 'about' ? <div className="settings__scroll"><SettingsAbout /></div> : null}
          {page === 'permissions' ? <div className="settings__scroll"><SettingsPermissions /></div> : null}
          {page === 'privacy' ? <div className="settings__scroll"><SettingsPrivacy /></div> : null}
          {page === 'knowledge' ? <div className="settings__scroll"><SettingsKnowledge /></div> : null}
          {page === 'backup' ? <div className="settings__scroll"><SettingsBackup /></div> : null}
          {page === 'data' ? (
            <div className="settings__scroll">
              {/*
                条件展开而不是传 undefined：项目开了 `exactOptionalPropertyTypes`，
                可选属性不接受显式 undefined。
              */}
              <SettingsData
                {...(sessionId === undefined ? {} : { sessionId })}
                onImported={onImported}
              />
            </div>
          ) : null}
          {page === 'plugins' ? (
            <SettingsPlugins {...(initialSection === undefined ? {} : { initialSection })} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
