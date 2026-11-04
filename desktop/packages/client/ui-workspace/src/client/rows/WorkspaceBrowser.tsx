/**
 * The conversation list filling the sidebar shell's `sidebar.workspaces` hole:
 * one flat, drag-reorderable list of conversations plus the rename and delete
 * dialogs. With a single default workspace and no folder grouping, the list is
 * its own index — so there is no section header, no search field, and no tree.
 * A Session row's "..." menu and hover buttons are the
 * `sidebar.workspaces.session.menu.item` and
 * `sidebar.workspaces.session.row.action` lists rendered through this entry's
 * `renderSlot`; the actions in them, this package's own included, are slot
 * entries with their own behavior, so this component threads no action
 * callbacks and hosts no action surface.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  AnimatedRows, Button, HoverCardGroup, IconQueueOutlineRegular, Modal,
} from '@ntars/ondra-client-ui-primitives'
import type { SessionListState } from '@ntars/ondra-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@ntars/ondra-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@ntars/ondra-api-workspace-controller/default-workspace'
import type { SessionId } from '@ntars/ondra-session/types'
import type { PropsRenderSlots } from '@ntars/ondra-client-ui-slots'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { SessionNode, SessionRowState } from '../tree.ts'
import {
  deriveFlat, orderByRecency, pinCurrentBlank, reconcileManualOrder, sessionMemberIds, UNGROUPED_KEY,
} from '../tree.ts'
import { SessionNodeItem } from './Rows.tsx'
import { FLAT_SESSION_ORDER_KEY } from '../stores.ts'
import css from './WorkspaceBrowser.module.css'


/**
 * Accept the native drag at document level while a row drag is active: row
 * hover still owns the insertion marker, and releasing outside the list must
 * not be rendered as a rejected drop before dragend commits that last marker.
 */
function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
}

/** In-flight root-row drag: source identity plus the current insert marker. */
interface DragState {
  /** Workspace id, or {@link UNGROUPED_KEY} for the browser-local loose-session account. */
  accountKey: string
  sessionId: SessionNode['id']
  /** Source row was pinned at drag start; drop targets share the pinned block. */
  pinned: boolean
  /** Row the marker sits on and which half (insert above/below it). */
  over: { id: SessionNode['id']; half: 'before' | 'after' } | null
}

/** Apply a visible drop to the complete account without removing hidden members. */
function sessionDragOrder(
  order: readonly SessionId[],
  rows: readonly SessionNode[],
  drag: DragState,
  over: NonNullable<DragState['over']>,
): SessionId[] | undefined {
  const source = rows.find(row => row.id === drag.sessionId)
  const target = rows.find(row => row.id === over.id)
  if (source === undefined || target === undefined || source.blank
    || source.pinned !== drag.pinned || target.pinned !== drag.pinned
    || source.id === target.id || !order.includes(source.id)) return
  const section = rows.filter(row => row.pinned === drag.pinned)
  const sourceIndex = section.findIndex(row => row.id === source.id)
  const withoutSource = section.filter(row => row.id !== source.id)
  const insertAt = withoutSource.findIndex(row => row.id === target.id) + (over.half === 'after' ? 1 : 0)
  if (insertAt === sourceIndex) return
  const next = order.filter(id => id !== source.id)
  const targetIndex = next.indexOf(target.id)
  if (targetIndex === -1) return
  next.splice(targetIndex + (over.half === 'after' ? 1 : 0), 0, source.id)
  return pinCurrentBlank(next, rows.find(row => row.blank)?.id)
}

type SessionTreeProps = Pick<
  WorkspaceBrowserProps,
  'useSessionStatus' | 'startSession' | 'open'
  | 'insertWorkspaceBefore' | 't' | 'usePanelInfo'
  | 'useRemoteAccess' | 'useSessionAccess' | 'useWorkspaceAccess'
> & PropsRenderSlots<
  | 'sidebar.workspaces.session.menu.item'
  | 'sidebar.workspaces.session.row.action'
  | 'sidebar.session.row.trailing'
  | 'sidebar.session.row.leading'
  | 'sidebar.session.row.hover'
