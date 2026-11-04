/** The package names the plugin manager protects, hides, orders, or marks experimental. */

/**
 * Plugin packages the plugin manager refuses to disable or remove, because management itself needs them; a bundle that
 * contains one is read-only as well. Removing a name drops only this `management-required` refusal; the manager's own
 * entry, installation-carried bundles, and unaddressable rows stay protected by their own rules.
 */
export const PROTECTED_PLUGINS: ReadonlySet<string> = new Set([
  '@ntars/ondra-plugin-manager', '@ntars/cordis-plugin-loader',
  '@ntars/cordis-plugin-include', '@ntars/ondra-api-gateway',
  '@ntars/ondra-host-webserver', '@ntars/ondra-client-modules',
  '@ntars/ondra-client-ui-settings-plugin-inventory', '@ntars/ondra-client-ui-plugin-manager',
  '@ntars/ondra-host-plugin-inventory', '@ntars/ondra-typert-registry',
  '@ntars/ondra-api-remotes', '@ntars/ondra-api-remote-access',
  '@ntars/cordis-plugin-timer', '@ntars/ondra-client-connection',
  '@ntars/ondra-host-frontend-static', '@ntars/ondra-tools',
  '@ntars/ondra-hmr',
])

/**
 * Built-in profile bundles and persistent terminals, which have no plugin manager page.
 * Their Host availability and activation stay intact.
 */
export const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([
  '@ntars/ondra-base',
  '@ntars/ondra-web-app',
  '@ntars/ondra-headless',
  '@ntars/ondra-sdk-app',
  '@ntars/ondra-acp-app',
  '@ntars/ondra-sdk-minimal',
  '@ntars/ondra-experimental-terminal-bundle',
])

/**
 * The optional bundles the plugin manager's main and More lists rank first, in this order. {@link MORE_BUNDLES}, not
 * this list, decides whether a bundle appears on the main list.
 */
export const EXTENSION_BUNDLES: readonly string[] = [
  '@ntars/ondra-experimental-agent-team-profile',
  '@ntars/ondra-experimental-voice-input-bundle',
  '@ntars/ondra-experimental-plugin-market-bundle',
  '@ntars/ondra-experimental-auto-review',
]

/**
 * The optional bundles the plugin manager's main list leaves out until the profile enables them; its More list,
 * which includes every eligible bundle, ranks them last in this order.
 */
export const MORE_BUNDLES: readonly string[] = [
  '@ntars/ondra-personalized-recommendations',
  '@ntars/ondra-experimental-inspector-profile',
  '@ntars/ondra-cua-bundle',
  '@ntars/ondra-experimental-tool-worktree',
  '@ntars/ondra-experimental-cot-translation-bundle',
  '@ntars/ondra-experimental-session-search',
  '@ntars/ondra-experimental-session-titles-bundle',
  '@ntars/ondra-experimental-badge-skill-bundle',
  '@ntars/ondra-experimental-ralph-bundle',
  '@ntars/ondra-subagent-codex',
  '@ntars/ondra-subagent-claude-code',
]

/** Official bundles the plugin manager marks with the Experimental badge. */
export const EXPERIMENTAL_BUNDLES: ReadonlySet<string> = new Set([
  '@ntars/ondra-personalized-recommendations',
  '@ntars/ondra-cua-bundle',
  '@ntars/ondra-experimental-agent-team-profile',
  '@ntars/ondra-experimental-voice-input-bundle',
  '@ntars/ondra-experimental-auto-review',
  '@ntars/ondra-experimental-inspector-profile',
  '@ntars/ondra-experimental-forge-bundle',
  '@ntars/ondra-experimental-tool-worktree',
  '@ntars/ondra-experimental-cot-translation-bundle',
  '@ntars/ondra-experimental-session-search',
  '@ntars/ondra-experimental-session-titles-bundle',
  '@ntars/ondra-experimental-badge-skill-bundle',
  '@ntars/ondra-experimental-ralph-bundle',
  '@ntars/ondra-experimental-plugin-market-bundle',
  '@ntars/ondra-experimental-liveshare',
])
