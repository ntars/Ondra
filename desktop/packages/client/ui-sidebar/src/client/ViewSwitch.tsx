/**
 * The column's two-view switch: 「对话 / 日志」.
 *
 * WHAT IT SWITCHES. Only the middle column. Choosing 日志 turns the conversation
 * into the run log and back; the session list on the left and the status column
 * on the right stay exactly as they are. That is the demo's contract, and it is
 * also the honest one — the two halves are two readings of the SAME session, so
 * nothing about who you are talking to changes when you look at what she did.
 *
 * HOW. The conversation package publishes `conversationViewSelection` (see its
 * `apply`), which reports the visible session's current view and switches it by
 * id. This switch reads that store and writes through it, so the lit half is
 * the session's real view rather than local state — a reload keeps it.
 *
 * Before any session is open there is nothing to switch: the store reports no
 * view, and the control renders disabled instead of pretending to work.
 *
 * A radiogroup rather than two buttons: the pair is one choice, so a screen
 * reader hears "1 of 2" and arrows between them instead of tabbing through two
 * unrelated toggles.
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './ViewSwitch.module.css'

/** The two readings this switch chooses between. */
export type SidebarView = 'chat' | 'run-log'

/** The slice of the conversation's view-selection service this control needs. */
export interface ViewSelectionSource {
  readonly getSnapshot: () => { readonly view: string | null }
  readonly subscribe: (listener: () => void) => () => void
  readonly select: (viewId: string) => void
}

/** Props: the copy for both halves and the selection service. */
export interface ViewSwitchProps {
  readonly chatLabel: string
  readonly logLabel: string
  /** The conversation's view selection, or undefined where no session surface exists. */
  readonly selection: ViewSelectionSource | undefined
}

/** View id of the conversation's own reading. */
const CHAT_VIEW = 'chat'

/** View id of the run log; must match ui-run-log's registration. */
const RUN_LOG_VIEW = 'run-log'

/**
 * Render the two-view switch.
 * @param props - the two labels and the selection service.
 * @returns the segmented control.
 */
export function ViewSwitch({ chatLabel, logLabel, selection }: ViewSwitchProps): ReactNode {
  const source = selection ?? NO_SELECTION
  const current = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  // No view reported means no session is open, so neither half can be chosen.
  const enabled = current.view !== null
  // The log is lit when the session shows anything that is not Chat: the view
  // ring may hold more entries later, and they are all "not the chat" here.
  const showingLog = enabled && current.view !== CHAT_VIEW
  // Neither half is lit without a session: a disabled control that still
  // claims "chat is selected" would tell a screen reader the user chose a
  // reading they have not chosen yet.
  const halves: readonly { readonly id: SidebarView; readonly label: string; readonly lit: boolean }[] = [
    { id: 'chat', label: chatLabel, lit: enabled && !showingLog },
    { id: 'run-log', label: logLabel, lit: enabled && showingLog },
  ]
  return (
    <div
      className={css.root}
      role="radiogroup"
      // The stylesheet draws the travelling pill behind the two halves and keys its
      // position off this attribute: `[data-active='run-log']` slides it right, any
      // other value parks it under 对话, and its absence hides it entirely. Omitting
      // the attribute with no session open is what keeps the pill from sitting under
      // a half nobody picked.
      data-active={enabled ? (showingLog ? RUN_LOG_VIEW : CHAT_VIEW) : undefined}
    >
      {halves.map(({ id, label, lit }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={lit}
          disabled={!enabled}
          className={clsx(css.half, lit && css.halfActive)}
          onClick={() => { source.select(id === 'chat' ? CHAT_VIEW : RUN_LOG_VIEW) }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * The stand-in source used before the conversation package is present: it
 * reports no view and accepts no selection, which renders the switch disabled
 * rather than throwing.
 *
 * The snapshot is ONE frozen object because `useSyncExternalStore` compares
 * successive snapshots by identity: a fresh `{ view: null }` on every read
 * looks like a change, so React re-renders forever and the column dies with
 * "Maximum update depth exceeded".
 */
const NO_VIEW = Object.freeze({ view: null }) as { readonly view: null }

const NO_SELECTION: ViewSelectionSource = {
  getSnapshot: () => NO_VIEW,
  subscribe: () => () => {},
  select: () => {},
}
