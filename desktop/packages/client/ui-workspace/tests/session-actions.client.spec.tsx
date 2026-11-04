// @vitest-environment jsdom
/**
 * The shipped Session row actions rendered directly with hand-built props:
 * the menu rows, hover buttons, dialogs, and global notices. Every action
 * reads its own injected hooks and calls its own injected callbacks;
 * what those callbacks do is apply.client.spec's
 * subject. The browser and the slot machinery stay out; the assembled
 * chain lives in rename-assembly.client.spec.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@ntars/ondra-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@ntars/ondra-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@ntars/ondra-client-ui-session/client'
import type { SessionId } from '@ntars/ondra-session/types'
import { createSnapshotStore } from '@ntars/ondra-client-store'
import type { GlobalStandardProps, PropsLocale, PropsRenderSlots, PropsRuntime } from '@ntars/ondra-client-ui-slots'
import { allowAllAccess, bindSnapshotSelector, makeTranslate, SlotTestRuntime } from '@ntars/ondra-client-test-runtime'
import { LocaleRuntime } from '@ntars/ondra-client-locale/client'
import { registerToasts } from '../src/client/toast/register.ts'
import { en as commonEn } from '@ntars/ondra-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@ntars/ondra-client-locale/src/locales/zh.ts'
import type {
  MenuOpenState, RowToast, RowToastState, SessionDeleteConfirmInjected, SessionDeleteConfirmRequest,
  SessionRenameDialogInjected, SessionRenameTarget,
} from '../src/client/contract/slots.ts'
import {
  DeleteSessionMenuItem, DeleteSessionRowButton, SessionDeleteConfirmDialog,
} from '../src/client/session-actions/DeleteSession.tsx'
import { ForkSessionMenuItem } from '../src/client/session-actions/ForkSession.tsx'
import { PinSessionMenuItem, PinSessionRowButton } from '../src/client/session-actions/PinSession.tsx'
import { RenameSessionMenuItem, SessionRenameDialog } from '../src/client/session-actions/RenameSession.tsx'
import { RowActionToast } from '../src/client/session-actions/RowActionToast.tsx'
import { SessionIdMenuItem } from '../src/client/session-actions/SessionId.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: PropsLocale<'workspace'>['t'] = makeTranslate(zh, commonZh)
const tEn: PropsLocale<'workspace'>['t'] = makeTranslate(en, commonEn)

const sid = (id: string) => id as SessionId
/** Selector hook over one fixed snapshot: how the renderer binds a standard or injected `hooks` source. */
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
/** The Set an injected membership hook selects from. */
const idSet = (...ids: string[]): ReadonlySet<SessionId> => new Set(ids.map(sid))

