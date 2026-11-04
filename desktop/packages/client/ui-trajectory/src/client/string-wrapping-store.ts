import {
  createSnapshotStore, type SnapshotStore,
} from '@ntars/ondra-client-store'

/**
 * Create the browser-wide default for expanded JSON strings.
 * @returns A persisted preference sampled only when a string is expanded.
 */
export function createTrajectoryStringWrappingStore(): SnapshotStore<boolean> {
  return createSnapshotStore(false, {
    persist: { name: 'ondra.trajectory.jsonStringWrapping' },
  })
}
