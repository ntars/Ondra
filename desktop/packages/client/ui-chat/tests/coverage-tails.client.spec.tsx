// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@ntars/ondra-client-test-runtime'
import { zh as commonZh } from '@ntars/ondra-client-locale/src/locales/zh.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { unusedImageLoader } from './reasoning-component-fixture.tsx'
import { zh } from '../src/client/locale.ts'

const t: AssistantMarkdownProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

describe('tails', () => {
  it('renders prose as Markdown paragraphs without remounting on a streaming change', () => {
    const body = (streaming: boolean) => (
      <AssistantMarkdown renderSlot={() => null} t={t} loadImage={unusedImageLoader}
        blocks={[{ kind: 'text', text: 'first paragraph\n\nsecond paragraph' }]} streaming={streaming} />
    )
    const view = render(body(true))
    const first = view.getByText('first paragraph')
    expect(view.getByText('second paragraph')).toBeTruthy()
    expect(first.tagName).toBe('P')

    view.rerender(body(false))
    expect(view.getByText('first paragraph')).toBe(first)
  })

  it('leaves reasoning and tool-call blocks out of the conversation and keeps the unknown-block fallback', () => {
    const view = render(
      <AssistantMarkdown renderSlot={() => null}
        t={t}
        blocks={[
          { kind: 'reasoning', text: 'thinking hard\nsecond line' },
          { kind: 'tool-call', callId: 'c', name: 'bash', argsRaw: '{}' },
          { kind: 'other', block: { type: 'mystery' } },
        ]}
        streaming
        loadImage={unusedImageLoader}
      />,
    )
    // Machine work belongs to the run log: no Think row, no tool head, no reasoning text.
    expect(view.queryByText('思考')).toBeNull()
    expect(view.queryByText('thinking hard')).toBeNull()
    expect(view.getByText(/未知内容块/)).toBeTruthy()
    const stopped = render(
      <AssistantMarkdown renderSlot={() => null}
        t={t}
        blocks={[{ kind: 'text', text: 'partial words' }]}
        streaming={false}
        interrupted
        loadImage={unusedImageLoader}
      />,
    )
    expect(stopped.getByText('已停止')).toBeTruthy()
  })

  it('AssistantMarkdown skips the root shell when only machine work remains', () => {
    // Reasoning and tool heads are drawn by the run log; an empty root between
    // groups is layout noise (no text, no pulse, no interrupted marker).
    const empty = render(
      <AssistantMarkdown renderSlot={() => null}
        t={t}
        blocks={[
          { kind: 'tool-call', callId: 'c', name: 'todo_write', argsRaw: '{}' },
          { kind: 'reasoning', text: 'quiet thought' },
        ]}
        streaming={false}
        loadImage={unusedImageLoader}
      />,
    )
    expect(empty.container.firstChild).toBeNull()
    const blank = render(
      <AssistantMarkdown renderSlot={() => null}
        t={t} blocks={[]} streaming={false} loadImage={unusedImageLoader} />,
    )
    expect(blank.container.firstChild).toBeNull()
  })
})
