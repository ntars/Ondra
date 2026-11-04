/**
 * Owner-side Liveshare Web bundle plugin.
 * @module @ntars/ondra-experimental-liveshare
 */

export { apply, name, inject, type Config } from './host/share-host.ts'
export { LiveshareShares } from './host/share-remote.ts'
export {
  ViewerDeclarations,
  viewerDeclarationsOf,
  type ViewerDeclarationsSurface,
} from './host/viewer-declarations.ts'

import type { LiveshareShares } from './host/share-remote.ts'

declare module '@ntars/cordis' {
  interface Context {
    /** Owner share management served to the owner page over Typert Remote. */
    liveshareShares: LiveshareShares
  }
}
