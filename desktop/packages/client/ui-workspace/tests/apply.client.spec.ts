import { createSnapshotStore } from '@ntars/ondra-client-store'
import { Context } from '@ntars/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  ISessions, SessionListState, SessionReference, SessionSnapshot, SessionSummary,
} from '@ntars/ondra-api-session-controller/client'
import { SessionForkError } from '@ntars/ondra-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@ntars/ondra-api-workspace-controller/client'
import type { SessionId } from '@ntars/ondra-session/types'
import { SlotRegistry } from '@ntars/ondra-client-ui-renderer/client'
import type { HostObservable, PropsRenderSlots, StoredEntry } from '@ntars/ondra-client-ui-slots'
import type { ShortcutCommand } from '@ntars/ondra-client-shortcuts/client'
import { RemoteError, StaticRemoteAccess, TestRemote } from '@ntars/ondra-client-test-runtime'
import { LocaleRuntime } from '@ntars/ondra-client-locale/client'
import { apply, inject } from '@ntars/ondra-client-ui-workspace/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from '@ntars/ondra-client-ui-workspace/client'
import {
  type DeleteSessionInjected, type ForkSessionInjected, menuOpenStateFactory, type PinSessionInjected,
  type RenameSessionInjected, type RowToastInjected, type SessionDeleteConfirmInjected, type SessionRenameDialogInjected,
  type SessionTrashInjected,
  type SessionIdInjected, type WorkspaceViewStoreHandle,
} from '../src/client/contract/slots.ts'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { DeleteSessionMenuItem, SessionDeleteConfirmDialog } from '../src/client/session-actions/DeleteSession.tsx'
import { PinSessionMenuItem } from '../src/client/session-actions/PinSession.tsx'
import { RenameSessionMenuItem, SessionRenameDialog } from '../src/client/session-actions/RenameSession.tsx'
import { RowActionToast } from '../src/client/session-actions/RowActionToast.tsx'
import type { ToastDisplayInjected } from '../src/client/contract/toast.ts'
import { SessionIdMenuItem } from '../src/client/session-actions/SessionId.tsx'
import { SessionTrashDialog } from '../src/client/session-actions/SessionTrash.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { FLAT_SESSION_ORDER_KEY } from '../src/client/stores.ts'
import { UNGROUPED_KEY } from '../src/client/tree.ts'
import { apply as hostApply } from '../src/index.ts'

const sid = (id: string) => id as SessionId
const summary = (id: string, updatedAt: number): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, retainedBy: {},
})
const sessionState = (items: readonly SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready',
  projectionsBySession: {},
})
const workspace = (id: string, sessionIds: readonly string[]): WorkspaceView => ({
  workspaceId: id as WorkspaceId, path: `/projects/${id}`, title: id,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (
  items: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[] = [],
  pinnedSessionIds: readonly SessionId[] = [],
): WorkspaceSnapshot => ({
  items, archivedSessionIds, pinnedSessionIds, state: 'idle', phase: 'ready', error: null,
})


/**
 * The fork face the menu item used to carry, rebuilt on the bench: the shipped
 * registration is gone from the menu, but the fork error paths still run through
 * this exact inject shape via the tests.
 */
const forkFace = (
  b: Awaited<ReturnType<typeof bench>>,
  toast: RowToastInjected,
): ForkSessionInjected => ({
  forkSession: (sessionId) => {
    let call: unknown
    try {
      call = (b.ctx.uiWorkspace as unknown as { forkSession: unknown }).forkSession
    } catch { call = undefined }
    void call
    b.ctx.uiWorkspace.forkSession(sessionId, (childId) => {
      b.ctx.get('productAnalytics')?.track('branch_session_click', {
        session_id: childId, parent_session_id: sessionId, click_position: 'sidebar',
      })
    }, { allowMigration: false }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'SessionForkError'
        && (error as SessionForkError).rpcError.code === 'session/migration-required') {
        const previous = toast.hooks.toast.getSnapshot() as { seq?: number } | null
        ;(toast.hooks.toast as unknown as { set(value: unknown): void })
          .set({ kind: 'forkRequiresOpen', sessionId, seq: (previous?.seq ?? 0) + 1 })
      }
    })
  },
})


const ALLOWED: HostObservable<boolean> = createSnapshotStore(true)

