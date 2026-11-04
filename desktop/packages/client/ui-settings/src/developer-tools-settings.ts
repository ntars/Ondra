/** Shared Web and desktop developer-tool preference stored by the Host. */
import z from '@ntars/schemastery'

/** Namespace for developer UI and HTML preview capabilities. */
export const DEVELOPER_TOOLS_NAMESPACE = 'ui-settings'

/** Persisted developer-tool choice. */
export interface DeveloperToolsSettings {
  /** Enable diagnostic views, preset selection, change summaries and scripted HTML previews. */
  enabled: boolean
}

/**
 * New installations start with the diagnostic interface OFF: the code-work view
 * (轨迹、本轮代码差异、完整 Agent 预设切换) is opt-in and has no settings entry
 * any more, so the default is the whole of what a fresh install sees.
 */
export const DeveloperToolsSettingsFields = {
  enabled: z.boolean().default(false),
}

/** Schema for shared configuration values. */
export const DeveloperToolsSettingsSchema = z.object(DeveloperToolsSettingsFields)
