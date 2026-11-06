/**
 * 应用根组件。
 *
 * ## 两种形态
 *
 * 首页（`inConversation === false`）：居中 logo + slogan + 输入框。
 * 会话态（`true`）：Rail + 主列（Timeline + Composer）+ Spine。
 *
 * ## 为什么抽屉与检查器都挂在 `.workspace` 里
 *
 * 它们覆盖主列但不改主列宽度（§3.4），所以定位参照必须是 workspace
 * 而不是 column。挂在 column 里会被 column 的 `overflow: hidden` 裁掉，
 * 挂在 shell 里则会让「top: 0」跑到标题栏下面去。
 *
 * ## 本批范围
 *
 * 第 4 批：设置三层（场景 / 模块 / 原始）接入，入口在检查器底部。
 * Composer 与 §12 的十四项细节分别在第 4 批之后与第 5 批，因此现在输入区
 * 仍是一个占位块——它能发消息（复用 `state.draft` 与 `state.send`），
 * 但外观是临时的。
 */

import { useCallback, useEffect, useState } from 'react'
import { useAppState } from './lib/useAppState.ts'
import { TitleBar } from './components/TitleBar.tsx'
import { Rail } from './components/Rail.tsx'
import type { DrawerKey } from './components/Rail.tsx'
import { Spine } from './components/Spine.tsx'
import { Inspector } from './components/Inspector.tsx'
import { Drawer } from './components/Drawer.tsx'
import { Timeline } from './components/Timeline.tsx'
import { Mark } from './components/Mark.tsx'
import { Settings } from './components/Settings.tsx'
import { isMac } from './lib/platform.ts'