/** The row every action is rendered for: its owner share as the browser passes it. */
const ROW = { sessionId: sid('one'), displayTitle: 'Session title' }
const one: SessionSummary = {
  id: ROW.sessionId, displayTitle: ROW.displayTitle, running: false, blank: false, updatedAt: 1, retainedBy: {},
}
const sessions: SessionListState = {
  ids: [one.id], byId: { [one.id]: one }, phase: 'ready', projectionsBySession: {},
}
// The Workspace snapshot lists no pins or archives: an action's membership
// arrives through its injected Set hooks, never through this seat.
const workspaces: WorkspaceSnapshot = {
  items: [{
    workspaceId: 'alpha' as WorkspaceId, path: '/projects/alpha', title: 'alpha', sessionIds: [one.id],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
}
const noStatus: SessionStatusSnapshot = new Map()
// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

/** The global standard seat every root-scope entry receives. */
const standard: GlobalStandardProps = {
  useSessions: hook(sessions),
  useSessionStatus: hook(noStatus),
  useSessionRetainInfo: () => undefined,
  usePanelInfo,
  useResource,
  useWorkspaces: hook(workspaces),
  ...allowAllAccess,
}

type MenuRowProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<'workspace'>
type ActionRowProps = PropsRuntime<'sidebar.workspaces.session.row.action'> & PropsLocale<'workspace'>
type OverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'>

/** Owner share, standard seat, locale seat, and the bound open-state hook of one menu row. */
function menuRow(menu: MenuOpenState): MenuRowProps {
  return { ...ROW, useMenuOpenState: () => menu, useShortcuts: hook([]), t, ...standard }
}

/** Owner share, standard seat, and locale seat of one hover button. */
const actionRow: ActionRowProps = { ...ROW, t, ...standard }

/** Standard and locale seats of a `shell.overlay` entry (no owner share). */
const overlay: OverlayProps = { t, ...standard }

/** An open menu whose setter records the entries' dismissal. */
function openMenu() {
  const setMenuOpen = vi.fn()
  const state: MenuOpenState = [true, setMenuOpen]
  return { state, setMenuOpen }
}

/** Position of a mock's `nth` call in the global call sequence (a call that never happened sorts last). */
function callOrder(fn: { mock: { invocationCallOrder: readonly number[] } }, nth = 0): number {
  return fn.mock.invocationCallOrder[nth] ?? Number.POSITIVE_INFINITY
}

describe('Session ID action', () => {
  it.each([t, tEn])('dismisses the menu before copying the complete row ID', (translate) => {
    const { state, setMenuOpen } = openMenu()
    const sessionId = sid('session-c4421b66-252e-44c0-80ed-6e320abeba25')
    const copySessionId = vi.fn(async () => {})
    render(<SessionIdMenuItem {...menuRow(state)} sessionId={sessionId} t={translate} copySessionId={copySessionId} />)
    fireEvent.click(screen.getByRole('menuitem', { name: translate('menu.sessionId') }))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(copySessionId).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(copySessionId))
  })
})

describe('pin action', () => {
  /** The pin share over fixed membership: the bound Set hooks and the two callbacks the entries call. */
  const pinShare = (pinned: readonly string[] = [], archived: readonly string[] = []) => ({
    usePinned: hook(idSet(...pinned)),
    useArchived: hook(idSet(...archived)),
    pinSession: vi.fn(),
    unpinSession: vi.fn(),
  })

  it('menu row closes the menu, then pins an unpinned Session', () => {
    const { state, setMenuOpen } = openMenu()
    const pin = pinShare()
    render(<PinSessionMenuItem {...menuRow(state)} {...pin} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶会话' }))
    expect(pin.pinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.unpinSession).not.toHaveBeenCalled()
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(pin.pinSession))
  })

  it('menu row closes the menu, then unpins a pinned Session', () => {
    const { state, setMenuOpen } = openMenu()
    const pin = pinShare(['one'])
    render(<PinSessionMenuItem {...menuRow(state)} {...pin} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }))
    expect(pin.unpinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.pinSession).not.toHaveBeenCalled()
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(pin.unpinSession))
  })

  it('row button toggles the pin', () => {
    const pin = pinShare()
    const view = render(<PinSessionRowButton {...actionRow} {...pin} />)
    fireEvent.click(screen.getByRole('button', { name: '置顶会话' }))
    expect(pin.pinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.unpinSession).not.toHaveBeenCalled()

    view.rerender(<PinSessionRowButton {...actionRow} {...pin} usePinned={hook(idSet('one'))} />)
    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }))
    expect(pin.unpinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.pinSession).toHaveBeenCalledOnce()
  })

  it('offers neither toggle while the access snapshot excludes it for this Session', () => {
    const { state } = openMenu()
    const useSessionAccess = vi.fn((_id: SessionId, endpoint: string) => endpoint !== 'workspace/pinSession')
    const menu = render(<PinSessionMenuItem {...menuRow(state)} {...pinShare()} useSessionAccess={useSessionAccess} />)
    expect(menu.container.innerHTML).toBe('')
    expect(useSessionAccess).toHaveBeenCalledWith(sid('one'), 'workspace/pinSession')
    menu.unmount()
    const button = render(<PinSessionRowButton {...actionRow} {...pinShare()} useSessionAccess={useSessionAccess} />)
    expect(button.container.innerHTML).toBe('')
    button.unmount()
    // A pinned row asks for its unpin endpoint instead.
    const pinned = render(<PinSessionRowButton {...actionRow} {...pinShare(['one'])} useSessionAccess={useSessionAccess} />)
    expect(useSessionAccess).toHaveBeenLastCalledWith(sid('one'), 'workspace/unpinSession')
    expect(pinned.getByRole('button', { name: '取消置顶' })).toBeTruthy()
  })

  it('offers nothing on an archived Session', () => {
    const { state } = openMenu()
    const pin = pinShare(['one'], ['one'])
    const menu = render(<PinSessionMenuItem {...menuRow(state)} {...pin} />)
    expect(menu.container.childElementCount).toBe(0)
    const button = render(<PinSessionRowButton {...actionRow} {...pin} />)
    expect(button.container.childElementCount).toBe(0)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('delete action', () => {
  /** The delete share over fixed membership: the callback the entries call. */
  const deleteShare = () => ({ deleteSession: vi.fn() })

  it('menu row closes the menu, then deletes', () => {
    const { state, setMenuOpen } = openMenu()
    const remove = deleteShare()
    render(<DeleteSessionMenuItem {...menuRow(state)} {...remove} />)
    const row = screen.getByRole('menuitem', { name: '删除会话' })
    // Deleting is destructive: the row carries the danger colors.
    expect(row.className).toMatch(/danger/)
    fireEvent.click(row)
    expect(remove.deleteSession).toHaveBeenCalledWith(sid('one'))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(remove.deleteSession))
  })

  it('offers neither the delete row nor its button while the access snapshot excludes removal', () => {
    const { state } = openMenu()
    const useSessionAccess = vi.fn((_id: SessionId, endpoint: string) => endpoint !== 'workspace/archiveSession')
    const menu = render(<DeleteSessionMenuItem {...menuRow(state)} {...deleteShare()} useSessionAccess={useSessionAccess} />)
    expect(menu.container.innerHTML).toBe('')
    expect(useSessionAccess).toHaveBeenCalledWith(sid('one'), 'workspace/archiveSession')
    menu.unmount()
    const button = render(<DeleteSessionRowButton {...actionRow} {...deleteShare()} useSessionAccess={useSessionAccess} />)
    expect(button.container.innerHTML).toBe('')
  })

  it('row button deletes the Session', () => {
    const remove = deleteShare()
    render(<DeleteSessionRowButton {...actionRow} {...remove} />)
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }))
    expect(remove.deleteSession).toHaveBeenCalledWith(sid('one'))
  })
})

