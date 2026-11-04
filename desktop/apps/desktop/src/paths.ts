/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveOndraHome } from '@ntars/ondra-home-paths'

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
 * guarantees that a co-installed `ondra` can never claim Ondra's lock or vice
 * versa.
 * @param home - Ondra data root; defaults to the resolved `$ONDRA_HOME`.
 * @returns the absolute Electron userData directory.
 */
export function resolveDesktopUserData(home: string = resolveOndraHome()): string {
  return join(home, 'electron')
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param ondraHome - Ondra data root, owned exclusively by this product.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(ondraHome: string = resolveOndraHome()): DesktopPaths {
  return {
    profile: join(ondraHome, 'profiles', 'desktop'),
    lock: join(ondraHome, 'profiles', 'desktop', 'lock'),
  }
}
