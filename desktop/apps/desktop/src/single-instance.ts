/** Electron single-instance ownership before any Desktop profile lifecycle begins. */

/** Minimal Electron application operations needed for instance ownership. */
export interface DesktopSingleInstanceApplication {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: () => void): unknown
}

/**
 * Claim the process-lifetime Desktop lock and route later launches to the owner.
 *
 * Electron keys the lock on `userData`, so the identity of "this application"
 * is whatever `main.ts` pinned before this call. That pin makes the identity
 * structural rather than incidental: a co-installed `dsh` resolves its own
 * userData and therefore its own lock, so neither application can evict the
 * other, and a branding change no longer silently moves the lock to a new
 * location while an older instance is still running.
 * @param application - Electron application singleton.
 * @param focusOwner - focus or recreate the primary window after a later launch.
 * @returns true only in the process that may access the Desktop profile.
 */
export function claimDesktopSingleInstance(
  application: DesktopSingleInstanceApplication,
  focusOwner: () => void,
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit()
    return false
  }
  application.on('second-instance', focusOwner)
  return true
}
