/** Sidebar-owned commands resolved against the currently mounted page. */
import type { Shortcuts, ShortcutBinding, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightController } from './service.ts'
import type {} from './locales.ts'

/**
 * Register the sidebar commands over the controller used by its visible controls.
 *
 * The set is exactly the operations a control can start: splitting the focused
 * pane, and closing or refreshing the focused page. Closing and refreshing also
 * fall back to the window, and to the modal stack, when focus is elsewhere.
 * Nothing here can collapse the column or change its presentation, because the
 * third column is permanent: a command for either would appear in the shortcut
 * catalogue and then do nothing.
 * @param shortcuts - effective-binding registry for this window.
 * @param sidebar - current Session and page owner.
 * @param t - current localized command and unavailable labels.
 * @param closeWindow - private native close operation using the current configuration revision.
 * @returns release callback for the commands.
 */
export function registerSidebarShortcuts(shortcuts: Pick<Shortcuts, 'register' | 'runtime'>, sidebar: SidebarRightController,
  t: TranslateNS<'sidebarRight'>, closeWindow: () => void): () => void {
  const splitBinding: ShortcutBinding = { code: 'Backslash', modifiers: ['primary'] }
  const disposers = [shortcuts.register({
    id: 'pane.split' as ShortcutCommandId, label: () => t('dock.splitPane'), aliases: ['split', 'panel'],
    defaults: { 'desktop:macos': splitBinding, 'desktop:windows': splitBinding, 'desktop:linux': splitBinding,
      'web:macos': splitBinding, 'web:windows': splitBinding },
    regions: ['page', 'editable', 'terminal'], modals: [],
    resolve: ({ target: element }) => {
      const target = sidebar.focusedTarget(element)
      if (target === undefined) return { status: 'blocked', reason: t('command.noFocus') }
      const block = sidebar.splitBlock(target)
      if (block !== undefined) return { status: 'blocked', reason: t(`command.${block}`) }
      return { status: 'handled', run: () => {
        if (sidebar.isTargetCurrent(target)) sidebar.split(target.paneId)
      } }
    },
  })]
  for (const kind of ['close', 'refresh'] as const) {
    const desktop: ShortcutBinding = { code: kind === 'close' ? 'KeyW' : 'KeyR', modifiers: ['primary'] }
    const web: ShortcutBinding = { ...desktop, modifiers: ['primary', 'alt'] }
    disposers.push(shortcuts.register({
      id: `page.${kind}` as ShortcutCommandId, label: () => t(`command.${kind}`), aliases: [kind, 'page'],
      defaults: { 'desktop:macos': desktop, 'desktop:windows': desktop, 'desktop:linux': desktop,
        'web:windows': web, ...(kind === 'close' ? { 'web:macos': web } : {}) },
      regions: ['page', 'editable', 'terminal'], modals: kind === 'close' ? ['settings', 'shortcuts', 'other'] : [],
      resolve: ({ target: element, source, modal }) => {
        if (kind === 'close' && modal !== null) {
          return { status: 'handled', run: () => { closeTopModal(document) } }
        }
        const target = sidebar.focusedTarget(element)
        if (target === undefined && (source === 'iframe' || element?.closest('[data-sidebar-right-session]'))) {
          return { status: 'blocked', reason: t('command.stale') }
        }
        if (kind === 'refresh') {
          const refresh = target?.occurrence?.commands.refresh
          if (target === undefined || refresh === undefined) return { status: 'blocked', reason: t('command.noRefresh') }
          return { status: 'handled', run: () => {
            if (sidebar.isTargetCurrent(target) && target.occurrence?.commands.refresh === refresh) refresh()
          } }
        }
        if (target !== undefined && sidebar.canCloseTarget(target)) {
          return { status: 'handled', run: () => { sidebar.closeTarget(target) } }
        }
        if (shortcuts.runtime !== 'desktop') return { status: 'blocked', reason: t('command.noFocus') }
        return { status: 'handled', run: () => {
          if (target === undefined || sidebar.isTargetCurrent(target)) closeWindow()
        } }
      },
    }))
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