async function bench(access: 'fake' | 'static' = 'fake') {
  const ctx = new Context()
  const commands = new Map<string, ShortcutCommand>()
  ctx.provide('shortcuts', {
    register: (command: ShortcutCommand) => {
      commands.set(command.id, command)
      return () => { commands.delete(command.id) }
    },
    catalog: createSnapshotStore([]),
  })
  ctx.provide('uiConversation', {})
  await ctx.plugin(SlotRegistry).await()
  const accessSource = vi.fn((_kind: string, _id: string, _action: string): HostObservable<boolean> => ALLOWED)
  const stopGuard = vi.fn()
  const whenResourceAccess = vi.fn((): () => void => stopGuard)
  if (access === 'static') new StaticRemoteAccess(ctx)
  else ctx.provide('remoteAccess', { source: accessSource, whenAccess: vi.fn(() => () => {}), whenResourceAccess })
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  const rename = vi.fn(async () => ({}))
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel, beginNavigation: () => new AbortController().signal })
  const search = vi.fn(async () => ({
    ok: true as const,
    value: { items: [{ sessionId: 'session' as never, snippet: 'match' }], hasMore: false },
  }))
  const renameSession = vi.fn(async (title: string) => ({ ok: true, value: { title, seq: 1 } }))
  const history = createSnapshotStore<Pick<SessionSnapshot, 'openState' | 'subagent'>>({ openState: 'open', subagent: null })
  const session = { rename: renameSession, getSnapshot: () => history.getSnapshot() }
  const binding = vi.fn((_id: string) => ({ session }))
  const retainedIds = new Map<string, number>()
  const scope = vi.fn((id: string) => retainedIds.has(id) ? ctx : undefined)
  const sessionOf = vi.fn((owner: Context) => owner === ctx ? session : undefined)
  const retain = vi.fn((target: string) => {
    const resolved = binding(target)
    retainedIds.set(target, (retainedIds.get(target) ?? 0) + 1)
    let active = true
    const release = vi.fn(() => {
      if (!active) return
      active = false
      const count = retainedIds.get(target)! - 1
      if (count === 0) retainedIds.delete(target)
      else retainedIds.set(target, count)
    })
    return {
      sessionId: target,
      binding: resolved,
      ready: Promise.resolve(resolved),
      release,
      [Symbol.dispose]: release,
    } as unknown as SessionReference
  })
  const using = vi.fn(async (
    target: string,
    _options: unknown,
    operation: (reference: SessionReference) => unknown,
  ) => await operation(retain(target)))
  const fork = vi.fn<ISessions['fork']>(async () => sid('forked'))
  const pinSession = vi.fn(async () => undefined)
  const unpinSession = vi.fn(async () => undefined)
  // The Host snapshots the injected hooks derive from and a pin's order write
  // reads at completion; a test replaces them whole, so an unchanged snapshot
  // keeps its identity between reads.
  let workspaceSnapshot = workspaceState([])
  let sessionSnapshot = sessionState([])
  const subscribe = () => () => {}
  const workspacesSubscribe = vi.fn(subscribe)
  const initializeDefault = vi.fn(async (): Promise<WorkspaceView | undefined> => undefined)
  ctx.provide('workspaces', {
    list: { getSnapshot: () => workspaceSnapshot, subscribe: workspacesSubscribe },
    create,
    initializeDefault,
    rename,
    delete: vi.fn(async () => undefined),
    insertBefore: vi.fn(async () => undefined),
    archiveSession: vi.fn(async () => undefined),
    unarchiveSession: vi.fn(async () => undefined),
    forgetSession: vi.fn(async () => undefined),
    pinSession,
    unpinSession,
    insertSessionBefore: vi.fn(async () => ({})),
  } as never)
  ctx.provide('sessions', {
    list: { getSnapshot: () => sessionSnapshot, subscribe },
    create: vi.fn(async () => 'created' as never),
    retain,
    using,
    search,
    searchResultLimit: 20,
    binding,
    scope,
    sessionOf,
    subagentAddress: vi.fn(() => undefined),
    refreshProjections: vi.fn(() => Promise.resolve()),
    fork,
  } as never)
  const pickDirectory = vi.fn(() => Promise.resolve({ ok: true as const, value: '/projects/picked' }))
  const directoryPicker = { pick: pickDirectory }
  Object.assign(new TestRemote(ctx), { directoryPicker })
  ctx.provide('remote.directoryPicker', directoryPicker as never)
  const locale = new LocaleRuntime(ctx)
  // These specs assert the shipped Chinese copy. There is no jsdom `window`
  // in this lane, so browser-language detection never runs and the locale
  // comes from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, create, rename, commands, accessSource, whenResourceAccess, stopGuard,
    retain, using, selectPanel, search, renameSession, binding, fork, pickDirectory, pinSession, unpinSession,
    workspacesSubscribe, initializeDefault, history, scope, sessionOf,
    setWorkspaces: (snapshot: WorkspaceSnapshot): void => { workspaceSnapshot = snapshot },
    setSessions: (snapshot: SessionListState): void => { sessionSnapshot = snapshot },
  }
}

type HoleName = 'sidebar.workspaces' | 'conversation.hero.workspace' | 'conversation.empty.workspace' | 'shell.overlay'

const MENU_ITEM = 'sidebar.workspaces.session.menu.item'
const ROW_ACTION = 'sidebar.workspaces.session.row.action'
type RowListName = typeof MENU_ITEM | typeof ROW_ACTION | 'shell.overlay'

/** Declare any subset of the holes with a single root registration ('root' is a single slot); the overlay is a list. */
function declare(slots: SlotRegistry, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [
    name, { kind: name === 'shell.overlay' ? 'list' : 'single', scope: 'root' },
  ]))
  return slots.register({ name: 'root', children } as never, () => null)
}

/** Own the sidebar declaration independently of the frame-wide overlay in lifecycle tests. */
function SidebarDeclarationOwner({ renderSlot }: PropsRenderSlots<'sidebar.workspaces'>) {
  return renderSlot('sidebar.workspaces', {})
}

/** The one entry registered under `id` in a list. */
function entry(slots: SlotRegistry, key: RowListName, id: string): StoredEntry {
  const found = slots.entries(key).find(candidate => candidate.options.id === id)
  if (found === undefined) throw new Error(`no ${key} entry ${id}`)
  return found
}

/** An entry's injected face; the shipped factories ignore the positional store actions. */
function faceOf(registration: StoredEntry): object {
  if (registration.inject === undefined) throw new Error(`entry ${String(registration.options.id)} declares no inject face`)
  return registration.inject()
}

/** The viewing-store instance the browser's declared handle hands the renderer. */
function viewInstance(slots: SlotRegistry) {
  const browser = slots.entries('sidebar.workspaces')[0]!
  if (browser.store === undefined) throw new Error('the browser entry declares no viewing store')
  return (browser.store as WorkspaceViewStoreHandle).create()
}