describe('fork and rename rows', () => {
  it('fork closes the menu, then forks the Session', () => {
    const { state, setMenuOpen } = openMenu()
    const forkSession = vi.fn()
    render(<ForkSessionMenuItem {...menuRow(state)} forkSession={forkSession} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '分叉会话' }))
    expect(forkSession).toHaveBeenCalledWith(sid('one'))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(forkSession))
  })

  it('omits the fork row when the access snapshot excludes session/fork for this Session', () => {
    const { state } = openMenu()
    const useSessionAccess = vi.fn(() => false)
    const { container } = render(
      <ForkSessionMenuItem {...menuRow(state)} useSessionAccess={useSessionAccess} forkSession={vi.fn()} />,
    )
    expect(container.innerHTML).toBe('')
    expect(useSessionAccess).toHaveBeenCalledWith(sid('one'), 'session/fork')
  })

  it('omits the rename row when the access snapshot excludes session/rename for this Session', () => {
    const { state } = openMenu()
    const useSessionAccess = vi.fn(() => false)
    const view = render(
      <RenameSessionMenuItem {...menuRow(state)} useSessionAccess={useSessionAccess} requestSessionRename={vi.fn()} />,
    )
    expect(view.container.innerHTML).toBe('')
    expect(useSessionAccess).toHaveBeenCalledWith(sid('one'), 'session/rename')
  })

  it('rename closes the menu, then asks for the dialog with the row title', () => {
    const { state, setMenuOpen } = openMenu()
    const requestSessionRename = vi.fn()
    render(<RenameSessionMenuItem {...menuRow(state)} requestSessionRename={requestSessionRename} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(requestSessionRename).toHaveBeenCalledWith(sid('one'), 'Session title')
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(requestSessionRename))
  })
})

