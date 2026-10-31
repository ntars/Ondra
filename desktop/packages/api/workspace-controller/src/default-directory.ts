/** Resolve the one Workspace root Ondra owns: `$ONDRA_HOME/workspace`. */

import { posix, win32 } from 'node:path'
import { ONDRA_HOME_DIR_NAME, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { DEFAULT_WORKSPACE_DIRECTORY } from './default-workspace.ts'

/**
 * Leaf directory name of the Workspace under the Ondra data root.
 *
 * Re-exported from {@link DEFAULT_WORKSPACE_DIRECTORY} rather than repeated, so
 * the directory the Host creates and the automatic-title sentinel that browser
 * consumers compare against cannot disagree.
 */
export const WORKSPACE_DIRECTORY_NAME = DEFAULT_WORKSPACE_DIRECTORY

/** Platform observations replaceable in directory-resolution tests. */
interface DocumentsDirectoryInternals {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly run?: NativeCommandRunner
}

/**
 * Validate a configured or OS-returned path without resolving it against cwd.
 * @param directory - fully qualified directory spelling.
 * @param platform - Host platform.
 * @returns the normalized directory.
 */
export function validateDocumentsDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix
  const root = paths.parse(directory).root
  if (!paths.isAbsolute(directory) || (platform === 'win32' && (root === '\\' || root === '/'))) {
    throw new Error(`Documents directory must be fully qualified: '${directory}'`)
  }
  return paths.normalize(directory)
}

/**
 * Resolve the fixed Workspace root on the Host without creating files.
 *
 * The Workspace is not user-selectable. It always lives at
 * `$ONDRA_HOME/workspace` and the reader never offers a picker, so every
 * Session on this installation shares one predictable tree and a later launch
 * resolves the same default instead of relocating it.
 *
 * The root comes from {@link resolveDshHome} rather than a second read of the
 * environment: two independent parses of one variable could disagree and send
 * the Workspace to a different tree than the profiles and sessions it belongs
 * to. Because that resolver only honours `$ONDRA_HOME`, a co-installed upstream
 * `dsh` — which owns its own `$DSH_HOME` and Documents-based directory — can
 * never redirect or share this tree.
 * @param _documentsDirectory - deprecated and ignored; the root is fixed.
 * @param signal - caller lifetime; checked before resolving.
 * @param internals - platform facts; `home` pins the data root for tests.
 * @returns the absolute Workspace root.
 */
export function defaultWorkspaceDirectory(
  _documentsDirectory: string | undefined,
  signal: AbortSignal,
  internals: DocumentsDirectoryInternals = {},
): Promise<string> {
  // Resolution is synchronous now that the OS lookup is gone, but the contract
  // stays a Promise so callers may join it with their own cancellation and a
  // rejection still reaches their `await` instead of throwing past it.
  return Promise.resolve().then(() => {
    signal.throwIfAborted()
    const platform = internals.platform ?? process.platform
    const paths = platform === 'win32' ? win32 : posix
    const root = internals.home === undefined
      ? resolveDshHome()
      : paths.join(internals.home, ONDRA_HOME_DIR_NAME)
    return paths.join(root, WORKSPACE_DIRECTORY_NAME)
  })
}

/** The legacy Documents-based leaf name, kept for existing importers. */
export { DEFAULT_WORKSPACE_DIRECTORY }