/** 渲染应用。 */
export function App(): React.JSX.Element {
  const state = useAppState()

  /** 当前抽屉。undefined 表示都收起。 */
  const [drawer, setDrawer] = useState<DrawerKey | undefined>(undefined)
  /** 检查器是否展开。 */
  const [inspector, setInspector] = useState(false)
  /**
   * 设置面板是否展开。
   *
   * ## 为什么设置也是 workspace 里的一个覆盖层而不是独立窗口
   *
   * §5.13 把设置分成两层：偏好设置是独立窗口（主题、语言、字号），
   * 检查器设置是「抽屉，宽 300 可扩至 420」。后者管 1168 项插件参数，
   * 用户改它时往往正在看会话——独立窗口会让"改一下、回来看"变成反复切窗。
   * 独立窗口留给下一批的偏好设置。
   */
  const [settings, setSettings] = useState(false)

  /**
   * 点击 Rail 入口。
   *
   * ## 为什么「点同一个收起、点另一个原地替换」在这里判而不是组件内
   *
   * 判断需要当前值。放在 Rail 里就要把状态在两层各存一份，两份迟早不同步。
   * 放在这里，状态只有一份，行为由一次 `setDrawer` 决定：
   * 同一个值 → 置 undefined（收起）；不同值 → 直接赋值（内容原地替换）。
   *
   * ## 为什么展开抽屉要收起检查器
   *
   * §3.4 的规则是「抽屉覆盖主列，不改变主列宽度」。但抽屉 300 + 检查器 300
   * 同时展开时，716 宽的主列只剩 348 到 464 之间 116px 可见——名义上仍是
   * 覆盖，实际效果等同挤压，正文掉到 116px 比 §3.4 说的「掉到 420 以下」
   * 还糟。所以两者互斥：任何时刻最多一个覆盖层。
   *
   * 这不是设计文档没写到的情况，而是它「覆盖式展开是可接受的，因为抽屉是
   * 临时态」这个前提在双开时不再成立——临时态叠临时态，就不临时了。
   */
  const toggleDrawer = useCallback((key: DrawerKey): void => {
    setDrawer((previous) => (previous === key ? undefined : key))
    setInspector(false)
    setSettings(false)
  }, [])

  /** 展开检查器同理：收起抽屉与设置。 */
  const toggleInspector = useCallback((): void => {
    setInspector((previous) => !previous)
    setDrawer(undefined)
    setSettings(false)
  }, [])

  /** 打开设置：三个覆盖层互斥，任何时刻最多一个。 */
  const openSettings = useCallback((): void => {
    setSettings((previous) => !previous)
    setDrawer(undefined)
    setInspector(false)
  }, [])

  /**
   * 键盘与 Esc。
   *
   * §9.3 的层级：正在生成 → 停止；有浮层 → 关浮层；抽屉 → 关抽屉；
   * 检查器 → 关检查器；其余无操作（不退出应用）。
   *
   * 只有前四层在本批范围内（浮层菜单与 Sheet 在第 5 批）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return

      // 生成中优先停生成，此时不关任何层。
      if (state.busy) {
        void state.stop()
        return
      }
      if (drawer !== undefined) {
        setDrawer(undefined)
        return
      }
      if (settings) {
        setSettings(false)
        return
      }
      if (inspector) {
        setInspector(false)
        return
      }
      // 其余无操作。刻意不退出应用（§9.3 第 8 条）。
    }

    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [state.busy, state.stop, drawer, inspector, settings])

  /** `Cmd/Ctrl + Shift + I` 开关检查器（§9.1）。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.shiftKey) return
      if (event.key !== 'I' && event.key !== 'i') return
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      event.preventDefault()
      toggleInspector()
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [toggleInspector])

  /** `Cmd/Ctrl + ,` 开关设置（§9.1）。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ',') return
      const modifier = isMac() ? event.metaKey : event.ctrlKey
      if (!modifier) return
      event.preventDefault()
      openSettings()
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [openSettings])

  if (state.phase === 'failed') {
    return (
      <div className="shell">
        <TitleBar title="" />
        <div className="fatal">
          <p className="fatal__title">没能连接上后台服务</p>
          <p className="fatal__detail">{state.error ?? '未知原因'}</p>
          <button type="button" className="button button--ghost" onClick={state.retry}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (state.phase === 'connecting') {
    return (
      <div className="shell">
        <TitleBar title="" />
        <div className="skeleton">
          <div />
          <div />
          <div />
        </div>
      </div>
    )
  }

  const title = state.inConversation ? (state.title === '' ? '新对话' : state.title) : ''

  return (
    <div className="shell">
      <TitleBar title={title} />
      {state.inConversation ? (
        <div className="workspace">
          <Rail
            active={drawer}
            onToggle={toggleDrawer}
            onOpenSettings={() => {
              /*
               * Rail 的齿轮开偏好设置（主题、语言、字号），那是独立窗口，
               * 第 5 批做。这里不弹任何东西——比弹一个空壳诚实。
               * 1168 项插件参数不在这里，它们从检查器底部的「全部设置」进。
               */
              setDrawer(undefined)
            }}
          />

          <main className="column">
            <Timeline
              messages={state.messages}
              busy={state.busy}
              empty={state.messages.length === 0 && !state.busy}
            />
            {/*
              输入区占位。第 4 批换成完整 Composer。
              现在保留一个能打字、能发送的最小实现，避免「进入会话后什么都做不了」。
            */}
            <div className="composer-slot">
              <textarea
                className="composer-slot__input"
                value={state.draft}
                placeholder="说点什么…"
                rows={1}
                onChange={(event) => { state.setDraft(event.target.value) }}
                onKeyDown={(event) => {
                  // 输入法组合中不发送（§12.3）。
                  if (event.nativeEvent.isComposing) return
                  if (event.key !== 'Enter' || event.shiftKey) return
                  event.preventDefault()
                  void state.send()
                }}
              />
              <button
                type="button"
                className="button button--primary composer-slot__send"
                disabled={state.draft.trim() === '' || state.busy}
                onClick={() => { void state.send() }}
              >
                {state.busy ? '先别说' : '发送'}
              </button>
            </div>
          </main>

          <Spine
            mood={state.mood.mood}
            energy={state.mood.energy}
            memoryCount={state.memories.length}
            hasData={state.mood.label !== undefined && state.mood.label !== ''}
            busy={state.busy}
            inspectorOpen={inspector}
            resting={false}
            onToggle={toggleInspector}
          />

          <Drawer
            view={drawer}
            sessions={state.sessions}
            currentSessionId={state.sessionId}
            memories={state.memories}
            onOpenSession={(id) => {
              void state.openSession(id)
              setDrawer(undefined)
            }}
            onClose={() => { setDrawer(undefined) }}
          />

          {inspector ? (
            <Inspector
              mood={state.mood}
              bond={state.bond}
              memories={state.memories}
              activity={state.busy ? '正在想' : ''}
              tension={undefined}
              hasData={state.mood.label !== undefined && state.mood.label !== ''}
              onClose={() => { setInspector(false) }}
              onOpenSettings={() => {
                setInspector(false)
                setSettings(true)
              }}
            />
          ) : null}

          {/* 设置与检查器、抽屉三者互斥，任何时刻最多一个覆盖层。 */}
          {settings ? <Settings onClose={() => { setSettings(false) }} /> : null}
        </div>
      ) : (
        <div className="welcome">
          <span className="welcome__mark">
            <Mark size={64} variant="tile" label="空谷 Ondra" />
          </span>
          <div className="welcome__title">空谷 Ondra</div>
          <div className="welcome__slogan">于无声处，听见共鸣。</div>
          {/*
            首页的输入框直接进入会话：点一下或打一个字就走 `enterSession`。
            这不违反「首页不显示会话列表」——它只是入口，不是列表。
          */}
          <div className="welcome__composer">
            <button
              type="button"
              className="button button--ghost welcome__start"
              onClick={state.enterSession}
            >
              说点什么
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
