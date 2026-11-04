// @vitest-environment jsdom
/**
 * The column's 「对话 / 日志」switch: the one control that changes what the
 * middle column shows.
 *
 * It replaced the conversation's own View tab strip, so these cases also stand
 * where the tab-row regressions used to: the lit half must come from the
 * session's real view, and the control must survive having no session to read.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViewSwitch } from '../src/client/ViewSwitch.tsx'
import type { ViewSelectionSource } from '../src/client/ViewSwitch.tsx'

afterEach(() => { cleanup() })

/**
 * A selection service whose snapshot is stable between writes, the way the
 * conversation package's own bus behaves.
 * @param initial - the view to report first, or null for no session.
 * @returns the source plus the knobs the cases drive it with.
 */
function selection(initial: string | null): {
  source: ViewSelectionSource
  select: ReturnType<typeof vi.fn>
  emit: (view: string | null) => void
} {
  let snapshot = { view: initial }
  const listeners = new Set<() => void>()
  const select = vi.fn()
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      select,
    },
    select,
    emit: (view) => {
      snapshot = { view }
      for (const listener of listeners) listener()
    },
  }
}

describe('ViewSwitch', () => {
  it('renders disabled and stable when no session surface supplies a selection', () => {
    // The stand-in source must return ONE snapshot: a fresh object per read
    // looks like a change to useSyncExternalStore, which re-renders forever and
    // tears the column down with "Maximum update depth exceeded".
    const view = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={undefined} />)
    const radios = view.getAllByRole('radio') as HTMLButtonElement[]
    expect(radios.map(radio => radio.textContent)).toEqual(['对话', '日志'])
    expect(radios.every(radio => radio.disabled)).toBe(true)
    expect(radios.every(radio => radio.getAttribute('aria-checked') === 'false')).toBe(true)
    // Re-rendering proves the snapshot is still identity-stable after mount.
    view.rerender(<ViewSwitch chatLabel="对话" logLabel="日志" selection={undefined} />)
    expect(view.getAllByRole('radio')).toHaveLength(2)
  })

  it('lights the chat half for the chat view and writes the view id on click', () => {
    const { source, select } = selection('chat')
    const view = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={source} />)
    const [chat, log] = view.getAllByRole('radio') as HTMLButtonElement[]
    expect(view.getByRole('radiogroup')).toBeTruthy()
    expect(chat!.getAttribute('aria-checked')).toBe('true')
    expect(log!.getAttribute('aria-checked')).toBe('false')
    expect(chat!.disabled).toBe(false)

    fireEvent.click(log!)
    expect(select).toHaveBeenCalledExactlyOnceWith('run-log')
    fireEvent.click(chat!)
    expect(select).toHaveBeenLastCalledWith('chat')
  })

  it('lights the log half for every non-chat view, including ones it does not know', () => {
    const { source } = selection('run-log')
    const view = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={source} />)
    expect((view.getAllByRole('radio')[1] as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
    cleanup()

    // The view ring may hold more readings later; all of them are "not chat".
    const other = selection('trajectory')
    const again = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={other.source} />)
    expect((again.getAllByRole('radio')[1] as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
  })

  it('exposes the active view as data-active, which is what draws the sliding pill', () => {
    // The stylesheet never tints the halves; it slides one pill behind them and
    // reads this attribute for both visibility (`:not([data-active])` hides it)
    // and position (`[data-active='run-log']` translates it). Without the
    // attribute the pill stays transparent and the user cannot see which half is
    // selected, so the attribute is part of the control's contract, not styling.
    const none = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={undefined} />)
    expect(none.getByRole('radiogroup').getAttribute('data-active')).toBeNull()
    cleanup()

    const chat = selection('chat')
    const chatView = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={chat.source} />)
    expect(chatView.getByRole('radiogroup').getAttribute('data-active')).toBe('chat')
    cleanup()

    const log = selection('run-log')
    const logView = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={log.source} />)
    expect(logView.getByRole('radiogroup').getAttribute('data-active')).toBe('run-log')
  })

  it('follows the store when the session switches views elsewhere', () => {
    const { source, emit } = selection('chat')
    const view = render(<ViewSwitch chatLabel="对话" logLabel="日志" selection={source} />)
    act(() => { emit('run-log') })
    expect((view.getAllByRole('radio')[1] as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
    act(() => { emit(null) })
    const radios = view.getAllByRole('radio') as HTMLButtonElement[]
    expect(radios.every(radio => radio.disabled)).toBe(true)
    expect(radios.every(radio => radio.getAttribute('aria-checked') === 'false')).toBe(true)
  })
})
