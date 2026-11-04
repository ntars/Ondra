/**
 * Run log plugin, browser half: registers 「运行日志」 as a conversation view.
 *
 * The registration rides the platform's own `conversation.view` slot, so the
 * log is a peer of Chat inside the same column: switching to it swaps only the
 * middle column, leaving the session list and the status column untouched. That
 * is the whole reason to build it here rather than as a second surface — the
 * view ring is the product's existing answer to "what else can this column
 * show", and a new reading of the same session belongs in it.
 *
 * The rows come from the Session binding's contiguous event window — the same
 * durable evidence Conversation assembles from. Nothing is subscribed here: the
 * view reads and subscribes through the source, so a log that is not on screen
 * costs no work.
 */
import type { Context as ClientContext } from '@ntars/cordis'
import type { SessionId } from '@ntars/ondra-session/types'
// Type-only: pulls the Conversation view slot and its locale seat merge.
import type {} from '@ntars/ondra-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@ntars/ondra-client-locale/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@ntars/ondra-client-ui-renderer/client'
// Type-only: pulls the sessions service's Context merge (ctx.sessions).
import type {} from '@ntars/ondra-api-session-controller/client'
import { RunLogView, type RunLogInjected } from './RunLogView.tsx'
import type { RunLogRecord, RunLogSource } from './entries.ts'
import { en, zh, type RunLogKey } from './locales.ts'

export { RunLogView } from './RunLogView.tsx'
export { deriveRunLog } from './entries.ts'
export type { RunLogCategory, RunLogEntry, RunLogLine, RunLogRecord, RunLogSource } from './entries.ts'
export type { RunLogKey } from './locales.ts'

declare module '@ntars/ondra-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The run log's copy. */
    runLog: RunLogKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'runLog'

/** Slot id of the log inside the conversation's view ring. */
export const RUN_LOG_VIEW_ID = 'run-log'

/** Required services: the view ring, the copy, and the Session event windows. */
export const inject = ['slots', 'locale', 'sessions']

/**
 * The Session's event window as the log reads it.
 *
 * The binding is already retained by whoever opened the Session; a missing one
 * means the column has no session to read, which the view renders as its empty
 * state rather than as an error.
 * @param ctx - client root context.
 * @param sessionId - the session this view belongs to.
 * @returns the window source, or an empty window when the binding is gone.
 */
function eventWindowOf(ctx: ClientContext, sessionId: SessionId): RunLogSource {
  const source = ctx.sessions.binding(sessionId)?.eventSource
  if (source !== undefined) return source
  const empty = { entries: [] as readonly RunLogRecord[] }
  return { getSnapshot: () => empty, subscribe: () => () => {} }
}

/**
 * Client plugin body: one conversation-view entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-run-log: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: RUN_LOG_VIEW_ID,
    order: 20,
    locale: NS,
    label: () => t('view.runlog'),
    inject: (sessionId: SessionId): RunLogInjected => ({ hooks: { feed: eventWindowOf(ctx, sessionId) } }),
  }, RunLogView))
}
