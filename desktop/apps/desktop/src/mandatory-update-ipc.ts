/** Dependency-free IPC names shared with the sandboxed mandatory-update preload. */
export const MANDATORY_IPC = {
  status: 'ondra-desktop:mandatory-status', state: 'ondra-desktop:mandatory-state', action: 'ondra-desktop:mandatory-action',
} as const
