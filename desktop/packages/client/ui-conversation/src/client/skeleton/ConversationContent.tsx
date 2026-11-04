import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { WorkspaceId } from '@ntars/ondra-workspace/types'
import { workspaceDisplayTitle } from '@ntars/ondra-api-workspace-controller/default-workspace'
import type { ConversationContentProps, ConversationViewsProps, InputZone } from '../contract/slots.ts'
import { HeroShell, workspaceLabel } from './EmptyHero.tsx'
import { viewSelectionBus } from '../view-selection-bus.ts'
import css from './ConversationRoot.module.css'

function ConversationSessionView({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', {})
}

function NoConversationWidthControls() {
  return null
}

/**
 * Render the shared Conversation body and its occurrence-selected local Components.
 * @param props - Factory input, standard Session sources, and Conversation seats.
 * @returns the Conversation view, Composer, and optional width controls.
 */
export function ConversationContent(props: ConversationContentProps) {
  const {
    sessionId, phase, hero, useSession, useSessions, useSessionStatus,
    useWorkspaces, useInput, useComposerBlock, renderSlot, renderSlotChain,
    selectWorkspace, t, useFactorySlot,
  } = props
  const session = useSession(snapshot => snapshot)
  const Views = useFactorySlot('views', ConversationSessionView)
  const WidthControls = useFactorySlot('widthControls', NoConversationWidthControls)
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const pendingInteraction = useSessionStatus(snapshot =>
    sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction)
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const workspaces = useWorkspaces(s => s)
  // A plugin this package cannot import (ui-model-selection) says this session cannot
  // send; its reason is already localized by whoever raised it.
  const composerBlock = useComposerBlock(block => block)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  // Publishes the two live measurements floating View chrome reads off the
  // scroll body: the seat's height as --ondra-composer-height, so controls clear
  // the composer as it grows, and the scrollport's own height as
  // --ondra-conversation-viewport-height, so a control can sit in the band the
  // seat leaves visible. Callback ref, not an effect; stable identity prevents
  // observer churn while the first blank session fills the resident body
  // outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--ondra-composer-height', `${seat.offsetHeight}px`)
      scroller.style.setProperty(
        '--ondra-conversation-viewport-height',
        `${scroller.clientHeight}px`,
      )
    })
    seatObserver.current.observe(seat)
    seatObserver.current.observe(scroller)
  }, [])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  // Clear the pending pick once the session lands in it, or when the picked
  // workspace disappears from a ready list (deleted from the sidebar).
  useEffect(() => {
    if (pendingWorkspaceId === undefined) return
    if (sessionWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace])

  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // The chip is a selector; label resolution walks the flow top-down:
  //   1. a just-picked workspace (pending) → its title;
  //   2. cold start, no session yet → placeholder ("Choose workspace");
  //   3. the blank session's workspace is in the list → its title;
  //   4. list still loading → cwd folder name bridges so the title does not
  //      flash on refresh (empty cwd → placeholder);
  //   5. list ready but no owning workspace (deleted from the sidebar) →
  //      placeholder, never the deleted folder's name via cwd.
  // A title still automatic reads in the reader's language, matching the
  // sidebar row the same Workspace has there.
  const storedChipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : sessionWorkspace?.title
        ?? (workspaces.phase === 'ready' || cwd === undefined || cwd === ''
          ? undefined
          : workspaceLabel(cwd)))
  const chipTitle = storedChipTitle === undefined
    ? undefined
    : workspaceDisplayTitle(storedChipTitle, t('workspace.defaultName'))


  // The placeholder chip ("Choose workspace") and the Workspace-trigger input travel
  // together: no workspace picked yet (cold start, no session at all), or a
  // blank session whose workspace vanished (deleted from the sidebar). The
  // bar is ONE session-maybe slot rendered unconditionally — inert is a prop,
  // not a different tree, so the textarea DOM survives the transition.
  const inert = sessionId === undefined || (hero && chipTitle === undefined)
  // A raised block is the same inert posture with the blocker's own reason:
  // one disabled textarea, never a second tree. The no-workspace state wins
  // when both hold — picking a workspace is the earlier prerequisite.
  const blocked = !inert && composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    variant: hero ? 'hero' : 'composer',
    ...(inert
      ? {
        disabled: true,
        placeholder: t('placeholder.workspace'),
        workspacePickerOpen: pickerOpen,
        onRequestWorkspace: () => { setPickerOpen(true) },
      }
      : blocked
        // `blocked`, not `disabled`: the bar refuses input either way, but a
        // block keeps the model seat live because choosing a model is how the
        // user clears it.
        ? { blocked: composerBlock, placeholder: composerBlock.reason }
        : hero ? { placeholder: t('placeholder.hero') } : {}),
  })

  const composerBar = (
    <div className={clsx(css.composerStack, hero && css.composerHero)}>
      {/* The hero is a floor group, not a top title: mark, name, and composer
          travel together at the bottom of the column, with the open space above
          them. The headline sits directly over the input card.
       *
       * The workspace CHIP is gone by instruction — choosing a workspace is a
       * setup step, and a companion app's first screen should offer a place to
       * speak rather than a folder to pick. What remains is a zero-height host
       * that keeps the picker's slot mounted (the embedding package renders the
       * picker there, and the composer's own workspace trigger opens it before a
       * workspace is chosen). The agent-preset chip keeps its seat in that host:
       * it is a real choice about who replies, it was never the folder control,
       * and hiding it would silently remove a capability the product still has. */}
      {/* The greeting owns the open space ABOVE the title: it flexes to fill
          everything between the column top and the floor group, centered, so
          the first screen reads greeting → mark+name → composer from top to
          bottom. */}
      {hero && (
        <div className={css.heroGreeting}>
          <p className={css.heroGreetingTitle}>{t('hero.greeting')}</p>
          <p className={css.heroGreetingBody}>{t('hero.greetingBody')}</p>
        </div>
      )}
      {hero && <HeroShell t={t} renderSlot={renderSlot} />}
      {hero && (
        <div className={css.heroWorkspaceHost}>
          {renderSlot('conversation.hero.workspace', {
            open: pickerOpen,
            anchorRef: pickerAnchor,
            selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
            onPick: (workspaceId) => {
              setPickerOpen(false)
              setPendingWorkspaceId(workspaceId)
              void selectWorkspace(workspaceId).catch(() => {
                setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
              })
            },
            onClose: () => { setPickerOpen(false) },
          })}
          {renderSlot('conversation.hero.agentPreset', {})}
          {sessionId === undefined ? null : <div className={css.heroOptions}>{renderSlot('conversation.hero.options', {})}</div>}
        </div>
      )}
      {zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {inputBar}
    </div>
  )

  const composer = renderSlotChain(
    'conversation.composer',
    { sessionId, session, pendingInteraction },
    { fallback: composerBar, fallbackOnly: sessionId === undefined, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave a business-owned takeover at the content
  // end off-screen when the user is not pinned to the floor.
  // The run log is a reading of the session, not a place to type into it: while
  // it is on screen the whole conversation surface — hero title, workspace host,
  // composer — stays out of the way so the log fills the column. Switching back
  // to 对话 brings all of it back, and only then does the column choose between
  // its empty state and a live conversation.
  const activeView = useSyncExternalStore(
    viewSelectionBus.subscribe,
    () => viewSelectionBus.getSnapshot().view,
    () => viewSelectionBus.getSnapshot().view,
  )
  const readingLog = activeView === 'run-log'
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="" data-conversation-region="composer">
      {composer}
    </div>
  )

  return (
    <div
      ref={setBody}
      className={clsx(css.body, props.variant === 'embedded' && css.embeddedBody)}
      data-conversation-content=""
      data-conversation-session={sessionId}
      data-conversation-region="chat"
      data-content-phase={phase}
    >
      {/* The seat is the scrollport's SIBLING, not its last child.
       *
       * As a sticky last child it only cleared content at the very end of the
       * scroll: everywhere else the transcript ran underneath it, and every
       * material used to separate the two was a lie — a painted band read as
       * "一块白" over the glass, and a painted ramp could not separate anything at
       * all because the page colour is 24% glass. As a sibling the column simply
       * ends where the composer begins: nothing can pass beneath it, so there is
       * nothing to mask, and the transcript keeps its full reading width.
       *
       * The seat stays mounted across phases (hero included), so a draft typed
       * on the title page survives the switch to a live conversation. */}
      <div className={css.scrollBody} data-conversation-scroll="">
        {sessionId === undefined ? null : <Views />}
      </div>
      {readingLog ? null : composerSeat}
      <WidthControls container={body} phase={phase} />
    </div>
  )
}