> & {
  shortcuts: readonly import('@ntars/ondra-client-shortcuts/client').ShortcutCatalogEntry[]
  /** Always-mounted Session list snapshot. */
  list: SessionListState
  /** Host account home for POSIX hover-path abbreviation. */
  home?: string | undefined
  /** Workspaces in Host group order with browser-projected Session order. */
  workspaces: readonly WorkspaceView[]
  /** Browser-projected order for Sessions outside every Workspace. */
  ungroupedSessionIds: readonly SessionId[]
  /** Whether the current Workspace stream has a complete Host baseline. */
  workspaceReady: boolean
  /** Grouping, ordering, and filter changes replace the view without row motion. */
  animationResetKey: string
  /** Nest Workspaces under their nearest registered ancestors. */
  nestWorkspaces: boolean
  /** Explicit persisted group expansion, including descendants in tree mode. */
  groupExpansion: Readonly<Record<string, boolean>>
  /** Persist one Workspace group's expansion. */
  setGroupExpanded: (key: string, expanded: boolean) => void
  /** Save a drag order and select Manual. */
  setSessionOrder: (accountKey: string, order: readonly string[]) => void
  /** Registry-global pin set and the Sessions already deleted from the list. */
  rowState: SessionRowState
  /** Open the browser-owned rename dialog for a real Workspace group. */
  onRenameRequest: (workspaceId: WorkspaceId, currentTitle: string) => void
  /** Open the browser-owned delete-confirmation dialog for a real Workspace group. */
  onDeleteRequest: (workspaceId: WorkspaceId, currentTitle: string) => void
  /** Open the rename dialog from a row title double-click. */
  onSessionRenameRequest: (sessionId: SessionNode['id'], currentTitle: string) => void
  /** One Session chosen from search that must be exposed and scrolled into view. */
  revealSessionId?: SessionId | undefined
  /** Acknowledge that the chosen Session row has been revealed. */
  onSessionRevealed: (sessionId: SessionId) => void
}

/** The list-empty placeholder — a glyph over the text. */
function EmptySessions({ t }: Pick<SessionTreeProps, 't'>) {
  return (
    <div className={css.emptyState} data-row-key="empty">
      <IconQueueOutlineRegular size={24} />
      <div>{t('empty.none')}</div>
    </div>
  )
}

