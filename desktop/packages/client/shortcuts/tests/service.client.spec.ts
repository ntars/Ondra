// @vitest-environment jsdom
/**
 * The `shortcuts` seat is deliberately inert in Ondra: it exists so feature
 * plugins that contribute catalog entries still compile and mount, but nothing
 * listens for keys, reserves a binding, reads a native bridge or persists a
 * preference. These cases pin that contract so the machinery cannot return
 * silently; ordinary key handling (Enter, Escape, Backspace) lives inside the
 * components themselves and is not covered here.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ShortcutsService from '../src/client/index.ts'
import type { ShortcutCommandId } from '../src/protocol.ts'
import type { ShortcutCommand, ShortcutFixedCommand } from '../src/client/index.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  delete document.documentElement.dataset.platform
  Reflect.deleteProperty(window, 'dshDesktop')
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount() {
  const ctx = new Context()
  const dispose = async () => { await ctx.fiber.dispose() }
  disposers.push(dispose)
  const service = new ShortcutsService(ctx)
  return { ctx, service }
}

const command: ShortcutCommand = {
  id: 'test.toggle' as ShortcutCommandId,
  label: () => 'Toggle',
  aliases: [],
  defaults: {
    'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
    'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
    'desktop:linux': { code: 'KeyB', modifiers: ['primary'] },
  },
  regions: ['page'],
  modals: [],
  resolve: () => ({ status: 'handled', run() {} }),
}

const fixed: ShortcutFixedCommand = {
  id: 'menu.close' as ShortcutCommandId,
  label: () => 'Close',
  keys: ['Esc'],
  bindings: [{ code: 'Escape', modifiers: [] }],
  group: 'menus',
}

it('occupies the shortcuts seat so contributing plugins can still resolve it', () => {
  const { ctx } = mount()
  // The seat answers through the context even though it holds no commands:
  // a feature plugin's `ctx.shortcuts.register(...)` stays a no-op, not a crash.
  const seat = ctx.get('shortcuts')
  expect(seat).toBeDefined()
  expect(seat!.catalog.getSnapshot()).toEqual([])
  expect(seat!.fixedCatalog.getSnapshot()).toEqual([])
  expect(seat!.stopSequenceMs).toBe(0)
})

it('accepts and releases contributions without reserving a key', () => {
  const { service } = mount()
  const offCommand = service.register(command)
  const offFixed = service.registerFixed(fixed)
  // Nothing reaches the catalog, so the settings surface has nothing to list.
  expect(service.catalog.getSnapshot()).toEqual([])
  expect(service.fixedCatalog.getSnapshot()).toEqual([])
  expect(service.describeBinding({ code: 'KeyB', modifiers: ['primary'] })).toEqual(
    { binding: null, keys: [], issue: null, conflicts: [] })
  expect(service.describeBinding({ code: 'Escape', modifiers: [] }).conflicts).toEqual([])
  // The disposers stay callable and idempotent so a plugin's teardown is harmless.
  offCommand(); offCommand(); offFixed(); offFixed()
})

it('reports every candidate as unbound rather than claiming a normalized binding', () => {
  const { service } = mount()
  for (const candidate of [null, { code: 'Slash', modifiers: ['primary'] as const },
    { code: 'KeyA', secondCode: 'KeyB', modifiers: [] }]) {
    expect(service.describeBinding(candidate)).toEqual({ binding: null, keys: [], issue: null, conflicts: [] })
  }
})

it('publishes a snapshot that never changes instead of loading a stored preference', () => {
  const read = vi.spyOn(Storage.prototype, 'getItem')
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const { service } = mount()
  const initial = service.config.getSnapshot()
  const listener = vi.fn()
  service.config.subscribe(listener)
  expect(service.config.getSnapshot()).toBe(initial)
  // The inert seat never completes a handshake, so the status stays `loading`
  // instead of announcing a catalog a settings surface could list.
  expect(initial.status).toBe('loading')
  expect(listener).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('rejects an edit as unreadable without touching storage or the accepted snapshot', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const { service } = mount()
  const accepted = service.config.getSnapshot()
  await expect(service.edit({ type: 'reset-all' }, accepted.revision))
    .resolves.toEqual({ status: 'unreadable', snapshot: accepted })
  expect(service.config.getSnapshot()).toBe(accepted)
  expect(write).not.toHaveBeenCalled()
})

it('resolves recording without a native bridge and observes no fixed input', async () => {
  const keyboard = { closeWindow: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}) }
  Object.defineProperty(window, 'dshDesktop', { configurable: true, value: { keyboard } })
  const { service } = mount()
  await expect(service.recording(true)).resolves.toBeUndefined()
  await expect(service.recording(false)).resolves.toBeUndefined()
  const observed = vi.fn()
  const off = service.observeFixedInput(observed)
  fireEventKey('Escape')
  fireEventKey('KeyB', { metaKey: true })
  expect(observed).not.toHaveBeenCalled()
  off(); off()
  expect(keyboard.subscribe).not.toHaveBeenCalled()
})

it('resolves a window close outside Desktop and never calls a native bridge inside it', async () => {
  const outside = mount()
  await expect(outside.service.closeWindow()).resolves.toBeUndefined()
  const keyboard = { closeWindow: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}) }
  Object.defineProperty(window, 'dshDesktop', { configurable: true, value: { keyboard } })
  const inside = mount()
  await expect(inside.service.closeWindow()).resolves.toBeUndefined()
  expect(keyboard.closeWindow).not.toHaveBeenCalled()
})

/** Dispatch one physical key and let any listener run before the assertion. */
function fireEventKey(code: string, init: KeyboardEventInit = {}): void {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(event)
  document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init }))
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init }))
}
