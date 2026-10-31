/**
 * Application command surface, deliberately inert.
 *
 * Ondra does not ship keyboard shortcuts: the command registry, physical-key
 * routing, native keyboard bridge, and preference persistence were removed.
 * This module keeps the `shortcuts` service seat and its types so feature
 * plugins that contribute catalog entries still compile and mount; nothing
 * listens for keys and the catalog stays empty. Ordinary key handling inside
 * inputs (Enter to submit, Escape to dismiss, Backspace to edit) lives in the
 * components themselves and is unaffected.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  BindingIssue, NormalizedBinding, ShortcutBinding, ShortcutCommandId,
  ShortcutConfigSnapshot, ShortcutEdit, ShortcutPlatform, ShortcutRevision,
  ShortcutRuntime, ShortcutSaveResult,
} from '../protocol.ts'
import { initialShortcutConfig } from '../persistence.ts'
import type {
  ShortcutCatalogEntry, ShortcutCommand, ShortcutFixedCatalogEntry,
  ShortcutFixedCommand, ShortcutFixedInput, Shortcuts,
} from './types.ts'

export type { ShortcutCatalogEntry, ShortcutCommand, ShortcutContext, ShortcutGesture, Shortcuts } from './types.ts'
export type { ShortcutFixedInput, ShortcutFixedCommand, ShortcutFixedCatalogEntry } from './types.ts'
export type { ShortcutBinding, ShortcutCommandId, ShortcutPlatform, ShortcutRuntime } from '../protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Window-local command seat; no commands and no key listeners are installed. */
    shortcuts: Shortcuts
  }
}

/** A snapshot that never changes. */
function constant<T>(value: T): ObservableSnapshot<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} }
}

const EMPTY_CATALOG: readonly ShortcutCatalogEntry[] = Object.freeze([])
const EMPTY_FIXED: readonly ShortcutFixedCatalogEntry[] = Object.freeze([])

/** Inert command seat: keeps feature plugins mounting without any key routing. */
export default class ShortcutsService extends Service implements Shortcuts {
  readonly runtime: ShortcutRuntime
  readonly platform: ShortcutPlatform
  readonly catalog = constant(EMPTY_CATALOG)
  readonly config = constant<ShortcutConfigSnapshot>(initialShortcutConfig())
  readonly fixedCatalog = constant(EMPTY_FIXED)
  readonly stopSequenceMs = 0

  constructor(ctx: Context) {
    super(ctx, 'shortcuts')
    this.runtime = typeof window === 'undefined' ? 'web' : 'desktop'
    this.platform = 'macos'
  }

  /** Accept a command contribution without wiring any key. */
  register(_command: ShortcutCommand): () => void {
    return () => {}
  }

  /** Accept a fixed contribution without reserving any key. */
  registerFixed(_command: ShortcutFixedCommand): () => void {
    return () => {}
  }

  /** No input is ever observed. */
  observeFixedInput(_listener: (input: ShortcutFixedInput) => void): () => void {
    return () => {}
  }

  /** Report the candidate as unbound: nothing is reserved. */
  describeBinding(_binding: ShortcutBinding | null): {
    binding: NormalizedBinding | null
    keys: readonly string[]
    issue: BindingIssue | null
    conflicts: readonly ShortcutCommandId[]
  } {
    return { binding: null, keys: [], issue: null, conflicts: [] }
  }

  /** Accept an edit without persisting it. */
  edit(_edit: ShortcutEdit, _revision: ShortcutRevision): Promise<ShortcutSaveResult> {
    return Promise.resolve({ status: 'unreadable', snapshot: this.config.getSnapshot() })
  }

  /** Nothing captures the keyboard, so there is nothing to suppress. */
  async recording(_active: boolean): Promise<void> {}

  /** Window closure is not a shortcut concern any more. */
  async closeWindow(): Promise<void> {}
}
