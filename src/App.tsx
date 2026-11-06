/**
 * 应用根组件。
 *
 * ## 只有两种视图
 *
 * - **首页**：居中单页（鲸鱼标 + 「空谷 Ondra」+ 输入框）。
 * - **三栏**：进入会话后永久显示，1:2:1 横向分配。
 *
 * 判据是 `inConversation`（是否已进入），不是"有没有消息"。
 * 用消息数判断会导致新建一个空会话立刻弹回首页，用户会觉得
 * "点了加号却没反应"。
 *
 * ## 浮层都在这一层管
 *
 * 菜单、提示条、设置窗口都必须挂在根节点：菜单要 portal 到 body，
 * 提示条要盖住三栏，设置窗口要盖住整个应用。放进某一个栏里，
 * 前者会被 `overflow: hidden` 裁掉，后两者会被同级栏压住。
 *
 * ## 提示条是唯一的"说话"通道
 *
 * 上一版所有失败都是静默的——点「新建会话」失败了，界面什么都不说。
 * 现在任何会失败的动作（新建、发送、保存设置、切模型）都走 `notify`，
 * 用户至少能看到「新建会话失败：<原因>」。
 */

import { useCallback, useState } from 'react'
import { Onboarding } from './components/Onboarding.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import type { SidebarView } from './components/Sidebar.tsx'
import { Companion } from './components/Companion.tsx'
import { Settings } from './components/Settings.tsx'
import { Thread } from './components/Thread.tsx'
import { Welcome } from './components/Welcome.tsx'
import { Toast, useToast } from './components/Toast.tsx'
import { useAppState } from './lib/useAppState.ts'

/** 渲染应用。 */
export function App(): React.JSX.Element {
  const state = useAppState()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<SidebarView>('chat')
  const { toast, show: showToast, dismiss: dismissToast } = useToast()

  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try {
      return globalThis.localStorage?.getItem('ondra.onboarded') === '1'
    } catch {
      return false
    }
  })

  const openSettings = useCallback((): void => { setSettingsOpen(true) }, [])
  const finishOnboarding = (): void => {
    try {
      globalThis.localStorage?.setItem('ondra.onboarded', '1')
    } catch { /* 忽略 */ }
    setOnboarded(true)
  }

  /**
   * 新建会话。
   *
   * 必须捕获失败：宿主拒绝建会话时（比如插件未就绪），
   * 不报告的话用户只会看到"点了没反应"。
   */
  const handleNewSession = useCallback((): void => {
    void state.newSession().catch((error: unknown) => {
      showToast(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [state, showToast])

  /** 打开会话，失败同样要报告。 */
  const handleOpenSession = useCallback((id: string): void => {
    void state.openSession(id).catch((error: unknown) => {
      showToast(`打开会话失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [state, showToast])

  /** 发送。失败由界面上的错误条与提示条双重呈现。 */
  const handleSend = useCallback((): void => {
    void state.send().catch((error: unknown) => {
      showToast(`发送失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [state, showToast])

  /** 从首页进入三栏：先进入，再发送，避免界面还停在首页时用户看不到自己的话。 */
  const enterAndSend = (): void => {
    state.enterSession()
    handleSend()
  }

  return (
    <div className="shell">
      {state.phase === 'failed' ? (
        <div className="fatal">
          <p className="fatal__title">没能连接上后台服务</p>
          <p className="fatal__detail">{state.error ?? '未知原因'}</p>
          <button type="button" className="button button--ghost" onClick={state.retry}>
            重试
          </button>
        </div>
      ) : state.phase === 'connecting' ? (
        // 连接中不显示转圈：本地宿主启动通常不到一秒，转圈闪一下更干扰。
        <div className="skeleton">
          <div />
          <div />
          <div />
        </div>
      ) : state.inConversation ? (
        /* --- 三栏：永久显示，1:2:1 ------------------------------------- */
        <div className="workspace">
          <div className="workspace__left">
            <Sidebar
              name="哦鲸鲸"
              online={state.phase === 'ready'}
              sessions={state.sessions}
              currentSessionId={state.sessionId}
              logs={state.logs}
              view={view}
              onViewChange={setView}
              onNewSession={handleNewSession}
              onOpenSession={handleOpenSession}
              onOpenSettings={openSettings}
              version={__APP_VERSION__}
              onNotify={showToast}
            />
          </div>

          <div className="workspace__center">
            <Thread
              title={state.title === '' ? '新对话' : state.title}
              messages={state.messages}
              value={state.draft}
              onChange={state.setDraft}
              onSend={handleSend}
              busy={state.busy}
              onStop={() => { void state.stop() }}
              permission={state.permission}
              onPermissionClick={openSettings}
              error={state.chatError}
              onDismissError={state.dismissChatError}
              view={view}
              onViewChange={setView}
              logs={state.logs}
              models={state.models}
              modelId={state.modelId}
              onModelChange={state.setModel}
              onAddFile={state.addFiles}
              attachments={state.attachments}
              onRemoveAttachment={state.removeAttachment}
              onVoice={state.toggleVoice}
              voiceActive={state.voiceActive}
              {...(state.usage === undefined ? {} : { usage: state.usage })}
              onNotify={showToast}
            />
          </div>

          <div className="workspace__right">
            <Companion
              mood={state.mood}
              bond={state.bond}
              memories={state.memories}
              updatedAt={state.companionUpdatedAt}
              onSummonPet={state.summonPet}
            />
          </div>
        </div>
      ) : (
        /* --- 首页：居中单页 ------------------------------------------- */
        <Welcome
          value={state.draft}
          onChange={state.setDraft}
          onSend={enterAndSend}
          permission={state.permission}
          onPermissionClick={openSettings}
          onOpenSettings={openSettings}
          busy={state.busy}
          autoFocus
          models={state.models}
          modelId={state.modelId}
          onModelChange={state.setModel}
          onAddFile={state.addFiles}
          attachments={state.attachments}
          onRemoveAttachment={state.removeAttachment}
          onVoice={state.toggleVoice}
          voiceActive={state.voiceActive}
          onNotify={showToast}
        />
      )}

      {/* 设置窗口。挂在这里而不是三栏内部：它要盖住整个窗口。 */}
      {settingsOpen ? (
        <Settings
          onClose={() => { setSettingsOpen(false) }}
          currentPermission={state.permission}
          onPermissionChange={state.setPermission}
          theme={state.theme}
          onThemeChange={state.setTheme}
          onNotify={showToast}
        />
      ) : null}

      {/* 提示条在设置之上：设置里保存失败也要能看见。 */}
      {toast === undefined ? null : <Toast message={toast} onDismiss={dismissToast} />}

      {onboarded ? null : <Onboarding onDone={finishOnboarding} />}
    </div>
  )
}
