/**
 * Workspace plugin, browser half. Two registrations: WorkspaceBrowser fills
 * the sidebar shell's `sidebar.workspaces` hole (the whole browsing region),
 * and WorkspacePicker fills the conversation hero's picker hole
 * (`conversation.hero.workspace` — both hero forms). Both read real Host
 * Workspaces through the global useWorkspaces hook, and each declares its
 * own `single` directory-flow child hole for the composed picker package's
 * client half. WorkspaceBrowser additionally declares the two Session row
 * action lists, and this apply registers the shipped actions — pin, rename,
 * archive, copy ID — into them the way any client plugin would, each
 * with its own behavior, plus the dialogs and the row-action notice into
 * `shell.overlay` (see the contract module doc). It also declares two
 * Session-row seats: the leading decoration a row renders only while its own
 * primary state is idle, and the section the row's hover card renders between
 * its relative time and its trailing status line. Export discipline:
 * packages/client/AGENTS.md.
 */
import type {} from '@ntars/ondra-client-product-analytics/client'
import type { Context } from '@ntars/cordis'
import type { RemoteHostFacts } from '@ntars/ondra-api-remotes/client'
import type { ISessions } from '@ntars/ondra-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot,
} from '@ntars/ondra-api-workspace-controller/client'
import type { RemoteEndpoint } from '@ntars/ondra-api-remote-access/client'
import { createSnapshotStore } from '@ntars/ondra-client-store'
import { writeClipboard } from '@ntars/ondra-client-ui-primitives'
import type { HostObservable, SnapshotSelectorHook } from '@ntars/ondra-client-ui-slots'
import type { SessionId } from '@ntars/ondra-session/types'
// Type-only: pulls the Controller service merges.
import type {} from '@ntars/ondra-api-session-controller/client'
import type {} from '@ntars/ondra-api-workspace-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@ntars/ondra-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@ntars/ondra-client-ui-renderer/client'
import type {} from '@ntars/ondra-client-ui-layout/client'
// Type-only: pulls the Session root standard-hook merge.
import type {} from '@ntars/ondra-client-ui-session/client'
import {
  type DeleteSessionInjected, menuOpenStateFactory, type PinSessionInjected,
  type SessionDeleteConfirmInjected, type SessionDeleteConfirmRequest,
  type RenameSessionInjected, type RowToast, type RowToastInjected, type RowToastState, type SessionRenameDialogInjected,
  type SessionIdInjected, type SessionTrashInjected, type TrashSessionRow,
  type WorkspaceBrowserInjected, type WorkspacePickerInjected,
} from './contract/slots.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from './shortcuts.ts'
import { UiWorkspaceService } from './navigation.ts'
import { createWorkspaceViewStore } from './stores.ts'
import { WorkspaceBrowser } from './rows/WorkspaceBrowser.tsx'
import { DeleteSessionMenuItem, SessionDeleteConfirmDialog } from './session-actions/DeleteSession.tsx'
import { derive, derivePair } from './session-actions/derived.ts'
import { PinSessionMenuItem } from './session-actions/PinSession.tsx'
import { RenameSessionMenuItem, SessionRenameDialog } from './session-actions/RenameSession.tsx'
import { RowActionToast } from './session-actions/RowActionToast.tsx'
import { registerToasts } from './toast/register.ts'
import { SessionIdMenuItem } from './session-actions/SessionId.tsx'
import { SnapshotSettingsRow } from './session-actions/SnapshotRow.tsx'
import { SessionTrashButton, SessionTrashDialog } from './session-actions/SessionTrash.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'

