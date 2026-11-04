/** Explicit exceptions and Host packages for the published dependency policy. */

/** Packages treated as Client/Host packages without declaring `ondra.client`. */
const CLIENT_FACE_INCLUDE: readonly string[] = []

/** Packages exempted from automatic Client/Host treatment despite declaring `ondra.client`. */
const CLIENT_FACE_EXCLUDE: readonly string[] = [
  '@ntars/ondra-api-session-controller',
  '@ntars/ondra-api-workspace-controller',
]

/** Host-only packages whose peer relays are deliberately flattened. */
const HOST_DEPENDENCY_PACKAGES: readonly string[] = [
  '@ntars/ondra-llm',
  '@ntars/ondra-session',
]

/** Required Cordis services whose Host imports are type-only. */
const REQUIRED_SERVICE_PEERS = {
  '@ntars/ondra-api-terminal-controller': ['@ntars/ondra-subprocess'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Development-only package relationships not represented by source imports. */
const CONFIGURATION_ONLY_DEV_DEPENDENCIES = {
  '@ntars/ondra-client-locale': ['@ntars/ondra-api-remotes'],
  '@ntars/ondra-client-ui-conversation': [
    '@ntars/ondra-api-remotes',
    '@ntars/ondra-client-ui-workspace',
  ],
  '@ntars/ondra-client-ui-model-selection': ['@ntars/ondra-client-ui-input-trigger'],
  '@ntars/ondra-client-ui-sidebar': ['@ntars/ondra-client-ui-workspace'],
  '@ntars/ondra-client-ui-subagent': ['@ntars/ondra-client-ui-input-trigger'],
  '@ntars/ondra-client-ui-theme': ['@ntars/ondra-api-remotes'],
  '@ntars/ondra-client-ui-tool': ['@ntars/ondra-api-remotes'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Workspace packages whose complete runtime surface is safe across duplicate installations. */
const DUPLICATE_SAFE_PACKAGES: readonly string[] = [
  '@ntars/ondra-brand',
  '@ntars/ondra-lazy-require',
  '@ntars/ondra-typert-protocol',
  '@ntars/ondra-util-code-language',
  '@ntars/ondra-util-crypto',
  '@ntars/ondra-util-values',
]

/**
 * Runtime exports whose values remain valid when npm installs another package copy.
 * New entries are forbidden by default. Automated agents must not add an
 * exception; every addition requires explicit human review and a dedicated,
 * prominent heading in the pull request description.
 */
const SAFE_HOST_DEPENDENCY_EXPORTS = {
  '@ntars/ondra-atomic-write': ['withFileLock', 'writeFileAtomic'],
  '@ntars/ondra-computer-use/brand': ['ComputerUseProviderName'],
  '@ntars/ondra-credentials': ['credentialKey'],
  '@ntars/ondra-deque': ['Deque'],
  // The Liveshare wire codec and identity helpers are stateless functions over caller-owned values.
  '@ntars/ondra-experimental-liveshare-protocol': [
    'LIVESHARE_CAPABILITIES', 'LIVESHARE_PROTOCOL_VERSION', 'parseRelayFrame', 'parseShareAccessState',
    'parseTunnelWorkerCommand', 'parseTunnelWorkerEvent', 'rawText', 'sendFrame', 'unsupportedFrameRefusal',
    'viewerRequestFields', 'identityFromKey', 'identityKeyOf',
  ],
  '@ntars/ondra-llm': ['callConfigEquals'],
  '@ntars/ondra-session': ['SessionId'],
  '@ntars/ondra-session-format': ['sessionFormatLogFilename'],
  '@ntars/ondra-storage-domain': ['defineDomain'],
  '@ntars/ondra-timeout': ['MAX_TIMER_DELAY_MS'],
  '@ntars/schemastery': ['default'],
} as const satisfies HostDependencyExports

/** Runtime exports that require every consumer to resolve the provider's shared peer instance. */
const PEER_REQUIRED_HOST_EXPORTS = {
  // Profile settings must match the installed Node provider's configuration schema.
  '@ntars/ondra-ptc-runtime-node/configuration': ['resolvePersistentExecution'],
  // CUA checks UserQuestionError and preserves AttachmentError from image admission.
  '@ntars/ondra-attachment': ['admitEncodedImages'],
  '@ntars/ondra-user-questions': ['UserQuestionError'],
  // `instanceof` checks need the translator's own class instance.
  '@ntars/ondra-experimental-translator': ['TranslationError'],
  // Stateless; a safe classification would turn the forge panel's forge and worktree peers into dependencies.
  '@ntars/ondra-experimental-forge': ['changeRequestKey'],
  '@ntars/ondra-experimental-worktree': ['generatedWorktreeName'],
  // The forge panel matches ctx.fs failures with `instanceof FsError`.
  '@ntars/ondra-fs': ['FsError'],
  '@ntars/ondra-scope': ['carrierKeyOf', 'createScope', 'scopeOf', 'scopeTarget'],
  // appendPluginRecord writes through the Session class's private log; pluginRecordOf is stateless.
  '@ntars/ondra-session': ['SESSION_FORMAT_VERSION', 'appendPluginRecord', 'pluginRecordOf'],
  '@ntars/ondra-session-persistence': ['SessionPersistenceNotFoundError'],
  // Readers recognize a deadline's TimeoutReason only by `instanceof` against their own copy.
  '@ntars/ondra-timeout': ['deadline'],
} as const satisfies HostDependencyExports

/** Exact import specifier to reviewed runtime exports. */
type HostDependencyExports = Readonly<Record<string, readonly string[]>>

/** Complete configurable input to package dependency classification. */
export interface PackageDependencyPolicy {
  readonly clientFaceInclude: readonly string[]
  readonly clientFaceExclude: readonly string[]
  readonly hostPackages: readonly string[]
  readonly requiredServicePeers?: Readonly<Record<string, readonly string[]>>
  readonly configurationOnlyDevDependencies: Readonly<Record<string, readonly string[]>>
  readonly duplicateSafePackages?: readonly string[]
  readonly safeHostDependencyExports: HostDependencyExports
  readonly peerRequiredHostExports: HostDependencyExports
}

/** Repository dependency policy consumed by verification and benchmarking. */
export const PACKAGE_DEPENDENCY_POLICY: PackageDependencyPolicy = {
  clientFaceInclude: CLIENT_FACE_INCLUDE,
  clientFaceExclude: CLIENT_FACE_EXCLUDE,
  hostPackages: HOST_DEPENDENCY_PACKAGES,
  requiredServicePeers: REQUIRED_SERVICE_PEERS,
  configurationOnlyDevDependencies: CONFIGURATION_ONLY_DEV_DEPENDENCIES,
  duplicateSafePackages: DUPLICATE_SAFE_PACKAGES,
  safeHostDependencyExports: SAFE_HOST_DEPENDENCY_EXPORTS,
  peerRequiredHostExports: PEER_REQUIRED_HOST_EXPORTS,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a package manifest declares a dynamically loaded Client entry. */
export function hasClientDeclaration(ondraField: unknown): boolean {
  return isRecord(ondraField) && Object.hasOwn(ondraField, 'client')
}
