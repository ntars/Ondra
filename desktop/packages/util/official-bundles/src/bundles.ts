/** The bundle package names the ondra installation selects, offers, installs on demand, or retires. */

/** Installation-owned defaults used when a shipped profile is first opened. */
export interface ProfileTemplate {
  /** Ordered bundle layer list. */
  bundles: readonly string[]
}

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@ntars/ondra-base', '@ntars/ondra-acp-app'],
  },
  web: {
    bundles: ['@ntars/ondra-base', '@ntars/ondra-web-app'],
  },
  headless: {
    bundles: ['@ntars/ondra-base', '@ntars/ondra-headless'],
  },
  sdk: {
    bundles: ['@ntars/ondra-base', '@ntars/ondra-sdk-app'],
  },
  'sdk-minimal': {
    bundles: ['@ntars/ondra-sdk-minimal'],
  },
}

/**
 * Installation-owned bundle tuples that an earlier release wrote into a shipped profile; app-boot replaces an exact
 * match with the {@link PROFILE_TEMPLATES} entry of the same name and leaves every other list untouched.
 */
export const INSTALLATION_OWNED_PROFILE_TUPLES: Readonly<Record<string, readonly string[]>> = {
  headless: ['@ntars/ondra-base', '@ntars/ondra-web-app', '@ntars/ondra-headless'],
}

/** Bundles an earlier release shipped and the installation no longer carries; app-boot removes them from profiles. */
export const RETIRED_BUNDLES: ReadonlySet<string> = new Set([
  // The Web composition mounts Schedule itself
  // ([upgrade guide](../../../../docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md)).
  '@ntars/ondra-experimental-schedule-bundle',
])

/** The bundle list a `ondra plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@ntars/ondra-base']

/**
 * The bundles the ondra installation ships for a person to switch on: each a
 * runtime dependency of the installation that declares `ondra.bundle.patch`,
 * an `icon`, and `./locale/*.json` display metadata, selected by no shipped
 * template, and offered switched off by the plugin manager except persistent
 * terminals, which have no page switch
 * ([rationale](../../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md),
 * [admission](../../../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)).
 */
export const OPTIONAL_BUNDLES: readonly string[] = [
  '@ntars/ondra-personalized-recommendations',
  '@ntars/ondra-cua-bundle',
  '@ntars/ondra-experimental-session-search',
  '@ntars/ondra-experimental-ralph-bundle',
  '@ntars/ondra-experimental-terminal-bundle',
  '@ntars/ondra-experimental-badge-skill-bundle',
  '@ntars/ondra-experimental-session-titles-bundle',
  '@ntars/ondra-experimental-agent-team-profile',
  '@ntars/ondra-experimental-voice-input-bundle',
  '@ntars/ondra-experimental-cot-translation-bundle',
  '@ntars/ondra-experimental-auto-review',
  '@ntars/ondra-experimental-inspector-profile',
  '@ntars/ondra-experimental-liveshare',
  '@ntars/ondra-experimental-plugin-market-bundle',
  '@ntars/ondra-experimental-tool-worktree',
  '@ntars/ondra-experimental-forge-bundle',
]

/** Public Ondra release members available through the ordinary on-demand bundle installer. */
export const ON_DEMAND_BUNDLES: readonly string[] = [
  '@ntars/ondra-subagent-claude-code',
  '@ntars/ondra-subagent-codex',
]
