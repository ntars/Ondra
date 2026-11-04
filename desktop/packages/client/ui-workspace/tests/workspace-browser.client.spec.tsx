// @vitest-environment jsdom
/**
 * The browsing region as shipped: one flat Session list over the single
 * default Workspace. It renders the visible Sessions most-recently-updated
 * first, opens one from its row, leaves archived Sessions out, honours a
 * saved account order, and shows its placeholder when the list is empty.
 * Grouping, search, and the view-options menu no longer exist on this
 * surface, so nothing here drives them.
 */
import type { GlobalStandardProps } from '@ntars/ondra-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@ntars/ondra-client-test-runtime'
import type { SessionListState, SessionSummary } from '@ntars/ondra-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@ntars/ondra-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@ntars/ondra-client-ui-session/client'
import type { SessionId } from '@ntars/ondra-session/types'
import { zh as commonZh } from '@ntars/ondra-client-locale/src/locales/zh.ts'
import type { DirectoryFlowOwnerProps, WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { createWorkspaceShortcutControls } from '../src/client/shortcuts.ts'
import { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } from '../src/client/stores.ts'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { zh } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: overrides.displayTitle ?? id, displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
  retainedBy: overrides.retainedBy ?? {},
})
const sessionState = (items: readonly SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready',
  projectionsBySession: {},
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (
  items: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[] = [],
  pinnedSessionIds: readonly SessionId[] = [],
): WorkspaceSnapshot => ({
  items, archivedSessionIds, pinnedSessionIds, state: 'idle', phase: 'ready', error: null,
})
const noPendingInteraction: SessionStatusSnapshot = new Map()
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

// The default child stub: an open directory flow shows its marker; the Session
// row lists stay empty (their entries have their own spec). A stub satisfies
// the generic render signature only with an erased owner type.
const renderDirectoryFlowOnly: WorkspaceBrowserProps['renderSlot'] = (name: string, owner: object) =>
  name === 'sidebar.workspaces.directoryFlow' && (owner as DirectoryFlowOwnerProps).open
    ? <div data-testid="directory-flow" />
    : null

function mount(overrides: Partial<WorkspaceBrowserProps> = {}) {
  const controls = createWorkspaceShortcutControls()
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    useShortcuts: select => select([]),
    useWorkspaceShortcuts: bindSnapshotSelector(controls.state),
    requestSearch: controls.search,
    requestAddWorkspace: controls.add,
    closeAddWorkspace: controls.closeAdd,
    setDirectoryBusy: controls.directoryBusy,
    requestSessionRename: controls.rename,
    useSessions: hook(sessionState([])),
    useSessionStatus: hook(noPendingInteraction),
    useSessionRetainInfo: () => undefined,
    usePanelInfo, useResource,
    useWorkspaces: hook(workspaceState([])),
    ...allowAllAccess,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    startSession: vi.fn(),
    open: vi.fn(),
    searchSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    insertWorkspaceBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace('created', [])),
    useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} }),
    useHostInfo: selector => selector({ home: undefined, isLoopback: true }),
    renderSlot: renderDirectoryFlowOnly,
    t,
    ...overrides,
  }
  const view = render(<WorkspaceBrowser {...props} />)
  return { view, props, store, controls }
}

/** The rows' titles in render order. */
function rowTitles(): string[] {
  return screen.getAllByRole('treeitem').map(row => row.querySelector('[class*="title"]')?.textContent ?? '')
}

describe('WorkspaceBrowser', () => {
  it('lists every visible Session in one flat list, most recently updated first', () => {
    mount({
      useSessions: hook(sessionState([summary('older', 1), summary('newer', 5)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['older', 'newer'])])),
    })
    expect(rowTitles()).toEqual(['newer', 'older'])
    // One list, no group rows: every treeitem is a Session.
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
  })

  it('opens a Session from its row', () => {
    const open = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('alpha-session', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-session'])])),
      open,
    })
    screen.getByText('alpha-session').click()
    expect(open).toHaveBeenCalledWith(sid('alpha-session'))
  })

  it('leaves archived Sessions out of the list', () => {
    mount({
      useSessions: hook(sessionState([summary('alive', 2), summary('gone', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alive', 'gone'])], [sid('gone')])),
    })
    expect(rowTitles()).toEqual(['alive'])
    expect(screen.queryByText('gone')).toBeNull()
  })

  it('follows the saved flat account order once one is written', async () => {
    const b = mount({
      useSessions: hook(sessionState([summary('older', 1), summary('newer', 5)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['older', 'newer'])])),
    })
    expect(rowTitles()).toEqual(['newer', 'older'])
    act(() => { b.store.actions.setSessionOrder(FLAT_SESSION_ORDER_KEY, ['older', 'newer'], {}) })
    await waitFor(() => { expect(rowTitles()).toEqual(['older', 'newer']) })
  })

  it('shows the placeholder instead of an empty list', () => {
    mount({ useSessions: hook(sessionState([])), useWorkspaces: hook(workspaceState([])) })
    expect(screen.queryByRole('treeitem')).toBeNull()
    expect(screen.getByText(t('empty.none'))).toBeTruthy()
  })


})