/** The flat "In one list" body: every session is one draggable top-level row. */
function FlatList({
  list, sessionIds, rowState, useSessionStatus, useSessionAccess, open, onSessionRenameRequest,
  usePanelInfo, setSessionOrder, workspaceReady, animationResetKey,
  revealSessionId, onSessionRevealed, renderSlot, home, t,
}: Pick<
  SessionTreeProps,
  | 'useSessionStatus'
  | 'useSessionAccess'
  | 'open'
  | 'onSessionRenameRequest'
  | 'renderSlot'
  | 'usePanelInfo'
  | 'setSessionOrder'
  | 'workspaceReady'
  | 'animationResetKey'
  | 'revealSessionId'
  | 'onSessionRevealed'
  | 'rowState'
  | 'home'
  | 't'
> & {
  list: SessionListState
  sessionIds: readonly SessionId[]
}) {
  const panelActive = usePanelInfo(info => info.activePanelId !== null)
  const statuses = useSessionStatus(s => s)
  const rows = useMemo(
    () => deriveFlat(list, sessionIds, rowState, statuses),
    [list, sessionIds, rowState, statuses],
  )
  const [drag, setDrag] = useState<DragState | null>(null)
  const dropCommitted = useRef(false)
  useNativeDragAcceptance(drag !== null)
  const currentId = panelActive
    ? undefined
    : Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const commitDrag = (activeDrag: DragState, over: NonNullable<DragState['over']>): void => {
    if (dropCommitted.current) return
    dropCommitted.current = true
    setDrag(null)
    const nextOrder = sessionDragOrder(sessionIds, rows, activeDrag, over)
    if (nextOrder !== undefined) setSessionOrder(FLAT_SESSION_ORDER_KEY, nextOrder)
  }
  const now = Date.now()
  return (
    <HoverCardGroup className={css.treeBody}>
      <AnimatedRows
        className={clsx(css.list, css.flatList)}
        role="tree"
        label={t('section.sessions')}
        rowKeys={rows.length === 0 ? ['empty'] : rows.map(row => `session:${row.id}`)}
        ready={list.phase === 'ready' && workspaceReady && drag === null}
        resetKey={animationResetKey}
      >
        {rows.length === 0 && (
          <EmptySessions t={t} />
        )}
        {rows.map((node) => {
          const active = drag !== null && drag.pinned === node.pinned
          const normalizeHalf = (half: 'before' | 'after'): 'before' | 'after' =>
            node.blank ? 'after' : half
          return (
            <SessionNodeItem
              key={node.id}
              node={node}
              currentId={currentId}
              now={now}
              onOpen={open}
              onRenameRequest={onSessionRenameRequest}
              renderSlot={renderSlot}
              onReveal={node.id === revealSessionId
                ? () => { onSessionRevealed(node.id) }
                : undefined}
              useSessionAccess={useSessionAccess}
              drag={{
                start: () => {
                  dropCommitted.current = false
                  setDrag({ accountKey: FLAT_SESSION_ORDER_KEY, sessionId: node.id, pinned: node.pinned, over: null })
                },
                active,
                marker: active && drag.over?.id === node.id ? drag.over.half : null,
                hover: (half) => {
                  setDrag(current => current === null ? current : {
                    ...current, over: { id: node.id, half: normalizeHalf(half) },
                  })
                },
                drop: (half) => {
                  if (drag !== null) commitDrag(drag, { id: node.id, half: normalizeHalf(half) })
                },
                end: () => {
                  if (drag?.over !== null && drag?.over !== undefined) commitDrag(drag, drag.over)
                  else setDrag(null)
                  dropCommitted.current = false
                },
              }}
              home={home}
              t={t}
            />
          )
        })}
      </AnimatedRows>
      <span className={css.fade} />
    </HoverCardGroup>
  )
}


/**
 * Render the browsing region.
 * @param props - composed slot props (shell owner share + store + injected actions).
 * @returns the region element tree.
 */
