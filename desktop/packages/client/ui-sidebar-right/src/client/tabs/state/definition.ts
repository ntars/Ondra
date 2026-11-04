/**
 * Stage one of the status tab's registration: what it IS.
 *
 * The status page is the right column's resting content — the column's whole
 * job is answering "how is she right now", and before this type existed the
 * column opened on the guide instead, which is a launcher rather than an
 * answer. It is a page type in the `builtin` band: it recognizes no resource
 * address (it views no file), takes no parameters, and keeps exactly one page
 * per pane.
 */
import type { TranslateNS } from '@ntars/ondra-client-locale/client'
import type { SidebarRightTabDefinition } from '../../tab-registry.ts'
import { STATE_KIND } from '../../contract/seed.ts'
import { StateGlyph } from './StateGlyph.tsx'

/** This implementation's identity: the key its body and chip title register under. */
export const STATE_ID = '@ntars/ondra-client-ui-sidebar-right/state'

/**
 * The status type's registry definition.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register.
 */
export function stateDefinition(t: TranslateNS<'sidebarRight'>): SidebarRightTabDefinition {
  return {
    id: STATE_ID,
    kind: STATE_KIND,
    priority: 'builtin',
    title: () => t('tab.state.title'),
    guide: [{
      id: 'state',
      order: 0,
      title: () => t('tab.state.title'),
      description: () => t('tab.state.description'),
      icon: StateGlyph,
    }],
  }
}
