/**
 * Path canonicalization for workspace identity.
 * @module @ntars/ondra-workspace/src/paths
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, posix, win32 } from 'node:path'

/**
 * Check whether a path names one fixed Host location without process cwd or
 * current-drive resolution.
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is fully qualified on that platform.
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Derive a non-empty default title from a canonical Workspace path.
 * @param path - Canonical Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns The final segment when present, otherwise the complete root spelling.
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * Canonicalize a fully qualified directory path via `fs.realpath`: trailing
 * slashes, `..` segments, and symlinks are all resolved. This is the ONE
 * uniqueness canon of the package — workspace paths are stored canonicalized,
 * uniqueness is string equality of canonicalized paths (a symlink to an
 * existing workspace's directory collides), and attach-time session `cwd`
 * checks go through the same canon. Relative paths reject before `realpath` can
 * resolve them from the Host cwd or current Windows drive. A path that does not
 * exist rejects with the original `ENOENT` — this is `create`'s reject path (a
 * workspace must point at an existing directory).
 * @param path - The path to canonicalize.
 * @returns the canonical absolute path.
 */
export async function realpathNormalize(path: string): Promise<string> {
  if (!fullyQualifiedWorkspacePath(path)) {
    throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
  }
  return await realpath(path)
}

/** Exact spelling of a per-day conversation bucket: `YYYY-MM-DD`. */
const DAY_BUCKET_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Project a Session's canonical cwd onto the Workspace that owns it.
 *
 * A Workspace is a root, not a leaf: the Session controller opens a new
 * conversation in a `YYYY-MM-DD` bucket directly under that root so one fixed
 * Workspace stays browsable by date. Membership therefore cannot be string
 * equality — a Session running in today's bucket belongs to the root exactly
 * as much as one running in the root itself. Only that one shape is accepted:
 * an arbitrary subdirectory is a different working directory, not a bucket,
 * and must not silently become member of the parent.
 * @param root - Canonical Workspace path.
 * @param cwd - Canonical Session working directory.
 * @returns the owning root, or `undefined` when `cwd` is not inside `root`.
 */
export function workspaceMemberPath(root: string, cwd: string): string | undefined {
  if (cwd === root) return root
  if (dirname(cwd) === root && DAY_BUCKET_PATTERN.test(basename(cwd))) return root
  return undefined
}
