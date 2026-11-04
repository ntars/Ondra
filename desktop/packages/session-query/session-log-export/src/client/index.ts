/** Browser plugin owning ZIP download and Markdown copy state, plus feedback controls. */

import type { Context as ClientContext } from '@ntars/cordis'
import type { SessionId } from '@ntars/ondra-session/types'
import type {} from '@ntars/ondra-client-locale/client'
import type {} from '@ntars/ondra-client-ui-commands/client'
import type {} from '@ntars/ondra-client-ui-conversation/client'
import type {} from '@ntars/ondra-client-ui-renderer/client'
import type {} from '@ntars/ondra-client-ui-session/client'
import type {} from '@ntars/ondra-client-ui-message-feedback/client'
import { createSnapshotStore } from '@ntars/ondra-client-store'
import { SessionLogDownloadController } from './controller.ts'
import { SessionMarkdownCopyController } from './copy-controller.ts'
import { SessionMarkdownCopyToast, type SessionMarkdownCopyToastInjected } from './CopyToast.tsx'
import { SessionLogDownloadHeaderAction, type SessionLogDownloadHeaderInjected } from './HeaderAction.tsx'
import { en, NS, zh, type SessionLogDownloadKey } from './locales.ts'

declare module '@ntars/cordis' {
  interface Context {
    sessionLogDownload: SessionLogDownloadController
  }
}

declare module '@ntars/ondra-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-log-download': SessionLogDownloadKey
  }
}

export type { SessionLogDownloadEntry, SessionLogDownloadState } from './controller.ts'

export const inject = ['slots', 'locale']

/**
 * Provide the download controller and mount its modal, the Markdown copy
 * controller and its root toast, and both Header actions.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionLogDownloadController()
  const copyController = new SessionMarkdownCopyController()
  ctx.provide('sessionLogDownload', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-log-download: browser download lifecycle')
  ctx.effect(() => async () => { await copyController.dispose() }, 'session-log-download: browser Markdown copy lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-log-download: browser dictionaries')
  const feedbackAvailable = createSnapshotStore(false)
  ctx.inject(['feedbackUi'], (scope: ClientContext) => {
    scope.effect(() => {
      feedbackAvailable.set(true)
      return () => { feedbackAvailable.set(false) }
    }, 'session-log-download: feedback availability')
  })
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName === 'export' && result.kind === 'success') void controller.download(sessionId)
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-log-download.copy-toast',
    locale: NS,
    inject: (): SessionMarkdownCopyToastInjected => ({
      hooks: { sessionMarkdownCopy: copyController.store },
      dismiss: () => { copyController.dismiss() },
    }),
  }, SessionMarkdownCopyToast))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',
    locale: NS,
    inject: (): SessionLogDownloadHeaderInjected => ({
      hooks: {
        sessionLogDownload: controller.store,
        sessionMarkdownCopy: copyController.store,
        feedbackAvailable,
      },
      request: (sessionId: SessionId) => controller.download(sessionId),
      copyMarkdown: (sessionId: SessionId) => copyController.copy(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      // The feedback plugin can unload between the menu render and this click.
      openFeedback: (sessionId: SessionId) => { ctx.get('feedbackUi')?.openSession(sessionId) },
    }),
  }, SessionLogDownloadHeaderAction))
}

export type { SessionLogDownloadDialogInjected, SessionLogDownloadDialogProps } from './Dialog.tsx'
