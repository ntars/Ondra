/**
 * Test-only client roster of the assembled viewer page.
 *
 * A served viewer page is the owner's own Web shell with the owner's client plugins; this roster is the
 * subset the viewer page specs need: the wire plugin, the Gateway, remote access, the Session/Workspace controllers,
 * the presentation plugins, and the Liveshare `./client` face, which mounts the viewer surfaces when the
 * carrier names a share. Every row is the package's own `/client` face registered as a module-table
 * factory. It must be imported only after {@link prepareViewerRemoteFaces} answered the generated
 * `/remote` faces these plugins import.
 *
 * @module @ntars/ondra-experimental-liveshare/tests/viewer-page-roster
 */

import * as apiGateway from '@ntars/ondra-api-gateway/client'
import * as apiRemoteAccess from '@ntars/ondra-api-remote-access/client'
import * as apiRemotes from '@ntars/ondra-api-remotes/client'
import * as apiSessionController from '@ntars/ondra-api-session-controller/client'
import * as apiWorkspaceController from '@ntars/ondra-api-workspace-controller/client'
import * as clientConnection from '@ntars/ondra-client-connection/client'
import * as clientFileUpload from '@ntars/ondra-client-file-upload/client'
import * as clientLocale from '@ntars/ondra-client-locale/client'
import * as clientModules from '@ntars/ondra-client-modules/client'
import * as clientResources from '@ntars/ondra-client-resources/client'
import * as clientShortcuts from '@ntars/ondra-client-shortcuts/client'
import * as uiAttachment from '@ntars/ondra-client-ui-attachment/client'
import * as uiChat from '@ntars/ondra-client-ui-chat/client'
import * as uiConversation from '@ntars/ondra-client-ui-conversation/client'
import * as uiDeliverables from '@ntars/ondra-client-ui-deliverables/client'
import * as uiFileDrag from '@ntars/ondra-client-ui-file-drag/client'
import * as uiLayout from '@ntars/ondra-client-ui-layout/client'
import * as uiRenderer from '@ntars/ondra-client-ui-renderer/client'
import * as uiSession from '@ntars/ondra-client-ui-session/client'
import * as uiSettings from '@ntars/ondra-client-ui-settings/client'
import * as uiSidebar from '@ntars/ondra-client-ui-sidebar/client'
import * as uiSidebarRight from '@ntars/ondra-client-ui-sidebar-right/client'
import * as uiTheme from '@ntars/ondra-client-ui-theme/client'
import * as uiTool from '@ntars/ondra-client-ui-tool/client'
import * as uiTrajectory from '@ntars/ondra-client-ui-trajectory/client'
import * as uiWorkspace from '@ntars/ondra-client-ui-workspace/client'
import * as typertRegistry from '@ntars/ondra-typert-registry/client'
import * as liveshare from '../src/client/index.ts'

/** One module-table row: the entry id the Loader creates, and that plugin's client exports. */
export interface ViewerPageRosterRow {
  readonly id: string
  readonly exports: Readonly<Record<string, unknown>>
}

/** Entry id of the module-system bootstrap whose exports the facade hands to the module system. */
export const VIEWER_PAGE_BOOTSTRAP_ID = '@ntars/ondra-client-modules'

/** The viewer page roster; Cordis composes these entries by service injection, so order is irrelevant. */
export const VIEWER_PAGE_ROSTER: readonly ViewerPageRosterRow[] = [
  { id: '@ntars/ondra-typert-registry', exports: typertRegistry },
  { id: '@ntars/ondra-experimental-liveshare', exports: liveshare },
  { id: VIEWER_PAGE_BOOTSTRAP_ID, exports: clientModules },
  { id: '@ntars/ondra-client-connection', exports: clientConnection },
  { id: '@ntars/ondra-api-gateway', exports: apiGateway },
  { id: '@ntars/ondra-api-remote-access', exports: apiRemoteAccess },
  { id: '@ntars/ondra-api-remotes', exports: apiRemotes },
  { id: '@ntars/ondra-api-session-controller', exports: apiSessionController },
  { id: '@ntars/ondra-api-workspace-controller', exports: apiWorkspaceController },
  { id: '@ntars/ondra-client-file-upload', exports: clientFileUpload },
  { id: '@ntars/ondra-client-locale', exports: clientLocale },
  { id: '@ntars/ondra-client-resources', exports: clientResources },
  { id: '@ntars/ondra-client-shortcuts', exports: clientShortcuts },
  { id: '@ntars/ondra-client-ui-renderer', exports: uiRenderer },
  { id: '@ntars/ondra-client-ui-theme', exports: uiTheme },
  { id: '@ntars/ondra-client-ui-settings', exports: uiSettings },
  { id: '@ntars/ondra-client-ui-layout', exports: uiLayout },
  { id: '@ntars/ondra-client-ui-session', exports: uiSession },
  { id: '@ntars/ondra-client-ui-sidebar', exports: uiSidebar },
  { id: '@ntars/ondra-client-ui-conversation', exports: uiConversation },
  { id: '@ntars/ondra-client-ui-chat', exports: uiChat },
  { id: '@ntars/ondra-client-ui-tool', exports: uiTool },
  { id: '@ntars/ondra-client-ui-attachment', exports: uiAttachment },
  { id: '@ntars/ondra-client-ui-file-drag', exports: uiFileDrag },
  { id: '@ntars/ondra-client-ui-sidebar-right', exports: uiSidebarRight },
  { id: '@ntars/ondra-client-ui-trajectory', exports: uiTrajectory },
  { id: '@ntars/ondra-client-ui-deliverables', exports: uiDeliverables },
  { id: '@ntars/ondra-client-ui-workspace', exports: uiWorkspace },
]
