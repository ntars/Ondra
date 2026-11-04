/** Derived observable sources for the row actions' injected hooks. */
import type { HostObservable } from '@ntars/ondra-client-ui-slots'

/**
 * Project one observable into another, recomputing only when the source
 * snapshot changes identity, so consumers that select from the projection
 * (a Set lookup per row) never rebuild it per read.
 * @param source - the observable to project.
 * @param project - pure projection of one source snapshot.
 * @returns the projected observable, subscribing through the source.
 */
export function derive<S, T>(source: HostObservable<S>, project: (snapshot: S) => T): HostObservable<T> {
  let seen: S | undefined
  let value: T | undefined
  return {
    getSnapshot: () => {
      const snapshot = source.getSnapshot()
      if (value === undefined || snapshot !== seen) {
        seen = snapshot
        value = project(snapshot)
      }
      return value
    },
    subscribe: listener => source.subscribe(listener),
  }
}

/**
 * Project two observables into one, recomputing only when either source
 * snapshot changes identity.
 *
 * The cached value matters more here than for {@link derive}: the projection
 * allocates (a row array per read), and `useSyncExternalStore` compares
 * snapshots by identity — an unmemoized projection would look like a new state
 * on every render and spin.
 * @param a - first source observable.
 * @param b - second source observable.
 * @param project - pure projection of both snapshots.
 * @returns the projected observable, subscribing through both sources.
 */
export function derivePair<A, B, T>(
  a: HostObservable<A>,
  b: HostObservable<B>,
  project: (first: A, second: B) => T,
): HostObservable<T> {
  let seenA: A | undefined
  let seenB: B | undefined
  let value: T | undefined
  return {
    getSnapshot: () => {
      const first = a.getSnapshot()
      const second = b.getSnapshot()
      if (value === undefined || first !== seenA || second !== seenB) {
        seenA = first
        seenB = second
        value = project(first, second)
      }
      return value
    },
    subscribe: listener => {
      const disposeA = a.subscribe(listener)
      const disposeB = b.subscribe(listener)
      return () => {
        disposeA()
        disposeB()
      }
    },
  }
}