/** Let the injected callbacks' Host-call chains settle: one macrotask drains every pending microtask. */
const settled = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('ui-workspace apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it drives', () => {
    expect(inject).toEqual([
      'slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.directoryPicker', 'layout', 'shortcuts', 'remoteAccess',
    ])
  })

  it('publishes the Workspace access Hook over the remoteAccess service', async () => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    const provideRoot = vi.spyOn(b.slots, 'provideRoot')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const keyed = provideRoot.mock.calls.map(([contribution]) => contribution.keyedHooks?.['workspaceAccess']).find(Boolean)
    // `useWorkspaceAccess(workspaceId, action)` reads the Workspace resource's answer; a call without an action names no source.
    expect(keyed?.('w1', 'workspace/follow')).toBe(ALLOWED)
    expect(b.accessSource).toHaveBeenCalledWith('workspace', 'w1', 'workspace/follow')
    expect(keyed?.('w1')).toBeUndefined()
    // `whenAccess` follows the same Workspace resource through the service's resource form.
    const guarded = vi.fn(() => () => {})
    expect(b.ctx.uiWorkspace.whenAccess('w1' as WorkspaceId, 'workspace/follow', guarded)).toBe(b.stopGuard)
    expect(b.whenResourceAccess).toHaveBeenCalledWith('workspace', 'w1', 'workspace/follow', guarded)
  })

  it('hangs Workspace-guarded effects on the calling plugin, so they leave when it unloads', async () => {
    const b = await bench('static')
    onTestFinished(() => b.ctx.fiber.dispose())
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const dispose = vi.fn()
    const caller = b.ctx.plugin({
      inject: ['uiWorkspace'],
      apply: (callerCtx: Context) => { callerCtx.uiWorkspace.whenAccess('w1' as WorkspaceId, 'workspace/follow', () => dispose) },
    })
    await caller.await()
    expect(dispose).not.toHaveBeenCalled()
    await caller.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reports a default Workspace creation failure through the shared notice overlay', async () => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    b.initializeDefault.mockRejectedValueOnce(new Error('denied'))
    declare(b.slots, 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    await vi.waitFor(() => {
      expect(face.hooks.toast.getSnapshot()).toMatchObject({ kind: 'defaultWorkspaceFailed' })
    })
    face.dismissToast()
    expect(face.hooks.toast.getSnapshot()).toBeNull()
  })

  it('registers browser and pickers for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.workspaces')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.workspaces')[0]!.component).toBe(WorkspaceBrowser)
    // Copy rides the standard locale seat: the entry declares the namespace
    // and apply registered both dictionaries.
    expect(before.slots.entries('sidebar.workspaces')[0]!.locale).toBe('workspace')
    expect(before.locale.bind('workspace')('session.new')).toBe('新会话')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'sidebar.workspaces', 'conversation.hero.workspace', 'conversation.empty.workspace', 'shell.overlay')
    await Promise.resolve()
    expect(after.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
    // The row actions follow the browser's own declaration, whenever it lands.
    expect(after.slots.entries(MENU_ITEM)).toHaveLength(4)
    expect(after.slots.entries(ROW_ACTION)).toHaveLength(0)
    expect(after.slots.entries('shell.overlay')).toHaveLength(4)
  })

  it('declares the two Session row lists and registers the shipped actions and overlay surfaces into them', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // The menu list binds the row's open state into every entry's hook; the
    // hover-button list carries no common face.
    expect(b.slots.spec(MENU_ITEM)).toEqual({
      kind: 'list', scope: 'root', inject: { hooks: { menuOpenState: menuOpenStateFactory, shortcuts: b.ctx.shortcuts.catalog } },
    })
    expect(b.slots.spec(ROW_ACTION)).toEqual({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('sidebar.session.row.trailing')).toEqual({ kind: 'list', scope: 'root', inline: true })
    expect(b.slots.spec('sidebar.session.row.leading')).toEqual({ kind: 'list', scope: 'root', inline: true })

    const rows = (key: RowListName) => b.slots.entries(key)
      .map(registration => [registration.options.id, registration.options.order, registration.component, registration.locale])
    expect(rows(MENU_ITEM)).toEqual([
      ['pin', 100, PinSessionMenuItem, 'workspace'],
      ['rename', 200, RenameSessionMenuItem, 'workspace'],
      ['delete', 400, DeleteSessionMenuItem, 'workspace'],
      ['session-id', 450, SessionIdMenuItem, 'workspace'],
    ])
    expect(rows(ROW_ACTION)).toEqual([])
    expect(rows('shell.overlay')).toEqual([
      ['workspace.session-rename', undefined, SessionRenameDialog, 'workspace'],
      ['workspace.session-delete', undefined, SessionDeleteConfirmDialog, 'workspace'],
      ['workspace.session-trash', undefined, SessionTrashDialog, 'workspace'],
      ['workspace.row-toast', undefined, RowActionToast, undefined],
    ])
    const browser = b.slots.entries('sidebar.workspaces')[0]!
    expect(browser.store).toBeDefined()
    expect(viewInstance(b.slots)).toBe(viewInstance(b.slots))
    const rowToastEntry = entry(b.slots, 'shell.overlay', 'workspace.row-toast')
    expect(rowToastEntry.store).toBeUndefined()
    expect(b.slots.entries('workspace.toast').map(row => row.options.key)).toEqual([
      'sessionIdCopied', 'sessionIdCopyFailed', 'pinFailed', 'unpinFailed', 'deleteFailed',
      'defaultWorkspaceFailed', 'shortcutForkFailed', 'createFailed', 'forkRequiresOpen',
    ])
    for (const registration of b.slots.entries('workspace.toast')) {
      expect(registration.locale).toBe('workspace')
      expect(registration.store).toBeUndefined()
    }
    for (const registration of [...b.slots.entries(MENU_ITEM), ...b.slots.entries(ROW_ACTION), ...b.slots.entries('shell.overlay')]) {
      if (registration === rowToastEntry) continue
      expect(registration.store).toBeUndefined()
    }
    // Each share raises its own notices inside its callbacks. The row hover
    // buttons are gone, so only the menu entry carries the share.
    for (const id of ['pin', 'delete']) {
      expect(faceOf(entry(b.slots, MENU_ITEM, id))).not.toHaveProperty('notify')
    }
  })

  it.each([true, false])('copies an ID directly without loading its Session (clipboard accepted: %s)', async (accepted) => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const action = faceOf(entry(b.slots, MENU_ITEM, 'session-id')) as SessionIdInjected
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const writeText = vi.fn(async () => {
      if (!accepted) throw new Error('clipboard denied')
    })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    onTestFinished(() => { vi.unstubAllGlobals() })
    await action.copySessionId(sid('cold-session'))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('cold-session')
    expect(toast.hooks.toast.getSnapshot()).toMatchObject({ kind: accepted ? 'sessionIdCopied' : 'sessionIdCopyFailed' })
    expect(b.retain).not.toHaveBeenCalled()
    expect(b.using).not.toHaveBeenCalled()
    expect(b.binding).not.toHaveBeenCalled()
  })

  it('publishes shortcut fork failures through the same latest-notice source as row actions', async () => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    declare(b.slots, 'shell.overlay')
    const removeBrowser = b.slots.register({
      name: 'shell.overlay', id: 'test-sidebar-owner',
      children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } },
    }, SidebarDeclarationOwner)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.setSessions(sessionState([{ ...summary('source', 1), retainedBy: { mainView: 1 } }]))
    const browser = faceOf(b.slots.entries('sidebar.workspaces')[0]!) as WorkspaceBrowserInjected
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warning.mockRestore() })
    const invoke = () => {
      const resolution = b.commands.get('session.fork')!.resolve({ region: 'page', modal: null, target: null })
      if (resolution.status !== 'handled') throw new Error('the source must be available')
      resolution.run()
    }

    // Some earlier notice is on display; a shortcut failure replaces it.
    const pin = faceOf(entry(b.slots, MENU_ITEM, 'pin')) as PinSessionInjected
    const pinFailure = b.pinSession.mockRejectedValueOnce(new Error('pin exploded'))
    pin.pinSession(sid('source'))
    await vi.waitFor(() => { expect(toast.hooks.toast.getSnapshot()).toMatchObject({ kind: 'pinFailed' }) })
    expect(pinFailure).toHaveBeenCalledWith(sid('source'))
    warning.mockClear()
    b.fork.mockRejectedValueOnce(new SessionForkError(
      new RemoteError('session/fork-unavailable', 'no completed turn', { sessionId: sid('source') }), sid('source'),
    ))
    invoke()
    await vi.waitFor(() => {
      expect(toast.hooks.toast.getSnapshot()).toMatchObject({ kind: 'shortcutForkFailed', reason: 'unavailable' })
    })
    expect(b.fork).toHaveBeenCalledExactlyOnceWith({ sessionId: sid('source'), increaseTitle: true })
    expect(warning).not.toHaveBeenCalled()
    const unavailable = toast.hooks.toast.getSnapshot()
    b.fork.mockRejectedValueOnce(new Error('connection closed'))
    invoke()
    await vi.waitFor(() => {
      expect(toast.hooks.toast.getSnapshot()).toMatchObject({ kind: 'shortcutForkFailed', reason: 'failed' })
    })
    expect(toast.hooks.toast.getSnapshot()).not.toBe(unavailable)
    expect(warning).toHaveBeenCalledExactlyOnceWith('session fork rejected:', expect.any(Error))
    const failure = toast.hooks.toast.getSnapshot()
    removeBrowser()
    expect(b.slots.entries('sidebar.workspaces')).toEqual([])
    expect(entry(b.slots, 'shell.overlay', 'workspace.row-toast').component).toBe(RowActionToast)
    expect(toast.hooks.toast.getSnapshot()).toBe(failure)
    const secondPinFailure = b.pinSession.mockRejectedValueOnce(new Error('pin exploded again'))
    pin.pinSession(sid('source'))
    await vi.waitFor(() => { expect(toast.hooks.toast.getSnapshot()).toMatchObject({ kind: 'pinFailed' }) })
    expect(secondPinFailure).toHaveBeenCalledWith(sid('source'))
    toast.dismissToast()
    expect(toast.hooks.toast.getSnapshot()).toBeNull()
    expect(browser).not.toHaveProperty('dismissForkError')
  })

  it('derives the pinned and archived Sets from the Workspace snapshot, rebuilt only when it changes', async () => {
    const b = await bench()
    b.setWorkspaces(workspaceState([workspace('alpha', ['one', 'two'])], [sid('two')], [sid('one')]))
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const pin = faceOf(entry(b.slots, MENU_ITEM, 'pin')) as PinSessionInjected
    const pinButton = faceOf(entry(b.slots, MENU_ITEM, 'pin')) as PinSessionInjected
    const pinned = pin.hooks.pinned.getSnapshot()
    const archived = pin.hooks.archived.getSnapshot()
    expect(pinned).toEqual(new Set(['one']))
    expect(archived).toEqual(new Set(['two']))
    // One source per set, shared by every entry and held while the snapshot stands.
    expect(pin.hooks.pinned.getSnapshot()).toBe(pinned)
    expect(pinButton.hooks.pinned.getSnapshot()).toBe(pinned)
    // Subscriptions ride the Workspace Controller's list source.
    const listener = vi.fn()
    const unsubscribe = pin.hooks.pinned.subscribe(listener)
    expect(b.workspacesSubscribe).toHaveBeenCalledWith(listener)
    unsubscribe()

    b.setWorkspaces(workspaceState([workspace('alpha', ['one', 'two'])], [], [sid('one'), sid('two')]))
    expect(pin.hooks.pinned.getSnapshot()).toEqual(new Set(['one', 'two']))
    expect(pin.hooks.pinned.getSnapshot()).not.toBe(pinned)
    expect(pin.hooks.archived.getSnapshot()).toEqual(new Set())
  })

  it('pins through the navigation service, which fronts the Session in its group and the flat list of the browser view', async () => {
    const b = await bench()
    b.setWorkspaces(workspaceState([workspace('alpha', ['one', 'two', 'three'])]))
    b.setSessions(sessionState([summary('one', 3), summary('two', 2), summary('three', 1)]))
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const view = viewInstance(b.slots)
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    expect(view.getSnapshot().sessionOrderByAccount).toEqual({})

    const pin = faceOf(entry(b.slots, MENU_ITEM, 'pin')) as PinSessionInjected
    pin.pinSession(sid('three'))
    expect(b.pinSession).toHaveBeenCalledWith('three')
    await vi.waitFor(() => {
      expect(view.getSnapshot().sessionOrderByAccount).toEqual({
        alpha: ['three', 'one', 'two'],
        [UNGROUPED_KEY]: [],
        [FLAT_SESSION_ORDER_KEY]: ['three', 'one', 'two'],
      })
    })
    // The saved positions lead without leaving Last updated, and a successful pin raises no notice.
    expect(view.getSnapshot().orderBy).toBe('updated')
    expect(toast.hooks.toast.getSnapshot()).toBeNull()

    // The hover button's face is the same behavior.
    const pinButton = faceOf(entry(b.slots, MENU_ITEM, 'pin')) as PinSessionInjected
    pinButton.pinSession(sid('one'))
    expect(b.pinSession).toHaveBeenLastCalledWith('one')
    await vi.waitFor(() => {
      expect(view.getSnapshot().sessionOrderByAccount.alpha).toEqual(['one', 'three', 'two'])
    })

    // Unpin leaves the saved orders as they are.
    const before = view.getSnapshot().sessionOrderByAccount
    pin.unpinSession(sid('one'))
    expect(b.unpinSession).toHaveBeenCalledWith('one')
    await settled()
    expect(view.getSnapshot().sessionOrderByAccount).toBe(before)
    expect(toast.hooks.toast.getSnapshot()).toBeNull()
  })

  it('raises the pin and unpin failure notices and writes no order', async () => {
    const b = await bench()
    b.setWorkspaces(workspaceState([workspace('alpha', ['one'])]))
    b.setSessions(sessionState([summary('one', 1)]))
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const view = viewInstance(b.slots)
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const pin = faceOf(entry(b.slots, MENU_ITEM, 'pin')) as PinSessionInjected

    b.pinSession.mockRejectedValueOnce(new Error('pin wire down'))
    pin.pinSession(sid('one'))
    await vi.waitFor(() => { expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'pinFailed', seq: 1 }) })
    b.unpinSession.mockRejectedValueOnce(new Error('unpin wire down'))
    pin.unpinSession(sid('one'))
    await vi.waitFor(() => { expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'unpinFailed', seq: 2 }) })
    expect(view.getSnapshot().sessionOrderByAccount).toEqual({})
  })

  it('asks before deleting: the click raises the confirmation and the Host is untouched', async () => {
    const b = await bench()
    b.setSessions(sessionState([{ ...summary('one', 2), displayTitle: 'First session' }]))
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const archiveSession = vi.spyOn(b.ctx.uiWorkspace, 'archiveSession')
    const confirm = faceOf(entry(b.slots, 'shell.overlay', 'workspace.session-delete')) as SessionDeleteConfirmInjected
    const remove = faceOf(entry(b.slots, MENU_ITEM, 'delete')) as DeleteSessionInjected

    expect(confirm.hooks.deleteRequest.getSnapshot()).toBeNull()
    remove.deleteSession(sid('one'))
    // The request names the row so the dialog can ask about it, and reports no
    // running work: the client never probes, the confirm hop stops it instead.
    expect(confirm.hooks.deleteRequest.getSnapshot()).toEqual({
      sessionId: 'one', displayTitle: 'First session', activity: [],
    })
    // The menu row's face is the same behavior, and still nothing is gone.
    const removeRow = faceOf(entry(b.slots, MENU_ITEM, 'delete')) as DeleteSessionInjected
    removeRow.deleteSession(sid('one'))
    expect(confirm.hooks.deleteRequest.getSnapshot()).toEqual({
      sessionId: 'one', displayTitle: 'First session', activity: [],
    })
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('deletes with stopActivity only once confirmed, and settles the request either way', async () => {
    const b = await bench()
    b.setSessions(sessionState([{ ...summary('busy', 3), displayTitle: 'Busy session' }]))
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const archiveSession = vi.spyOn(b.ctx.uiWorkspace, 'archiveSession').mockResolvedValue(undefined)
    const remove = faceOf(entry(b.slots, MENU_ITEM, 'delete')) as DeleteSessionInjected
    const confirm = faceOf(entry(b.slots, 'shell.overlay', 'workspace.session-delete')) as SessionDeleteConfirmInjected

    remove.deleteSession(sid('busy'))
    expect(confirm.hooks.deleteRequest.getSnapshot()).toEqual({
      sessionId: 'busy', displayTitle: 'Busy session', activity: [],
    })
    // Cancelling settles the request and leaves the Host alone.
    confirm.settleSessionDelete()
    expect(confirm.hooks.deleteRequest.getSnapshot()).toBeNull()
    expect(archiveSession).not.toHaveBeenCalled()

    // Confirming stops whatever runs first: a quiet Session simply has nothing
    // to stop, so one hop covers both shapes.
    remove.deleteSession(sid('busy'))
    await confirm.stopAndDeleteSession(sid('busy'))
    expect(archiveSession).toHaveBeenCalledExactlyOnceWith('busy', { stopActivity: true })
  })

  it('lists what was deleted in the trash and restores one through the navigation service', async () => {
    const b = await bench()
    // Archiving keeps the Workspace slot, so the fixture has to as well: the
    // deleted list only lists archived ids that a Workspace still accounts for.
    b.setWorkspaces(workspaceState([
      {
        workspaceId: 'ws-one' as never,
        path: '/projects/one',
        title: 'one',
        sessionIds: [sid('two'), sid('three')],
        createdAt: '0',
        updatedAt: '0',
      },
    ], [sid('two'), sid('three')], []))
    b.setSessions(sessionState([
      { ...summary('two', 2), displayTitle: 'Second session' },
      summary('three', 1),
    ]))
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const trash = faceOf(entry(b.slots, 'shell.overlay', 'workspace.session-trash')) as SessionTrashInjected

    expect(trash.hooks.open.getSnapshot()).toBe(false)
    // Titles come from the Session list, so a row reads like the row it was; a
    // Session the list has not described yet falls back to its id. Each row
    // carries the time the list reports, and the newest row leads.
    expect(trash.hooks.rows.getSnapshot()).toEqual([
      { sessionId: 'two', displayTitle: 'Second session', updatedAt: 2 },
      { sessionId: 'three', displayTitle: 'three', updatedAt: 1 },
    ])
    // The projection is identity-stable while both sources stand: a fresh
    // array per read would spin the dialog's store.
    expect(trash.hooks.rows.getSnapshot()).toBe(trash.hooks.rows.getSnapshot())

    trash.openTrash()
    expect(trash.hooks.open.getSnapshot()).toBe(true)
    const unarchiveSession = vi.spyOn(b.ctx.uiWorkspace, 'unarchiveSession')
    await trash.restoreSession(sid('two'))
    expect(unarchiveSession).toHaveBeenCalledWith('two')
    trash.closeTrash()
    expect(trash.hooks.open.getSnapshot()).toBe(false)

    // 删除记录 is a registry forget, not a filesystem move: every id goes through
    // `forgetSession`, which detaches the Workspace slot (so the row leaves this
    // list) while keeping the archive flag (so the sidebar keeps hiding it).
    const forgetSession = vi.spyOn(b.ctx.uiWorkspace, 'forgetSession')
    await trash.purgeSessions([sid('two'), sid('three')])
    expect(forgetSession).toHaveBeenCalledWith('two')
    expect(forgetSession).toHaveBeenCalledWith('three')
  })

  it('the notice share takes a failure notice down and notifies its subscribers', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const pinSession = b.pinSession.mockRejectedValueOnce(new Error('denied'))
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const pin = faceOf(entry(b.slots, MENU_ITEM, 'pin')) as PinSessionInjected

    expect(toast.hooks.toast.getSnapshot()).toBeNull()
    const noticed = vi.fn()
    const unsubscribe = toast.hooks.toast.subscribe(noticed)
    pin.pinSession(sid('one'))
    await vi.waitFor(() => {
      expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'pinFailed', seq: 1 })
    })
    expect(pinSession).toHaveBeenCalledWith('one')
    expect(noticed).toHaveBeenCalledOnce()
    toast.dismissToast()
    expect(toast.hooks.toast.getSnapshot()).toBeNull()
    unsubscribe()
  })

  it('routes fork and rename through their shares, the rename dialog, and the browser face', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    // Fork goes through the navigation service, which leaves the child unselected.
    const forkSession = vi.spyOn(b.ctx.uiWorkspace, 'forkSession')
    const fork = forkFace(b, null as never)
    using source = b.ctx.sessions.retain(sid('session'), { source: 'controllerOperation' })
    await source.ready
    b.retain.mockClear()
    fork.forkSession('session' as never)
    await forkSession.mock.results[0]!.value
    const [request] = b.fork.mock.calls[0]!
    const { onCreated, ...payload } = request
    expect(payload).toEqual({ sessionId: 'session', increaseTitle: true, allowMigration: false })
    expect(onCreated).toBeTypeOf('function')
    expect(b.retain).not.toHaveBeenCalled()
    expect(b.selectPanel).not.toHaveBeenCalled()

    // The rename row raises the request the dialog entry reads; settling clears it.
    const rename = faceOf(entry(b.slots, MENU_ITEM, 'rename')) as RenameSessionInjected
    const dialog = faceOf(entry(b.slots, 'shell.overlay', 'workspace.session-rename')) as SessionRenameDialogInjected
    expect(dialog.hooks.renameRequest.getSnapshot()).toBeNull()
    const requested = vi.fn()
    const unsubscribeRequest = dialog.hooks.renameRequest.subscribe(requested)
    rename.requestSessionRename('session' as never, 'Old title')
    expect(dialog.hooks.renameRequest.getSnapshot()).toEqual({ sessionId: 'session', currentTitle: 'Old title' })
    expect(requested).toHaveBeenCalled()
    unsubscribeRequest()
    dialog.settleSessionRename()
    expect(dialog.hooks.renameRequest.getSnapshot()).toBeNull()
    // The dialog's rename hop reaches the Session face and rethrows a business error.
    await dialog.renameSession('session' as never, 'renamed session')
    expect(b.using).toHaveBeenCalledWith('session', { source: 'workspaceOperation' }, expect.any(Function))
    expect(b.renameSession).toHaveBeenCalledWith('renamed session')
    b.renameSession.mockResolvedValueOnce({
      ok: false, error: new RemoteError('gateway/internal', 'title write failed', {}),
    } as never)
    await expect(dialog.renameSession('session' as never, 'again')).rejects.toThrow('title write failed')

    // The browser raises the same rename request from a title double-click and
    // carries none of the row verbs itself; deleting is the one it does carry.
    const browser = faceOf(b.slots.entries('sidebar.workspaces')[0]!) as WorkspaceBrowserInjected
    browser.requestSessionRename('session' as never, 'Row title')
    expect(dialog.hooks.renameRequest.getSnapshot()).toEqual({ sessionId: 'session', currentTitle: 'Row title' })
    for (const verb of ['forkSession', 'archiveSession', 'pinSession', 'unpinSession', 'renameSession']) {
      expect(browser).not.toHaveProperty(verb)
    }
  })

  it.each(['absent', 'cold', 'loading', 'error', 'closed'] as const)(
    'forks a %s source without opening it locally', async (state) => {
      const b = await bench()
      onTestFinished(() => b.ctx.fiber.dispose())
      declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      if (state !== 'absent') {
        const source = b.ctx.sessions.retain(sid('source'), { source: 'controllerOperation' })
        onTestFinished(() => { source.release() })
        await source.ready
        b.history.set({ openState: state === 'closed' ? 'open' : state, subagent: null })
        if (state === 'closed') source.release()
      }
      b.retain.mockClear()
      const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
      const fork = forkFace(b, toast)

      expect(() => { fork.forkSession(sid('source')) }).not.toThrow()
      await vi.waitFor(() => { expect(b.fork).toHaveBeenCalledOnce() })

      const [request] = b.fork.mock.calls[0]!
      const { onCreated, ...payload } = request
      expect(payload).toEqual({ sessionId: 'source', increaseTitle: true, allowMigration: false })
      expect(onCreated).toBeTypeOf('function')
      expect(toast.hooks.toast.getSnapshot()).toBeNull()
      expect(b.retain).not.toHaveBeenCalled()
      expect(b.selectPanel).not.toHaveBeenCalled()
    },
  )

  it('offers to open a source only after the Host refuses migration and never retries the fork', async () => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.fork.mockRejectedValueOnce(new SessionForkError(
      new RemoteError('session/migration-required', 'migration required', { sessionId: sid('source') }),
      sid('source'),
    ))
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const fork = forkFace(b, toast)

    fork.forkSession(sid('source'))
    await vi.waitFor(() => {
      expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'forkRequiresOpen', sessionId: 'source', seq: 1 })
    })

    expect(b.fork).toHaveBeenCalledOnce()
    expect(b.retain).not.toHaveBeenCalled()
    expect(b.selectPanel).not.toHaveBeenCalled()
    toast.dismissToast()
    ;(faceOf(b.slots.entries('workspace.toast').find(row => row.options.key === 'forkRequiresOpen')!) as ToastDisplayInjected<'forkRequiresOpen'>)
      .display({ kind: 'forkRequiresOpen', sessionId: sid('source'), seq: 1 }, b.locale.bind('workspace'), toast.dismissToast).actions![0]!.onClick()
    expect(b.retain).toHaveBeenCalledExactlyOnceWith('source', { source: 'mainView' })
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(null)
    expect(b.fork).toHaveBeenCalledOnce()
  })

  it('opens the fork source from its Toast action and takes the notice down', async () => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    b.setSessions(sessionState([summary('source', 1)]))
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const openSession = vi.spyOn(b.ctx.uiWorkspace, 'openSession').mockResolvedValue(undefined)
    b.fork.mockRejectedValueOnce(new SessionForkError(
      new RemoteError('session/migration-required', 'migration required', { sessionId: sid('source') }),
      sid('source'),
    ))
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const fork = forkFace(b, toast)
    fork.forkSession(sid('source'))
    await vi.waitFor(() => {
      expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'forkRequiresOpen', sessionId: 'source', seq: 1 })
    })

    ;(faceOf(b.slots.entries('workspace.toast').find(row => row.options.key === 'forkRequiresOpen')!) as ToastDisplayInjected<'forkRequiresOpen'>)
      .display({ kind: 'forkRequiresOpen', sessionId: sid('source'), seq: 1 }, b.locale.bind('workspace'), toast.dismissToast).actions![0]!.onClick()

    expect(openSession).toHaveBeenCalledExactlyOnceWith('source')
    expect(toast.hooks.toast.getSnapshot()).toBeNull()
    // Opening the source does not retry the fork, locally or on the Host.
    expect(b.fork).toHaveBeenCalledOnce()
    expect(b.retain).not.toHaveBeenCalled()
    expect(b.selectPanel).not.toHaveBeenCalled()
  })

  it('forks opened read-only subagent history without selecting its child', async () => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    using source = b.ctx.sessions.retain(sid('source'), { source: 'controllerOperation' })
    await source.ready
    b.history.set({ openState: 'open', subagent: {
      address: { parentSessionId: sid('parent'), childSessionId: sid('source'), mode: 'one-shot' },
    } })
    b.retain.mockClear()
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const fork = forkFace(b, toast)

    fork.forkSession(sid('source'))
    await vi.waitFor(() => { expect(b.fork).toHaveBeenCalledOnce() })

    const [request] = b.fork.mock.calls[0]!
    const { onCreated, ...payload } = request
    expect(payload).toEqual({ sessionId: 'source', increaseTitle: true, allowMigration: false })
    expect(onCreated).toBeTypeOf('function')
    expect(toast.hooks.toast.getSnapshot()).toBeNull()
    expect(b.retain).not.toHaveBeenCalled()
    expect(b.selectPanel).not.toHaveBeenCalled()
  })

  it.each(['ordinary', 'other-remote', 'unwrapped-migration'] as const)('keeps a fork failure silent after rejection (%s)', async (kind) => {
    const b = await bench()
    onTestFinished(() => b.ctx.fiber.dispose())
    declare(b.slots, 'sidebar.workspaces', 'shell.overlay')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    using source = b.ctx.sessions.retain(sid('source'), { source: 'controllerOperation' })
    await source.ready
    b.retain.mockClear()
    const error = kind === 'ordinary'
      ? new Error('fork failed')
      : kind === 'other-remote'
        ? new SessionForkError(
          new RemoteError('session/fork-unavailable', 'no completed turn', { sessionId: sid('source') }),
          sid('source'),
        )
        : new RemoteError('session/migration-required', 'migration required', { sessionId: sid('source') })
    b.fork.mockRejectedValueOnce(error)
    const forkSession = vi.spyOn(b.ctx.uiWorkspace, 'forkSession')
    const toast = faceOf(entry(b.slots, 'shell.overlay', 'workspace.row-toast')) as RowToastInjected
    const fork = forkFace(b, toast)

    fork.forkSession(sid('source'))
    expect(forkSession).toHaveBeenCalledOnce()
    await expect(forkSession.mock.results[0]!.value).rejects.toBe(error)

    expect(toast.hooks.toast.getSnapshot()).toBeNull()
    expect(b.fork).toHaveBeenCalledOnce()
    expect(b.retain).not.toHaveBeenCalled()
    expect(b.selectPanel).not.toHaveBeenCalled()
  })

  it('routes browser actions and picker creation to the services', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const startSession = vi.spyOn(b.ctx.uiWorkspace, 'startSession').mockImplementation(() => undefined)

    const browser = faceOf(b.slots.entries('sidebar.workspaces')[0]!) as WorkspaceBrowserInjected
    // The browser share delegates to the shared Session navigation action.
    browser.startSession('ws' as never)
    expect(startSession).toHaveBeenLastCalledWith('ws', undefined)
    browser.startSession()
    expect(startSession).toHaveBeenLastCalledWith(undefined, undefined)
    browser.startSession(undefined, { clearPreviousDraft: false })
    expect(startSession).toHaveBeenLastCalledWith(undefined, { clearPreviousDraft: false })
    browser.open('session' as never)
    expect(b.retain).toHaveBeenCalledWith('session', { source: 'mainView' })
    const signal = new AbortController().signal
    await expect(browser.searchSessions('match', signal)).resolves.toEqual({
      items: [{ sessionId: 'session', snippet: 'match' }],
      hasMore: false,
    })
    expect(b.search).toHaveBeenCalledWith('match', signal)
    expect(browser.searchResultLimit).toBe(20)
    await browser.renameWorkspace('ws' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('ws', 'renamed')
    await browser.createWorkspace({ path: '/tmp/browser-project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/browser-project' })

    const picker = faceOf(b.slots.entries('conversation.hero.workspace')[0]!) as WorkspacePickerInjected
    await picker.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/project' })
  })

  it('declares the browser child slots and reports directory-flow occupancy per surface', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Registration declared the child holes (declaration = render authorization).
    expect(b.slots.spec('sidebar.workspaces.directoryFlow')).toMatchObject({ kind: 'single' })
    expect(b.slots.spec('conversation.hero.workspace.directoryFlow')).toMatchObject({ kind: 'single' })

    const browser = faceOf(b.slots.entries('sidebar.workspaces')[0]!) as WorkspaceBrowserInjected
    const picker = faceOf(b.slots.entries('conversation.hero.workspace')[0]!) as WorkspacePickerInjected
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    expect(browser.hooks.hostInfo.getSnapshot()).toMatchObject({ home: undefined })
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    // A flow occupant flips exactly its own surface, and the source notifies.
    const notified = vi.fn()
    const unsubscribe = browser.hooks.directoryFlow.subscribe(notified)
    const dispose = b.slots.register({ name: 'sidebar.workspaces.directoryFlow' } as never, () => null)
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(true)
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    await Promise.resolve()
    expect(notified).toHaveBeenCalled()
    dispose()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    unsubscribe()
  })

  it('rejects the browser search callback on a Session Controller business error', async () => {
    const b = await bench()
    b.search.mockImplementationOnce(async () => ({
      ok: false,
      error: new RemoteError('gateway/internal', 'index unavailable', {}),
    }) as never)
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const browser = faceOf(b.slots.entries('sidebar.workspaces')[0]!) as WorkspaceBrowserInjected
    await expect(browser.searchSessions('needle', new AbortController().signal))
      .rejects.toThrow('index unavailable')
  })

  it('unregisters every entry on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace', 'conversation.empty.workspace', 'shell.overlay')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(MENU_ITEM)).toHaveLength(4)
    expect(b.slots.entries(ROW_ACTION)).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(4)
    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
    // The row lists collapse with the browser declaration; the overlay list
    // (declared by the shell) keeps no ui-workspace entry behind.
    expect(b.slots.spec(MENU_ITEM)).toBeUndefined()
    expect(b.slots.entries(MENU_ITEM)).toHaveLength(0)
    expect(b.slots.entries(ROW_ACTION)).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('workspace.toast')).toHaveLength(0)
    expect(b.slots.snapshot('factory:workspace.toast.content')).toEqual([])
  })
})
