/**
 * Shared filesystem path helpers for Ondra user data.
 *
 * Ondra is a rebranded fork of DeepSeek Harness and is frequently installed
 * beside the upstream `dsh` CLI. Every root below is owned exclusively by
 * Ondra: the directory names, the environment variables that relocate them,
 * and the derived agent-configuration root all differ from upstream, so no
 * `DSH_*` variable and no shared directory can redirect or alias Ondra data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default Ondra home under the OS home. */
export const ONDRA_HOME_DIR_NAME = '.ondra'

/** Stable user-facing display form for the default Ondra home. */
export const DEFAULT_ONDRA_HOME_DISPLAY = `~/${ONDRA_HOME_DIR_NAME}`

/** Environment variable that overrides the default Ondra home. */
export const ONDRA_HOME_ENV = 'ONDRA_HOME'

/**
 * Leaf directory name for the agent configuration root.
 *
 * It sits inside the Ondra home rather than under the OS home, because the
 * previous `~/.agents` location is shared with other agent tools: two products
 * reading and writing the same `AGENTS.md` and `skills/` tree would overwrite
 * each other's instructions.
 */
export const AGENTS_HOME_DIR_NAME = 'agents'

/** Stable user-facing display form for the default agent configuration root. */
export const DEFAULT_AGENTS_HOME_DISPLAY = `${DEFAULT_ONDRA_HOME_DISPLAY}/${AGENTS_HOME_DIR_NAME}`

/** Environment variable that overrides the default agent configuration root. */
export const AGENTS_HOME_ENV = 'ONDRA_AGENTS_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default Ondra home using Node's platform path rules.
 * @returns the absolute default Ondra home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), ONDRA_HOME_DIR_NAME)
}

/**
 * Resolve the default agent configuration root using Node's platform path rules.
 *
 * The root is nested inside the Ondra home so that a co-installed upstream
 * `dsh` can never read or rewrite the same instruction and skill files.
 * @returns the absolute default agent configuration root.
 */
export function defaultAgentsHome(): string {
  return join(defaultDshHome(), AGENTS_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve one user-data root from an explicit path, an environment override, and a default.
 * @param configured - explicit path, which has highest precedence.
 * @param env - environment mapping to read.
 * @param envName - environment variable that overrides the default.
 * @param fallback - default root, used when neither the explicit path nor the environment provides one.
 * @returns the normalized absolute root.
 */
function resolveRoot(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: () => string,
): string {
  const fromEnv = env[envName]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback())
  return resolve(expandHomePath(selected))
}

/**
 * Label one resolved user-data root symbolically for user-facing display.
 * @param resolvedRoot - absolute path returned by the matching resolver.
 * @param defaultRoot - absolute default root whose symbolic label applies to a match.
 * @param defaultLabel - symbolic label for the default root.
 * @param envName - environment variable name that labels any other root.
 * @returns the symbolic label.
 */
function rootDisplay(resolvedRoot: string, defaultRoot: string, defaultLabel: string, envName: string): string {
  return resolvedRoot === resolve(defaultRoot) ? defaultLabel : `$${envName}`
}

/**
 * Resolve the single-root Ondra home.
 *
 * Precedence, highest first: an explicit configured path, `$ONDRA_HOME`, then
 * `~/.ondra`. Ondra keeps all user data under one root. An empty or
 * whitespace-only `$ONDRA_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 *
 * Upstream's `$ONDRA_HOME` is deliberately not consulted: honouring it would
 * point this installation at a `dsh` data root, and the two products would
 * then read and overwrite each other's profiles and sessions.
 * @param configured - explicit home override, which has highest precedence.
 * @param env - environment mapping used to read `$ONDRA_HOME`.
 * @returns the normalized absolute Ondra home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, ONDRA_HOME_ENV, defaultDshHome)
}

/**
 * Resolve the agent configuration root.
 *
 * Precedence, highest first: an explicit configured path,
 * `$ONDRA_AGENTS_HOME`, then `~/.ondra/agents`. The root is owned by Ondra and
 * nested inside its home, so it is never the `~/.agents` tree that other agent
 * tools share. An empty or whitespace-only `$ONDRA_AGENTS_HOME` is treated as
 * unset, so a blank override never resolves the root to the current working
 * directory.
 * @param configured - explicit root override, which has highest precedence.
 * @param env - environment mapping used to read `$ONDRA_AGENTS_HOME`.
 * @returns the normalized absolute agent configuration root.
 */
export function resolveAgentsHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTS_HOME_ENV, defaultAgentsHome)
}

/**
 * Join path segments onto the resolved Ondra home.
 * @param segments - path segments appended to the Ondra home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the resolved Ondra home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved Ondra home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.ondra`, and any configured home is labelled `$ONDRA_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.ondra` for the default home, otherwise `$ONDRA_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultDshHome(), DEFAULT_ONDRA_HOME_DISPLAY, ONDRA_HOME_ENV)
}

/**
 * Describe a resolved agent configuration root symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default root is labelled
 * `~/.ondra/agents`, and any configured root is labelled `$ONDRA_AGENTS_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveAgentsHome}.
 * @returns `~/.ondra/agents` for the default root, otherwise `$ONDRA_AGENTS_HOME`.
 */
export function agentsHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultAgentsHome(), DEFAULT_AGENTS_HOME_DISPLAY, AGENTS_HOME_ENV)
}