export function WorkspaceBrowser({
  usePanelInfo,
  useSessions,
  useSessionStatus,
  useSessionAccess,
  useWorkspaces,
  useStore,
  actions,
  open,
  requestSessionRename,
  renameWorkspace,
  deleteWorkspace,
  useHostInfo,
  renderSlot,
  t,
}: WorkspaceBrowserProps) {
  const home = useHostInfo(info => info.home)
  // Ordering remains live while the list body renders.
  const list = useSessions(state => state)
  const storedWorkspaces = useWorkspaces(state => state.items)
  // The resolved name, not `t`, is the memo dependency: the bound seat keeps
  // its identity across a language switch.
  const defaultWorkspaceName = t('workspace.defaultName')
  const workspaces = useMemo(
    () => storedWorkspaces.map(workspace => ({
      ...workspace,
      title: workspaceDisplayTitle(workspace.title, defaultWorkspaceName),
    })),
    [storedWorkspaces, defaultWorkspaceName],
  )
  const workspacePhase = useWorkspaces(state => state.phase)
  const workspaceStreamState = useWorkspaces(state => state.state)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const pinnedSessionIds = useWorkspaces(state => state.pinnedSessionIds)
  const orderBy = useStore(s => s.orderBy)
  const sessionOrderByAccount = useStore(s => s.sessionOrderByAccount)
  const workspaceReady = workspacePhase === 'ready' && workspaceStreamState !== 'loading'
  const mainSessionId = Object.values(list.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const currentBlank = mainSessionId !== undefined && list.byId[mainSessionId]?.blank === true
    ? mainSessionId
    : undefined
  const orderState = useMemo(
    () => ({ pinnedSessionIds, archivedSessionIds }),
    [archivedSessionIds, pinnedSessionIds],
  )
  // No archived view: a Session is either in the list or deleted, so the list
  // always reads the default (hide removed) projection.
  const rowState = useMemo<SessionRowState>(
    () => ({ ...orderState, archivedFilter: 'default' }),
    [orderState],
  )
  const flatMemberIds = useMemo(() => sessionMemberIds(list), [list])
  const orderedFlatSessionIds = useMemo(() => {
    const baseOrder = orderBy === 'updated'
      ? orderByRecency(flatMemberIds, list.byId)
      : reconcileManualOrder(flatMemberIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY], list.byId, orderState)
    return pinCurrentBlank(
      baseOrder,
      currentBlank !== undefined && flatMemberIds.includes(currentBlank) ? currentBlank : undefined,
    )
  }, [currentBlank, flatMemberIds, list.byId, orderBy, orderState, sessionOrderByAccount])
  // One account: the flat list. Grouping, folder nesting, and the loose-session
  // account are gone, so a blank row's pinning only ever touches this key.
  const activeSessionOrders = useMemo<Readonly<Record<string, readonly SessionId[]>>>(
    () => ({ [FLAT_SESSION_ORDER_KEY]: orderedFlatSessionIds }),
    [orderedFlatSessionIds],
  )
  useEffect(() => {
    actions.retainAccountKeys([FLAT_SESSION_ORDER_KEY])
  }, [actions.retainAccountKeys])
  useEffect(() => {
    if (list.phase !== 'ready' || workspaceReady || orderBy !== 'manual' || currentBlank === undefined) return
    // A first prompt can end blank pinning before the Workspace baseline arrives.
    // Preserve saved members until that baseline can establish departures.
    const changed: Record<string, readonly string[]> = {}
    for (const [key, ids] of Object.entries(activeSessionOrders)) {
      const saved = sessionOrderByAccount[key] ?? []
      if (ids[0] !== currentBlank || saved[0] === currentBlank) continue
      changed[key] = [currentBlank, ...saved.filter(id => id !== currentBlank)]
    }
    if (Object.keys(changed).length > 0) actions.syncSessionOrders(changed)
  }, [
    actions.syncSessionOrders,
    activeSessionOrders,
    currentBlank,
    list.phase,
    orderBy,
    sessionOrderByAccount,
    workspacePhase,
    workspaceReady,
  ])
  useEffect(() => {
    if (list.phase !== 'ready' || !workspaceReady || orderBy !== 'manual' || currentBlank === undefined) return
    const moved = Object.entries(activeSessionOrders).some(([key, ids]) =>
      ids[0] === currentBlank && sessionOrderByAccount[key]?.[0] !== currentBlank)
    if (moved) actions.syncSessionOrders(activeSessionOrders)
  }, [
    actions.syncSessionOrders,
    activeSessionOrders,
    currentBlank,
    list.phase,
    orderBy,
    sessionOrderByAccount,
    workspaceReady,
  ])
  const saveSessionOrder = (accountKey: string, order: readonly string[]): void => {
    actions.setSessionOrder(accountKey, order, activeSessionOrders)
  }
  const [revealSessionId, setRevealSessionId] = useState<SessionId | undefined>(undefined)
  // Section-header ＋ opens the picker menu; the menu anchors on this button.
  const composingRef = useRef(false)

  const acknowledgeSessionReveal = (sessionId: SessionId): void => {
    setRevealSessionId(current => current === sessionId ? undefined : current)
  }

  // Rename dialog (browser-owned so it outlives row unmounts during collapse).
  // The stored title decides whether confirming is a real rename; the draft is
  // seeded with the label on screen. They differ for a Workspace still
  // carrying its automatic title, so confirming the prefill pins that name.
  const [renameTarget, setRenameTarget] = useState<{ workspaceId: WorkspaceId; storedTitle: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameTrimmed = renameDraft.trim()
  // Self is excluded by identity, not by title: the draft is seeded with the
  // localized label, which for an automatically titled Workspace equals its
  // own displayed title without being a conflict with itself.
  const renameDuplicate = renameTarget !== null && renameTrimmed !== ''
    && workspaces.some(w => w.workspaceId !== renameTarget.workspaceId && w.title === renameTrimmed)
  const renameBlocked = renaming || renameTrimmed === ''
    || renameTarget === null || renameTrimmed === renameTarget.storedTitle || renameDuplicate
  const closeRename = () => {
    if (renaming) return
    setRenameTarget(null)
    setRenameError(null)
  }
  const confirmRename = () => {
    if (renameBlocked) return
    setRenaming(true)
    setRenameError(null)
    renameWorkspace(renameTarget.workspaceId, renameTrimmed).then(() => {
      setRenaming(false)
      setRenameTarget(null)
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  // Delete dialog is separate from the row so a successful removal can
  // unmount that row without tearing down the in-flight confirmation state.
  const [deleteTarget, setDeleteTarget] = useState<{ workspaceId: WorkspaceId; title: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteCommittedId, setDeleteCommittedId] = useState<WorkspaceId | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    if (deleteCommittedId === null
      || workspaces.some(workspace => workspace.workspaceId === deleteCommittedId)) return
    setDeleting(false)
    setDeleteCommittedId(null)
    setDeleteTarget(null)
  }, [deleteCommittedId, workspaces])
  const closeDelete = () => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
  }
  const confirmDelete = () => {
    /* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
    if (deleting || deleteTarget === null) return
    setDeleting(true)
    setDeleteCommittedId(null)
    setDeleteError(null)
    deleteWorkspace(deleteTarget.workspaceId).then(() => {
      // Keep the confirmation pending until this component has rendered the
      // committed list projection without the deleted id. Closing earlier
      // exposes one stale React frame to the next Create Workspace gesture.
      setDeleteCommittedId(deleteTarget.workspaceId)
    }).catch((reason: unknown) => {
      setDeleting(false)
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <div className={css.root}>
      {/* No section header and no search field. The column is a conversation
          list: identity row, the 对话 / 日志 switch, then conversations. Both
          the 「工作区」 toolbar row and the search box were tools for finding a
          conversation among many folders; with one default workspace and a
          short list, the list itself is the index. */}
      {/* Always-mounted seat keeps the region's flex slot. */}
      <div className={css.listArea}>
        <FlatList
          useSessionAccess={useSessionAccess}
          usePanelInfo={usePanelInfo}
          list={list}
          sessionIds={orderedFlatSessionIds}
          rowState={rowState}
          workspaceReady={workspaceReady}
          animationResetKey={`flat/${orderBy}`}
          useSessionStatus={useSessionStatus}
          open={open}
          onSessionRenameRequest={requestSessionRename}
          renderSlot={renderSlot}
          setSessionOrder={saveSessionOrder}
          revealSessionId={revealSessionId}
          onSessionRevealed={acknowledgeSessionReveal}
          home={home}
          t={t}
        />
      </div>

      <Modal
        open={renameTarget !== null}
        onClose={closeRename}
        closeLabel={t('close')}
        title={t('rename.workspace.title')}
        footer={(
          <>
            <Button variant="outline" disabled={renaming} onClick={closeRename}>{t('cancel')}</Button>
            <Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>{t('rename')}</Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={renameDraft}
          aria-label={t('field.workspaceName')}
          data-modal-autofocus
          disabled={renaming}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setRenameDraft(e.target.value); setRenameError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmRename()
            }
          }}
        />
        {renameDuplicate && (
          <div className={css.renameError} role="alert">{t('conflict.named', { name: renameTrimmed })}</div>
        )}
        {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        closeLabel={t('close')}
        title={t('delete.workspace')}
        {...deleteTarget === null
          ? {}
          : { description: t('delete.desc', { name: deleteTarget.title }) }}
        footer={(
          <>
            <Button variant="outline" disabled={deleting} onClick={closeDelete}>{t('cancel')}</Button>
            <Button
              variant="outline"
              className={css.deleteAction}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {t('delete.workspace')}
            </Button>
          </>
        )}
      >
        {deleting && <div className={css.deleteStatus} role="status">{t('delete.pending')}</div>}
        {deleteError !== null && <div className={css.renameError} role="alert">{deleteError}</div>}
      </Modal>
    </div>
  )
}
