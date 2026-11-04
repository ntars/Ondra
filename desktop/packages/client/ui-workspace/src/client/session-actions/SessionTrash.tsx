/**
 * The trash: a 开发者模式 row that opens the list of deleted Sessions, and the
 * `shell.overlay` dialog that lists them with restore and clear.
 *
 * Deleting a Session was always a soft removal — the Host marks it archived and
 * keeps the transcript — but with no surface of its own, "deleted" and "gone"
 * looked the same from the outside. This is that surface. It is a developer
 * row, not a sidebar entry: emptying the list deletes bytes for good, and that
 * is not a control an everyday user should be one click from.
 */
import { useState } from 'react'
import { Button, Modal } from '@ntars/ondra-client-ui-primitives'
import type { SessionId } from '@ntars/ondra-session/types'
import type { SessionTrashButtonProps, SessionTrashProps, TrashSessionRow } from '../contract/slots.ts'
import css from './SessionTrash.module.css'

/**
 * 开发者模式 row: states how much is in the trash and opens the list.
 * @param props - the injected share and the locale seat.
 * @returns the settings row.
 */
export function SessionTrashButton({ openTrash, useRows, t }: SessionTrashButtonProps) {
  const rows = useRows(current => current)
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <span className={css.rowTitle}>{t('trash.open')}</span>
        <span className={css.rowHint}>
          {rows.length === 0 ? t('trash.row.empty') : t('trash.row.count', { count: rows.length })}
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={openTrash}>{t('trash.row.action')}</Button>
    </div>
  )
}

/**
 * The `shell.overlay` entry: nothing while the trash is closed, otherwise the
 * list. Restoring is per row and leaves the dialog open, so putting back three
 * Sessions is three clicks and one close.
 * @param props - the open/rows hooks, the close, restore and purge hops, the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionTrashDialog({ useOpen, useRows, closeTrash, restoreSession, purgeSessions, t }: SessionTrashProps) {
  const open = useOpen(current => current)
  const rows = useRows(current => current)
  if (!open) return null
  return (
    <TrashForm
      rows={rows}
      close={closeTrash}
      restore={restoreSession}
      purge={purgeSessions}
      t={t}
    />
  )
}

/**
 * When a row was last touched, in the shortest form that is still unambiguous:
 * `09:41` today, `3月2日 09:41` earlier this year, `2025年3月2日` before that.
 * @param at - epoch milliseconds from the Session list.
 * @returns the formatted stamp.
 */
function formatDeletedAt(at: number): string {
  const date = new Date(at)
  const now = new Date()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === now.toDateString()) return time
  if (date.getFullYear() === now.getFullYear()) {
    return `${String(date.getMonth() + 1)}月${String(date.getDate())}日 ${time}`
  }
  return `${String(date.getFullYear())}年${String(date.getMonth() + 1)}月${String(date.getDate())}日`
}

/**
 * One open trash: the restore in flight, the failure on display, and the clear.
 */
function TrashForm({ rows, close, restore, purge, t }: {
  rows: readonly TrashSessionRow[]
  close: () => void
  restore: SessionTrashProps['restoreSession']
  purge: SessionTrashProps['purgeSessions']
  t: SessionTrashProps['t']
}) {
  const [busy, setBusy] = useState<SessionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Clearing is its own step, not a second click on the same button: the first
  // click turns the dialog into the question, and only the confirmed answer
  // deletes bytes. Cancelling returns to the list untouched.
  const [clearing, setClearing] = useState(false)
  const [clearBusy, setClearBusy] = useState(false)
  const onRestore = (sessionId: SessionId) => {
    setBusy(sessionId)
    setError(null)
    restore(sessionId).then(() => {
      setBusy(null)
    }).catch((reason: unknown) => {
      setBusy(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  // One row leaves the list the same way the whole list does — 删除记录, which
  // forgets the Session in the registry rather than deleting bytes — so a
  // mistaken click loses nothing that the clear-all confirmation protects.
  const onForget = (sessionId: SessionId) => {
    setBusy(sessionId)
    setError(null)
    purge([sessionId]).then(() => {
      setBusy(null)
    }).catch((reason: unknown) => {
      setBusy(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const onClear = () => {
    setClearBusy(true)
    setError(null)
    purge(rows.map(row => row.sessionId)).then(() => {
      setClearBusy(false)
      setClearing(false)
    }).catch((reason: unknown) => {
      setClearBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  if (clearing) {
    return (
      <Modal
        open
        onClose={() => { if (!clearBusy) setClearing(false) }}
        closeLabel={t('close')}
        title={t('trash.clear.confirmTitle')}
        description={t('trash.clear.confirmDesc', { count: rows.length })}
        footer={(
          <>
            <Button variant="outline" disabled={clearBusy} onClick={() => { setClearing(false) }}>{t('cancel')}</Button>
            <Button variant="outline" className={css.danger} disabled={clearBusy} onClick={onClear}>
              {clearBusy ? t('trash.clear.pending') : t('trash.clear.action')}
            </Button>
          </>
        )}
      >
        {error !== null && <div className={css.error} role="alert">{error}</div>}
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('trash.title')}
      description={t('trash.desc')}
      footer={(
        <>
          {rows.length === 0
            ? null
            : (
              <Button variant="outline" className={css.danger} disabled={busy !== null} onClick={() => { setClearing(true) }}>
                {t('trash.clear.open')}
              </Button>
            )}
          <Button variant="outline" onClick={close}>{t('close')}</Button>
        </>
      )}
    >
      {rows.length === 0
        ? <p className={css.empty}>{t('trash.empty')}</p>
        : (
          <ul className={css.list} aria-label={t('trash.title')}>
            {rows.map(row => (
              <li key={row.sessionId} className={css.item}>
                <span className={css.itemText}>
                  <span className={css.title} title={row.displayTitle}>{row.displayTitle}</span>
                  {row.updatedAt > 0 && (
                    <span className={css.time}>{formatDeletedAt(row.updatedAt)}</span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className={css.danger}
                  disabled={busy !== null}
                  onClick={() => { onForget(row.sessionId) }}
                >
                  {busy === row.sessionId ? t('trash.deleting') : t('trash.delete')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => { onRestore(row.sessionId) }}
                >
                  {busy === row.sessionId ? t('trash.restoring') : t('trash.restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </Modal>
  )
}
