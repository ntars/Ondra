// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@ntars/ondra-client-test-runtime'
import { zh as commonZh } from '@ntars/ondra-client-locale/src/locales/zh.ts'
import type { AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { ActivityPill, UsagePill, type StatPillProps } from '../src/client/chat/StatsPills.tsx'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const t: AssistantMarkdownProps['t'] = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})


describe('render branch tails', () => {
  it('composer stats fall back to window-node counts and drop the usage pill without projections', () => {
    // No sessionStats key → the window fold supplies the counts (the
    // assembly-without-the-unit fallback). Node `usage` is deliberately
    // ignored: billing rides the durable tokenUsage projection, so an absent
    // projection leaves counts only.
    const nodes = [
      { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] },
      { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 2, blocks: [], usage: { inputTokens: 4, outputTokens: 6 } },
      { kind: 'assistant', seq: 3, time: 3, turn: 2, step: 1, blocks: [], usage: { inputTokens: 5 } },
    ] as const
    const snap = chatSnapshotFixture({ nodes })
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const pillProps: StatPillProps = {
      usePerformanceUsage: selector => selector('detailed'),
      t,
      useChat: bindSnapshotSelector(source),
      useProjection: () => undefined,
    }
    const view = render(
      <>
        <ActivityPill {...pillProps} />
        <UsagePill {...pillProps} />
      </>,
    )
    // The window fold carries no timed figure those nodes could turn into a
    // speed, and the counts reading is retired, so neither pill has anything
    // to say and no button renders.
    expect(view.container.textContent).toBe('')
    expect(view.queryAllByRole('button')).toHaveLength(0)
  })

})
