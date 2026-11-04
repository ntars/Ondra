/** Business-owned mappings into the keyed Workspace Toast slot. */
import type { Context } from '@ntars/cordis'
import type { PropsRuntime } from '@ntars/ondra-client-ui-slots'
import type { RowToastActions } from '../contract/slots.ts'
import type { ToastDisplayInjected } from '../contract/toast.ts'
import { ToastEntry, WorkspaceToast } from './Toast.tsx'

/** Register notice presentations with their business-owned display fields and actions.
 * @param ctx - Workspace plugin context.
 * @param actions - Source-opening callbacks.
 */
export function registerToasts(
  ctx: Context,
  actions: Pick<RowToastActions, 'openForkSource'>,
): void {
  ctx.slots.registerFactory({ name: 'workspace.toast.content', scope: 'root' }, WorkspaceToast)
  ctx.slots.inject('workspace.toast', function* () {
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sessionIdCopied', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sessionIdCopied'> => ({
        display: (_notice, t) => ({ text: t('toast.sessionIdCopied'), tone: 'success' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopied'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sessionIdCopyFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sessionIdCopyFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.sessionIdCopyFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopyFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'pinFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'pinFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.pinFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'pinFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'unpinFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'unpinFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.unpinFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'unpinFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'deleteFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'deleteFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.deleteFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'deleteFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'defaultWorkspaceFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'defaultWorkspaceFailed'> => ({
        display: (_notice, t) => ({ text: t('defaultWorkspace.failed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'defaultWorkspaceFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'shortcutForkFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'shortcutForkFailed'> => ({
        display: (notice, t) => ({
          text: t(notice.reason === 'unavailable' ? 'shortcut.noCompletedTurn' : 'shortcut.forkFailed'), tone: 'plain',
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'shortcutForkFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'createFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'createFailed'> => ({
        display: (notice, t) => ({ text: t('toast.createFailed', { message: notice.message }), tone: 'warning', holdMs: 6000 }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'createFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'forkRequiresOpen', locale: 'workspace',
      inject: (): ToastDisplayInjected<'forkRequiresOpen'> => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.forkRequiresOpen'), tone: 'warning', holdMs: 6000,
          actions: [{ label: t('toast.openForkSource'), onClick: () => { dismiss(); actions.openForkSource(notice.sessionId) } }],
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'forkRequiresOpen'>>)
  })
}