describe('SessionRenameDialog', () => {
  /** The dialog over a test-owned request source; settling clears the request the way apply does. */
  function renameDialog(renameSession: SessionRenameDialogInjected['renameSession']) {
    const request = createSnapshotStore<SessionRenameTarget | null>(null)
    const settleSessionRename = vi.fn(() => { request.set(null) })
    render(
      <SessionRenameDialog
        {...overlay}
        useRenameRequest={bindSnapshotSelector(request)}
        settleSessionRename={settleSessionRename}
        renameSession={renameSession}
      />,
    )
    const ask = (sessionId: string, currentTitle: string): void => {
      act(() => { request.set({ sessionId: sid(sessionId), currentTitle }) })
    }
    return { settleSessionRename, ask }
  }

  it('renders nothing until a rename is requested', () => {
    renameDialog(vi.fn(async () => {}))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it('restores composer focus and selection after cancelling and accepting a rename', async () => {
    const renameSession = vi.fn(async () => {})
    const { ask } = renameDialog(renameSession)
    render(<textarea aria-label="Composer" defaultValue="Keep this draft" />)
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Composer' })
    composer.focus()
    composer.setSelectionRange(5, 9)

    ask('one', 'Session title')
    const firstInput = screen.getByLabelText<HTMLInputElement>('会话名称')
    expect(document.activeElement).toBe(firstInput)
    expect([firstInput.selectionStart, firstInput.selectionEnd]).toEqual([0, 'Session title'.length])
    fireEvent.keyDown(firstInput, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([5, 9])
    expect(renameSession).not.toHaveBeenCalled()

    ask('one', 'Session title')
    const secondInput = screen.getByLabelText<HTMLInputElement>('会话名称')
    expect(document.activeElement).toBe(secondInput)
    fireEvent.change(secondInput, { target: { value: 'Renamed session' } })
    await act(async () => { fireEvent.keyDown(secondInput, { key: 'Enter' }) })
    expect(renameSession).toHaveBeenCalledWith(sid('one'), 'Renamed session')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
    expect(composer.value).toBe('Keep this draft')
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([5, 9])
  })

  it('seeds the draft from the request, renames with the trimmed title, and settles on acceptance', async () => {
    const pending = Promise.withResolvers<undefined>()
    const renameSession = vi.fn(() => pending.promise)
    const { settleSessionRename, ask } = renameDialog(renameSession)
    ask('one', '旧标题')
    expect(screen.getByRole('dialog', { name: '重命名会话' })).toBeTruthy()
    const input = screen.getByLabelText<HTMLInputElement>('会话名称')
    expect(input.value).toBe('旧标题')
    // Confirming the current title is allowed (that gesture pins an automatic
    // title); a blank draft is not, by button or by Enter.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(false)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '  新标题  ' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    expect(renameSession).toHaveBeenCalledWith(sid('one'), '新标题')
    // While the Host call is pending the input locks and closing is blocked.
    expect(input.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionRename).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined) })
    expect(settleSessionRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enter confirms only outside an IME composition', () => {
    const renameSession = vi.fn(async () => {})
    const { ask } = renameDialog(renameSession)
    ask('one', 'Old')
    const input = screen.getByLabelText<HTMLInputElement>('会话名称')
    fireEvent.change(input, { target: { value: 'New' } })
    // Enter that commits a composition must not submit.
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).toHaveBeenCalledWith(sid('one'), 'New')
  })

  it('keeps the dialog open with the rejection surfaced, clears it on edit, and reports a non-Error reason as text', async () => {
    const renameSession = vi.fn<SessionRenameDialogInjected['renameSession']>()
      .mockRejectedValueOnce(new Error('title write failed'))
      .mockRejectedValueOnce('denied')
    const { settleSessionRename, ask } = renameDialog(renameSession)
    ask('one', 'Old')
    const input = screen.getByLabelText<HTMLInputElement>('会话名称')
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('title write failed') })
    expect(input.disabled).toBe(false)
    expect(settleSessionRename).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Newer' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    expect(screen.getByRole('dialog', { name: '重命名会话' })).toBeTruthy()
  })

  it('Cancel, Escape, and Close settle without renaming; a request for another Session starts a fresh draft', () => {
    const renameSession = vi.fn(async () => {})
    const { settleSessionRename, ask } = renameDialog(renameSession)
    ask('one', 'Old')
    fireEvent.change(screen.getByLabelText('会话名称'), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    ask('one', 'Old')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleSessionRename).toHaveBeenCalledTimes(2)
    ask('one', 'Old')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(settleSessionRename).toHaveBeenCalledTimes(3)
    expect(renameSession).not.toHaveBeenCalled()

    ask('one', 'First')
    fireEvent.change(screen.getByLabelText('会话名称'), { target: { value: 'Edited' } })
    ask('two', 'Second')
    expect(screen.getByLabelText<HTMLInputElement>('会话名称').value).toBe('Second')
  })
})

