/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under the Ondra home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve the Electron `userData` directory Ondra owns.
 *
 * Electron otherwise derives `userData` from the application name, so every
 * rename of the product silently created a new `Application Support`
 * directory and orphaned the previous profile, cookies, and local storage.
 * Pinning it inside the Ondra home makes the location independent of branding
 * and, because Electron keys the single-instance lock on `userData`, also
 * guarantees that a co-installed `dsh` can never claim Ondra's lock or vice
 * versa.
 * @param home - Ondra data root; defaults to the resolved `$ONDRA_HOME`.
 * @returns the absolute Electron userData directory.
 */
export function resolveDesktopUserData(home: string = resolveDshHome()): string {
  return join(home, 'electron')
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Ondra data root, owned exclusively by this product.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', 'desktop'),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}
