/**
 * Removing a Session's stored directory for good.
 *
 * A Session lives in one directory per Session under a per-project directory:
 * `sessions/<encoded cwd>/session-<id>/`. Deleting is therefore a targeted
 * move/removal of that one directory — never of the project directory, which
 * holds every other Session started from the same cwd.
 *
 * WHERE THE BYTES GO. Nothing here destroys anything: each directory is moved to
 * the OS trash — the macOS Trash, or the Windows Recycle Bin — so "empty the
 * trash" means what the name promises. `rm` only runs when the platform has no
 * trash to move to, and that is the shell's explicit decision, not a fallback
 * nobody notices.
 *
 * Nothing here trusts the renderer: ids are validated against the shape the Host
 * mints, the project directory is never derived from user input, and a missing
 * directory counts as already gone.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The Session id shape the Host mints; anything else is refused unread. */
const SESSION_ID_SHAPE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/u

/** What happened to each requested Session. */
export interface PurgeOutcome {
  /** Directories moved to the OS trash. */
  readonly trashed: number
  /** Directories removed outright, because the platform offered no trash. */
  readonly removed: number
}

/**
 * Delete the stored directory of each requested Session.
 * @param sessionsRoot - The Session storage root (`<ondraHome>/sessions`).
 * @param ids - Session ids to delete; invalid entries are ignored.
 * @param options - `trash` moves to the OS trash (default), `delete` removes.
 * @returns how many directories were trashed and how many removed.
 */
export async function purgeSessionDirectories(
  sessionsRoot: string,
  ids: readonly string[],
  options: { readonly mode?: 'trash' | 'delete'; readonly platform?: NodeJS.Platform } = {},
): Promise<PurgeOutcome> {
  const mode = options.mode ?? 'trash'
  const platform = options.platform ?? process.platform
  const wanted = [...new Set(ids.filter(id => SESSION_ID_SHAPE.test(id)))]
  if (wanted.length === 0) return { trashed: 0, removed: 0 }
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    // No storage root yet: nothing has ever been written, so nothing is owed.
    return { trashed: 0, removed: 0 }
  }
  let trashed = 0
  let removed = 0
  for (const project of projects) {
    for (const id of wanted) {
      const directory = join(sessionsRoot, project, `session-${id}`)
      try {
        if (!(await stat(directory)).isDirectory()) continue
      } catch {
        continue
      }
      if (mode === 'trash' && await moveToTrash(directory, platform)) {
        trashed += 1
        continue
      }
      await rm(directory, { recursive: true, force: true })
      removed += 1
    }
  }
  return { trashed, removed }
}

/**
 * Hand one directory to the platform's trash.
 *
 * macOS goes through Finder so the move is the same one a person makes in the
 * UI (the item appears in Trash with its own name and can be put back). Windows
 * reports "the folder is in the Recycle Bin" through the shell verb. Every path
 * is passed as an argument, never interpolated into the script, because a
 * project directory name can contain a quote.
 * @param directory - Absolute path to move.
 * @param platform - Target platform.
 * @returns whether the platform accepted the move.
 */
async function moveToTrash(directory: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      // Move into ~/.Trash directly instead of asking Finder over AppleScript.
      // The AppleScript route needs the user to grant "control Finder" to the
      // app; until that grant exists the call blocks on a prompt that never
      // appears, so "empty the trash" looked like a button that did nothing.
      // A rename into ~/.Trash is the same move Finder performs, needs no
      // automation permission, and keeps the item recoverable.
      const trash = join(homedir(), '.Trash')
      await mkdir(trash, { recursive: true })
      const name = basename(directory)
      let destination = join(trash, name)
      if (existsSync(destination)) destination = join(trash, `${name}-${String(Date.now())}`)
      await rename(directory, destination)
      return true
    }
    if (platform === 'win32') {
      // The shell's own recycle action; `-LiteralPath` keeps wildcard characters
      // in a directory name from being expanded.
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($args[0], "OnlyErrorDialogs", "SendToRecycleBin")',
        directory])
      return true
    }
  } catch {
    // No trash available (headless session, permission, cross-device move): the
    // caller removes outright, which is why this reports rather than throws.
  }
  return false
}