describe('SessionDeleteConfirmDialog', () => {
  /** The dialog over a test-owned request source; settling clears the request the way apply does. */
  function deleteDialog(stopAndDeleteSession: SessionDeleteConfirmInjected['stopAndDeleteSession'], translate = t) {
    const request = createSnapshotStore<SessionDeleteConfirmRequest | null>(null)
    const settleSessionDelete = vi.fn(() => { request.set(null) })
    render(
      <SessionDeleteConfirmDialog
        {...overlay}
        t={translate}
        useDeleteRequest={bindSnapshotSelector(request)}
        settleSessionDelete={settleSessionDelete}
        stopAndDeleteSession={stopAndDeleteSession}
      />,
    )
    const ask = (activity: SessionDeleteConfirmRequest['activity']): void => {
      act(() => { request.set({ sessionId: sid('one'), displayTitle: 'Busy session', activity }) })
    }
    return { settleSessionDelete, ask }
  }

  it('renders nothing until a confirmation is requested', () => {
    deleteDialog(vi.fn(async () => {}))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the session and lists every reported family with its items, then stops and deletes on confirm', async () => {
    const pending = Promise.withResolvers<undefined>()
    const stopAndDeleteSession = vi.fn(() => pending.promise)
    const { settleSessionDelete, ask } = deleteDialog(stopAndDeleteSession)
    ask([
      { kind: 'turn' },
      { kind: 'subagent', items: [{ id: 'child-1', label: 'reviewer' }, { id: 'child-2' }] },
      { kind: 'job', items: [{ id: 'bash-1', label: 'pnpm run build' }] },
      { kind: 'schedule', items: [{ id: 'schedule-1', label: 'check the build' }] },
    ])
    const dialog = screen.getByRole('dialog', { name: '删除此会话？' })
    expect(dialog.textContent).toContain('“Busy session”将从列表中移除，归入已删除会话')
    const lines = [...screen.getByRole('list', { name: '将被停止的工作' }).querySelectorAll('li')].map(li => li.textContent)
    expect(lines).toEqual([
      '进行中的回合',
      '2 个运行中的子智能体：reviewer、child-2',
      '1 个后台任务：pnpm run build',
      '1 条定时提醒：check the build',
    ])
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(stopAndDeleteSession).toHaveBeenCalledWith(sid('one'))
    // While the Host call is pending, closing is blocked and the status shows.
    expect(screen.getByRole('status').textContent).toBe('正在删除…')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionDelete).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined) })
    expect(settleSessionDelete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the dialog open with a rejection surfaced, and Cancel settles without deleting', async () => {
    const stopAndDeleteSession = vi.fn<SessionDeleteConfirmInjected['stopAndDeleteSession']>()
      .mockRejectedValueOnce(new Error('stop exploded'))
    const { settleSessionDelete, ask } = deleteDialog(stopAndDeleteSession)
    ask([{ kind: 'turn' }])
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('stop exploded') })
    expect(settleSessionDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionDelete).toHaveBeenCalledOnce()
    expect(stopAndDeleteSession).toHaveBeenCalledOnce()
  })

  it('ignores Escape while the Host call is pending and reports a non-Error reason as text', async () => {
    const pending = Promise.withResolvers<undefined>()
    const stopAndDeleteSession = vi.fn<SessionDeleteConfirmInjected['stopAndDeleteSession']>()
      .mockReturnValueOnce(pending.promise)
    const { settleSessionDelete, ask } = deleteDialog(stopAndDeleteSession)
    ask([{ kind: 'turn' }])
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleSessionDelete).not.toHaveBeenCalled()
    await act(async () => { pending.reject('plain failure') })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('plain failure') })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleSessionDelete).toHaveBeenCalledOnce()
  })

  it('describes a family merged by another provider with the generic line', () => {
    const { ask } = deleteDialog(vi.fn(async () => {}))
    ask([{ kind: 'probe', items: [{ id: 'probe-1' }] }])
    const lines = [...screen.getByRole('list', { name: '将被停止的工作' }).querySelectorAll('li')].map(li => li.textContent)
    expect(lines).toEqual(['1 项其他工作（probe）'])
  })

  it('selects the singular or plural English line by item count', () => {
    const { ask } = deleteDialog(vi.fn(async () => {}), tEn)
    ask([
      { kind: 'subagent', items: [{ id: 'child-1', label: 'reviewer' }] },
      { kind: 'job', items: [{ id: 'bash-1' }, { id: 'bash-2' }] },
      { kind: 'schedule', items: [{ id: 'schedule-1', label: 'check the build' }, { id: 'schedule-2', label: 'stand-up' }] },
      { kind: 'probe', items: [{ id: 'probe-1' }] },
    ])
    const lines = [...screen.getByRole('list', { name: 'Work that will be stopped' }).querySelectorAll('li')].map(li => li.textContent)
    expect(lines).toEqual([
      '1 running subagent: reviewer',
      '2 background jobs: bash-1, bash-2',
      '2 scheduled reminders: check the build, stand-up',
      '1 other item of work (probe)',
    ])
  })
})

