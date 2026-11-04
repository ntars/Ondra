/**
 * The delete action: a `sidebar.workspaces.session.menu.item` row and a
 * `sidebar.workspaces.session.row.action` button over one injected behavior,
 * plus the `shell.overlay` dialog that confirms stopping a Session's running
 * work before removing it from the list. A Session with nothing running is
 * removed on the click; the dialog only appears when the Host refuses because
 * work is still live, and it names that work.
 */
import { useState } from 'react'
import type { SessionActivity } from '@ntars/ondra-api-workspace-controller/client'
// Type-only: the family keys each provider merges; a key this program did not compile takes the generic line.
import type {} from '@ntars/ondra-agent/types'
import type {} from '@ntars/ondra-jobs/view'
import type {} from '@ntars/ondra-schedule/client'
import type {} from '@ntars/ondra-subagent/client'
import {
  Button, IconTrashOutlineRegular, MenuItemButton, Modal, Tooltip,
} from '@ntars/ondra-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteConfirmInjected, SessionDeleteConfirmProps, SessionDeleteConfirmRequest,
  SessionMenuItemProps, SessionRowActionProps,
} from '../contract/slots.ts'
import css from '../rows/Rows.module.css'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 400): delete the Session. Absent while the Session's access
 * snapshot excludes `session/delete`.
 * @param props - owner share, the delete share, the access Hook, and the menu open state.
 * @returns the row, or nothing when the caller may not delete this Session.
 */
export function DeleteSessionMenuItem({
  sessionId, useMenuOpenState, useSessionAccess, deleteSession, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const allowed = useSessionAccess(sessionId, 'workspace/archiveSession')
  if (!allowed) return null
  return (
    <MenuItemButton
      danger
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        deleteSession(sessionId)
      }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * Hover button (order 100): the same delete, one click away from the row.
 * @param props - owner share, the access Hook, and the delete share.
 * @returns the button, or nothing when the caller may not delete this Session.
 */
export function DeleteSessionRowButton({
  sessionId, useSessionAccess, deleteSession, t,
}: SessionRowActionProps<DeleteSessionInjected>) {
  const allowed = useSessionAccess(sessionId, 'workspace/archiveSession')
  if (!allowed) return null
  return (
    <Tooltip label={t('actions.delete')} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className={css.iconButton}
        aria-label={t('menu.deleteSession')}
        onClick={() => { deleteSession(sessionId) }}
      >
        <IconTrashOutlineRegular size={14} />
      </button>
    </Tooltip>
  )
}

/**
 * The `shell.overlay` entry: nothing while no confirmation is pending,
 * otherwise one dialog per request (keyed by the Session). Confirming asks
 * the Host to stop the listed work and delete; cancelling leaves the Session
 * running and visible.
 * @param props - the request hook, its settlement, the stop-and-delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionDeleteConfirmDialog({
  useDeleteRequest, settleSessionDelete, stopAndDeleteSession, t,
}: SessionDeleteConfirmProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteConfirmForm
      key={request.sessionId}
      request={request}
      stopAndDeleteSession={stopAndDeleteSession}
      onSettle={settleSessionDelete}
      t={t}
    />
  )
}

/** One request's dialog: in-flight and error state die with it. */
function DeleteConfirmForm({ request, stopAndDeleteSession, onSettle, t }: {
  request: SessionDeleteConfirmRequest
  stopAndDeleteSession: SessionDeleteConfirmInjected['stopAndDeleteSession']
  onSettle: () => void
  t: SessionDeleteConfirmProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    stopAndDeleteSession(request.sessionId).then(() => {
      setDeleting(false)
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.confirm.title')}
      description={t('delete.confirm.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={browserCss.deleteAction}
            disabled={deleting}
            onClick={confirm}
          >
            {t('delete.confirm.action')}
          </Button>
        </>
      )}
    >
      {request.activity.length === 0
        ? null
        : (
          <ul className={browserCss.archiveActivity} aria-label={t('delete.confirm.activity')}>
            {request.activity.map((entry, index) => (
              <li key={`${entry.kind}-${String(index)}`}>{activityLine(entry, t)}</li>
            ))}
          </ul>
        )}
      {deleting && <div className={browserCss.deleteStatus} role="status">{t('delete.confirm.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}

/**
 * One family's line: its count and the items' labels (ids when a family
 * carries no label). A family this dictionary does not know — a provider
 * merged into the kind map — falls through to the generic line.
 */
function activityLine(entry: SessionActivity, t: SessionDeleteConfirmProps['t']): string {
  const items = entry.items ?? []
  const n = items.length
  const names = items.map(item => item.label ?? item.id).join(t('delete.confirm.listSeparator'))
  const plural = n === 1 ? 'one' : 'other'
  switch (entry.kind) {
    case 'turn': return t('delete.confirm.turn')
    case 'subagent': return t(`delete.confirm.subagents.${plural}`, { n, names })
    case 'job': return t(`delete.confirm.jobs.${plural}`, { n, names })
    case 'schedule': return t(`delete.confirm.schedules.${plural}`, { n, names })
    default: return t(`delete.confirm.other.${plural}`, { kind: entry.kind, n })
  }
}