export type { StartSessionOptions, UiWorkspace } from './navigation.ts'
export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  MenuOpenState, RowToast, SessionRenameTarget, SessionRowOwnerProps, UseMenuOpenState, WorkspaceBrowserInjected,
  SessionRowScheduleOwnerProps,
  WorkspaceBrowserProps,
  WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module '@ntars/ondra-client-ui-slots' {
  interface GlobalStandardProps {
    /** Selector hook over the pure Workspace Controller snapshot. */
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
    /** Whether the current Peer may call `action` on one Workspace resource. */
    useWorkspaceAccess: (workspaceId: WorkspaceId, action: RemoteEndpoint) => boolean
  }

  interface LocaleNamespaceMap {
    /** The workspace browsing region and pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

declare module '@ntars/ondra-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    workspaceOperation: unknown
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: ondra.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 */
export const inject = [
  'slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.directoryPicker', 'layout', 'shortcuts', 'remoteAccess',
]

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  // One viewing-store instance, created here as ui-layout does for its layout
  // store: the browser declares the handle, and the UiWorkspace service writes
  // view order through the same instance the renderer hands the browser.
  const viewHandle = createWorkspaceViewStore()
  const viewInstance = viewHandle.create()
  const viewStore: typeof viewHandle = { ...viewHandle, create: () => viewInstance }
  const rowToast = createSnapshotStore<RowToastState | null>(null)
  let toastSeq = 0
  const notify = (toast: RowToast): void => { rowToast.set({ ...toast, seq: ++toastSeq }) }
  const uiWorkspace = new UiWorkspaceService(
    ctx, ctx.remote.directoryPicker, workspaces, sessions, viewInstance.actions, notify,
  )
  ctx.slots.provideRoot({
    hooks: { workspaces: workspaces.list },
    keyedHooks: {
      workspaceAccess: (workspaceId, action) => action === undefined
        ? undefined
        : ctx.remoteAccess.source('workspace', workspaceId, action),
    },
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')
  // A window with no Session is not a state this product shows.
  //
  // First launch and "deleted everything" both used to land on an empty
  // browser offering nothing to type into; the person had to find the Workspace
  // picker before they could say anything. Whenever the lists settle with no
  // visible Session, this resolves the Workspace's blank (the Host reuses one
  // that already exists) and selects it, so there is always a Conversation on
  // screen. One attempt per empty epoch: a Host that refuses must not turn this
  // into a creation loop.
  ctx.effect(() => {
    let attempted = false
    const ensure = (): void => {
      const workspaceSnapshot = workspaces.list.getSnapshot()
      const sessionSnapshot = sessions.list.getSnapshot()
      if (workspaceSnapshot.phase !== 'ready' || sessionSnapshot.phase !== 'ready') return
      const archived = new Set<string>(workspaceSnapshot.archivedSessionIds)
      const visible = workspaceSnapshot.items.some(item =>
        item.sessionIds.some(sessionId => !archived.has(sessionId)))
      if (visible) {
        attempted = false
        return
      }
      // No Workspace yet: the picker owns that state, and a Session cannot be
      // created without a directory.
      const workspace = workspaceSnapshot.items[0]
      if (workspace === undefined || attempted) return
      attempted = true
      uiWorkspace.connectWorkspace(workspace.workspaceId).then((sessionId) => {
        // Deliberately not `openSession`: this runs on its own, so it must not
        // take the person off the page they are reading.
        uiWorkspace.selectSession(sessionId)
      }).catch(() => {
        // The empty browser stays; the next list change retries.
      })
    }
    const stopSessions = sessions.list.subscribe(ensure)
    const stopWorkspaces = workspaces.list.subscribe(ensure)
    ensure()
    return () => {
      stopSessions()
      stopWorkspaces()
    }
  }, 'ui-workspace: a Session to start from')
  const shortcutControls = createWorkspaceShortcutControls()

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await sessions.search(query, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: 'sidebar.workspaces.directoryFlow' | 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  const hostInfo: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const openSession: WorkspaceBrowserInjected['open'] = (sessionId) => {
    uiWorkspace.openSession(sessionId)
  }
  // Registry-global sets as Sets, rebuilt only when the Workspace snapshot changes.
  const pinnedSet = derive(workspaces.list, snapshot => new Set<SessionId>(snapshot.pinnedSessionIds))
  const archivedSet = derive(workspaces.list, snapshot => new Set<SessionId>(snapshot.archivedSessionIds))
  // Plugin-private facts the row actions and their overlay surfaces share:
  // the pending rename request and the notice on display. Each business
  // writes through its own injected callback and the surface reads through
  // its bound hook.
  const renameRequest = derive(shortcutControls.state, state => state.renameTarget)
  const deleteRequest = createSnapshotStore<SessionDeleteConfirmRequest | null>(null)
  const requestSessionRename = shortcutControls.rename
  const renameSession: SessionRenameDialogInjected['renameSession'] = async (sessionId, title) => {
    const result = await sessions.using(
      sessionId,
      { source: 'workspaceOperation' },
      reference => reference.binding.session.rename(title),
    )
    if (!result.ok) throw new Error(result.error.message)
  }
  const pinInjected = (): PinSessionInjected => ({
    hooks: { pinned: pinnedSet, archived: archivedSet },
    // Pin failures surface as a notice: nothing else on the surface moves, so
    // a silent failure would read as a dead action.
    pinSession: (sessionId) => {
      uiWorkspace.pinSession(sessionId).catch(() => { notify({ kind: 'pinFailed' }) })
    },
    unpinSession: (sessionId) => {
      uiWorkspace.unpinSession(sessionId).catch(() => { notify({ kind: 'unpinFailed' }) })
    },
  })
  // Deleting asks first, always. The row disappears into the trash, so the
  // confirmation is a check — "this Session leaves the sidebar, and comes back
  // from 回收站" — rather than the only thing standing between a click and data
  // loss. The Host still refuses while work is live; the confirm hop asks it to
  // stop that work, and the refusal names it.
  const deleteInjected = (): DeleteSessionInjected => ({
    deleteSession: (sessionId) => {
      const displayTitle = sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId
      deleteRequest.set({ sessionId, displayTitle, activity: [] })
    },
  })
  installWorkspaceShortcuts(ctx, uiWorkspace, shortcutControls,
    (reason) => { notify({ kind: 'shortcutForkFailed', reason }) })
  const deleteConfirmInjected = (): SessionDeleteConfirmInjected => ({
    hooks: { deleteRequest },
    settleSessionDelete: () => { deleteRequest.set(null) },
    stopAndDeleteSession: async (sessionId) => {
      await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
    },
  })
  // The trash is the other half of the archive: every deleted Session is still
  // here, with its title resolved from the Session list so the row reads like
  // the row it used to be instead of an id.
  const trashOpen = createSnapshotStore(false)
  // A row is listed only while its Workspace slot still exists.
  //
  // Deleting a Session archives it (that flag is what hides it from the
  // sidebar) and keeps its slot so restoring returns it to the same place.
  // 删除记录 drops the slot and keeps the flag, so the same archive set yields
  // two different answers on the two surfaces without a second persisted set:
  // here the row is gone because nothing accounts for it any more, while the
  // sidebar keeps hiding it because it is still archived.
  const trashRows = derivePair(
    workspaces.list,
    sessions.list,
    (workspaceSnapshot, sessionSnapshot): readonly TrashSessionRow[] => {
      const accounted = new Set<string>()
      for (const workspace of workspaceSnapshot.items) {
        for (const sessionId of workspace.sessionIds) accounted.add(sessionId)
      }
      return workspaceSnapshot.archivedSessionIds
        .filter(sessionId => accounted.has(sessionId))
        .map(sessionId => ({
          sessionId,
          displayTitle: sessionSnapshot.byId[sessionId]?.displayTitle ?? sessionId,
          updatedAt: sessionSnapshot.byId[sessionId]?.updatedAt ?? 0,
        }))
        // Newest first: a person emptying the list looks for what they just
        // deleted, which is the row that used to be hardest to find at the
        // bottom of a long archive.
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
  )
  const trashInjected = (): SessionTrashInjected => ({
    hooks: { open: trashOpen, rows: trashRows },
    openTrash: () => { trashOpen.set(true) },
    closeTrash: () => { trashOpen.set(false) },
    // Restore lifts the archive flag, which is the whole of what hid the row:
    // the Session returns to the position its Workspace slot still records.
    restoreSession: async (sessionId) => {
      await uiWorkspace.unarchiveSession(sessionId)
    },
    // 删除记录 forgets the Session in the registry instead of deleting bytes.
    //
    // One write removes it from the archive set (so it leaves this list) and
    // detaches it from every Workspace (so it can never return to the sidebar).
    // Nothing is written to disk and no OS trash is involved, which is why this
    // cannot half-fail on a platform permission. Because the archive flag is
    // gone rather than shadowed by a client-side marker, a Session that is
    // deleted again later shows up here again — the failure mode of the earlier
    // local-marker attempt.
    purgeSessions: async (sessionIds) => {
      for (const sessionId of sessionIds) await uiWorkspace.forgetSession(sessionId)
    },
  })
  const sessionIdInjected = (): SessionIdInjected => ({
    copySessionId: async (sessionId) => {
      const copied = await writeClipboard(sessionId)
      notify({ kind: copied ? 'sessionIdCopied' : 'sessionIdCopyFailed' })
    },
  })
  const renameInjected = (): RenameSessionInjected => ({ requestSessionRename })
  const renameDialogInjected = (): SessionRenameDialogInjected => ({
    hooks: { renameRequest },
    settleSessionRename: shortcutControls.closeRename,
    renameSession,
  })
  const toastActions = {
    openForkSource: (sessionId: SessionId) => { openSession(sessionId) },
  }
  registerToasts(ctx, toastActions)
  const rowToastInjected = (): Pick<RowToastInjected, 'hooks' | 'dismissToast'> => ({
    hooks: { toast: rowToast },
    dismissToast: () => { rowToast.set(null) },
  })
  const browserInjected = (): WorkspaceBrowserInjected => ({
    // Explicit group actions keep their target; unscoped New Session inherits
    // the current Session Workspace before the recent-Workspace fallback.
    startSession: (workspaceId, options) => { uiWorkspace.startSession(workspaceId, options) },
    open: openSession,
    searchSessions,
    searchResultLimit: sessions.searchResultLimit,
    requestSessionRename,
    renameWorkspace: async (workspaceId, title) => { await workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    createWorkspace: input => workspaces.create(input),
    requestSearch: shortcutControls.search,
    requestAddWorkspace: shortcutControls.add,
    closeAddWorkspace: shortcutControls.closeAdd,
    setDirectoryBusy: shortcutControls.directoryBusy,
    hooks: { directoryFlow: browserFlowSource, hostInfo, workspaceShortcuts: shortcutControls.state, shortcuts: ctx.shortcuts.catalog },
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => workspaces.create(input),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its owned children in the same call; slot
  // injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: {
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
        // Every row entry reads the menu's open state through a hook bound
        // from the row's render occurrence (the owner passes the state pair
        // as hookContext).
        'sidebar.workspaces.session.menu.item': {
          kind: 'list', scope: 'root', inject: { hooks: { menuOpenState: menuOpenStateFactory, shortcuts: ctx.shortcuts.catalog } },
        },
        'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' },
        'sidebar.session.row.leading': { kind: 'list', scope: 'root', inline: true },
        'sidebar.session.row.trailing': { kind: 'list', scope: 'root', inline: true },
        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
      },
      store: viewStore,
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  // The shipped row actions take the same route as a plugin's: `slots.inject`
  // waits for the browser registration above to declare each list, and the
  // entries leave with it. Explicit orders leave room for plugin entries.
  // The menu is the only action surface on a row: hover shows the "…" trigger
  // alone, so pin, rename, and delete live here and nowhere else.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'pin', order: 100, locale: NS, inject: pinInjected }, PinSessionMenuItem)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'rename', order: 200, locale: NS, inject: renameInjected }, RenameSessionMenuItem)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'delete', order: 400, locale: NS, inject: deleteInjected }, DeleteSessionMenuItem)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'session-id', order: 450, locale: NS, inject: sessionIdInjected }, SessionIdMenuItem)
  })
  // The trash entry sits with the other frame-wide actions at the sidebar's
  // foot, so it is reachable without opening a menu to look for it.
  // The trash is a developer tool, not a sidebar affordance: it can delete for
  // good, and the everyday path (delete → confirm) never needs it.
  ctx.slots.inject('settings.developer.item', function* () {
    yield ctx.slots.register({
      name: 'settings.developer.item', id: 'session-trash', order: 100, locale: NS, inject: trashInjected,
    }, SessionTrashButton)
    // Backups are the recovery story for someone who broke their own data while
    // working on the product, so they sit beside the trash rather than in 通用.
    yield ctx.slots.register({
      name: 'settings.developer.item', id: 'snapshots', order: 200, locale: NS, inject: trashInjected,
    }, SnapshotSettingsRow)
  })
  // The surfaces the actions raise live in the frame-wide layer: they must
  // outlive the row menu the action sat in.
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-rename', locale: NS, inject: renameDialogInjected,
    }, SessionRenameDialog)
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-delete', locale: NS, inject: deleteConfirmInjected,
    }, SessionDeleteConfirmDialog)
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-trash', locale: NS, inject: trashInjected,
    }, SessionTrashDialog)
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.row-toast', inject: rowToastInjected,
      children: { 'workspace.toast': { kind: 'keyed', scope: 'root' } },
    }, RowActionToast)
  })
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
}
