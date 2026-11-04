/**
 * The guide tab's identity, the page-address scheme, and default page selection.
 *
 * These live in the contract because two sides need them and neither may read
 * the other: the store seeds new panes from the registry, and the guide
 * domain registers the type under the same kind.
 *
 * The docking kit treats `kind` as opaque, so these strings mean something only
 * here and in the registry. Both types go through the same two stages any other
 * type would use — the guide is not special in the machinery, only in being
 * always available.
 */
import type { SidebarRightTabRegistry } from '../tab-registry.ts'

/** One pane's initial page, resolved from the current registered guide entries. */
export interface SidebarRightSeed {
  readonly kind: string
  readonly title: string
}

/**
 * Resolve the default page a pane opens on.
 *
 * The status page wins whenever it is registered: a new Session should answer
 * "how is she right now" immediately, not ask the person to pick a page first.
 * The guide is a launcher behind the strip's add control, so offering it as the
 * opening content put a menu where an answer belongs. Only a build with no
 * status type falls back to the single guide entry, then to the guide.
 * @param tabs - current tab registry.
 * @returns the status page, or the sole entry, or the guide.
 */
export function defaultSeed(tabs: SidebarRightTabRegistry): SidebarRightSeed {
  const [only, ...others] = tabs.guide()
  const single = only !== undefined && others.length === 0
  const kind = tabs.get(STATE_KIND) !== undefined
    ? STATE_KIND
    : (single ? only.kind : GUIDE_KIND)
  const definition = tabs.get(kind)
  if (definition === undefined) throw new Error(`sidebarRight: default tab kind "${kind}" is not registered`)
  return { kind, title: definition.title(pageAddress(kind)) }
}

/** The guide tab's kind. */
export const GUIDE_KIND = 'guide'

/**
 * The status page's kind: the column's resting content.
 *
 * It sits beside the guide rather than replacing it — the guide stays the
 * launcher behind the strip's add control, while the status page is what a
 * session opens on. `defaultSeed` prefers a single guide entry over the guide
 * itself, so the status type also contributes one entry; that way a product
 * that ships no other type opens on the status page without any special case
 * in the seed.
 */
export const STATE_KIND = 'state'

/**
 * The address a page tab is recorded under: `sidebar://<kind>`. The scheme is
 * this package's bookkeeping for `openTab`, spelled here and nowhere else; a
 * caller names the kind and never sees or composes the address.
 * @param kind - the page type's kind.
 * @returns the page's address.
 */
export function pageAddress(kind: string): string {
  return `sidebar://${kind}`
}
