import { useEffect, useSyncExternalStore } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import { viewSelectionBus } from '../view-selection-bus.ts'
import css from './ConversationRoot.module.css'

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft persisted while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, inputActions, useStore, actions,
  renderSlot, bindDraftPersistence, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  // The bus is the live source (see view-selection-bus): the sidebar's switch
  // writes it directly, and it always describes the session this column shows.
  // The per-session store only carries the durable preference, so it stays the
  // fallback for a session whose choice predates this mount.
  const busView = useSyncExternalStore(viewSelectionBus.subscribe, () => viewSelectionBus.getSnapshot().view, () => viewSelectionBus.getSnapshot().view)
  const selectedId = busView ?? useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewRequest = useStore(s => s.viewRequest ?? null)

  useEffect(() => {
    const unbindDraftPersistence = bindDraftPersistence(actions.setDraft)
    inputActions.persistDraft()
    return () => { unbindDraftPersistence() }
    // The Session input owns content before this persistence writer is attached.
  }, [inputActions])

  // A blank session shows no message area — the hero owns the screen. The run
  // log is the exception: it is a standing reading of the session, not a list
  // of messages, so switching to it must work on an empty session too (its
  // empty state IS the reading: nothing has happened yet). Chat keeps the
  // official behaviour — a blank session has no transcript to show.
  const blankViewsNothing = session.blank && conversationPhase(session, conversation) === 'blank'
  const viewId = view ?? active?.id
  if (blankViewsNothing && viewId !== 'run-log') return null
  return (
    <div className={css.viewArea} data-conversation-view={viewId}>
      {viewId !== undefined && renderSlot('conversation.view', {
        inspectCall,
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
      }, { only: viewId })}
    </div>
  )
}
