/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@ntars/cordis'
import productAnalyticsRemote from '@ntars/ondra-client-product-analytics/remote'
export type {} from '@ntars/ondra-client-product-analytics/remote'
import agentPresetsRemote from '@ntars/ondra-agent-preset-registry/remote'
import userQuestionsRemote from '@ntars/ondra-user-questions/remote'
import commandsRemote from '@ntars/ondra-commands/remote'
import accountRemote from '@ntars/ondra-api-account-controller/remote'
import settingsControllerRemote from '@ntars/ondra-api-settings-controller/remote'
import officeToPdfRemote from '@ntars/ondra-office-to-pdf/remote'
import goalsRemote from '@ntars/ondra-goal/remote'
import scheduleRemote from '@ntars/ondra-schedule/remote'
import llmRemote from '@ntars/ondra-llm/remote'
import dynamicRemote from '@ntars/ondra-cordis-host-runner/remote'
import pluginManagerRemote from '@ntars/ondra-plugin-manager/remote'
import toolResultsRemote from '@ntars/ondra-client-ui-trajectory/remote'
import pluginRegistryProbeRemote from '@ntars/ondra-client-ui-plugin-manager/remote'
import pluginMarketRemote from '@ntars/ondra-plugin-market/remote'
import pluginInventoryRemote from '@ntars/ondra-host-plugin-inventory/remote'
import messageFeedbackRemote from '@ntars/ondra-message-feedback/remote'
import permissionPresetsRemote from '@ntars/ondra-permission-presets/remote'
import sessionFeedbackRemote from '@ntars/ondra-command-feedback/remote'
import fileUploadsRemote from '@ntars/ondra-client-file-upload/remote'
import sessionReferencesRemote from '@ntars/ondra-session-reference/remote'
import subagentsRemote from '@ntars/ondra-subagent/remote'
import sessionRemote from '@ntars/ondra-api-session-controller/remote'
import jobRemote from '@ntars/ondra-api-job-controller/remote'
import workspaceRemote from '@ntars/ondra-api-workspace-controller/remote'
import terminalRemote from '@ntars/ondra-api-terminal-controller/remote'
import workspaceFilesRemote from '@ntars/ondra-api-workspace-files/remote'
import type { ClientRemote } from '@ntars/ondra-api-gateway/client'

export type { ClientRemote } from '@ntars/ondra-api-gateway/client'
export type {
  BundleDetail, BundleInfo, BundleRowInfo, ChangeResult, IncompatiblePlugin, InspectOptions, InstallBundleOptions, InstallSpecKind,
  ManagementError, PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection,
  PluginUpdateProgress, PluginUpdateResult, PluginUpdateStep, PluginVersion, PluginVersionList, RegistryAttempt,
  ReadOnlyReason, Registry, RestartReason,
} from '@ntars/ondra-plugin-manager/types'
export type {} from '@ntars/ondra-plugin-manager/remote'
export type {} from '@ntars/ondra-client-ui-plugin-manager/remote'
export type {} from '@ntars/ondra-client-ui-trajectory/remote'
export type {} from '@ntars/ondra-plugin-market/remote'
export type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketInstallationStatus, MarketListingEntry, MarketListingVersion,
  MarketQuery, MarketSearchResult, MarketSort, PluginDetail, PluginDetailDocumentId, PluginDetailOrigin,
} from '@ntars/ondra-plugin-market/types'
export type { PluginInventorySnapshot } from '@ntars/ondra-host-plugin-inventory/types'
export type {} from '@ntars/ondra-agent-preset-registry/remote'
export type {} from '@ntars/ondra-user-questions/remote'
export type {} from '@ntars/ondra-commands/remote'
export type {} from '@ntars/ondra-api-settings-controller/remote'
export type {} from '@ntars/ondra-api-account-controller/remote'
export type {} from '@ntars/ondra-goal/remote'
export type {} from '@ntars/ondra-schedule/remote'
export type {} from '@ntars/ondra-office-to-pdf/remote'
export type {} from '@ntars/ondra-llm/remote'
export type {} from '@ntars/ondra-host-plugin-inventory/remote'
export type {} from '@ntars/ondra-message-feedback/remote'
export type {} from '@ntars/ondra-permission-presets/remote'
export type {} from '@ntars/ondra-command-feedback/remote'
export type {} from '@ntars/ondra-client-file-upload/remote'
export type {} from '@ntars/ondra-session-reference/remote'
export type {} from '@ntars/ondra-subagent/remote'
export type * from '@ntars/ondra-subagent/client'
export type {} from '@ntars/ondra-api-session-controller/remote'
export type * from '@ntars/ondra-api-session-controller/types'
export type {} from '@ntars/ondra-api-job-controller/remote'
export type * from '@ntars/ondra-api-job-controller/types'
export type {} from '@ntars/ondra-api-workspace-controller/remote'
export type * from '@ntars/ondra-api-workspace-controller/types'
export type {} from '@ntars/ondra-api-workspace-files/remote'
export type * from '@ntars/ondra-api-workspace-files/types'
export type {} from '@ntars/ondra-api-terminal-controller/remote'
export type * from '@ntars/ondra-api-terminal-controller/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@ntars/ondra-commands/types'
export type {} from '@ntars/ondra-cordis-host-runner/types'
export type {} from '@ntars/ondra-credentials/types'
export type {} from '@ntars/ondra-llm/types'
export type {} from '@ntars/ondra-agent-preset-registry/types'
export type {} from '@ntars/ondra-permission-presets/types'
export type {} from '@ntars/ondra-settings/types'
export type {} from '@ntars/ondra-user-approval/types'
export type {} from '@ntars/ondra-user-questions/types'
export type {} from '@ntars/ondra-api-session-controller/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@ntars/ondra-client-connection/client'
export type {} from '@ntars/ondra-api-gateway/client'
export type {} from '@ntars/ondra-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@ntars/ondra-cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
export type { CredentialInfo } from '@ntars/ondra-credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@ntars/ondra-settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmNativeAuth, LlmProviderInfo,
} from '@ntars/ondra-llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@ntars/ondra-file-reference/types'
export type { SessionReferenceMentionCandidate } from '@ntars/ondra-session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// ondra-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@ntars/ondra-typert-protocol'
export type { RemoteHostFacts } from '@ntars/ondra-api-gateway/client'

declare module '@ntars/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote, accountRemote,
      goalsRemote, llmRemote, dynamicRemote, scheduleRemote,
      pluginInventoryRemote, pluginManagerRemote, pluginMarketRemote, pluginRegistryProbeRemote, toolResultsRemote,
      messageFeedbackRemote, sessionFeedbackRemote,
      fileUploadsRemote, sessionReferencesRemote,
      permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
      officeToPdfRemote, userQuestionsRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
