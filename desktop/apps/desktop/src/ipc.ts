/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@ntars/ondra-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@ntars/ondra-client-ui-sidebar-browser/types'
import type { DesktopFileDrag } from '@ntars/ondra-util-file-drag'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  shortcutsInput: 'ondra-desktop:shortcuts-input',
  shortcutsCloseWindow: 'ondra-desktop:shortcuts-close-window',
  shortcutsGet: 'ondra-desktop:shortcuts-get',
  shortcutsEdit: 'ondra-desktop:shortcuts-edit',
  shortcutsChanged: 'ondra-desktop:shortcuts-changed',
  shortcutsRecording: 'ondra-desktop:shortcuts-recording',
  boot: 'ondra-desktop:boot',
  enterWorkspace: 'ondra-desktop:enter-workspace',
  onboardingActive: 'ondra-desktop:onboarding-active',
  onboardingApiKey: 'ondra-desktop:onboarding-api-key',
  bootFailed: 'ondra-desktop:boot-failed',
  browserAcquire: 'ondra-desktop:browser-acquire',
  browserRelease: 'ondra-desktop:browser-release',
  browserOpenRequested: 'ondra-desktop:browser-open-requested',
  directoryPick: 'ondra-desktop:directory-pick',
  fileDragPrepare: 'ondra-desktop:file-drag-prepare',
  fileDragCancel: 'ondra-desktop:file-drag-cancel',
  fileDragStart: 'ondra-desktop:file-drag-start',
  fileDragRelease: 'ondra-desktop:file-drag-release',
  sessionsPurge: 'ondra-desktop:sessions-purge',
  snapshotsList: 'ondra-desktop:snapshots-list',
  snapshotsCapture: 'ondra-desktop:snapshots-capture',
  snapshotsRestore: 'ondra-desktop:snapshots-restore',
  snapshotsDelete: 'ondra-desktop:snapshots-delete',
  deviceInfo: 'ondra-desktop:device-info',
  about: 'ondra-desktop:about',
  localeBootstrap: 'ondra-desktop:locale-bootstrap',
  localeChanged: 'ondra-desktop:locale-changed',
  updatesStatus: 'ondra-desktop:updates-status',
  updatesOpen: 'ondra-desktop:updates-open',
  updatesPresentation: 'ondra-desktop:updates-presentation',
  nativeThemeSet: 'ondra-desktop:native-theme-set',
  windowFullscreen: 'ondra-desktop:window-fullscreen',
  windowsAppearance: 'ondra-desktop:windows-appearance',
  windowsMenu: 'ondra-desktop:windows-menu',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'fullscreen-timeout'

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface OndraDesktopProductApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly fileDrag: DesktopFileDrag
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  /**
   * Local machine description for the feedback questionnaire.
   * @returns `name=value` fields separated by `; `, with no hostname, user name, or serial number.
   */
  deviceInfo(): Promise<string>
  /**
   * Open the shell's standard About panel (name, version and icon).
   * @returns a promise that settles once the request reached the main process.
   */
  showAbout(): Promise<void>
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'ondra-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('ondra desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('ondra desktop: rejected IPC from an unowned renderer')
  }
}

/** One restorable snapshot, as the settings row lists it. */
export interface DesktopSnapshot {
  readonly id: string
  readonly createdAt: number
  readonly files: number
  readonly addedBytes: number
}
