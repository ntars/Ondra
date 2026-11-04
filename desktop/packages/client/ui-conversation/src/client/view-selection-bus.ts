/**
 * The conversation's view selection bus: one module-level store for the view
 * the column is showing, keyed to the session it belongs to.
 *
 * WHY THIS EXISTS. The natural home for a per-session view choice is the
 * per-session Conversation store — but a store *handle* mints a fresh instance
 * on every `create()` (the caching lives in the slot renderer's own instance
 * table, which is private to it). A plugin that writes through
 * `handle.create(sessionId)` therefore writes to an instance nobody renders,
 * and the choice silently evaporates. Publishing the choice here gives every
 * reader in this package — the view renderer, the header's tab strip, and the
 * `conversationViewSelection` service the sidebar consumes — one source of
 * truth that outlives render passes and does not depend on instance identity.
 *
 * The session id rides along so a switch is only honoured for the session it
 * was made on: switching sessions restores that session's own choice, which
 * `restoreView` writes back from the persisted preference.
 */
import { createSnapshotStore } from '@ntars/ondra-client-store'
import type { SessionId } from '@ntars/ondra-session/types'

/** The bus: which session shows which view. */
export const viewSelectionBus = createSnapshotStore<{
  readonly sessionId: SessionId | undefined
  readonly view: string | null
}>({ sessionId: undefined, view: null })

/**
 * Publish the view one session is showing.
 * @param sessionId - session whose view is on screen; undefined when none is.
 * @param view - the view id, or null when the session has not chosen one.
 */
export function publishViewSelection(sessionId: SessionId | undefined, view: string | null): void {
  const current = viewSelectionBus.getSnapshot()
  if (current.sessionId === sessionId && current.view === view) return
  viewSelectionBus.set({ sessionId, view })
}

/**
 * The view the given session is showing, when the bus still agrees.
 * @param sessionId - session to ask about.
 * @returns the view id, or undefined when another session owns the bus.
 */
export function selectedViewOf(sessionId: SessionId): string | null | undefined {
  const current = viewSelectionBus.getSnapshot()
  return current.sessionId === sessionId ? current.view : undefined
}
