/**
 * 应用根组件。
 *
 * 这一版只搭骨架：标题栏 + 两种形态的切换。
 * 双脊、时间轴、设置三层在后续批次接入。
 */

import { useAppState } from './lib/useAppState.ts'
import { TitleBar } from './components/TitleBar.tsx'

/** 渲染应用。 */
export function App(): React.JSX.Element {
  const state = useAppState()

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
          <nav className="rail" aria-label="主导航" />
          <main className="column">
            <div className="column__scroll" />
          </main>
          <aside className="spine" aria-label="此刻" />
        </div>
      ) : (
        <div className="welcome">
          <div className="welcome__title">空谷 Ondra</div>
          <div className="welcome__slogan">于无声处，听见共鸣。</div>
        </div>
      )}
    </div>
  )
}