// A provider outside this package may merge its own family into the kind map;
// the dialog must describe it without knowing its copy.
declare module '@ntars/ondra-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
  }
}

function ToastFrame({ renderSlot }: PropsRenderSlots<'shell.overlay'>) {
  return renderSlot('shell.overlay', {})
}

describe('RowActionToast', () => {
  /** The notice surface over a test-owned notice source; dismissal clears the notice the way apply does. */
  async function toastSurface(translate = t) {
    const toast = createSnapshotStore<RowToastState | null>(null)
    const dismissToast = vi.fn(() => { toast.set(null) })
    const openForkSource = vi.fn()
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale(translate === tEn ? 'en' : 'zh')
    locale.register('workspace', { en, zh })
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } }, ToastFrame)
    registerToasts(runtime.ctx, { openForkSource })
    runtime.slots.register({
      name: 'shell.overlay', id: 'workspace.row-toast',
      children: { 'workspace.toast': { kind: 'keyed', scope: 'root' } },
      inject: () => ({ hooks: { toast }, dismissToast }),
    }, RowActionToast)
    runtime.renderRoot()
    let seq = 0
    const notify = (notice: RowToast): void => {
      act(() => { toast.set({ ...notice, seq: ++seq }) })
    }
    return { dismissToast, openForkSource, notify, locale }
  }

  it('keeps the same notice mounted across a locale change and still takes it down on its own hold', async () => {
    const { notify, locale, dismissToast } = await toastSurface()
    vi.useFakeTimers()
    try {
      notify({ kind: 'forkRequiresOpen', sessionId: sid('one') })
      const alert = screen.getByRole('alert')
      act(() => { vi.advanceTimersByTime(3000) })
      act(() => { locale.setLocale('en') })
      expect(screen.getByRole('alert')).toBe(alert)
      expect(alert.textContent).toContain('Open the original session to complete migration before creating a branch.')
      // The action label follows the locale too, on the same occurrence.
      expect(screen.getByRole('button', { name: 'Open original session' })).toBeTruthy()
      act(() => { vi.advanceTimersByTime(4001) })
      expect(dismissToast).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing without a notice', async () => {
    await toastSurface()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it.each([
    ['zh', t, '请先打开原会话完成迁移，再创建分支', '打开原会话'],
    ['en', tEn, 'Open the original session to complete migration before creating a branch.', 'Open original session'],
  ] as const)('keeps the %s fork notice after menu unmount and opens only on its action', async (_locale, translate, message, action) => {
    const { dismissToast, openForkSource, notify } = await toastSurface(translate)
    const { state, setMenuOpen } = openMenu()
    const forkSession = vi.fn((sessionId: SessionId) => { notify({ kind: 'forkRequiresOpen', sessionId }) })
    const menu = render(<ForkSessionMenuItem {...menuRow(state)} t={translate} forkSession={forkSession} />)

    fireEvent.click(screen.getByRole('menuitem', { name: translate('menu.fork') }))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(forkSession))
    menu.unmount()

    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(message)
    expect(openForkSource).not.toHaveBeenCalled()
    expect(forkSession).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: action }))
    expect(dismissToast).toHaveBeenCalledOnce()
    expect(openForkSource).toHaveBeenCalledExactlyOnceWith(sid('one'))
    expect(callOrder(dismissToast)).toBeLessThan(callOrder(openForkSource))
    expect(forkSession).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([t, tEn])('reports clipboard success and failure through the global toast', async (translate) => {
    const { notify } = await toastSurface(translate)
    notify({ kind: 'sessionIdCopied' })
    expect(screen.getByRole('alert').textContent).toBe(translate('toast.sessionIdCopied'))
    notify({ kind: 'sessionIdCopyFailed' })
    expect(screen.getByRole('alert').textContent).toBe(translate('toast.sessionIdCopyFailed'))
  })

  it.each([t, tEn])('replaces other notices with plain shortcut fork failures and only keeps the latest', async (translate) => {
    const { dismissToast, notify } = await toastSurface(translate)
    vi.useFakeTimers()
    try {
      notify({ kind: 'createFailed', message: 'boom' })
      act(() => { vi.advanceTimersByTime(1000) })
      notify({ kind: 'shortcutForkFailed', reason: 'unavailable' })
      const first = screen.getByRole('alert')
      expect(first.textContent).toBe(translate('shortcut.noCompletedTurn'))
      expect(first.querySelector('svg')).toBeNull()
      expect(first.querySelector('button')).toBeNull()
      act(() => { vi.advanceTimersByTime(3000) })
      expect(screen.getByRole('alert')).toBe(first)
      notify({ kind: 'shortcutForkFailed', reason: 'failed' })
      const retry = screen.getByRole('alert')
      expect(retry).not.toBe(first)
      expect(retry.textContent).toBe(translate('shortcut.forkFailed'))
      expect(retry.querySelector('svg')).toBeNull()
      act(() => { vi.advanceTimersByTime(3999) })
      expect(screen.getAllByRole('alert')).toEqual([retry])
      expect(dismissToast).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(dismissToast).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).toBeNull()

      notify({ kind: 'shortcutForkFailed', reason: 'failed' })
      act(() => { vi.advanceTimersByTime(1000) })
      notify({ kind: 'sessionIdCopied' })
      const latest = screen.getByRole('alert')
      expect(latest.textContent).toBe(translate('toast.sessionIdCopied'))
      act(() => { vi.advanceTimersByTime(3000) })
      expect(screen.getAllByRole('alert')).toEqual([latest])
      expect(dismissToast).toHaveBeenCalledOnce()
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['pinFailed', '置顶失败，请稍后重试'],
    ['unpinFailed', '取消置顶失败，请稍后重试'],
    ['deleteFailed', '删除会话失败，请稍后重试'],
    ['defaultWorkspaceFailed', '无法创建默认工作区，请通过“选择工作区”选择文件夹'],
  ] as const)('shows the %s warning and takes it down when its hold ends', async (kind, text) => {
    const { dismissToast, notify } = await toastSurface()
    vi.useFakeTimers()
    try {
      notify({ kind })
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe(text)
      expect(alert.querySelector('button')).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(dismissToast).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a refused creation with the Host reason and holds it longer than a plain notice', async () => {
    const { dismissToast, notify } = await toastSurface()
    vi.useFakeTimers()
    try {
      notify({ kind: 'createFailed', message: 'agent-preset/invalid: agent-presets: preset "broken" failed to mount' })
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe('新建会话失败：agent-preset/invalid: agent-presets: preset "broken" failed to mount')
      expect(alert.querySelector('button')).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(dismissToast).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(3001) })
      expect(dismissToast).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a long notice holds longer than a plain one, and a repeat restarts its hold', async () => {
    const { dismissToast, notify } = await toastSurface()
    vi.useFakeTimers()
    try {
      notify({ kind: 'forkRequiresOpen', sessionId: sid('one') })
      act(() => { vi.advanceTimersByTime(4000) })
      expect(screen.getByRole('alert')).toBeTruthy()
      notify({ kind: 'forkRequiresOpen', sessionId: sid('two') })
      act(() => { vi.advanceTimersByTime(7001) })
      expect(dismissToast).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

