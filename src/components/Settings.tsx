/**
 * 设置窗口。
 *
 * ## 结构照原版实测重建
 *
 * 我上一版把它做成了"一整列往下滚的所有设置项"，那不是原版：
 * 原版是**居中面板 + 左侧分组导航**，772×532，圆角 28px，蒙层盖住全窗。
 * 实测结构：
 *
 * | 节点 | 实测 |
 * |---|---|
 * | 面板 `dialog` | 24,24 → 772×532，白底，圆角 28px |
 * | 左侧 `nav` | 24,78 → 188×478，内边距 `10px 12px 0` |
 * | 导航项 | 164×40，圆角 12px，内边距 `9px 16px 9px 12px`，字号 14px |
 * | 选中项底色 | `rgb(235,238,242)` |
 * | 标题「设置」 | 左侧导航上方，字号 16px 量级 |
 *
 * 导航只有三项：通用设置、模型、开发者模式。
 * 我此前编的「模型供应商」「权限」「最近的对话」三个分组原版没有——
 * 供应商在「模型」页里，权限在「通用设置」页里，历史会话不进设置。
 *
 * ## 通用设置页的真实内容（截图逐项读出）
 *
 * - 权限：说明「选择新会话的默认权限模式」，右侧下拉，当前「仅可查看」
 * - 语言：右侧下拉，当前「中文」
 * - 外观：三张卡片横排（浅色 / 深色 / 跟随系统），带图标，当前选中项高亮
 * - 切换运行时的消息发送方式：说明「运行时按 Enter 与发送按钮的行为；Cmd/Ctrl+Enter 用另一种」，右侧下拉「排队发送」
 * - 当前版本：1.2.0
 *
 * ## 关闭方式
 *
 * 右上角一个 ✕，以及 Esc。点蒙层不关闭——原版面板几乎占满窗口，
 * 蒙层只有 24px 的边，误点概率低但一旦误点就丢失改动，不值得。
 */

import { useEffect, useState } from 'react'
import { CloseIcon, GearIcon, ChatIcon, ShieldIcon, LockIcon } from './icons.tsx'
import {
  getConfig,
  listModels,
  savePermission,
  saveProfiles,
  selectModel,
} from '../lib/api.ts'
import type { ModelDescriptor, PermissionLevel, ProfileView, ThemeMode } from '../lib/api.ts'

/** 设置窗口的分组。 */
type SettingsTab = 'general' | 'models' | 'developer'

/** 导航项。 */
const TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: '通用设置', icon: <GearIcon size={15} /> },
  { id: 'models', label: '模型', icon: <ChatIcon size={15} /> },
  { id: 'developer', label: '开发者模式', icon: <ShieldIcon size={15} /> },
]

/** 主题选项。原版是三张带图标的卡片，顺序为浅色、深色、跟随系统。 */
const THEMES: Array<{ id: ThemeMode; label: string }> = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
]

/** 权限档位。界面上显示为「仅可查看」这类短档位名。 */
const PERMISSIONS: Array<{ id: PermissionLevel; label: string }> = [
  { id: 'chat', label: '仅可查看' },
  { id: 'workspace', label: '工作区内' },
  { id: 'full', label: '完全放开' },
]

/** 发送方式。 */
type SendMode = 'queue' | 'interrupt'

/** 组件属性。 */
export interface SettingsProps {
  onClose(): void
  currentPermission: PermissionLevel
  onPermissionChange(permission: PermissionLevel): void
  theme: ThemeMode
  onThemeChange(theme: ThemeMode): void
  /** 顶层提示通道：保存成功/失败都走它，不在面板内部另做一套。 */
  onNotify(text: string, tone: 'error' | 'info'): void
}

/** 空白的供应商表单。 */
const EMPTY_PROFILE: ProfileView = {
  id: '',
  label: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  hasKey: false,
}

/** 渲染设置窗口。 */
export function Settings(props: SettingsProps): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [draft, setDraft] = useState<ProfileView | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [sendMode, setSendMode] = useState<SendMode>('queue')
  const [language, setLanguage] = useState('中文')

  const reload = async (): Promise<void> => {
    try {
      const [config, modelList] = await Promise.all([getConfig(), listModels()])
      setProfiles(config.profiles)
      setCurrentModel(config.currentModel)
      setModels(modelList)
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : '读取设置失败', 'error')
    }
  }

  useEffect(() => { void reload() }, [])

  // Esc 关闭。
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', handle)
    return () => { window.removeEventListener('keydown', handle) }
  }, [props])

  const handleSelectModel = async (id: string): Promise<void> => {
    try {
      await selectModel(id)
      setCurrentModel(id)
      props.onNotify('已切换模型', 'info')
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : '切换失败', 'error')
    }
  }

  const handlePermission = async (permission: PermissionLevel): Promise<void> => {
    try {
      await savePermission(permission)
      props.onPermissionChange(permission)
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : '保存权限失败', 'error')
    }
  }

  const handleSaveProfile = async (): Promise<void> => {
    if (draft === undefined) return
    setSaving(true)
    try {
      // 新条目用 model 名当 id；已有条目保持原 id，
      // 这样"改端点"不会被当成"删掉旧的再加一个新的"。
      const next = draft.id === ''
        ? [...profiles, { ...draft, id: draft.model, hasKey: draft.apiKey !== '' }]
        : profiles.map((profile) => profile.id === draft.id ? { ...draft, hasKey: draft.apiKey !== '' } : profile)
      await saveProfiles(next)
      setDraft(undefined)
      props.onNotify('已保存', 'info')
      await reload()
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleRemoveProfile = async (id: string): Promise<void> => {
    setSaving(true)
    try {
      await saveProfiles(profiles.filter((profile) => profile.id !== id))
      props.onNotify('已删除', 'info')
      await reload()
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings" role="presentation">
      <div className="settings__panel" role="dialog" aria-modal="true" aria-label="设置">
        <div className="settings__head">
          <h2 className="settings__title">设置</h2>
          <button type="button" className="settings__close" onClick={props.onClose} aria-label="关闭设置">
            <CloseIcon size={15} />
          </button>
        </div>

        <nav className="settings__nav" aria-label="设置分组">
          <div className="settings__navList">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings__navCell${tab === item.id ? ' settings__navCell--active' : ''}`}
                aria-current={tab === item.id ? 'page' : undefined}
                onClick={() => { setTab(item.id) }}
              >
                <span className="settings__navGlyph" aria-hidden>{item.icon}</span>
                <span className="settings__navLabel">{item.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="settings__body">
          {tab === 'general' ? (
            <div className="settings__rows">
              <div className="settings__row">
                <div className="settings__rowText">
                  <span className="settings__rowTitle">权限</span>
                  <span className="settings__rowHint">选择新会话的默认权限模式</span>
                </div>
                <select
                  className="settings__select"
                  value={props.currentPermission}
                  onChange={(event) => { void handlePermission(event.target.value as PermissionLevel) }}
                  aria-label="权限"
                >
                  {PERMISSIONS.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </div>

              <div className="settings__row">
                <div className="settings__rowText">
                  <span className="settings__rowTitle">语言</span>
                </div>
                <select
                  className="settings__select"
                  value={language}
                  onChange={(event) => { setLanguage(event.target.value) }}
                  aria-label="语言"
                >
                  <option value="中文">中文</option>
                  <option value="English">English</option>
                </select>
              </div>

              <div className="settings__block">
                <span className="settings__rowTitle">外观</span>
                <div className="themeCards">
                  {THEMES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`themeCard${props.theme === item.id ? ' themeCard--active' : ''}`}
                      aria-pressed={props.theme === item.id}
                      onClick={() => { props.onThemeChange(item.id) }}
                    >
                      <span className="themeCard__glyph" aria-hidden>
                        <ThemeGlyph mode={item.id} />
                      </span>
                      <span className="themeCard__label">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings__row">
                <div className="settings__rowText">
                  <span className="settings__rowTitle">切换运行时的消息发送方式</span>
                  <span className="settings__rowHint">
                    运行时按 Enter 与发送按钮的行为；Cmd/Ctrl+Enter 用另一种
                  </span>
                </div>
                <select
                  className="settings__select"
                  value={sendMode}
                  onChange={(event) => { setSendMode(event.target.value as SendMode) }}
                  aria-label="消息发送方式"
                >
                  <option value="queue">排队发送</option>
                  <option value="interrupt">打断当前回复</option>
                </select>
              </div>

              <div className="settings__row">
                <div className="settings__rowText">
                  <span className="settings__rowTitle">当前版本：{__APP_VERSION__}</span>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'models' ? (
            <div className="settings__rows">
              <div className="settings__block">
                <span className="settings__rowTitle">当前模型</span>
                {models.length === 0 ? <p className="settings__rowHint">没有可用模型</p> : null}
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className={`pickRow${model.id === currentModel ? ' pickRow--active' : ''}`}
                    onClick={() => { void handleSelectModel(model.id) }}
                  >
                    <span className="pickRow__name">{model.label}</span>
                    <span className="pickRow__meta">
                      {model.id === 'local/echo' ? '不联网，仅用于验证链路' : model.id}
                    </span>
                  </button>
                ))}
              </div>

              <div className="settings__block">
                <span className="settings__rowTitle">供应商</span>
                {profiles.map((profile) => (
                  <div key={profile.id} className="profileRow">
                    <span className="profileRow__text">
                      <span className="pickRow__name">{profile.label}</span>
                      <span className="pickRow__meta">{profile.baseUrl} · {profile.model}</span>
                    </span>
                    <button
                      type="button"
                      className="button--danger"
                      onClick={() => { void handleRemoveProfile(profile.id) }}
                      disabled={saving}
                    >
                      删除
                    </button>
                  </div>
                ))}

                {draft === undefined ? (
                  <>
                    <button type="button" className="button button--ghost" style={{ marginTop: 8 }}
                      onClick={() => { setDraft({ ...EMPTY_PROFILE }) }}>
                      添加供应商
                    </button>
                    <p className="settings__rowHint">
                      支持任何 OpenAI 兼容接口：DeepSeek、Moonshot、智谱，以及本地的
                      Ollama 或 LM Studio。接口地址填到 <code>/v1</code> 为止，
                      例如 <code>https://api.deepseek.com/v1</code>。
                    </p>
                  </>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <label className="field">
                      <span className="field__label">名称</span>
                      <input
                        value={draft.label}
                        placeholder="随便起个名字，比如 DeepSeek"
                        onChange={(event) => { setDraft({ ...draft, label: event.target.value }) }}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">接口地址</span>
                      <input
                        value={draft.baseUrl}
                        placeholder="https://api.deepseek.com/v1"
                        onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }) }}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">模型名</span>
                      <input
                        value={draft.model}
                        placeholder="deepseek-chat"
                        onChange={(event) => { setDraft({ ...draft, model: event.target.value }) }}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">密钥</span>
                      <input
                        value={draft.apiKey}
                        placeholder="留空表示不需要密钥（本地服务）"
                        onChange={(event) => { setDraft({ ...draft, apiKey: event.target.value }) }}
                      />
                    </label>
                    <div className="settings__actions">
                      <button
                        type="button"
                        className="button"
                        onClick={() => { void handleSaveProfile() }}
                        disabled={saving || draft.baseUrl.trim() === '' || draft.model.trim() === ''}
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                      <button type="button" className="button button--ghost" onClick={() => { setDraft(undefined) }}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {tab === 'developer' ? (
            <div className="settings__rows">
              <div className="settings__block">
                <span className="settings__rowTitle">开发者模式</span>
                <p className="settings__rowHint">
                  开发者模式用于查看运行日志、注入调试补丁与检查插件状态。
                  本版尚未接入插件管理器，因此这里只显示链接信息。
                </p>
              </div>
              <div className="settings__row">
                <div className="settings__rowText">
                  <span className="settings__rowTitle">后台服务地址</span>
                  <span className="settings__rowHint">界面通过这个本地地址与宿主通信，令牌由桌面壳注入</span>
                </div>
              </div>
              <div className="settings__row">
                <div className="settings__rowText">
                  <span className="settings__rowTitle">
                    <LockIcon size={12} /> 令牌不会显示在界面上
                  </span>
                  <span className="settings__rowHint">
                    宿主只在启动时把令牌交给桌面壳，前端拿不到明文，也无法导出
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 主题卡片里的小图标。浅色是太阳、深色是月亮、跟随系统是显示器。 */
function ThemeGlyph({ mode }: { mode: ThemeMode }): React.JSX.Element {
  if (mode === 'light') {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    )
  }
  if (mode === 'dark') {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    )
  }
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}
